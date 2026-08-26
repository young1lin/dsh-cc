/**
 * Host-side runtime: session store + live engines + the /cc/api HTTP surface
 * (REST for mutations, one SSE stream for all pushes). Registered as a single
 * prefix route on the dsh webserver.
 *
 * @module dsh-cc/runtime
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  applyConfigDir, CONFIG_DIR_ENV, normalizeAccounts, resolveAccountDir, restoreConfigDir, sameDir,
} from './accounts.ts'
import type { ResolvedConfig } from './config.ts'
import { SessionEngine, resolveSessionModel, resolveSessionPermissionMode, type EngineHooks, type SendImage } from './engine.ts'
import { BlobStore, isImageMediaType } from './blobs.ts'
import { SessionCatalog } from './catalog.ts'
import { fileIndexFor } from './file-index.ts'
import { effectiveEnvEntries, maskSecret, readDirListing, readSdkVersion, readTextFile } from './http-support.ts'
import { reduceDelta, type LiveTurn } from './live-turn.ts'
import { deleteNativeSession, renameNativeSession } from './native-sessions.ts'
import { SessionStore } from './store.ts'
import type {
  AccountSummary, CcAccount, CcEvent, CcEventInput, CcSettings, ConfigSummary, EffortLevel, EnvPreset,
  ImageRef, LiveTurnSnapshot, PermissionDestination, PermissionModeValue, SessionMeta, TaskRow, WireMessage,
} from './types.ts'
import {
  DEFAULT_EFFORT_LEVELS, MEDIA_TYPE_EXTENSIONS, PERMISSION_MODE_VALUES, PROVIDER_ENV_NAMES, TERMINAL_TASK_STATUSES,
} from './types.ts'

const MAX_BODY_BYTES = 1024 * 1024

/** Session id of the throwaway engine started only to read the model catalog. */
const CATALOG_PROBE_ID = 'dsh-cc:catalog-probe'

/** How long that probe is given before the catalog is reported unavailable. */
const CATALOG_PROBE_TIMEOUT_MS = 15_000

/**
 * How long a failed model-catalog probe suppresses further probes. The page
 * can ask for the catalog on every settings open; without a negative cache
 * each failed answer would spawn another throwaway CLI process, forever.
 */
const MODEL_PROBE_NEGATIVE_TTL_MS = 30_000

/**
 * Native-store rescan cadence while at least one page is attached: fast enough
 * that a turn driven from a terminal shows up on the rail as it happens.
 */
const RESCAN_ACTIVE_MS = 2_000

/**
 * Rescan cadence with no page attached.
 *
 * The sweep is not free — it enumerates every project directory in the CLI's
 * store, which on a well-used machine is thousands of transcript files, and
 * the result is only ever delivered over SSE. Running it at the active cadence
 * with nobody listening burned a measurable fraction of a core around the
 * clock. Nothing is lost by slowing down: a page that attaches forces its own
 * full refresh, and `GET /sessions` refreshes before answering.
 */
const RESCAN_IDLE_MS = 30_000

/**
 * Hooks for an engine started to read the control channel and nothing else.
 * It belongs to no session, so everything it would publish is dropped rather
 * than persisted against an id the store has never heard of.
 */
