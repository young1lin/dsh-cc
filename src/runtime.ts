/**
 * Host-side runtime: session store + live engines + the /cc/api HTTP surface
 * (REST for mutations, one SSE stream for all pushes). Registered as a single
 * prefix route on the dsh webserver.
 *
 * @module dsh-cc/runtime
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from './config.ts'
import { SessionEngine, type EngineHooks, type SendImage } from './engine.ts'
import { BlobStore, isImageMediaType } from './blobs.ts'
import { SessionCatalog } from './catalog.ts'
import { reduceDelta, type LiveTurn } from './live-turn.ts'
import { deleteNativeSession, renameNativeSession } from './native-sessions.ts'
import { SessionStore } from './store.ts'
import type {
  AccountSummary, CcEvent, CcEventInput, CcSettings, ConfigLayer, ConfigSummary, DirListing,
  EffectiveEnvEntry, ImageRef, LiveTurnSnapshot, PermissionDestination, WireMessage,
} from './types.ts'
import { DEFAULT_EFFORT_LEVELS } from './types.ts'

const MAX_BODY_BYTES = 1024 * 1024

/**
 * Largest single image accepted for upload. Matches the Anthropic API's
 * per-image limit, so an image the page accepts is one the model can be sent
 * rather than one that fails at request time.
 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** Static model aliases shown before a live CLI catalog exists. */
const STATIC_MODEL_FALLBACK = [
  { value: 'default', displayName: 'Default (recommended)' },
  { value: 'sonnet', displayName: 'Sonnet' },
  { value: 'opus', displayName: 'Opus' },
  { value: 'haiku', displayName: 'Haiku' },
]

/**
 * Fill the effort ladder into catalog rows that carry no effort opinion.
 *
 * The CLI's `supportedModels()` leaves `supportsEffort`/`supportedEffortLevels`
 * unset for models it does not know — every gateway model — and the static
 * fallback rows never had them, so the page read "unsupported" for exactly the
 * models this deployment runs. Rows that do state their own levels keep them.
 * @param rows - the catalog rows as the engine reported them.
 * @returns the rows, each now carrying a non-empty effort ladder.
 */
function withEffortDefaults(rows: readonly unknown[]): unknown[] {
  return rows.map(row => {
    if (typeof row !== 'object' || row === null) return row
    const declared = (row as { supportedEffortLevels?: unknown }).supportedEffortLevels
    if (Array.isArray(declared) && declared.length > 0) return row
    return { ...row, supportsEffort: true, supportedEffortLevels: [...DEFAULT_EFFORT_LEVELS] }
  })
}

/**
 * The dsh-cc host runtime. One instance per mounted plugin; disposal closes
 * every live engine and SSE client.
 */
export class CcRuntime {
  readonly store: SessionStore
  /** The merged view over the CLI's session store and the dsh-cc sidecar. */
  readonly catalog: SessionCatalog
  /** Image bytes attached to user messages. */
  private readonly blobs: BlobStore
  private readonly engines = new Map<string, SessionEngine>()
  /**
   * The in-flight turn per session, folded from the same deltas the page
   * receives. This is what a page that arrives mid-turn is handed, so a
   * session switch (or a reload) never loses the streamed thinking.
   */
  private readonly liveTurns = new Map<string, LiveTurn>()
  /**
   * Monotonic per-session delta counters. Never reset while the runtime
   * lives: a page compares its last-seen counter against a snapshot's to know
   * which side is ahead, and resetting would break that comparison.
   */
  private readonly liveSeqs = new Map<string, number>()
  private readonly clients = new Set<ServerResponse>()
  private readonly sdkVersion: string
  private heartbeat: ReturnType<typeof setInterval> | undefined
  /** Periodic native-store rescan; picks up sessions running in a terminal. */
  private rescan: ReturnType<typeof setInterval> | undefined
  /** Page-editable overrides layered over the cordis config. */
  private settings: CcSettings
  /** Live-chosen reasoning effort; undefined keeps each model's default. */
  private effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined
  /**
   * The account the CLI last reported. Only a live CLI can answer, so this is
   * cached from the first engine that resolves one and survives that engine's
   * close; a credential change is picked up by the next engine start.
   */
  private account: AccountSummary | undefined

