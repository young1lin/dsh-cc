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
import { SessionEngine, type EngineHooks } from './engine.ts'
import { SessionStore } from './store.ts'
import type {
  CcEvent, CcEventInput, CcSettings, ConfigLayer, ConfigSummary, DirListing, EffectiveEnvEntry, WireMessage,
} from './types.ts'

const MAX_BODY_BYTES = 1024 * 1024

/** Static model aliases shown before a live CLI catalog exists. */
const STATIC_MODEL_FALLBACK = [
  { value: 'default', displayName: 'Default (recommended)' },
  { value: 'sonnet', displayName: 'Sonnet' },
  { value: 'opus', displayName: 'Opus' },
  { value: 'haiku', displayName: 'Haiku' },
]

/**
 * The dsh-cc host runtime. One instance per mounted plugin; disposal closes
 * every live engine and SSE client.
 */
export class CcRuntime {
  readonly store: SessionStore
  private readonly engines = new Map<string, SessionEngine>()
  private readonly clients = new Set<ServerResponse>()
  private readonly sdkVersion: string
  private heartbeat: ReturnType<typeof setInterval> | undefined
  /** Page-editable overrides layered over the cordis config. */
  private settings: CcSettings
  /** Live-chosen reasoning effort; undefined keeps each model's default. */
  private effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined

  constructor(
    private readonly ctx: Context,
    private readonly baseConfig: ResolvedConfig,
  ) {
    this.store = new SessionStore(baseConfig.dataDir)
    this.store.load()
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
      if (parts[0] === 'config' && parts.length === 1 && method === 'GET') return json(res, this.configSummary())
      if (parts[0] === 'settings' && parts.length === 1 && method === 'GET') return json(res, { settings: this.settings })
      if (parts[0] === 'settings' && parts.length === 1 && method === 'PUT') {
        return await this.saveSettings(req, res)
      }
      if (parts[0] === 'fs' && parts[1] === 'list' && parts.length === 2 && method === 'GET') {
        return await this.listDir(url.searchParams.get('path') ?? undefined, res)
      }
      if (parts[0] === 'sessions') {
        if (parts.length === 1 && method === 'GET') return json(res, { sessions: this.store.list() })
        if (parts.length === 1 && method === 'POST') {
          const body = await readJson(req)
          const session = await this.store.create(body ?? {}, { cwd: this.effectiveConfig().cwd })
          this.broadcastSessions()
          return json(res, { session })
        }
        const id = parts[1] ?? ''
        if (parts.length === 2 && method === 'GET') {
          const session = this.store.get(id)
          if (!session) return json(res, { error: '会话不存在' }, 404)
          return json(res, { session, events: await this.store.transcript(id) })
        }
        if (parts.length === 2 && method === 'DELETE') {
          await this.closeEngine(id)
          const removed = await this.store.remove(id)
          if (!removed) return json(res, { error: '会话不存在' }, 404)
          this.broadcastSessions()
          return json(res, { ok: true })
        }
        if (parts.length === 3 && parts[2] === 'name' && method === 'PUT') {
          const session = this.store.get(id)
          if (!session) return json(res, { error: '会话不存在' }, 404)
          const body = await readJson(req)
          const name = typeof body?.name === 'string' ? body.name.trim() : ''
          if (name.length === 0 || name.length > 80) {
            return json(res, { error: '名称需为 1-80 个字符' }, 400)
          }
          await this.patchMeta(id, { name })
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
              models: STATIC_MODEL_FALLBACK,
              current: current === '' ? 'default' : current,
              effort: this.effort,
            })
          }
          const models = await engine.supportedModels()
          return json(res, {
            available: models !== undefined,
            models: models ?? STATIC_MODEL_FALLBACK,
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
          if (engine !== undefined && engine.busy) void engine.setModel(model === '' ? undefined : model)
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
            if (engine.busy) void engine.setEffort(this.effort)
            else await this.closeEngine(engineId)
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
    const session = this.store.get(id)
    if (!session) return json(res, { error: '会话不存在' }, 404)
    const body = await readJson(req)
    const text = typeof body?.text === 'string' ? body.text : ''
    if (text.trim().length === 0) return json(res, { error: '消息不能为空' }, 400)
    let engine = this.engines.get(id)
    if (!engine || engine.isClosed) {
      const base = this.effectiveConfig()
      const merged = Object.keys(session.env ?? {}).length > 0
        ? { ...base, env: { ...base.env, ...session.env } }
        : base
      engine = new SessionEngine(
        { sessionId: id, cwd: session.cwd, model: session.model, claudeSessionId: session.claudeSessionId },
        merged,
        this.hooks(id),
      )
      this.engines.set(id, engine)
      this.enforceLiveCap()
    }
    await this.emitEvent(id, { kind: 'user', text })
    await engine.send(text)
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
    const decided = engine?.answerPermission(requestId, behavior, message)
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
    const events = await this.store.transcript(sessionId, 40)
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
    await this.patchMeta(sessionId, { status: 'busy' })
    this.broadcastSessions()
  }

  private async emitEvent(sessionId: string, input: CcEventInput): Promise<void> {
    const event = { ...input, seq: this.store.nextSeq(sessionId), ts: new Date().toISOString() } as CcEvent
    await this.store.append(sessionId, event)
    this.broadcast({ t: 'event', sessionId, event })
  }

  private async patchMeta(sessionId: string, patch: Parameters<SessionStore['update']>[1]): Promise<void> {
    const meta = await this.store.update(sessionId, patch)
    if (meta) this.broadcastSessions()
  }

  private broadcastSessions(): void {
    this.broadcast({ t: 'sessions', sessions: this.store.list() })
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
    }
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
    await engine.close()
  }
}

/** Write one JSON response. */
function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
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
  for (const [key, value] of Object.entries(plugin)) winner.set(key, { value, layer: 'plugin' })
  if (Object.keys(settings).length > 0) {
    winner.clear()
    for (const [key, value] of Object.entries(settings)) winner.set(key, { value, layer: 'settings' })
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