const SILENT_HOOKS: EngineHooks = {
  emit: async () => {},
  updateMeta: async () => {},
  delta: () => {},
  permissionRequest: () => {},
  dialogRequest: () => {},
  tasks: () => {},
  telemetry: () => {},
}

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
  /** The cadence {@link rescan} is currently armed at; 0 when it is not armed. */
  private rescanEveryMs = 0
  /** Page-editable overrides layered over the cordis config. */
  private settings: CcSettings
  /**
   * The account the CLI last reported. Only a live CLI can answer, so this is
   * cached from the first engine that resolves one and survives that engine's
   * close; a credential change is picked up by the next engine start.
   */
  private account: AccountSummary | undefined
  /**
   * The model catalog under the current configuration, cached because reading
   * it can cost a process start. Cleared whenever the settings that produced
   * it change.
   */
  private modelCatalog: readonly unknown[] | undefined
  /** The catalog probe currently running; concurrent requests share it. */
  private modelsInFlight: Promise<readonly unknown[] | undefined> | undefined
  /** When the last catalog probe failed; gates retries via a short negative TTL. */
  private modelsFailedAt = 0
  /**
   * Bumped on every account switch. Both CLI probes below run detached against
   * whichever root was active when they started, so each captures this and
   * refuses to publish an answer the switch has already invalidated — without
   * it a slow probe writes the previous account's identity or model list onto
   * the new one.
   */
  private configGeneration = 0

  constructor(
    private readonly ctx: Context,
    private readonly baseConfig: ResolvedConfig,
  ) {
    this.store = new SessionStore(baseConfig.dataDir)
    this.store.load()
    this.blobs = new BlobStore(baseConfig.dataDir)
    // Settings hold the account selection, so they must be read before
    // anything resolves a root — and the root must be on this process before
    // the first catalog sweep, since the SDK reads it from the environment.
    this.settings = loadSettings(baseConfig.dataDir)
    applyConfigDir(this.activeConfigDir())
    this.catalog = new SessionCatalog(
      this.store,
      this.blobs,
      id => this.drivesNative(id),
      () => this.activeConfigDir(),
    )
    // The CLI store is read from disk, so the first list is served from the
    // sidecar alone and the broadcast that follows fills in the rest.
    void this.catalog.refresh().then(() => this.broadcastSessions())
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
    this.armRescan()
  }

  /**
   * (Re)arm the native-store rescan at the cadence the current audience earns.
   *
   * A session driven from a terminal CLI writes its transcript with no engine
   * of ours involved, so rescanning is what keeps the rail — statuses included
   * — in step with it. But the result only ever leaves over SSE, so the fast
   * cadence is worth paying for exactly while somebody is attached to receive
   * it. Idempotent: called on every client add and remove, and does nothing
   * unless the cadence actually has to change.
   */
  private armRescan(): void {
    const wanted = this.clients.size > 0 ? RESCAN_ACTIVE_MS : RESCAN_IDLE_MS
    if (this.rescan !== undefined && this.rescanEveryMs === wanted) return
    if (this.rescan !== undefined) clearInterval(this.rescan)
    this.rescanEveryMs = wanted
    this.rescan = setInterval(() => {
      void this.catalog.refresh().then(changed => {
        if (changed) this.broadcastSessions()
      })
    }, wanted)
  }

  /**
   * The cordis config with page-editable settings layered on top: a non-empty
   * settings field replaces its base counterpart, an empty one keeps the base.
   *
   * `env` layers per key rather than wholesale. Replacing the whole map made
   * one unrelated page edit — a proxy, a timeout — silently retire every
   * variable the cordis config supplied, endpoint and credential included,
   * with nothing on screen naming what had just been dropped.
   */
  private effectiveConfig(): ResolvedConfig {
    const overrides = this.settings
    const configDir = this.activeConfigDir()
    const base = {
      ...this.baseConfig,
      configDir,
      model: overrides.model !== '' ? overrides.model : this.baseConfig.model,
      permissionMode: overrides.permissionMode !== ''
        ? overrides.permissionMode as ResolvedConfig['permissionMode']
        : this.baseConfig.permissionMode,
    }
    const preset = overrides.presets.find(candidate => candidate.id === overrides.activePresetId)
    if (preset === undefined) {
      return {
        ...base,
        // The account root rides in the env layer rather than being poked into
        // the spawn separately, so the engine's spawn-time env comparison sees an
        // account switch as the environment change it is and recycles the idle
        // engines still pointed at the old home. It is last because no other
        // layer may supply this key: both env editors reject it.
        env: { ...this.baseConfig.env, ...overrides.env, [CONFIG_DIR_ENV]: configDir },
      }
    }
    // A preset owns the provider key scope outright. Within it, the preset is
    // the whole truth: its keys replace the cordis and page layers, and a key
    // it omits is REMOVED — from those layers and from the environment dsh
    // itself inherited, which per-key layering can override but never delete.
    // That removal is what makes 账号直连 possible on a machine whose shell
    // exports a gateway's credentials to every process it spawns.
    const providerScope = new Set(PROVIDER_ENV_NAMES.map(key => key.toUpperCase()))
    const isProviderKey = (key: string): boolean => providerScope.has(key.toUpperCase())
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(this.baseConfig.env)) {
      if (!isProviderKey(key)) env[key] = value
    }
    for (const [key, value] of Object.entries(overrides.env)) {
      if (!isProviderKey(key)) env[key] = value
    }
    for (const [key, value] of Object.entries(preset.env)) {
      if (value !== '') env[key] = value
    }
    const envDeletes = PROVIDER_ENV_NAMES.filter(key => preset.env[key] === undefined || preset.env[key] === '')
    return {
      ...base,
      env: { ...env, [CONFIG_DIR_ENV]: configDir },
      envDeletes,
    }
  }

  /**
   * The Claude Code home in force: the selected account's directory, else the
   * cordis config's, else whatever dsh was launched with.
   * @returns the absolute account root.
   */
  private activeConfigDir(): string {
    return resolveAccountDir(this.settings.accounts, this.settings.activeAccountId, this.baseConfig.configDir)
  }

  /**
   * The effective config with one session's own layers folded in: its env
   * map, and its reasoning-effort override.
   *
   * Both are spawn-time, so every path that starts a process for a session —
   * a submitted message, a fallback replay — has to resolve them the same
   * way, or a session pinned to its own gateway (or effort) silently runs
   * against the global one.
   * @param session - the session about to get a process.
   * @returns the config that process is spawned with.
   */
  private configFor(session: SessionMeta): ResolvedConfig {
    const base = this.effectiveConfig()
    const effort = this.effortFor(session)
    const layered = Object.keys(session.env ?? {}).length > 0
    const env = layered
      // The account root is re-asserted after the session layer: a row
      // persisted before accounts existed may still carry the key, and honoring
      // it would spawn against a home the catalog is not reading.
      ? { ...base.env, ...session.env, [CONFIG_DIR_ENV]: base.configDir }
      : base.env
    // A session override that re-adds a key a preset removed is deliberate:
    // the session layer outranks the preset, so the deletion must not strip
    // it back off at spawn.
    const envDeletes = layered
      ? base.envDeletes?.filter(key => session.env?.[key] === undefined)
      : base.envDeletes
    return {
      ...base,
      env,
      ...(envDeletes !== undefined ? { envDeletes } : {}),
      permissionMode: this.permissionModeFor(session),
      ...(effort !== undefined ? { effort } : {}),
    }
  }

  /**
   * The effort a session's next engine spawns with: the session's own
   * override when it names one, else the resolved config default.
   * @param session - the session being resolved.
   * @returns the effort level, or undefined to keep the CLI default.
   */
  private effortFor(session: SessionMeta): EffortLevel | undefined {
    if (session.effort !== undefined && session.effort !== '') return session.effort
    return this.effectiveConfig().effort
  }

  /**
   * The posture a session's next engine spawns with: the session's own
   * override when it names one, else the resolved config default.
   * @param session - the session being resolved.
   * @returns the posture.
   */
  private permissionModeFor(session: SessionMeta): PermissionModeValue {
    return resolveSessionPermissionMode(session.permissionMode ?? '', this.effectiveConfig().permissionMode)
  }

  /**
   * The model catalog as the CLI resolves it under the current configuration:
   * a gateway's own aliases and whatever `ANTHROPIC_MODEL` names, rather than
   * a list hardcoded here that cannot know either.
   *
   * A live session answers for free. With none running, a throwaway process is
   * started purely to ask — `supportedModels()` is served out of the CLI's own
   * resolved config, so it makes no API call, writes no transcript, and
   * unlinks its process-registry entry on close.
   * @returns the catalog, or undefined when no CLI could answer.
   */
  private async globalModels(): Promise<readonly unknown[] | undefined> {
    if (this.modelCatalog !== undefined) return this.modelCatalog
    if (this.modelsInFlight !== undefined) return await this.modelsInFlight
    if (Date.now() - this.modelsFailedAt < MODEL_PROBE_NEGATIVE_TTL_MS) return undefined
    const run = this.probeModels().finally(() => {
      this.modelsInFlight = undefined
    })
    this.modelsInFlight = run
    const models = await run
    if (models === undefined) this.modelsFailedAt = Date.now()
    return models
  }

  /**
   * One model-catalog attempt: a live engine answers for free, else a
   * throwaway process is started purely to ask. Never rejects — a probe
   * failure reports as an absent catalog, not as a faulting request.
   * @returns the catalog, or undefined when nothing could answer.
   */
  private async probeModels(): Promise<readonly unknown[] | undefined> {
    const generation = this.configGeneration
    for (const engine of this.engines.values()) {
      if (engine.isClosed || engine.isDead) continue
      const live = await engine.supportedModels()
      if (live !== undefined) {
        if (generation === this.configGeneration) this.modelCatalog = live
        return live
      }
    }
    const probe = new SessionEngine(
      { sessionId: CATALOG_PROBE_ID, cwd: this.baseConfig.cwd, model: '', permissionMode: '' },
      this.effectiveConfig(),
      SILENT_HOOKS,
    )
    try {
      probe.warmUp()
      // A CLI that never answers must not hold the settings dialog open.
      const models = await Promise.race([
        probe.supportedModels(),
        new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), CATALOG_PROBE_TIMEOUT_MS)),
      ])
      if (models !== undefined && generation === this.configGeneration) this.modelCatalog = models
      return models
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-cc: could not read the model catalog: ${String(error)}`)
      return undefined
    } finally {
      await probe.close().catch(() => {})
    }
  }

  /**
   * Whether one of this runtime's own engines currently holds a native session
   * open. Our engines register in the CLI's live-process registry exactly as a
   * terminal `claude` does, so this is the only thing separating "a terminal
   * is driving it" from "this page is driving it".
   * @param claudeSessionId - the native session id to test.
   * @returns true when a live engine of ours is attached to it.
   */
  private drivesNative(claudeSessionId: string): boolean {
    for (const engine of this.engines.values()) {
      if (!engine.isClosed && !engine.isDead && engine.claudeSessionId === claudeSessionId) return true
    }
    return false
  }

  private async saveSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req)
    if (body === undefined) return json(res, { error: '请求体不能为空' }, 400)
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    const permissionMode = typeof body.permissionMode === 'string' ? body.permissionMode : ''
    if (permissionMode !== '' && !['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions', 'auto'].includes(permissionMode)) {
      return json(res, { error: '无效的权限模式' }, 400)
    }
    const env: Record<string, string> = {}
    if (typeof body.env === 'object' && body.env !== null) {
      for (const [key, value] of Object.entries(body.env as Record<string, unknown>)) {
        if (typeof value !== 'string') continue
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
        if (key === CONFIG_DIR_ENV) {
          return json(res, { error: `${CONFIG_DIR_ENV} 请在「账号」里配置：写成环境变量只会改到 claude 进程，页面读取的会话目录不会跟着走。` }, 400)
        }
        env[key] = value
      }
    }
    const accounts = normalizeAccounts(body.accounts)
    // Presets are whole env bundles; a stray CLAUDE_CONFIG_DIR inside one
    // would move the spawned process without moving the plugin's reads —
    // the same fork the settings env refuses, named before any is saved.
    for (const item of Array.isArray(body.presets) ? body.presets : []) {
      if (typeof item === 'object' && item !== null && typeof (item as { env?: unknown }).env === 'object'
        && (item as { env: Record<string, unknown> }).env !== null
        && CONFIG_DIR_ENV in (item as { env: Record<string, unknown> }).env) {
        return json(res, { error: `预设里的 ${CONFIG_DIR_ENV} 请在「账号」里配置，环境变量层不接收它。` }, 400)
      }
    }
    const presets = normalizePresets(body.presets)
    const activePresetId = typeof body.activePresetId === 'string'
      && presets.some(preset => preset.id === body.activePresetId)
      ? body.activePresetId
      : ''
    // The list is editable here; which one is ACTIVE is not — that is its own
    // endpoint. But editing the list can still move the root out from under the
    // plugin: deleting the active account, or repointing its directory. That is
    // an account switch by another name, so it carries the same guarantees.
    const activeAccountId = accounts.some(account => account.id === this.settings.activeAccountId)
      ? this.settings.activeAccountId
      : ''
    const before = this.activeConfigDir()
    const after = resolveAccountDir(accounts, activeAccountId, this.baseConfig.configDir)
    const moved = !sameDir(before, after)
    if (moved) {
      const busy = [...this.engines.values()].filter(engine => engine.busy).length
      if (busy > 0) {
        return json(res, { error: `有 ${busy} 个会话正在运行，等它们结束再改动当前账号的目录。` }, 409)
      }
    }
    this.settings = { model, permissionMode, env, presets, activePresetId, accounts, activeAccountId }
    persistSettings(this.baseConfig.dataDir, this.settings)
    if (moved) {
      // Same cascade as an explicit switch: move the environment, then drop
      // every answer that came out of the root being left behind.
      this.configGeneration += 1
      applyConfigDir(after)
      this.account = undefined
      this.catalog.invalidate()
    }
    // The catalog is derived from the environment that just changed; a stale
    // negative cache must not suppress the re-probe the new settings deserve.
    this.modelCatalog = undefined
    this.modelsFailedAt = 0
    // Idle engines keep their spawn-time environment; recycle them so the
    // next message spawns with the new settings.
    for (const [id, engine] of [...this.engines]) {
      if (!engine.busy) await this.closeEngine(id)
    }
    await this.catalog.refresh()
    this.broadcast({ t: 'hello', config: this.configSummary() })
    this.broadcastSessions()
    return json(res, { ok: true, settings: this.settings })
  }

  /**
   * Switch the whole plugin to one account's Claude Code home.
   *
   * Everything the page shows about Claude Code is read out of that root —
   * the session list and their transcripts, the live-process registry behind
   * terminal ownership, the authenticated identity, the model catalog the
   * gateway reports, and the permission posture in the root's own
   * settings.json. So the switch is not a filter: it repoints the process,
   * drops every cached answer that came from the old root, and re-reads.
   *
   * Refused while any engine is busy. A running turn holds a CLI process
   * spawned against the old home, and there is no way to move it — nor to
   * interrupt it, which is the same cross-process limit the read-only terminal
   * sessions live under.
   * @param req - the request carrying `{ id }`; an empty id selects the host default.
   * @param res - the response to write.
   */
  private async switchAccount(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req)
    const id = typeof body?.id === 'string' ? body.id.trim() : ''
    if (id !== '' && !this.settings.accounts.some(account => account.id === id)) {
      return json(res, { error: '账号不存在' }, 404)
    }
    if (id === this.settings.activeAccountId) return json(res, { ok: true, activeAccountId: id })
    const busy = [...this.engines.entries()].filter(([, engine]) => engine.busy).map(([key]) => key)
    if (busy.length > 0) {
      return json(res, { error: `有 ${busy.length} 个会话正在运行，等它们结束再切换账号。` }, 409)
    }
    this.settings = { ...this.settings, activeAccountId: id }
    persistSettings(this.baseConfig.dataDir, this.settings)
    // Order matters: the environment must be moved before anything re-reads,
    // and the generation bumped before the detached probes can land.
    this.configGeneration += 1
    applyConfigDir(this.activeConfigDir())
    for (const key of [...this.engines.keys()]) await this.closeEngine(key)
    this.account = undefined
    this.modelCatalog = undefined
    this.modelsFailedAt = 0
    this.catalog.invalidate()
    await this.catalog.refresh()
    this.broadcast({ t: 'hello', config: this.configSummary() })
    this.broadcastSessions()
    return json(res, { ok: true, activeAccountId: id })
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
    // The loopback fence. This prefix reads the whole machine's filesystem
    // (file viewer, directory picker) and the CLI's stores, and nothing else
    // validates Host for prefix routes — so a page from any other origin
    // would reach it via DNS rebinding (attacker.com resolving to 127.0.0.1,
    // a same-origin GET that needs no CORS). Only loopback hostnames may
    // name us.
    const rawHost = req.headers.host ?? ''
    const host = (rawHost.startsWith('[') ? rawHost.slice(1, rawHost.indexOf(']')) : rawHost.split(':')[0]).toLowerCase()
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
      return json(res, { error: '拒绝非本机 Host 的请求' }, 403)
    }
    const parts = url.pathname.replace(/^\/cc\/api\/?/, '').split('/').filter(Boolean)
    const method = req.method ?? 'GET'
    try {
      if (parts[0] === 'events' && parts.length === 1 && method === 'GET') return this.sse(req, res)
      if (parts[0] === 'config' && parts.length === 1 && method === 'GET') {
        return json(res, { config: this.configSummary() })
      }
      if (parts[0] === 'models' && parts.length === 1 && method === 'GET') {
        const models = await this.globalModels()
        return json(res, {
          available: models !== undefined,
          models: withEffortDefaults(models ?? STATIC_MODEL_FALLBACK),
          current: this.settings.model,
        })
      }
      if (parts[0] === 'settings' && parts.length === 1 && method === 'GET') return json(res, { settings: this.settings })
      if (parts[0] === 'settings' && parts.length === 1 && method === 'PUT') {
        return await this.saveSettings(req, res)
      }
      if (parts[0] === 'accounts' && parts[1] === 'active' && parts.length === 2 && method === 'POST') {
        return await this.switchAccount(req, res)
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
      if (parts[0] === 'fs' && parts[1] === 'index' && parts.length === 2 && method === 'GET') {
        // The mention menu's project-wide index: one bounded walk under the
        // requested root (the session cwd), cached briefly host-side.
        const path = url.searchParams.get('path')
        if (path === null || path.trim() === '') return json(res, { error: '缺少 path 参数' }, 400)
        try {
          return json(res, { index: await fileIndexFor(resolve(path.trim())) })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return json(res, { error: `无法建立项目索引：${message}` }, 400)
        }
      }
      if (parts[0] === 'fs' && parts[1] === 'file' && parts.length === 2 && method === 'GET') {
        const path = url.searchParams.get('path')
        if (path === null || path.trim() === '') return json(res, { error: '缺少 path 参数' }, 400)
        try {
          return json(res, { file: await readTextFile(path) })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return json(res, { error: `无法读取文件：${message}` }, 404)
        }
      }
      if (parts[0] === 'sessions') {
        if (parts.length === 1 && method === 'GET') {
          await this.catalog.refresh()
          return json(res, { sessions: this.catalog.list() })
        }
        if (parts.length === 1 && method === 'POST') {
          const body = await readJson(req)
          const effective = this.effectiveConfig()
          const session = await this.store.create(body ?? {}, {
            cwd: effective.cwd,
            configDir: effective.configDir,
          })
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
            live: this.liveSnapshot(session.id),
            tasks: this.taskSnapshot(session.id),
          })
        }
        if (parts.length === 2 && method === 'DELETE') {
          // Dual-id addressing: the row may live under its page id while the
          // request names the native id (or vice versa); both must resolve to
          // the same row so a delete cannot leave one half of the session
          // behind — a surviving sidecar row would resurrect the session on
          // the next refresh, a surviving native copy on the next rescan.
          const sidecar = this.store.get(id) ?? this.store.findByClaudeId(id)
          const native = sidecar === undefined ? this.catalog.get(id) : undefined
          const row = sidecar ?? native
          if (row === undefined) {
            return json(res, { error: '会话不存在' }, 404)
          }
          const key = row.id
          const claudeSessionId = row.claudeSessionId
          // The send path's gate, for the same reason: a terminal claude is
          // appending to this very transcript, and deleting the file under it
          // would resurrect a truncated session on the next rescan (or fail
          // EPERM halfway, after the sidecar is already gone).
          if (this.catalog.terminalOwned(row.id)) {
            return json(res, { error: '该会话正由终端中的 Claude 进程使用，等它退出后再删除' }, 409)
          }
          // Stop our own writer first: it holds the very native file about to
          // be deleted open and would keep appending to it. Closing an engine
          // destroys nothing — the conversation resumes on the next send.
          await this.closeEngine(key)
          if (id !== key) await this.closeEngine(id)
          this.liveSeqs.delete(key)
          if (claudeSessionId !== undefined) {
            try {
              await deleteNativeSession(claudeSessionId, { cwd: row.cwd })
            } catch (error) {
              // A delete that cannot reach the CLI's store must fail whole:
              // swallowing it here and broadcasting the refreshed list would
              // walk the session right back onto the page.
              const message = error instanceof Error ? error.message : String(error)
              this.ctx.logger?.warn?.(`dsh-cc: could not delete native session ${claudeSessionId}: ${message}`)
              return json(res, { error: `无法删除 CLI 侧会话记录：${message}` }, 409)
            }
          }
          if (sidecar !== undefined) await this.store.remove(key)
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
          await this.patchMeta(session.id, { name })
          // Title the CLI's record too, so `claude --resume` lists the same
          // name — but never the record another process is appending to: the
          // page-side rename alone carries a terminal-owned row.
          if (session.claudeSessionId !== undefined && !this.catalog.terminalOwned(session.id)) {
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
              if (key === CONFIG_DIR_ENV) {
                return json(res, { error: `${CONFIG_DIR_ENV} 不能按会话覆盖：会话目录是整个插件级的账号选择。` }, 400)
              }
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
          const engine = this.liveEngine(session.id)
          if (engine === undefined) return json(res, { available: false })
          const context = await engine.getContextUsage()
          if (context === undefined) return json(res, { available: false })
          return json(res, { available: true, context })
        }
        if (parts.length === 3 && parts[2] === 'models' && method === 'GET') {
          const session = this.store.get(id)
          if (!session) return json(res, { error: '会话不存在' }, 404)
          const engine = this.liveEngine(session.id)
          const current = resolveSessionModel(session.model, this.effectiveConfig().model) ?? ''
          if (engine === undefined) {
            // Cold session: no live catalog yet; static aliases still switch.
            return json(res, {
              available: false,
              models: withEffortDefaults(STATIC_MODEL_FALLBACK),
              current: current === '' ? 'default' : current,
              effort: this.effortFor(session),
            })
          }
          const models = await engine.supportedModels()
          return json(res, {
            available: models !== undefined,
            models: withEffortDefaults(models ?? STATIC_MODEL_FALLBACK),
            current: current === '' ? 'default' : current,
            effort: this.effortFor(session),
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
          await this.patchMeta(session.id, { model })
          const engine = this.liveEngine(session.id)
          if (engine !== undefined && engine.busy) {
            // Detached on purpose — the next turn already uses the persisted
            // model, so the hot-switch is a courtesy to the running turn. It
            // still needs its own catch: an unhandled rejection here would
            // take down the host process.
            engine.setModel(model === '' ? undefined : model).catch((error: unknown) => {
              this.ctx.logger?.warn?.(`dsh-cc: live model switch failed for ${session.id}: ${String(error)}`)
            })
          }
          return json(res, { ok: true, model })
        }
        if (parts.length === 3 && parts[2] === 'effort' && method === 'POST') {
          const session = this.store.get(id) ?? await this.catalog.adopt(id)
          if (!session) return json(res, { error: '会话不存在' }, 404)
          const body = await readJson(req)
          const level = typeof body?.effort === 'string' ? body.effort : ''
          if (level !== '' && !(DEFAULT_EFFORT_LEVELS as readonly string[]).includes(level)) {
            return json(res, { error: '无效的思考档位' }, 400)
          }
          // Effort is a per-session fact: persisted to this session's meta
          // (the sessions frame carries it), never pushed onto other
          // sessions' engines.
          const effort = level === '' ? undefined : level as EffortLevel
          await this.patchMeta(session.id, { effort })
          const engine = this.liveEngine(session.id)
          if (engine !== undefined && engine.busy) {
            // Same reasoning as the live model switch: detached, but caught,
            // so a refusing CLI cannot fault the host process.
            engine.setEffort(effort).catch((error: unknown) => {
              this.ctx.logger?.warn?.(`dsh-cc: live effort switch failed for ${session.id}: ${String(error)}`)
            })
          } else if (engine !== undefined) {
            // Effort is spawn-time for a cold engine: recycle so the next
            // message starts a process with the new level.
            await this.closeEngine(session.id)
          }
          return json(res, { ok: true, effort: level })
        }
        if (parts.length === 3 && parts[2] === 'permission-mode' && method === 'POST') {
          const session = this.store.get(id) ?? await this.catalog.adopt(id)
          if (!session) return json(res, { error: '会话不存在' }, 404)
          const body = await readJson(req)
          const mode = typeof body?.mode === 'string' ? body.mode.trim() : ''
          if (mode !== '' && !(PERMISSION_MODE_VALUES as readonly string[]).includes(mode)) {
            return json(res, { error: '无效的权限模式' }, 400)
          }
          // Same lifecycle as the model override: persisted as this session's
          // default, hot-switched on a busy process, and spawn-time for a cold
          // one — an idle engine is recycled so the next message respawns.
          const permissionMode = mode === '' ? undefined : mode as PermissionModeValue
          await this.patchMeta(session.id, { permissionMode })
          const engine = this.liveEngine(session.id)
          if (engine !== undefined && engine.busy) {
            // Detached but caught, exactly like the live model switch: a
            // refusing CLI must not fault the host process.
            engine.setPermissionMode(permissionMode).catch((error: unknown) => {
              this.ctx.logger?.warn?.(`dsh-cc: live permission-mode switch failed for ${session.id}: ${String(error)}`)
            })
          } else if (engine !== undefined) {
            await this.closeEngine(session.id)
          }
          return json(res, { ok: true, mode })
        }
        if (parts.length === 3 && parts[2] === 'usage' && method === 'GET') {
          const session = this.store.get(id)
          if (!session) return json(res, { error: '会话不存在' }, 404)
          const engine = this.liveEngine(session.id)
          if (engine === undefined) {
            return json(res, { available: false, reason: '当前没有活跃的 Claude 进程；发送一条消息后即可查询' })
          }
          const usage = await engine.getUsage()
          if (usage === undefined) return json(res, { available: false, reason: '查询失败或该账户类型无额度数据' })
          return json(res, { available: true, usage })
        }
        if (parts.length === 3 && parts[2] === 'commands' && method === 'GET') {
          const engine = this.liveEngine(id)
          if (engine === undefined) {
            return json(res, { available: false, commands: [] })
          }
          const commands = await engine.supportedCommands()
          if (commands === undefined) return json(res, { available: false, commands: [] })
          return json(res, { available: true, commands })
        }
        if (parts.length === 3 && parts[2] === 'stop' && method === 'POST') {
          const engine = this.liveEngine(id)
          if (!engine) return json(res, { error: '会话没有正在运行的进程' }, 404)
          await engine.interrupt()
          return json(res, { ok: true })
        }
        if (parts.length === 5 && parts[2] === 'tasks' && method === 'POST') {
          return await this.controlTask(id, parts[3] ?? '', parts[4] ?? '', res)
        }
        if (parts.length === 4 && parts[2] === 'dialogs' && method === 'POST') {
          const session = this.store.get(id)
          if (!session) return json(res, { error: '会话不存在' }, 404)
          const engine = this.liveEngine(session.id)
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
    // An account switch wrote CLAUDE_CONFIG_DIR onto the host process; unloading
    // the plugin must not leave that behind for whatever mounts next.
    restoreConfigDir()
  }

  /**
   * The engine slot for one session id, ignoring entries that cannot serve a
   * message: closed engines (removed, or mid-removal) and dead ones (their
   * query ended — the CLI exited, however cleanly — so pushing into them
   * feeds a stream nobody consumes and the turn would never finish).
   * @param id - the session id, which is also the engine table key.
   * @returns the engine when it can still take a message, else undefined.
   */
  private liveEngine(id: string): SessionEngine | undefined {
    const engine = this.engines.get(id)
    if (engine === undefined || engine.isClosed || engine.isDead) return undefined
    return engine
  }

  /**
   * Create an engine for a session, claim its table slot synchronously, and
   * arm the end-of-life callback that drops it again the moment its query
   * terminates — the C1 guarantee: no path can hand a spent engine back to a
   * send.
   * @param session - the session the engine drives.
   * @param model - the model override this engine runs with.
   * @returns the registered engine.
   */
  private startEngine(session: SessionMeta, model: string): SessionEngine {
    const engine = new SessionEngine(
      { sessionId: session.id, cwd: session.cwd, model, permissionMode: session.permissionMode ?? '', claudeSessionId: session.claudeSessionId },
      this.configFor(session),
      this.hooks(session.id),
    )
    engine.onEnd = () => this.retireEngine(session.id, engine)
    this.engines.set(session.id, engine)
    this.enforceLiveCap(session.id)
    return engine
  }

  /**
   * Drop one terminated engine from the live table. Identity-checked: by the
   * time a death notice travels, recovery may already have installed a
   * replacement under the same key, and removing that one would orphan a
   * healthy engine mid-turn.
   * @param id - the session whose engine table slot is in question.
   * @param engine - the exact engine that ended.
   */
  private retireEngine(id: string, engine: SessionEngine): void {
    if (this.engines.get(id) !== engine) return
    this.engines.delete(id)
    // A closed/replaced engine can still be mid-fold; its live turn dies with
    // it, exactly as an explicit close would clear it.
    this.liveTurns.delete(id)
  }

  private async sendMessage(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const session = this.store.get(id) ?? await this.catalog.adopt(id)
    if (!session) return json(res, { error: '会话不存在' }, 404)
    // A terminal-held session is another process's conversation; sending into
    // it would interleave two writers on one transcript with no way to steer
    // the other process's turn. The page keeps it read-only.
    if (this.catalog.terminalOwned(session.id)) {
      return json(res, { error: '该会话正由终端中的 Claude 进程使用，页面端已设为只读' }, 409)
    }
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
    // Every table below is keyed by the row's own id, so a session reached
    // through its native id and the same session reached through its page id
    // converge on one engine, one live turn, one counter.
    const key = session.id
    let engine = this.liveEngine(key)
    const merged = this.configFor(session)
    // Environment is spawn-time: an engine that outlived a session-env edit
    // (the save happened mid-turn, when recycling a busy engine would have
    // killed the turn) must not serve the next message from the stale layer.
    // Key order is not part of env equality — the same layer reached through
    // two merge orders is the same layer.
    if (engine !== undefined && !engine.busy && !sameEnv(engine.spawnEnv, merged.env)) {
      await this.closeEngine(key)
      // Re-read the slot rather than assuming it stayed empty: the close
      // awaited, and a send that raced through it may already have installed
      // a fresh engine — starting another would orphan that one mid-turn.
      engine = this.liveEngine(key)
    }
    if (engine === undefined) engine = this.startEngine(session, session.model)
    await this.emitEvent(key, { kind: 'user', text, ...(images.length > 0 ? { images } : {}) })
    await engine.send(text, attachments)
    // An engine that died during the send already wrote its terminal status
    // through finish(); flipping to busy now would strand the session busy
    // with nothing running. A death that lands after this line is corrected
    // by finish() itself.
    if (engine.isDead) return json(res, { ok: true }, 202)
    // After send, never before: the engine creates its query lazily on the
    // first message, and an account can only be read from a live query.
    this.refreshAccount(engine)
    // The count increments inside the store so two overlapping sends cannot
    // both read the same base and lose one.
    await this.store.incrementMessageCount(key)
    await this.patchMeta(key, { status: 'busy', lastError: undefined })
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
    const engine = this.liveEngine(session.id)
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

  /**
   * Stop or background one task of one session's live engine.
   * @param id - the session id.
   * @param taskId - the task id from the table.
   * @param action - `stop` or `background`.
   * @param res - the response to write.
   */
  private async controlTask(id: string, taskId: string, action: string, res: ServerResponse): Promise<void> {
    const engine = this.liveEngine(id)
    if (engine === undefined) return json(res, { error: '会话没有正在运行的进程' }, 409)
    const row = engine.taskRows().find(task => task.id === taskId)
    if (row === undefined) return json(res, { error: '任务不存在' }, 404)
    if (action === 'stop') {
      if ((TERMINAL_TASK_STATUSES as readonly string[]).includes(row.status)) {
        return json(res, { error: '任务已结束' }, 409)
      }
      await engine.stopTask(taskId)
      return json(res, { ok: true })
    }
    if (action === 'background') {
      if (row.toolUseId === undefined) return json(res, { error: '该任务没有对应的工具调用' }, 409)
      const backgrounded = await engine.backgroundTask(row.toolUseId)
      if (!backgrounded) return json(res, { error: '该任务不在前台运行' }, 409)
      return json(res, { ok: true })
    }
    return json(res, { error: '未知操作' }, 400)
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
      tasks: rows => {
        this.broadcast({ t: 'tasks', sessionId, tasks: rows })
      },
      telemetry: payload => {
        this.broadcast({ t: 'telemetry', sessionId, ...payload })
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
   *
   * The replacement claims the engine slot synchronously, before any await:
   * a send slipping into the gap between closing the old engine and
   * registering the new one would install its own engine, which this
   * recovery would then overwrite — leaving an orphaned process resuming the
   * same native session as the replacement. Never rejects: it runs inside the
   * engine's termination path, where a rejection has no catcher.
   * @param sessionId - the failing session.
   * @param error - the engine failure.
   */
  private async recoverWithLastGoodModel(sessionId: string, error: Error): Promise<void> {
    try {
      const session = this.store.get(sessionId)
      if (session === undefined) return
      const from = session.model
      const fallback = session.lastGoodModel
      if (fallback === undefined || fallback === '' || fallback === from) return
      // The dead engine knows what it was given, attachments included. Reading
      // it back out of the transcript instead would resolve to some earlier
      // message: a CLI-owned session's store is read as a bounded tail, and the
      // failed turn's own record is written by the process that just died.
      const replay = this.engines.get(sessionId)?.lastSend
      if (replay === undefined) return
      const dead = this.engines.get(sessionId)
      const engine = this.startEngine(session, fallback)
      // Close the spent engine before the replay: closing denies whatever it
      // left pending. Its slot is already taken, so this close cannot unseat
      // the replacement.
      if (dead !== undefined && dead !== engine) await dead.close()
      await this.patchMeta(sessionId, { model: fallback, lastError: undefined, status: 'idle' })
      await this.emitEvent(sessionId, {
        kind: 'system',
        subtype: 'model-fallback',
        data: { from, to: fallback, reason: error.message },
      })
      this.ctx.logger?.warn?.(`dsh-cc: session ${sessionId} fell back to ${fallback}: ${error.message}`)
      await engine.send(replay.text, replay.images)
      this.refreshAccount(engine)
      // Same death-race guard as the send path: a replacement that died
      // before this line has already written its own terminal status.
      if (!engine.isDead) await this.patchMeta(sessionId, { status: 'busy' })
      this.broadcastSessions()
    } catch (recoveryError) {
      // The session must not stay busy because the recovery itself failed.
      const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
      this.ctx.logger?.warn?.(`dsh-cc: 会话 ${sessionId} 的模型回落失败：${message}`)
      await this.patchMeta(sessionId, { status: 'error', lastError: `模型回落失败：${message}` })
    }
  }

  /**
   * Persist and broadcast one transcript event.
   *
   * A persistence failure degrades, never faults: the event is broadcast
   * either way (the page must not lose a turn because a disk went bad), the
   * failure is logged, and the session gets one error event noting that its
   * file and its page have diverged. The engine calls this fire-and-forget,
   * so a rejection escaping here would be an unhandled one.
   * @param sessionId - the session the event belongs to.
   * @param input - the event before seq/ts assignment.
   * @param reportPersistFailure - false for the synthetic notice itself, so a
   *   failing write cannot recurse into more notices.
   */
  private async emitEvent(sessionId: string, input: CcEventInput, reportPersistFailure = true): Promise<void> {
    // The turn's own end commits its content, so the folded live turn dies
    // with it; keeping it would ghost-render beside the committed transcript.
    if (input.kind === 'result' || input.kind === 'error') this.liveTurns.delete(sessionId)
    const event = { ...input, seq: this.store.nextSeq(sessionId), ts: new Date().toISOString() } as CcEvent
    let persisted = true
    if (SessionCatalog.persists(this.store.get(sessionId), event)) {
      try {
        await this.store.append(sessionId, event)
      } catch (error) {
        persisted = false
        this.ctx.logger?.warn?.(`dsh-cc: 会话 ${sessionId} 的事件未能写入转录：${String(error)}`)
      }
    }
    this.broadcast({ t: 'event', sessionId, event })
    if (!persisted && reportPersistFailure && input.kind !== 'error') {
      await this.emitEvent(sessionId, {
        kind: 'error',
        message: '事件写入磁盘失败，页面显示可能与会话文件不一致；请检查数据目录磁盘状态。',
      }, false)
    }
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

  /**
   * One session's live task table, read off its engine. No engine — cold,
   * evicted, or terminal-owned — means an empty table, which is also the
   * truth: those tasks died with their process.
   * @param sessionId - the session to read.
   * @returns the rows in start order.
   */
  private taskSnapshot(sessionId: string): TaskRow[] {
    return this.liveEngine(sessionId)?.taskRows() ?? []
  }

  /**
   * Patch session metadata and broadcast the new list.
   *
   * The in-memory record is already updated when the index write runs, so a
   * failing write costs durability, not correctness of this turn — logged and
   * swallowed. The engine calls this fire-and-forget from its message loop;
   * a rejection here would be unhandled.
   * @param sessionId - the session to patch.
   * @param patch - fields to overwrite.
   */
  private async patchMeta(sessionId: string, patch: Parameters<SessionStore['update']>[1]): Promise<void> {
    try {
      const meta = await this.store.update(sessionId, patch)
      if (meta !== undefined) this.broadcastSessions()
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-cc: 会话 ${sessionId} 的元数据未能落盘：${String(error)}`)
    }
  }

  private broadcastSessions(): void {
    this.broadcast({ t: 'sessions', sessions: this.catalog.list() })
  }

  /**
   * Push one frame to every SSE client. Never throws: a frame that cannot be
   * serialized (or a socket that cannot be written) drops that frame or that
   * client, never the turn that was publishing it.
   * @param message - the frame.
   */
  private broadcast(message: WireMessage): void {
    let payload: string
    try {
      payload = `data: ${JSON.stringify(message)}\n\n`
    } catch {
      return
    }
    let dropped = false
    for (const res of this.clients) {
      try {
        res.write(payload)
      } catch {
        this.clients.delete(res)
        dropped = true
      }
    }
    if (dropped) this.armRescan()
  }

  private sse(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    this.write(res, { t: 'hello', config: this.configSummary() })
    // The merged catalog, exactly like every later broadcast: the sidecar
    // alone is a small subset of it, and the rescan only broadcasts when the
    // native store actually moves — so a sidecar-only frame here would leave
    // the page short of every CLI session until something unrelated changed.
    this.write(res, { t: 'sessions', sessions: this.catalog.list() })
    this.clients.add(res)
    // With nobody attached the rescan runs slowly, so that cached list can be
    // most of RESCAN_IDLE_MS old. The page gets it immediately anyway — a list
    // that renders now beats a blank rail — and this forced sweep corrects it.
    this.armRescan()
    void this.catalog.refresh().then(changed => {
      if (changed) this.broadcastSessions()
    })
    const remove = (): void => {
      this.clients.delete(res)
      // Last page gone: fall back to the idle cadence rather than sweeping the
      // whole CLI store every two seconds for an empty room.
      this.armRescan()
    }
    req.on('close', remove)
    req.on('error', remove)
    res.on('close', remove)
  }

  /** Write one frame to a single fresh SSE client; best effort, never throws. */
  private write(res: ServerResponse, message: WireMessage): void {
    try {
      res.write(`data: ${JSON.stringify(message)}\n\n`)
    } catch {
      // The socket died between accept and first write; the close handler
      // below removes it from the client set.
    }
  }

  private configSummary(): ConfigSummary {
    const effective = this.effectiveConfig()
    const preset = this.settings.presets.find(candidate => candidate.id === this.settings.activePresetId)
    return {
      dataDir: this.baseConfig.dataDir,
      defaultCwd: this.baseConfig.cwd,
      model: effective.model,
      permissionMode: effective.permissionMode,
      env: effectiveEnvEntries(
        this.baseConfig.env,
        this.settings.env,
        { [CONFIG_DIR_ENV]: effective.configDir },
        preset === undefined ? undefined : { env: preset.env, removed: effective.envDeletes ?? [] },
      ),
      liveSessions: this.engines.size,
      sdkVersion: this.sdkVersion,
      ...(this.account !== undefined ? { account: this.account } : {}),
      configDir: effective.configDir,
      defaultConfigDir: resolveAccountDir([], '', this.baseConfig.configDir),
      accounts: this.settings.accounts,
      activeAccountId: this.settings.activeAccountId,
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
    const generation = this.configGeneration
    void engine.accountInfo().then(account => {
      if (account === undefined) return
      if (generation !== this.configGeneration) return
      if (JSON.stringify(account) === JSON.stringify(this.account)) return
      this.account = account
      this.broadcast({ t: 'hello', config: this.configSummary() })
    })
  }

  /**
   * Close idle engines beyond the live cap, oldest use first.
   * @param keep - the session whose engine must survive, i.e. the one this
   *   call was made for. It is idle until its first message is pushed, so
   *   without this a host at its cap with every other session busy evicts the
   *   engine it just created and the send that follows finds it closed.
   */
  private enforceLiveCap(keep?: string): void {
    const idle = [...this.engines.entries()]
      .filter(([id, engine]) => id !== keep && !engine.busy)
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

/**
 * Write one JSON response.
 *
 * A handler that already began its response — the SSE stream, a blob body —
 * cannot restate a late failure as JSON; writing a second set of headers would
 * throw inside the error path itself, so the socket is simply ended.
 * @param res - the response to write.
 * @param body - the JSON body.
 * @param status - the HTTP status.
 */
function json(res: ServerResponse, body: unknown, status = 200): void {
  if (res.headersSent) {
    res.end()
    return
  }
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

/**
 * Blob URL extensions, the inverse of the shared media-type table in types.ts
 * — deriving it is what keeps the URL space and the blob store's file names
 * from drifting apart.
 */
const BLOB_EXTENSION_TYPES: Record<string, ImageRef['mediaType'] | undefined> = Object.fromEntries(
  Object.entries(MEDIA_TYPE_EXTENSIONS)
    .map(([mediaType, extension]) => [extension, mediaType as ImageRef['mediaType']]),
)

/**
 * Compare two environment layers for equality by content, not by key order:
 * the same layer can be reached through different merge orders, and a
 * key-order-sensitive comparison would recycle a perfectly fresh engine (or
 * worse, keep a stale one) on a coin flip.
 * @param left - one env layer.
 * @param right - the other env layer.
 * @returns true when both layers hold exactly the same keys and values.
 */
function sameEnv(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  for (const key of leftKeys) {
    if (left[key] !== right[key]) return false
  }
  return true
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
const EMPTY_SETTINGS: Omit<CcSettings, 'presets' | 'activePresetId'> = {
  model: '', permissionMode: '', env: {}, accounts: [], activeAccountId: '',
}

/**
 * Validate the preset list from a settings write or a settings file: ids and
 * names must be non-empty strings, env keys follow the same shape rules as
 * the settings env (the account-owned key is refused earlier, in the route),
 * and the list is capped so a runaway writer cannot grow the file unbounded.
 * @param value - the raw `presets` field.
 * @returns the valid presets, in order.
 */
function normalizePresets(value: unknown): EnvPreset[] {
  if (!Array.isArray(value)) return []
  const presets: EnvPreset[] = []
  for (const item of value.slice(0, 16)) {
    if (typeof item !== 'object' || item === null) continue
    const { id, name, env } = item as { id?: unknown; name?: unknown; env?: unknown }
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue
    if (typeof name !== 'string' || name.trim() === '') continue
    const clean: Record<string, string> = {}
    if (typeof env === 'object' && env !== null) {
      for (const [key, entry] of Object.entries(env as Record<string, unknown>)) {
        if (typeof entry !== 'string') continue
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
        clean[key] = entry
      }
    }
    presets.push({ id, name: name.trim(), env: clean })
  }
  return presets
}

/**
 * The presets a first run — or a settings file from before presets existed —
 * starts with. The GLM bundle snapshots whatever provider environment this
 * process itself inherited, so on a machine already pointed at a gateway the
 * preset works on first click; the account bundle is everything else stripped
 * back to just the proxy, which is what 账号直连 means on such a machine.
 * @returns the two seeded presets.
 */
function seedPresets(): EnvPreset[] {
  const proxy: Record<string, string> = {
    HTTP_PROXY: process.env.HTTP_PROXY ?? process.env.http_proxy ?? 'http://127.0.0.1:7890',
    HTTPS_PROXY: process.env.HTTPS_PROXY ?? process.env.https_proxy ?? 'http://127.0.0.1:7890',
    NO_PROXY: process.env.NO_PROXY ?? process.env.no_proxy ?? 'localhost,127.0.0.1',
  }
  const glm: Record<string, string> = {
    ...proxy,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? 'https://open.bigmodel.cn/api/anthropic',
  }
  // Snapshot every other provider-scope variable this process carries: the
  // tier-alias mapping (opus/sonnet/haiku) and a relay's long timeout ride
  // along with the endpoint and credential instead of silently falling back
  // to CLI defaults on first switch.
  for (const key of PROVIDER_ENV_NAMES) {
    if (key in glm) continue
    const value = process.env[key]
    if (value !== undefined && value !== '') glm[key] = value
  }
  return [
    { id: 'account', name: '账号直连', env: proxy },
    { id: 'glm', name: 'GLM 中转', env: glm },
  ]
}

/**
 * Load the page-editable settings file from the data directory.
 * @param dataDir - session store directory.
 * @returns the persisted settings, or empties when absent or unreadable.
 */
function loadSettings(dataDir: string): CcSettings {
  try {
    const file = join(dataDir, 'settings.json')
    if (!existsSync(file)) {
      return { ...EMPTY_SETTINGS, env: {}, accounts: [], presets: seedPresets(), activePresetId: '' }
    }
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<CcSettings>
    const env: Record<string, string> = {}
    if (typeof raw.env === 'object' && raw.env !== null) {
      for (const [key, value] of Object.entries(raw.env)) {
        if (typeof value === 'string') env[key] = value
      }
    }
    // A file written before the key was reserved can still carry it; the
    // account layer owns it now, so it is dropped rather than obeyed.
    delete env[CONFIG_DIR_ENV]
    const accounts = normalizeAccounts(raw.accounts)
    const activeAccountId = typeof raw.activeAccountId === 'string'
      && accounts.some(account => account.id === raw.activeAccountId)
      ? raw.activeAccountId
      : ''
    // A file from before presets existed seeds them rather than loading an
    // empty list; the seed never activates anything, so behavior is
    // unchanged until a preset is clicked.
    const presets = raw.presets === undefined ? seedPresets() : normalizePresets(raw.presets)
    const activePresetId = typeof raw.activePresetId === 'string'
      && presets.some(preset => preset.id === raw.activePresetId)
      ? raw.activePresetId
      : ''
    return {
      model: typeof raw.model === 'string' ? raw.model : '',
      permissionMode: typeof raw.permissionMode === 'string' ? raw.permissionMode : '',
      env,
      presets,
      activePresetId,
      accounts,
      activeAccountId,
    }
  } catch {
    return { ...EMPTY_SETTINGS, env: {}, accounts: [], presets: seedPresets(), activePresetId: '' }
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