  constructor(
    private readonly ctx: Context,
    private readonly baseConfig: ResolvedConfig,
  ) {
    this.store = new SessionStore(baseConfig.dataDir)
    this.store.load()
    this.blobs = new BlobStore(baseConfig.dataDir)
    this.catalog = new SessionCatalog(this.store, this.blobs)
    // The CLI store is read from disk, so the first list is served from the
    // sidecar alone and the broadcast that follows fills in the rest.
    void this.catalog.refresh().then(() => this.broadcastSessions())
    this.settings = loadSettings(baseConfig.dataDir)
    this.sdkVersion = readSdkVersion()
    this.heartbeat = setInterval(() => {
      for (const res of this.clients) {
        try {
          res.write(': ping\n\n')
        } catch {
          this.clients.delete(res)
        }
      }
    }, 20_000)
    // A session driven from a terminal CLI writes its transcript with no
    // engine of ours involved; rescanning the native store keeps the page's
    // list — statuses included — in step with it. The catalog only reports a
    // change when something actually moved, so a quiet store costs one stat
    // sweep and no broadcast.
    this.rescan = setInterval(() => {
      void this.catalog.refresh().then(changed => {
        if (changed) this.broadcastSessions()
      })
    }, 2_000)
  }

  /**
   * The cordis config with page-editable settings layered on top: a non-empty
   * settings field replaces its base counterpart, an empty one keeps the base.
   */
  private effectiveConfig(): ResolvedConfig {
    const overrides = this.settings
    return {
      ...this.baseConfig,
      model: overrides.model !== '' ? overrides.model : this.baseConfig.model,
      permissionMode: overrides.permissionMode !== ''
        ? overrides.permissionMode as ResolvedConfig['permissionMode']
        : this.baseConfig.permissionMode,
      env: Object.keys(overrides.env).length > 0 ? { ...overrides.env } : this.baseConfig.env,
      ...(this.effort !== undefined ? { effort: this.effort } : {}),
    }
  }

  private async saveSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req)
    if (body === undefined) return json(res, { error: '请求体不能为空' }, 400)
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    const permissionMode = typeof body.permissionMode === 'string' ? body.permissionMode : ''
    if (permissionMode !== '' && !['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'].includes(permissionMode)) {
      return json(res, { error: '无效的权限模式' }, 400)
    }
    const env: Record<string, string> = {}
    if (typeof body.env === 'object' && body.env !== null) {
      for (const [key, value] of Object.entries(body.env as Record<string, unknown>)) {
        if (typeof value !== 'string') continue
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
        env[key] = value
      }
    }
    this.settings = { model, permissionMode, env }
    persistSettings(this.baseConfig.dataDir, this.settings)
    // Idle engines keep their spawn-time environment; recycle them so the
    // next message spawns with the new settings.
    for (const [id, engine] of [...this.engines]) {
      if (!engine.busy) await this.closeEngine(id)
    }
    this.broadcast({ t: 'hello', config: this.configSummary() })
    this.broadcastSessions()
    return json(res, { ok: true, settings: this.settings })
  }

  /**
   * Accept one pasted or dropped image. The body is the raw bytes and the
   * `content-type` names the image type, so there is no multipart parse and
   * no temporary file.
   * @param req - the upload request.
   * @param res - the response to write.
   */
  private async uploadImage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const mediaType = (req.headers['content-type'] ?? '').split(';')[0]?.trim() ?? ''
    if (!isImageMediaType(mediaType)) {
      return json(res, { error: `不支持的图片类型：${mediaType || '未指定'}` }, 415)
    }
    let bytes: Buffer
    try {
      bytes = await readBytes(req, MAX_IMAGE_BYTES)
    } catch {
      return json(res, { error: '图片超过 5MB 上限' }, 413)
    }
    if (bytes.length === 0) return json(res, { error: '图片内容为空' }, 400)
    const name = req.headers['x-image-name']
    const image = await this.blobs.put(
      bytes,
      mediaType,
      typeof name === 'string' && name !== '' ? decodeURIComponent(name) : undefined,
    )
    return json(res, { image })
  }

  /**
   * Serve one stored image for display. The id encodes the content, so the
   * response is immutable and cached indefinitely.
   * @param file - the `<id>.<ext>` path segment.
   * @param res - the response to write.
   */
  private async serveBlob(file: string, res: ServerResponse): Promise<void> {
    const [id = '', ext = ''] = file.split('.')
    const mediaType = BLOB_EXTENSION_TYPES[ext]
    if (mediaType === undefined || !/^[0-9a-f]{32}$/.test(id)) {
      return json(res, { error: '无效的图片地址' }, 404)
    }
    const bytes = await this.blobs.get(id, mediaType)
    if (bytes === undefined) return json(res, { error: '图片不存在' }, 404)
    res.writeHead(200, {
      'content-type': mediaType,
      'content-length': String(bytes.length),
      'cache-control': 'public, max-age=31536000, immutable',
    })
    res.end(bytes)
  }

  private async listDir(pathname: string | undefined, res: ServerResponse): Promise<void> {
    try {
      return json(res, await readDirListing(pathname))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json(res, { error: `无法读取目录：${message}` }, 400)
    }
  }

  /** The webserver route handler for the /cc/api prefix. */
  readonly handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const parts = url.pathname.replace(/^\/cc\/api\/?/, '').split('/').filter(Boolean)
    const method = req.method ?? 'GET'
    try {
      if (parts[0] === 'events' && parts.length === 1 && method === 'GET') return this.sse(req, res)
      if (parts[0] === 'config' && parts.length === 1 && method === 'GET') {
        return json(res, { config: this.configSummary() })
      }
      if (parts[0] === 'settings' && parts.length === 1 && method === 'GET') return json(res, { settings: this.settings })
      if (parts[0] === 'settings' && parts.length === 1 && method === 'PUT') {
        return await this.saveSettings(req, res)
      }
      if (parts[0] === 'blobs' && parts.length === 2 && method === 'GET') {
        return await this.serveBlob(parts[1] ?? '', res)
      }
      if (parts[0] === 'images' && parts.length === 1 && method === 'POST') {
        return await this.uploadImage(req, res)
      }
      if (parts[0] === 'fs' && parts[1] === 'list' && parts.length === 2 && method === 'GET') {
        return await this.listDir(url.searchParams.get('path') ?? undefined, res)
      }
      if (parts[0] === 'sessions') {
        if (parts.length === 1 && method === 'GET') {
          await this.catalog.refresh()
          return json(res, { sessions: this.catalog.list() })
        }
        if (parts.length === 1 && method === 'POST') {
          const body = await readJson(req)
          const session = await this.store.create(body ?? {}, { cwd: this.effectiveConfig().cwd })
          this.broadcastSessions()
          return json(res, { session })
        }
        const id = parts[1] ?? ''
        if (parts.length === 2 && method === 'GET') {
          const session = this.store.get(id) ?? await this.catalog.adopt(id)
          if (!session) return json(res, { error: '会话不存在' }, 404)
          return json(res, {
            session,
            events: await this.catalog.transcript(session),
            live: this.liveSnapshot(id),
          })
        }
        if (parts.length === 2 && method === 'DELETE') {
          const session = this.catalog.get(id)
          if (!session) return json(res, { error: '会话不存在' }, 404)
          await this.closeEngine(id)
          await this.store.remove(id)
          // The CLI's own copy is the conversation; leaving it behind would
          // make a deleted session reappear on the next refresh.
          if (session.claudeSessionId !== undefined) {
            try {
              await deleteNativeSession(session.claudeSessionId, { cwd: session.cwd })
            } catch (error) {
              this.ctx.logger?.warn?.(`dsh-cc: could not delete native session ${session.claudeSessionId}: ${String(error)}`)
            }
          }
          await this.catalog.refresh()
          this.broadcastSessions()
          return json(res, { ok: true })
        }
        if (parts.length === 3 && parts[2] === 'name' && method === 'PUT') {
          const session = this.store.get(id) ?? await this.catalog.adopt(id)
          if (!session) return json(res, { error: '会话不存在' }, 404)
          const body = await readJson(req)
          const name = typeof body?.name === 'string' ? body.name.trim() : ''
          if (name.length === 0 || name.length > 80) {
            return json(res, { error: '名称需为 1-80 个字符' }, 400)
          }
          await this.patchMeta(id, { name })
          // Title the CLI's record too, so `claude --resume` lists the same name.
          if (session.claudeSessionId !== undefined) {
            try {
              await renameNativeSession(session.claudeSessionId, name, { cwd: session.cwd })
            } catch (error) {
              this.ctx.logger?.warn?.(`dsh-cc: could not retitle native session ${session.claudeSessionId}: ${String(error)}`)
            }
          }
          return json(res, { ok: true, name })
        }
        if (parts.length === 3 && parts[2] === 'env' && method === 'PUT') {
          const session = this.store.get(id)
          if (!session) return json(res, { error: '会话不存在' }, 404)
          const body = await readJson(req)
          const env: Record<string, string> = {}
          if (typeof body?.env === 'object' && body.env !== null) {
            for (const [key, value] of Object.entries(body.env as Record<string, unknown>)) {
              if (typeof value !== 'string') continue
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
              env[key] = value
            }
          }
          await this.patchMeta(id, { env: Object.keys(env).length > 0 ? env : undefined })
          // Environment is spawn-time: recycle the idle engine so the next
          // message spawns with the new layer. A busy turn finishes first.
          const engine = this.engines.get(id)
          if (engine !== undefined && !engine.busy) await this.closeEngine(id)
          return json(res, { ok: true })
        }
        if (parts.length === 3 && parts[2] === 'messages' && method === 'POST') {
          return await this.sendMessage(id, req, res)
        }
        if (parts.length === 3 && parts[2] === 'context' && method === 'GET') {
          const session = this.store.get(id)
          if (!session) return json(res, { error: '会话不存在' }, 404)
          const engine = this.engines.get(id)
          if (engine === undefined || engine.isClosed) return json(res, { available: false })
          const context = await engine.getContextUsage()
          if (context === undefined) return json(res, { available: false })
          return json(res, { available: true, context })
        }
        if (parts.length === 3 && parts[2] === 'models' && method === 'GET') {
          const session = this.store.get(id)
          if (!session) return json(res, { error: '会话不存在' }, 404)
          const engine = this.engines.get(id)
          const current = session.model !== '' ? session.model : this.effectiveConfig().model
          if (engine === undefined || engine.isClosed) {
            // Cold session: no live catalog yet; static aliases still switch.
            return json(res, {
              available: false,
              models: withEffortDefaults(STATIC_MODEL_FALLBACK),
              current: current === '' ? 'default' : current,
              effort: this.effort,
            })
          }
          const models = await engine.supportedModels()
          return json(res, {
            available: models !== undefined,
            models: withEffortDefaults(models ?? STATIC_MODEL_FALLBACK),
            current: current === '' ? 'default' : current,
            effort: this.effort,
          })
        }
        if (parts.length === 3 && parts[2] === 'model' && method === 'POST') {
          const session = this.store.get(id)
          if (!session) return json(res, { error: '会话不存在' }, 404)
          const body = await readJson(req)
          const raw = typeof body?.model === 'string' ? body.model.trim() : ''
          const model = raw === '' || raw === 'default' ? '' : raw
          // The chosen model becomes THIS session's default (persists across
          // restarts); busy processes also hot-switch in place.
          await this.patchMeta(id, { model })
          const engine = this.engines.get(id)
          if (engine !== undefined && engine.busy) {
            // Detached on purpose — the next turn already uses the persisted
            // model, so the hot-switch is a courtesy to the running turn. It
            // still needs its own catch: an unhandled rejection here would
            // take down the host process.
            engine.setModel(model === '' ? undefined : model).catch((error: unknown) => {
              this.ctx.logger?.warn?.(`dsh-cc: live model switch failed for ${id}: ${String(error)}`)
            })
          }
          return json(res, { ok: true, model })
        }
        if (parts.length === 3 && parts[2] === 'effort' && method === 'POST') {
          const session = this.store.get(id)
          if (!session) return json(res, { error: '会话不存在' }, 404)
          const body = await readJson(req)
          const level = typeof body?.effort === 'string' ? body.effort : ''
          if (level !== '' && !['low', 'medium', 'high', 'xhigh', 'max'].includes(level)) {
            return json(res, { error: '无效的思考档位' }, 400)
          }
          this.effort = level === '' ? undefined : level as 'low' | 'medium' | 'high' | 'xhigh' | 'max'
          for (const [engineId, engine] of [...this.engines]) {
            if (engine.busy) {
              // Same reasoning as the live model switch: detached, but caught,
              // so a refusing CLI cannot fault the host process.
              engine.setEffort(this.effort).catch((error: unknown) => {
                this.ctx.logger?.warn?.(`dsh-cc: live effort switch failed for ${engineId}: ${String(error)}`)
              })
            } else await this.closeEngine(engineId)
          }
          return json(res, { ok: true, effort: this.effort ?? '' })
        }
        if (parts.length === 3 && parts[2] === 'usage' && method === 'GET') {
          const session = this.store.get(id)
          if (!session) return json(res, { error: '会话不存在' }, 404)
          const engine = this.engines.get(id)
          if (engine === undefined || engine.isClosed) {
            return json(res, { available: false, reason: '当前没有活跃的 Claude 进程；发送一条消息后即可查询' })
          }
          const usage = await engine.getUsage()
          if (usage === undefined) return json(res, { available: false, reason: '查询失败或该账户类型无额度数据' })
          return json(res, { available: true, usage })
        }
        if (parts.length === 3 && parts[2] === 'commands' && method === 'GET') {
          const engine = this.engines.get(id)
          if (engine === undefined || engine.isClosed) {
            return json(res, { available: false, commands: [] })
          }
          const commands = await engine.supportedCommands()
          if (commands === undefined) return json(res, { available: false, commands: [] })
          return json(res, { available: true, commands })
        }
        if (parts.length === 3 && parts[2] === 'stop' && method === 'POST') {
          const engine = this.engines.get(id)
          if (!engine) return json(res, { error: '会话没有正在运行的进程' }, 404)
          await engine.interrupt()
          return json(res, { ok: true })
        }
        if (parts.length === 4 && parts[2] === 'dialogs' && method === 'POST') {
          const session = this.store.get(id)
          if (!session) return json(res, { error: '会话不存在' }, 404)
          const engine = this.engines.get(id)
          const body = await readJson(req)
          const answers = body === undefined || body.cancel === true ? undefined : body?.answers
          const decided = engine?.answerDialog(parts[3] ?? '', answers)
          if (!decided) return json(res, { error: '问题不存在或已处理' }, 404)
          this.broadcast({ t: 'dialog-done', sessionId: id, requestId: parts[3] ?? '' })
          return json(res, { ok: true })
        }
        if (parts.length === 4 && parts[2] === 'permissions' && method === 'POST') {
          return await this.answerPermission(id, parts[3] ?? '', req, res)
        }
      }
      return json(res, { error: 'not found' }, 404)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger?.warn?.(new Error(`dsh-cc: ${url.pathname}: ${message}`))
      return json(res, { error: message }, 500)
    }
  }

  /** Close every engine and SSE client; the route disposer calls this. */
  async dispose(): Promise<void> {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    if (this.rescan !== undefined) clearInterval(this.rescan)
    for (const id of [...this.engines.keys()]) await this.closeEngine(id)
    for (const res of this.clients) {
      try {
        res.end()
      } catch {
        // The browser already went away; the socket cleanup is best effort.
      }
    }
    this.clients.clear()
  }

  private async sendMessage(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const session = this.store.get(id) ?? await this.catalog.adopt(id)
    if (!session) return json(res, { error: '会话不存在' }, 404)
    const body = await readJson(req)
    const text = typeof body?.text === 'string' ? body.text : ''
    const images = readImageRefs(body?.images)
    if (text.trim().length === 0 && images.length === 0) {
      return json(res, { error: '消息不能为空' }, 400)
    }
    // Resolve every reference before starting the turn: a message whose image
    // has been evicted must fail as a request, not half-send.
    const attachments: SendImage[] = []
    for (const image of images) {
      const bytes = await this.blobs.get(image.id, image.mediaType)
      if (bytes === undefined) return json(res, { error: '图片已失效，请重新粘贴' }, 409)
      attachments.push({ mediaType: image.mediaType, data: bytes.toString('base64') })
    }
    let engine = this.engines.get(id)
    const base = this.effectiveConfig()
    const merged = Object.keys(session.env ?? {}).length > 0
      ? { ...base, env: { ...base.env, ...session.env } }
      : base
    // Environment is spawn-time: an engine that outlived a session-env edit
    // (the save happened mid-turn, when recycling a busy engine would have
    // killed the turn) must not serve the next message from the stale layer.
    if (engine !== undefined && !engine.isClosed && !engine.busy
      && JSON.stringify(engine.spawnEnv) !== JSON.stringify(merged.env)) {
      await this.closeEngine(id)
      engine = undefined
    }
    if (!engine || engine.isClosed) {
      engine = new SessionEngine(
        { sessionId: id, cwd: session.cwd, model: session.model, claudeSessionId: session.claudeSessionId },
        merged,
        this.hooks(id),
      )
      this.engines.set(id, engine)
      this.enforceLiveCap()
    }
    await this.emitEvent(id, { kind: 'user', text, ...(images.length > 0 ? { images } : {}) })
    await engine.send(text, attachments)
    // After send, never before: the engine creates its query lazily on the
    // first message, and an account can only be read from a live query.
    this.refreshAccount(engine)
    await this.patchMeta(id, { status: 'busy', lastError: undefined, messageCount: session.messageCount + 1 })
    return json(res, { ok: true }, 202)
  }

  private async answerPermission(
    id: string,
    requestId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const session = this.store.get(id)
    if (!session) return json(res, { error: '会话不存在' }, 404)
    const engine = this.engines.get(id)
    const body = await readJson(req)
    const behavior = body?.behavior === 'allow' ? 'allow' as const : 'deny' as const
    const message = typeof body?.message === 'string' ? body.message : undefined
    const remember = readDestination(body?.remember)
    const decided = engine?.answerPermission(requestId, {
      behavior,
      ...(message !== undefined ? { message } : {}),
      ...(remember !== undefined ? { remember } : {}),
    })
    if (!decided) return json(res, { error: '权限请求不存在或已处理' }, 404)
    this.broadcast({ t: 'permission-done', sessionId: id, requestId, behavior: decided })
    return json(res, { ok: true })
  }

  private hooks(sessionId: string): EngineHooks {
    return {
      emit: async input => {
        await this.emitEvent(sessionId, input)
      },
      updateMeta: async patch => {
        await this.patchMeta(sessionId, patch)
      },
      delta: delta => {
        // Fold first, then broadcast with the fold's sequence number: a page
        // that fetches the snapshot right after this frame can compare seqs
        // and keep whichever side is ahead.
        const seq = (this.liveSeqs.get(sessionId) ?? 0) + 1
        this.liveSeqs.set(sessionId, seq)
        const turn = reduceDelta(this.liveTurns.get(sessionId), delta)
        if (turn === undefined) this.liveTurns.delete(sessionId)
        else this.liveTurns.set(sessionId, turn)
        this.broadcast({ t: 'delta', sessionId, seq, delta })
      },
      permissionRequest: request => {
        this.broadcast({ t: 'permission', sessionId, request })
      },
      dialogRequest: request => {
        this.broadcast({ t: 'dialog', sessionId, request })
      },
      onEngineFailure: async error => {
        await this.recoverWithLastGoodModel(sessionId, error)
      },
    }
  }

  /**
   * Auto-recovery when a chosen model cannot serve the session: fall back to
   * the last model that completed a turn and replay the failed message once,
   * so a bad model choice never leaves the conversation unusable.
   * @param sessionId - the failing session.
   * @param error - the engine failure.
   */
  private async recoverWithLastGoodModel(sessionId: string, error: Error): Promise<void> {
    const session = this.store.get(sessionId)
    if (session === undefined) return
    const fallback = session.lastGoodModel
    if (fallback === undefined || fallback === '' || fallback === session.model) return
    // Find the last user message to replay.
    const events = await this.catalog.transcript(session, 40)
    const lastUser = [...events].reverse().find(event => event.kind === 'user')
    if (lastUser === undefined) return
    await this.patchMeta(sessionId, { model: fallback, lastError: undefined, status: 'idle' })
    await this.emitEvent(sessionId, {
      kind: 'system',
      subtype: 'model-fallback',
      data: { from: session.model, to: fallback, reason: error.message },
    })
    this.ctx.logger?.warn?.(`dsh-cc: session ${sessionId} fell back to ${fallback}: ${error.message}`)
    // Replay through a fresh engine (the old one is dead).
    const engine = new SessionEngine(
      { sessionId, cwd: session.cwd, model: fallback, claudeSessionId: session.claudeSessionId },
      this.effectiveConfig(),
      this.hooks(sessionId),
    )
    this.engines.set(sessionId, engine)
    await engine.send(lastUser.text)
    this.refreshAccount(engine)
    await this.patchMeta(sessionId, { status: 'busy' })
    this.broadcastSessions()
  }

  private async emitEvent(sessionId: string, input: CcEventInput): Promise<void> {
    // The turn's own end commits its content, so the folded live turn dies
    // with it; keeping it would ghost-render beside the committed transcript.
    if (input.kind === 'result' || input.kind === 'error') this.liveTurns.delete(sessionId)
    const event = { ...input, seq: this.store.nextSeq(sessionId), ts: new Date().toISOString() } as CcEvent
    if (SessionCatalog.persists(this.store.get(sessionId), event)) {
      await this.store.append(sessionId, event)
    }
    this.broadcast({ t: 'event', sessionId, event })
  }

  /**
   * The reconcile-ready view of one session's in-flight turn: the fold plus
   * the delta counter it was taken at.
   * @param sessionId - the session to snapshot.
   * @returns the snapshot; seq 0 and a null turn when nothing ever streamed.
   */
  private liveSnapshot(sessionId: string): LiveTurnSnapshot {
    return { seq: this.liveSeqs.get(sessionId) ?? 0, turn: this.liveTurns.get(sessionId) ?? null }
  }

  private async patchMeta(sessionId: string, patch: Parameters<SessionStore['update']>[1]): Promise<void> {
    const meta = await this.store.update(sessionId, patch)
    if (meta) this.broadcastSessions()
  }

  private broadcastSessions(): void {
    this.broadcast({ t: 'sessions', sessions: this.catalog.list() })
  }

  private broadcast(message: WireMessage): void {
    const payload = `data: ${JSON.stringify(message)}\n\n`
    for (const res of this.clients) {
      try {
        res.write(payload)
      } catch {
        this.clients.delete(res)
      }
    }
  }

  private sse(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    this.write(res, { t: 'hello', config: this.configSummary() })
    this.write(res, { t: 'sessions', sessions: this.store.list() })
    this.clients.add(res)
    const remove = (): void => {
      this.clients.delete(res)
    }
    req.on('close', remove)
    req.on('error', remove)
    res.on('close', remove)
  }

  private write(res: ServerResponse, message: WireMessage): void {
    res.write(`data: ${JSON.stringify(message)}\n\n`)
  }

  private configSummary(): ConfigSummary {
    const effective = this.effectiveConfig()
    return {
      dataDir: this.baseConfig.dataDir,
      defaultCwd: this.baseConfig.cwd,
      model: effective.model,
      permissionMode: effective.permissionMode,
      env: effectiveEnvEntries(this.baseConfig.env, this.settings.env),
      liveSessions: this.engines.size,
      sdkVersion: this.sdkVersion,
      ...(this.account !== undefined ? { account: this.account } : {}),
    }
  }

  /**
   * Ask a freshly started engine which account it authenticated as, and
   * republish the config when the answer differs from the cached one. Runs
   * detached: the account readout is informational, and a CLI that cannot
   * answer must not delay the turn that started it.
   * @param engine - the engine to interrogate.
   */
  private refreshAccount(engine: SessionEngine): void {
    void engine.accountInfo().then(account => {
      if (account === undefined) return
      if (JSON.stringify(account) === JSON.stringify(this.account)) return
      this.account = account
      this.broadcast({ t: 'hello', config: this.configSummary() })
    })
  }

  /** Close idle engines beyond the live cap, oldest use first. */
  private enforceLiveCap(): void {
    const idle = [...this.engines.entries()]
      .filter(([, engine]) => !engine.busy)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    let overflow = this.engines.size - this.baseConfig.maxLiveSessions
    for (const [id] of idle) {
      if (overflow <= 0) break
      void this.closeEngine(id)
      overflow -= 1
    }
  }

  private async closeEngine(id: string): Promise<void> {
    const engine = this.engines.get(id)
    if (!engine) return
    this.engines.delete(id)
    // A closed engine can still be mid-turn (recycling, disposal); its fold
    // would never be cleared by a result event, so it dies with the engine.
    this.liveTurns.delete(id)
    await engine.close()
  }
}

/** Write one JSON response. */
function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * Read one raw request body with a size cap.
 * @param req - the request to drain.
 * @param limit - maximum bytes to accept.
 * @returns the body bytes.
 */
async function readBytes(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/** Read and parse one JSON request body with a size cap. */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim().length === 0) return undefined
  return JSON.parse(raw) as Record<string, unknown>
}

/**
 * Environment variables Claude Code itself reads, matched by the families its
 * own documentation defines rather than by an enumerated list, so a variable
 * the CLI gains later is still reported. Used only to decide what is worth
 * showing on the settings page; it never filters what the CLI is given.
 */
const CLI_ENV_KEY = /^(ANTHROPIC_|CLAUDE_CODE_|API_TIMEOUT_MS$|(HTTPS?|NO)_PROXY$)/i

/**
 * Variables a parent Claude Code process injects into the processes it spawns.
 * They match {@link CLI_ENV_KEY} but are handoff plumbing, not configuration
 * anyone set — and two of them carry a live credential and IPC path of the
 * parent session, which must not be rendered onto a settings page.
 */
const CLI_ENV_INJECTED = /^CLAUDE_CODE_(SESSION_ID|CHILD_SESSION|ENTRYPOINT|EXECPATH|MESSAGING_.*)$/

/**
 * Narrow the page-supplied image list. The page is an untrusted wire peer and
 * these ids select files to read, so an entry that is not a well-formed
 * reference is dropped rather than reaching the blob store.
 * @param value - the raw `images` field from the request body.
 * @returns the valid references, in order.
 */
function readImageRefs(value: unknown): ImageRef[] {
  if (!Array.isArray(value)) return []
  const refs: ImageRef[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const { id, mediaType, name, bytes } = entry as Record<string, unknown>
    if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) continue
    if (typeof mediaType !== 'string' || !isImageMediaType(mediaType)) continue
    refs.push({
      id,
      mediaType,
      ...(typeof name === 'string' ? { name } : {}),
      bytes: typeof bytes === 'number' ? bytes : 0,
    })
  }
  return refs
}

/** Blob URL extensions, the inverse of the blob store's own extension table. */
const BLOB_EXTENSION_TYPES: Record<string, ImageRef['mediaType'] | undefined> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** Rule destinations the CLI accepts; anything else from the page is dropped. */
const PERMISSION_DESTINATIONS: readonly PermissionDestination[] = [
  'userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg',
]

/**
 * Narrow one page-supplied rule destination. The page is an untrusted wire
 * peer, and an unrecognised destination would make the CLI reject the whole
 * permission response, so an invalid value degrades to a one-shot decision
 * rather than failing the tool call.
 * @param value - the raw `remember` field from the request body.
 * @returns the destination when valid, else undefined.
 */
function readDestination(value: unknown): PermissionDestination | undefined {
  return PERMISSION_DESTINATIONS.find(destination => destination === value)
}

/** Default settings: every field empty, so the cordis config stays authoritative. */
const EMPTY_SETTINGS: CcSettings = { model: '', permissionMode: '', env: {} }

/**
 * Load the page-editable settings file from the data directory.
 * @param dataDir - session store directory.
 * @returns the persisted settings, or empties when absent or unreadable.
 */
function loadSettings(dataDir: string): CcSettings {
  try {
    const file = join(dataDir, 'settings.json')
    if (!existsSync(file)) return { ...EMPTY_SETTINGS, env: {} }
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<CcSettings>
    const env: Record<string, string> = {}
    if (typeof raw.env === 'object' && raw.env !== null) {
      for (const [key, value] of Object.entries(raw.env)) {
        if (typeof value === 'string') env[key] = value
      }
    }
    return {
      model: typeof raw.model === 'string' ? raw.model : '',
      permissionMode: typeof raw.permissionMode === 'string' ? raw.permissionMode : '',
      env,
    }
  } catch {
    return { ...EMPTY_SETTINGS, env: {} }
  }
}

/**
 * Persist the page-editable settings file.
 * @param dataDir - session store directory.
 * @param settings - the complete settings value.
 */
function persistSettings(dataDir: string, settings: CcSettings): void {
  try {
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8')
  } catch (error) {
    // Settings are a convenience layer; the cordis config still boots without them.
    console.warn('dsh-cc: failed to persist settings', error)
  }
}

/**
 * Read one directory page for the picker; an undefined path lists drive roots.
 * @param pathname - the requested directory, or undefined for the root level.
 * @returns the listing.
 */
async function readDirListing(pathname: string | undefined): Promise<DirListing> {
  if (pathname === undefined || pathname.trim() === '') {
    const roots: string[] = []
    if (process.platform === 'win32') {
      for (let code = 65; code <= 90; code++) {
        const drive = `${String.fromCharCode(code)}:\\`
        if (existsSync(drive)) roots.push(drive)
      }
    } else {
      roots.push('/')
    }
    return { path: '', parent: null, entries: roots.map(root => ({ name: root, directory: true })) }
  }
  const dir = resolve(pathname.trim())
  const dirents = await readdir(dir, { withFileTypes: true })
  const entries = dirents
    .filter(dirent => dirent.isDirectory() || dirent.isFile())
    .map(dirent => ({ name: dirent.name, directory: dirent.isDirectory() }))
    .sort((left, right) =>
      left.directory === right.directory
        ? left.name.localeCompare(right.name)
        : left.directory ? -1 : 1)
  const parent = dirname(dir) !== dir ? dirname(dir) : null
  return { path: dir, parent, entries }
}

/** The pinned Agent SDK version, read from the installed package for diagnostics. */
function readSdkVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    // The SDK exports map hides ./package.json, so resolve its entry and walk
    // up to the owning manifest.
    let dir = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'))
    for (;;) {
      const manifestPath = join(dir, 'package.json')
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string; version?: string }
        if (manifest.name === '@anthropic-ai/claude-agent-sdk') return manifest.version ?? ''
      }
      const parent = dirname(dir)
      if (parent === dir) return ''
      dir = parent
    }
  } catch {
    return ''
  }
}

/** Keys whose values are credentials; the page only ever sees them masked. */
const SECRET_KEY = /(TOKEN|KEY|SECRET|PASSWORD|COOKIE)$/i

/**
 * Project the environment layered onto the claude process, recording which
 * layer supplied each winning value so the page can show where a setting
 * actually comes from. Secret values are masked here — the raw value never
 * leaves the host.
 * @param plugin - the cordis plugin config env.
 * @param settings - the page-editable settings env, which replaces it when non-empty.
 * @returns one entry per variable, sorted by key.
 */
function effectiveEnvEntries(
  plugin: Record<string, string>,
  settings: Record<string, string>,
): EffectiveEnvEntry[] {
  const winner = new Map<string, { value: string; layer: ConfigLayer }>()
  // The CLI is spawned with this process's environment, so a variable set in
  // the shell that launched dsh reaches Claude Code even though no dsh-cc
  // layer mentions it. Reporting it is what makes "which endpoint am I
  // actually talking to" answerable from the page.
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (!CLI_ENV_KEY.test(key) || CLI_ENV_INJECTED.test(key)) continue
    winner.set(key, { value, layer: 'process' })
  }
  // Settings replace the plugin's env map wholesale rather than merging into
  // it (see effectiveConfig), so a non-empty settings layer retires every
  // plugin entry. The process layer survives either way: the CLI inherits it
  // from the spawn regardless of which dsh-cc layer wins.
  if (Object.keys(settings).length > 0) {
    for (const [key, value] of Object.entries(settings)) winner.set(key, { value, layer: 'settings' })
  } else {
    for (const [key, value] of Object.entries(plugin)) winner.set(key, { value, layer: 'plugin' })
  }
  return [...winner.entries()]
    .map(([key, { value, layer }]) => SECRET_KEY.test(key)
      ? { key, value: maskSecret(value), masked: true, layer }
      : { key, value, masked: false, layer })
    .sort((left, right) => left.key.localeCompare(right.key))
}

/**
 * Mask a credential down to a recognizable stub.
 * @param value - the raw secret.
 * @returns the masked form, e.g. `90cd…4e83`.
 */
function maskSecret(value: string): string {
  if (value.length <= 8) return '••••'
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}
