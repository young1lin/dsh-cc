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
  applyConfigDir, baselineConfigDir, CONFIG_DIR_ENV, normalizeAccounts, resolveAccountDir,
  restoreConfigDir, sameDir,
} from './accounts.ts'
import { loadSettings, normalizePresets, persistSettings } from './settings-file.ts'
import { redactEnvForWire, retainWireSecrets, sealEnvForStorage } from './secret-box.ts'
import { probeCatalogOnce } from './model-probe.ts'
import type { ResolvedConfig } from './config.ts'
import { SessionEngine, resolveSessionModel, resolveSessionPermissionMode, type EngineHooks, type QueuedMessage, type SendImage } from './engine.ts'
import { BlobStore, isImageMediaType } from './blobs.ts'
import { cachedCommands, rememberCommands } from './command-cache.ts'
import { SessionCatalog, type CatalogRefresh } from './catalog.ts'
import { fileIndexFor } from './file-index.ts'
import { gitInfoFor } from './git-info.ts'
import { effectiveEnvEntries, readDirListing, readSdkVersion, readTextFile } from './http-support.ts'
import { reduceDelta, type LiveTurn } from './live-turn.ts'
import { deleteNativeSession, forkNativeSession, messageBeforeUuid, renameNativeSession } from './native-sessions.ts'
import { SessionStore } from './store.ts'
import { watchClaudeHome, type StoreChange, type StoreWatch } from './store-watch.ts'
import type {
  AccountSummary, CcAccount, CcEvent, CcEventInput, CcSettings, ConfigSummary, EffortLevel, EnvPreset,
  ImageRef, LiveTurnSnapshot, PermissionDestination, PermissionModeValue, QueuedMessageView, SessionMeta, TaskRow,
  WireMessage,
} from './types.ts'
import {
  DEFAULT_EFFORT_LEVELS, MEDIA_TYPE_EXTENSIONS, PERMISSION_MODE_VALUES, PROVIDER_ENV_NAMES, TERMINAL_TASK_STATUSES,
} from './types.ts'

const MAX_BODY_BYTES = 1024 * 1024

/**
 * Extract the persistable core of one telemetry context answer. The CLI's
 * control-channel payload is passed through shaped-as-is; only a reading with
 * real totals qualifies — a probe that failed or returned gibberish leaves the
 * previously persisted snapshot untouched.
 * @param value - the raw `context` half of a telemetry push.
 * @returns the sidecar snapshot, or undefined when nothing usable arrived.
 */
function contextSnapshot(value: unknown): NonNullable<SessionMeta['lastContext']> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const totalTokens = record.totalTokens
  const maxTokens = record.maxTokens
  if (typeof totalTokens !== 'number' || typeof maxTokens !== 'number') return undefined
  return {
    recordedAt: new Date().toISOString(),
    context: {
      totalTokens,
      maxTokens,
      ...(typeof record.percentage === 'number' ? { percentage: record.percentage } : {}),
      ...(Array.isArray(record.categories) ? { categories: record.categories } : {}),
      ...(typeof record.isAutoCompactEnabled === 'boolean'
        ? { isAutoCompactEnabled: record.isAutoCompactEnabled } : {}),
      ...(typeof record.autoCompactThreshold === 'number'
        ? { autoCompactThreshold: record.autoCompactThreshold } : {}),
    },
  }
}

/** Session id of the throwaway engine started only to read the model catalog. */
const CATALOG_PROBE_ID = 'dsh-cc:catalog-probe'

/** How long that probe is given before the catalog is reported unavailable. */

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
 * How often unreferenced images are swept. Rare on purpose: the sweep reads
 * every sidecar transcript, and blobs grow slowly enough that half a day of
 * latency costs nothing.
 */
const BLOB_SWEEP_EVERY_MS = 12 * 60 * 60 * 1000

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

/** Longest auto-derived title; keeps the rename endpoint's 1-80 range intact. */
const AUTO_TITLE_MAX = 80

/**
 * Derive the CLI-parity auto title from a session's first user message: its
 * first line, trimmed and truncated. A slash command is an operation, not
 * conversation, and an image-only message has no line to take — neither titles
 * a session, so the timestamp label stands.
 * @param text - the message body about to be submitted.
 * @returns the title candidate, or undefined when the message cannot name the session.
 */
function deriveAutoTitle(text: string): string | undefined {
  const firstLine = text.trim().split('\n')[0]?.trim() ?? ''
  if (firstLine.length === 0 || firstLine.startsWith('/')) return undefined
  return firstLine.length > AUTO_TITLE_MAX ? `${firstLine.slice(0, AUTO_TITLE_MAX - 1)}…` : firstLine
}

/** The 409 body for a send whose session belongs to another account root. */
const SCOPE_CONFLICT_MESSAGE = '会话属于另一个账号根目录，请重新选择'

/**
 * Thrown by the pre-spawn scope check ({@link CcRuntime.assertInScope}) so
 * the send route can answer a 409 instead of letting the refusal surface as
 * a generic spawn failure.
 */
class ScopeConflictError extends Error {}

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
   * Undelivered queued messages orphaned by a dead engine, keyed by session
   * id. They never reached the CLI, so they cost nothing to hold: the next
   * engine for the session re-enters them in their original order (see
   * {@link restoreRetainedQueue}), and the queue endpoints serve them while
   * no live engine holds the session's queue.
   */
  private readonly retainedQueues = new Map<string, QueuedMessage[]>()
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
  /** Periodic unreferenced-image sweep. */
  private blobSweep: ReturnType<typeof setInterval> | undefined
  /** Filesystem watch over the CLI store; undefined when none could be established. */
  private storeWatch: StoreWatch | undefined
  /** The Claude Code home {@link storeWatch} was opened on; '' when there is none. */
  private storeWatchDir = ''
  /** Whether a coalesced `sessions` frame is already scheduled for this tick. */
  private sessionsFramePending = false
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
      () => this.providerScopeSnapshot(),
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
    // Blob housekeeping runs detached: it is disk work nobody waits on, and a
    // mount must not be held up by it.
    void this.sweepBlobs()
    this.blobSweep = setInterval(() => void this.sweepBlobs(), BLOB_SWEEP_EVERY_MS)
  }

  /**
   * Drop stored images no transcript refers to any more. Aborts without
   * deleting anything when the mark scan could not complete — a partial mark
   * set would sweep live images.
   */
  private async sweepBlobs(): Promise<void> {
    try {
      const referenced = await this.store.referencedBlobIds()
      if (referenced === undefined) return
      const { deleted, bytes } = await this.blobs.sweep(referenced)
      if (deleted > 0) {
        this.ctx.logger?.info?.(`dsh-cc: 清理了 ${deleted} 张无引用图片，回收 ${Math.round(bytes / 1024)} KB`)
      }
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-cc: 图片清理失败 ${String(error)}`)
    }
  }

  /**
   * Re-read the CLI store and publish only what actually moved.
   *
   * A terminal appending to one transcript moves one row. Broadcasting the
   * whole catalog for it cost 135KB per write-burst on this machine — the
   * dominant traffic on an otherwise idle page — so rows go out one frame each
   * and the full list is reserved for a changed session SET, which no per-row
   * frame can express.
   */
  private sweepCatalog(change?: StoreChange): void {
    // A watch batch that named its project directories is re-read scoped to
    // them; anything else — a timer tick, a change that could not be scoped —
    // sweeps the store. The scoped read refuses rather than guesses, so an
    // undefined answer falls through to the sweep.
    const scoped = change !== undefined && !change.full
      ? this.catalog.refreshProjects(change.projects)
      : Promise.resolve(undefined)
    void scoped
      .then(async result => result ?? await this.catalog.refresh())
      .then(result => this.publishCatalogChange(result))
  }

  /**
   * Turn one refresh answer into the smallest frames that convey it.
   * @param result - what the refresh found.
   */
  private publishCatalogChange(result: CatalogRefresh): void {
    if (!result.changed) return
    if (result.structural) {
      this.broadcastSessions()
      return
    }
    for (const id of result.moved) this.broadcastSession(id)
  }

  /**
   * (Re)arm change detection over the CLI's session store.
   *
   * A session driven from a terminal CLI writes its transcript with no engine
   * of ours involved, so noticing those writes is what keeps the rail —
   * statuses included — in step with it.
   *
   * The store is watched, not polled: the sweep enumerates every project
   * directory (see {@link watchClaudeHome} for the measurement), and running it
   * on a timer spent that cost forever whether or not anything had changed. The
   * watch carries the rate ceiling, so an actively-written store costs no more
   * than the old fast cadence and a quiet one costs nothing.
   *
   * The timer survives as a backstop, at the idle cadence, for what a watch can
   * miss: a network share that reports no events, a watcher the OS dropped, a
   * platform without recursive watching at all. Where no watch could be
   * established the timer keeps its original audience-scaled cadence, because
   * it is then the only source of truth.
   *
   * Idempotent: called on every client add/remove and on every account switch.
   */
  private armRescan(): void {
    this.armStoreWatch()
    const wanted = this.storeWatch !== undefined
      ? RESCAN_IDLE_MS
      : (this.clients.size > 0 ? RESCAN_ACTIVE_MS : RESCAN_IDLE_MS)
    if (this.rescan !== undefined && this.rescanEveryMs === wanted) return
    if (this.rescan !== undefined) clearInterval(this.rescan)
    this.rescanEveryMs = wanted
    this.rescan = setInterval(() => this.sweepCatalog(), wanted)
  }

  /**
   * Point the store watch at the Claude Code home currently in force, or leave
   * it unestablished when this platform cannot watch recursively.
   *
   * An account switch moves the home, so the watch is rebuilt whenever the
   * directory it was opened on is no longer the active one — a watch left on
   * the previous root would report the wrong store's changes and miss the new
   * one's entirely.
   */
  private armStoreWatch(): void {
    const dir = this.activeConfigDir()
    if (this.storeWatch !== undefined && sameDir(this.storeWatchDir, dir)) return
    this.storeWatch?.close()
    this.storeWatch = watchClaudeHome({
      configDir: dir,
      minIntervalMs: RESCAN_ACTIVE_MS,
      onChange: change => this.sweepCatalog(change),
    })
    this.storeWatchDir = this.storeWatch === undefined ? '' : dir
  }

  /** Browser-safe settings view: secret values become keep-existing sentinels. */
  private settingsView(): CcSettings {
    return {
      ...this.settings,
      env: redactEnvForWire(this.settings.env),
      presets: this.settings.presets.map(preset => ({
        ...preset,
        env: redactEnvForWire(preset.env),
      })),
    }
  }

  /** Browser-safe session view; no credential or encrypted envelope leaves the host. */
  private sessionView(session: SessionMeta): SessionMeta {
    return {
      ...session,
      ...(session.env !== undefined ? { env: redactEnvForWire(session.env) } : {}),
      ...(session.accountEnv !== undefined
        ? { accountEnv: redactEnvForWire(session.accountEnv) }
        : {}),
    }
  }

  /** Browser-safe form of a complete catalog frame. */
  private sessionViews(sessions: SessionMeta[]): SessionMeta[] {
    return sessions.map(session => this.sessionView(session))
  }

  /**
   * The cordis config with page-editable settings layered on top: a non-empty
   * settings field replaces its base counterpart, an empty one keeps the base.
   * `env` layers per key rather than wholesale so unrelated edits cannot
   * silently retire an endpoint or credential.
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
   * The provider-scope environment a spawn started right now would carry:
   * each key's winning layer — config over the inherited environment — with
   * preset deletions honored. This is the account binding stamped onto every
   * session row at initialization, so the row can reproduce it on every later
   * spawn no matter what the global layers say by then.
   * @returns the provider-scope snapshot; possibly empty (account-direct).
   */
  private providerScopeSnapshot(): Record<string, string> {
    const effective = this.effectiveConfig()
    const deletes = new Set((effective.envDeletes ?? []).map(key => key.toLowerCase()))
    const snapshot: Record<string, string> = {}
    for (const key of PROVIDER_ENV_NAMES) {
      if (deletes.has(key.toLowerCase())) continue
      const value = effective.env[key] ?? process.env[key]
      if (typeof value === 'string' && value !== '') snapshot[key] = value
    }
    return sealEnvForStorage(this.baseConfig.dataDir, snapshot)
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
    // A row with an account binding carries its own provider scope and root:
    // the stamp replaces the global layers for exactly those keys, so a
    // session initialized under one account keeps using it after the page
    // switches to another. The manual per-session env layer stays on top — an
    // explicit edit outranks the stamp — and the root always comes from the
    // row itself. Provider keys the stamp does not carry are deleted from the
    // inherited environment, so one account's credentials cannot leak into
    // another account's session.
    if (session.accountEnv !== undefined) {
      const scope = new Set(PROVIDER_ENV_NAMES.map(key => key.toUpperCase()))
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(base.env)) {
        if (!scope.has(key.toUpperCase())) env[key] = value
      }
      Object.assign(env, session.accountEnv)
      const ownRoot = session.configDir ?? base.configDir
      // CLAUDE_CONFIG_DIR is asserted last: both env editors refuse the key,
      // so nothing but the row's own root can ever supply it.
      Object.assign(env, session.env ?? {}, { [CONFIG_DIR_ENV]: ownRoot })
      const envDeletes = PROVIDER_ENV_NAMES.filter(
        key => session.accountEnv?.[key] === undefined && session.env?.[key] === undefined,
      )
      return {
        ...base,
        env,
        envDeletes,
        permissionMode: this.permissionModeFor(session),
        ...(effort !== undefined ? { effort } : {}),
      }
    }
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
    // A CLI that never answers must not hold the settings dialog open: the
    // helper wraps warm-up/ask/close under its own timeout.
    const models = await probeCatalogOnce(probe, message => this.ctx.logger?.warn?.(message))
    if (models !== undefined && generation === this.configGeneration) this.modelCatalog = models
    return models
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
    const envKeys = new Set<string>()
    if (typeof body.env === 'object' && body.env !== null) {
      for (const [key, value] of Object.entries(body.env as Record<string, unknown>)) {
        if (typeof value !== 'string' || value === '') continue
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          return json(res, { error: `环境变量名“${key}”无效` }, 400)
        }
        const normalizedKey = key.toUpperCase()
        if (envKeys.has(normalizedKey)) return json(res, { error: `环境变量名“${key}”重复` }, 400)
        envKeys.add(normalizedKey)
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
    const previousActivePreset = this.settings.presets.find(preset => preset.id === this.settings.activePresetId)
    const presets = normalizePresets(body.presets).map(preset => {
      const previous = this.settings.presets.find(candidate => candidate.id === preset.id)?.env
        ?? previousActivePreset?.env
        ?? this.settings.env
      return {
        ...preset,
        env: sealEnvForStorage(
          this.baseConfig.dataDir,
          retainWireSecrets(preset.env, previous),
        ),
      }
    })
    const protectedEnv = sealEnvForStorage(
      this.baseConfig.dataDir,
      retainWireSecrets(env, this.settings.env),
    )
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
    const nextSettings = { model, permissionMode, env: protectedEnv, presets, activePresetId, accounts, activeAccountId }
    persistSettings(this.baseConfig.dataDir, nextSettings)
    this.settings = nextSettings
    if (moved) {
      // Same cascade as an explicit switch: move the environment, then drop
      // every answer that came out of the root being left behind.
      this.configGeneration += 1
      applyConfigDir(after)
      this.account = undefined
      this.catalog.invalidate()
      // The watched store moved with the root; re-point it (see armStoreWatch).
      this.armRescan()
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
    return json(res, { ok: true, settings: this.settingsView() })
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
    const nextSettings = { ...this.settings, activeAccountId: id }
    persistSettings(this.baseConfig.dataDir, nextSettings)
    this.settings = nextSettings
    // Order matters: the environment must be moved before anything re-reads,
    // and the generation bumped before the detached probes can land.
    this.configGeneration += 1
    applyConfigDir(this.activeConfigDir())
    for (const key of [...this.engines.keys()]) await this.closeEngine(key)
    this.account = undefined
    this.modelCatalog = undefined
    this.modelsFailedAt = 0
    this.catalog.invalidate()
    // The store being watched moved with the account; a watch left on the old
    // root would report the wrong store and go blind to the new one.
    this.armRescan()
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
      if (parts[0] === 'settings' && parts.length === 1 && method === 'GET') return json(res, { settings: this.settingsView() })
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
          return json(res, { sessions: this.sessionViews(this.catalog.list()) })
        }
        if (parts.length === 1 && method === 'POST') {
          const body = await readJson(req)
          const effective = this.effectiveConfig()
          const session = await this.store.create(body ?? {}, {
            cwd: effective.cwd,
            configDir: effective.configDir,
            // The account binding is captured at initialization on purpose:
            // later page-level account/preset switches must not reroute this
            // conversation's quota or credentials (see SessionMeta.accountEnv).
            accountEnv: this.providerScopeSnapshot(),
          })
          this.broadcastSessions()
          return json(res, { session: this.sessionView(session) })
        }
        const id = parts[1] ?? ''
        if (parts.length === 2 && method === 'GET') {
          const session = this.store.get(id) ?? await this.catalog.adopt(id)
          if (!session) return json(res, { error: '会话不存在' }, 404)
          return json(res, {
            session: this.sessionView(session),
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
          // The retained carry-over of any dead engine dies with the session:
          // a resurrected row (the rescan re-adopting its native twin) must
          // not inherit messages meant for the deleted conversation.
          this.retainedQueues.delete(key)
          if (id !== key) this.retainedQueues.delete(id)
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
          // The response does not wait on the full CLI-store sweep: a cold
          // sweep (or an event loop stalled by a spawn) stretches it to
          // seconds while the delete itself already took effect in the store.
          // Broadcast the cached list now; the native half's disappearance is
          // picked up by the rescan's signature change and re-broadcast there.
          this.broadcastSessions()
          void this.catalog.refresh().then(result => {
            if (result.changed) this.broadcastSessions()
          })
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
          // A hand-set title is final: no later auto-derivation may replace it.
          await this.patchMeta(session.id, { name, titleSource: 'user' })
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
          const envKeys = new Set<string>()
          if (typeof body?.env === 'object' && body.env !== null) {
            for (const [key, value] of Object.entries(body.env as Record<string, unknown>)) {
              if (typeof value !== 'string' || value === '') continue
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
                return json(res, { error: `环境变量名“${key}”无效` }, 400)
              }
              const normalizedKey = key.toUpperCase()
              if (envKeys.has(normalizedKey)) return json(res, { error: `环境变量名“${key}”重复` }, 400)
              envKeys.add(normalizedKey)
              if (key === CONFIG_DIR_ENV) {
                return json(res, { error: `${CONFIG_DIR_ENV} 不能按会话覆盖：会话目录是整个插件级的账号选择。` }, 400)
              }
              env[key] = value
            }
          }
          const protectedEnv = sealEnvForStorage(
            this.baseConfig.dataDir,
            retainWireSecrets(env, session.env),
          )
          await this.patchMeta(id, { env: Object.keys(protectedEnv).length > 0 ? protectedEnv : undefined })
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
          // This and the usage/models reads fire in the same tick as the
          // adopting GET /sessions/:id when a CLI session is first opened, so
          // they regularly land before the sidecar row exists. A session the
          // catalog knows is not "nonexistent" — it merely has no live engine
          // yet, which is exactly what available:false reports. catalog.get is
          // the read-only view: a telemetry poll must not write an adoption
          // row of its own.
          const session = this.store.get(id) ?? this.catalog.get(id)
          if (!session) return json(res, { error: '会话不存在' }, 404)
          const engine = this.liveEngine(session.id)
          if (engine !== undefined) {
            const context = await engine.getContextUsage()
            if (context !== undefined) return json(res, { available: true, context })
          }
          // 冷会话回退：渲染上次探测并持久化的读数（标记 persisted，页面
          // 在提示里注明是记录值）。没有记录过才真的不可用。
          if (session.lastContext !== undefined) {
            return json(res, { available: true, persisted: true, context: session.lastContext.context })
          }
          return json(res, { available: false })
        }
        if (parts.length === 3 && parts[2] === 'models' && method === 'GET') {
          // Same adopting-race guard as the context route: the status bar's
          // model picker reads on every selection, cold session or not.
          const session = this.store.get(id) ?? this.catalog.get(id)
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
        if (parts.length === 3 && parts[2] === 'git' && method === 'GET') {
          // Branch/worktree readout for the status strip. Ground truth is git
          // itself over the session cwd — the CLI only persists a lagging
          // end-of-session branch stamp — and no live engine is involved, so
          // a cold session shows its branch too.
          const session = this.store.get(id) ?? this.catalog.get(id)
          if (!session) return json(res, { error: '会话不存在' }, 404)
          const git = await gitInfoFor(session.cwd)
          if (git === undefined) return json(res, { available: false })
          return json(res, { available: true, git })
        }
        if (parts.length === 3 && parts[2] === 'usage' && method === 'GET') {
          // Same adopting-race guard as the context route.
          const session = this.store.get(id) ?? this.catalog.get(id)
          if (!session) return json(res, { error: '会话不存在' }, 404)
          const engine = this.liveEngine(session.id)
          if (engine === undefined) {
            return json(res, { available: false, reason: '当前没有活跃的 Claude 进程；发送一条消息后即可查询' })
          }
          const usage = await engine.getUsage()
          if (usage === undefined) return json(res, { available: false, reason: '查询失败或该账户类型无额度数据' })
          return json(res, { available: true, usage })
        }
        if (parts.length === 3 && parts[2] === 'commands' && method === 'POST') {
          // Re-discovery, not just a re-read: a skill or plugin edited on disk
          // since the process started is invisible to `supportedCommands()`
          // until the CLI reloads them, which used to mean restarting the
          // session. Both reloads are attempted independently — a plugin tree
          // that refuses to reload must not cost the user their skills.
          const engine = this.liveEngine(id)
          if (engine === undefined) return json(res, { error: '会话没有正在运行的进程' }, 404)
          const failures = await engine.reloadExtensions()
          const commands = await engine.supportedCommands()
          const session = this.store.get(id)
          if (session !== undefined && commands !== undefined && commands.length > 0) {
            rememberCommands(this.baseConfig.dataDir, this.activeConfigDir(), session.cwd, commands)
          }
          return json(res, {
            available: commands !== undefined,
            commands: commands ?? [],
            ...(failures.length > 0 ? { failures } : {}),
          })
        }
        if (parts.length === 3 && parts[2] === 'commands' && method === 'GET') {
          const engine = this.liveEngine(id)
          if (engine === undefined) {
            // 冷会话回退：这个账号+项目上一次活进程报告过的目录。带 savedAt 让
            // 页面可标注「来自缓存」；两者皆无才是真正的空目录（首条消息后会补上）。
            const session = this.store.get(id)
            const fallback = session === undefined
              ? undefined
              : cachedCommands(this.baseConfig.dataDir, this.activeConfigDir(), session.cwd)
            if (fallback === undefined) return json(res, { available: false, commands: [] })
            return json(res, { available: true, commands: fallback.commands, stale: true, savedAt: fallback.savedAt })
          }
          const commands = await engine.supportedCommands()
          if (commands === undefined) return json(res, { available: false, commands: [] })
          // 活目录到手即记档：这个 (configDir, cwd) 对下一次冷会话的回退来源。
          const session = this.store.get(id)
          if (session !== undefined && commands.length > 0) {
            rememberCommands(this.baseConfig.dataDir, this.activeConfigDir(), session.cwd, commands)
          }
          return json(res, { available: true, commands })
        }
        if (parts.length === 3 && parts[2] === 'stop' && method === 'POST') {
          const engine = this.liveEngine(id)
          if (!engine) return json(res, { error: '会话没有正在运行的进程' }, 404)
          await engine.interrupt()
          return json(res, { ok: true })
        }
        if (parts.length === 3 && parts[2] === 'mcp' && method === 'GET') {
          const engine = this.liveEngine(id)
          if (engine === undefined) return json(res, { available: false, servers: [] })
          const servers = await engine.mcpServers()
          return json(res, { available: servers !== undefined, servers: servers ?? [] })
        }
        if (parts.length === 4 && parts[2] === 'mcp' && method === 'POST') {
          const engine = this.liveEngine(id)
          if (engine === undefined) return json(res, { error: '会话没有正在运行的进程' }, 404)
          const name = decodeURIComponent(parts[3] ?? '')
          if (name === '') return json(res, { error: '缺少服务器名' }, 400)
          const body = await readJson(req)
          const action = typeof body?.action === 'string' ? body.action : ''
          try {
            if (action === 'reconnect') await engine.reconnectMcpServer(name)
            else if (action === 'enable') await engine.toggleMcpServer(name, true)
            else if (action === 'disable') await engine.toggleMcpServer(name, false)
            else return json(res, { error: '无效的操作' }, 400)
          } catch (error) {
            // The CLI throws with its own reason (unknown server, auth needed,
            // transport refused); pass it through rather than flattening it.
            return json(res, { error: error instanceof Error ? error.message : String(error) }, 409)
          }
          const servers = await engine.mcpServers()
          return json(res, { ok: true, available: servers !== undefined, servers: servers ?? [] })
        }
        if (parts.length === 3 && parts[2] === 'agents' && method === 'GET') {
          const engine = this.liveEngine(id)
          if (engine === undefined) return json(res, { available: false, agents: [] })
          const agents = await engine.supportedAgents()
          return json(res, { available: agents !== undefined, agents: agents ?? [] })
        }
        if (parts.length === 3 && parts[2] === 'fork' && method === 'POST') {
          const session = this.store.get(id) ?? await this.catalog.adopt(id)
          if (!session) return json(res, { error: '会话不存在' }, 404)
          if (session.claudeSessionId === undefined) {
            return json(res, { error: '草稿会话无可分叉内容' }, 400)
          }
          // A busy engine is appending to the very transcript about to be
          // copied; a half-turn slice would fork a torn conversation, so the
          // fork waits for the turn to finish instead.
          if (this.liveEngine(session.id)?.busy === true) {
            return json(res, { error: '回合进行中，稍后再试' }, 409)
          }
          const body = await readJson(req)
          const upToMessageId = typeof body?.upToMessageId === 'string' && body.upToMessageId !== ''
            ? body.upToMessageId
            : undefined
          const title = typeof body?.title === 'string' && body.title.trim() !== '' ? body.title.trim() : undefined
          const forked = await forkNativeSession(session.claudeSessionId, {
            cwd: session.cwd,
            ...(upToMessageId !== undefined ? { upToMessageId } : {}),
            ...(title !== undefined ? { title } : {}),
          })
          // The fork is a native session like any other: it joins the list
          // through the regular rescan/adopt path. Refreshing once here puts
          // it in the broadcast frame immediately instead of up to one rescan
          // tick later.
          // A fork is a new session, so the refresh reports it as structural;
          // either way the page needs the whole list to gain a row.
          if ((await this.catalog.refresh()).changed) this.broadcastSessions()
          return json(res, { sessionId: forked.sessionId })
        }
        if (parts.length === 3 && parts[2] === 'rewind-preview' && method === 'POST') {
          return await this.rewindFiles(id, req, res, true)
        }
        if (parts.length === 3 && parts[2] === 'rewind' && method === 'POST') {
          return await this.rewindFiles(id, req, res, false)
        }
        if (parts.length === 3 && parts[2] === 'rewind-apply' && method === 'POST') {
          // Conversation rewind as edit-and-resend, composed rather than
          // native: the SDK offers no transcript truncation, so the rewound
          // conversation is a fork cut BEFORE the anchor message — the anchor
          // itself rides back into the page's composer, the CLI /rewind
          // semantics — carrying the row's own name and session-level
          // settings, and the original is deleted right after. On the rail
          // it reads as the SAME session having gone back.
          const session = this.store.get(id) ?? await this.catalog.adopt(id)
          if (!session) return json(res, { error: '会话不存在' }, 404)
          if (session.claudeSessionId === undefined) {
            return json(res, { error: '草稿会话无可回退内容' }, 400)
          }
          if (this.liveEngine(session.id)?.busy === true) {
            return json(res, { error: '回合进行中，稍后再试' }, 409)
          }
          if (this.catalog.terminalOwned(session.id)) {
            return json(res, { error: '该会话正由终端中的 Claude 进程使用，等它退出后再回退' }, 409)
          }
          const body = await readJson(req)
          const userMessageId = typeof body?.userMessageId === 'string' && body.userMessageId !== ''
            ? body.userMessageId
            : undefined
          if (userMessageId === undefined) return json(res, { error: '缺少回退锚点消息' }, 400)
          // 1) Files first: the rewind control rides the ORIGINAL session's
          //    live query, whose checkpoints die with the delete below.
          let filesWarning: string | undefined
          if (body?.restoreFiles === true) {
            const engine = this.liveEngine(session.id)
            if (engine === undefined) {
              return json(res, { error: '文件回滚需要正在运行的会话进程；可取消勾选后仅回退对话' }, 409)
            }
            const files = await engine.rewindFiles(userMessageId, false)
            if (!files.canRewind) {
              return json(res, { error: files.error ?? '文件回滚被拒绝' }, 409)
            }
            if ((files.skippedLinks ?? 0) > 0) {
              filesWarning = `有 ${files.skippedLinks} 个文件因符号链接或备份不可读等原因未被回滚，请手动检查`
            }
          }
          // 2) The rewound conversation: a fork cut at the record BEFORE the
          //    anchor. A first-message anchor has nothing before it — the
          //    rewind is then a fresh empty conversation under the same name
          //    (a draft row, bound to the same account root and cwd).
          const cut = await messageBeforeUuid(session.claudeSessionId, {
            cwd: session.cwd,
            anchorUuid: userMessageId,
          })
          const rewoundId = cut !== undefined
            ? (await forkNativeSession(session.claudeSessionId, {
              cwd: session.cwd,
              upToMessageId: cut,
              title: session.name,
            })).sessionId
            : (await this.store.create(
              { name: session.name, cwd: session.cwd },
              {
                cwd: session.cwd,
                // A pre-binding row carries no stamp; those follow the
                // effective root exactly as a fresh create would.
                configDir: session.configDir ?? this.effectiveConfig().configDir,
                accountEnv: session.accountEnv ?? this.providerScopeSnapshot(),
              },
            )).id
          // 3) Session-level settings move over: model / effort / permission
          //    / env layer are sidecar-only fields the native fork cannot
          //    carry. The fork's adopt stamps the CURRENT root's binding, so
          //    the original's binding is written over it — a session on
          //    another account rewinds onto its own account. (The draft-row
          //    path already carries its binding from the create above.)
          if (cut !== undefined) {
            await this.catalog.refresh()
            const adopted = await this.catalog.adopt(rewoundId)
            if (adopted !== undefined) {
              await this.patchMeta(adopted.id, {
                model: session.model,
                effort: session.effort,
                permissionMode: session.permissionMode,
                lastGoodModel: session.lastGoodModel,
                env: session.env,
                accountEnv: session.accountEnv,
                configDir: session.configDir,
              })
            }
          }
          // 4) Delete the original on both stores — the DELETE handler's
          //    body, minus its guards (already passed above). A native-delete
          //    failure is reported as a warning, not an error: the rewind
          //    DID happen, only the old row's cleanup is left to the user.
          let warning = filesWarning
          const key = session.id
          await this.closeEngine(key)
          if (id !== key) await this.closeEngine(id)
          this.retainedQueues.delete(key)
          if (id !== key) this.retainedQueues.delete(id)
          this.liveSeqs.delete(key)
          try {
            await deleteNativeSession(session.claudeSessionId, { cwd: session.cwd })
            await this.store.remove(key)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.ctx.logger?.warn?.(`dsh-cc: rewind left the original session ${key} behind: ${message}`)
            warning = (warning === undefined ? '' : `${warning}；`) + `对话已回退，但原会话的 CLI 记录删除失败（${message}），请手动删除原会话`
          }
          if ((await this.catalog.refresh()).changed) this.broadcastSessions()
          else this.broadcastSession(rewoundId)
          return json(res, { sessionId: rewoundId, ...(warning !== undefined ? { warning } : {}) })
        }
        if (parts.length === 3 && parts[2] === 'queue' && method === 'GET') {
          const session = this.store.get(id)
          if (!session) return json(res, { error: '会话不存在' }, 404)
          // The retained half (a dead engine's carry-over) precedes the live
          // engine's queue: those messages were queued first and deliver first.
          const retained = this.retainedQueues.get(session.id) ?? []
          const queued = this.liveEngine(session.id)?.queuedItems() ?? []
          return json(res, { items: [...retained, ...queued].map(queuedMessageView) })
        }
        if (parts.length === 4 && parts[2] === 'queue' && method === 'DELETE') {
          const session = this.store.get(id)
          if (!session) return json(res, { error: '会话不存在' }, 404)
          const uuid = parts[3] ?? ''
          // The live half's recall goes through the CLI's own dequeue control,
          // so it is the CLI that decides whether the message can still be
          // taken back; the retained half never reached a CLI at all.
          const removed = this.removeRetainedQueued(session.id, uuid)
            ?? await this.liveEngine(session.id)?.removeQueued(uuid)
          if (removed === undefined) return json(res, { error: '该消息已投递或不存在' }, 404)
          // The engine patch (when the live half served the recall) plus this
          // combined count agree in every single-half case; the belt-and-braces
          // rewrite keeps the promise when both halves are non-empty at once.
          await this.patchMeta(session.id, { queued: this.queuedTotal(session.id) })
          return json(res, { item: queuedMessageView(removed) })
        }
        if (parts.length === 5 && parts[2] === 'tasks' && parts[4] === 'messages' && method === 'POST') {
          return await this.messageTask(id, parts[3] ?? '', req, res)
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
    if (this.blobSweep !== undefined) clearInterval(this.blobSweep)
    this.storeWatch?.close()
    this.storeWatch = undefined
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
   * Refuse a session whose sidecar row was stamped under an account root
   * other than the one in force right now.
   *
   * The catalog filters such rows out of the merged list; this is the same
   * test applied where it must also gate writes. A row's `claudeSessionId`
   * only resolves inside the root it was created under, so spawning it under
   * today's root would resume nothing while the row stays invisible to the
   * page — an engine running a session nobody can see. A row with an account
   * binding is the exception that proves the rule: it carries its own root
   * and provider scope, so spawning it is spawning it under ITS root, and the
   * catalog keeps it listed. Rows written before accounts existed carry no
   * stamp and belong to the baseline root, exactly as the catalog reads them.
   * @param session - the sidecar row a send or spawn targets.
   * @throws {ScopeConflictError} when the row belongs to another account root.
   */
  private assertInScope(session: SessionMeta): void {
    if (session.accountEnv !== undefined) return
    if (!sameDir(session.configDir ?? baselineConfigDir(), this.activeConfigDir())) {
      throw new ScopeConflictError(SCOPE_CONFLICT_MESSAGE)
    }
  }

  /**
   * Create an engine for a session, claim its table slot synchronously, and
   * arm the end-of-life callback that drops it again the moment its query
   * terminates — the C1 guarantee: no path can hand a spent engine back to a
   * send.
   * @param session - the session the engine drives.
   * @param model - the model override this engine runs with.
   * @returns the registered engine.
   * @throws {ScopeConflictError} when the row belongs to another account root —
   *   the check runs here, at the last sync moment before the spawn, because
   *   an account switch can land across the send route's earlier awaits.
   */
  private startEngine(session: SessionMeta, model: string): SessionEngine {
    this.assertInScope(session)
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
    // The queue hand-off runs before the identity check: a replacement may
    // already hold the slot, but the dying engine's undelivered entries
    // belong to the session either way and must not die with the object.
    this.retainEngineQueue(id, engine)
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
    // A row stamped with another account's root is filtered out of the merged
    // list for a reason: its transcript cannot be read under the root in
    // force. Fail the send before parsing anything, and again — inside
    // startEngine — when a switch lands across the awaits below.
    try {
      this.assertInScope(session)
    } catch {
      return json(res, { error: SCOPE_CONFLICT_MESSAGE }, 409)
    }
    const body = await readJson(req)
    const text = typeof body?.text === 'string' ? body.text : ''
    const images = readImageRefs(body?.images)
    if (text.trim().length === 0 && images.length === 0) {
      return json(res, { error: '消息不能为空' }, 400)
    }
    // Shell mode (leading '!'): the line runs in the session cwd through the
    // host's own runner, its output becomes a commandOutput row, and the
    // wrapped report rides into the conversation as the CLI's shell mode
    // does. An approval posture (default/plan) refuses rather than silently
    // bypassing the posture - switch modes to run shell lines directly.
    const shellMatch = /^!\s*(.+)$/s.exec(text.trimStart())
    if (shellMatch !== null && images.length === 0) {
      const shellKey = session.id
      const shellEngine = this.liveEngine(shellKey)
      if (shellEngine === undefined) return json(res, { error: '会话没有正在运行的进程' }, 404)
      const shellMode = session.permissionMode || this.baseConfig.permissionMode
      const approve = shellMode === 'default' || shellMode === 'plan'
        ? async () => {
            await this.emitEvent(shellKey, { kind: 'notice', level: 'warning', text: '当前权限模式需要审批才能执行 shell 命令；切换到接受编辑/自动等模式后可直接运行' })
            return false
          }
        : async () => true
      await this.emitEvent(shellKey, { kind: 'user', text })
      void shellEngine.runShell(shellMatch[1] ?? '', shellMode, approve).catch(error => {
        this.ctx.logger?.warn?.('dsh-cc: shell 模式执行失败 ' + String(error))
      })
      return json(res, { ok: true }, 202)
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
    if (engine === undefined) {
      try {
        engine = this.startEngine(session, session.model)
      } catch (error) {
        // Only the scope refusal answers 409; anything else a spawn fails
        // with keeps flowing to the route's generic 500 path.
        if (error instanceof ScopeConflictError) return json(res, { error: SCOPE_CONFLICT_MESSAGE }, 409)
        throw error
      }
    }
    // A previous engine may have died holding undelivered messages — they
    // never reached the CLI, so they re-enter ahead of this send, original
    // order first. A live engine that already holds a queue keeps them ahead
    // of anything queued after the death.
    this.restoreRetainedQueue(key, engine)
    // CLI-parity titling: a page-created draft's first user message becomes
    // its name, unless the user titled the session by hand first. The
    // `claudeSessionId === undefined` guard keeps adopted CLI sessions out:
    // their sidecar rows adopt with messageCount 0 however long the real
    // conversation is, and their names already carry the CLI's own derivation
    // (customTitle → summary → firstPrompt).
    const autoTitle = deriveAutoTitle(text)
    if (autoTitle !== undefined && session.titleSource !== 'user'
      && session.messageCount === 0 && session.claudeSessionId === undefined) {
      await this.patchMeta(key, { name: autoTitle, titleSource: 'auto' })
    }
    // The transcript row is NOT written here: a message the CLI parks in its
    // command queue must not read as already sent. The engine publishes it at
    // the moment the CLI actually takes the message into a turn.
    await engine.send(text, attachments, { imageRefs: images })
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

  /**
   * Shared body of the rewind-preview and rewind endpoints: both ask a live
   * engine's control channel to restore tracked files to their state at one
   * user message, differing only in the dryRun flag. The CLI's answer is
   * passed through verbatim; a refusal (canRewind false) keeps its body but
   * answers 409 so the page's generic error path shows the CLI's own reason,
   * while a failing control channel is a plain 500.
   * @param id - the session id (page id or native id).
   * @param req - the request carrying { userMessageId }.
   * @param res - the response to answer on.
   * @param dryRun - true to preview the file changes without applying them.
   */
  private async rewindFiles(id: string, req: IncomingMessage, res: ServerResponse, dryRun: boolean): Promise<void> {
    const engine = this.liveEngine(id)
    if (engine === undefined) return json(res, { error: '先发一条消息启动会话' }, 404)
    const body = await readJson(req)
    const userMessageId = typeof body?.userMessageId === 'string' ? body.userMessageId : ''
    if (userMessageId === '') return json(res, { error: '缺少 userMessageId' }, 400)
    let result: Awaited<ReturnType<SessionEngine['rewindFiles']>>
    try {
      result = await engine.rewindFiles(userMessageId, dryRun)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json(res, { error: message }, 500)
    }
    return json(res, result, result.canRewind ? 200 : 409)
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
   * Forward one user message from a live subagent detail view.
   * @param id - the session id.
   * @param taskId - the live subagent task id.
   * @param req - request containing the text.
   * @param res - the response to write.
   */
  private async messageTask(id: string, taskId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const session = this.store.get(id) ?? this.catalog.get(id)
    if (session === undefined) return json(res, { error: '会话不存在' }, 404)
    const engine = this.liveEngine(session.id)
    if (engine === undefined) return json(res, { error: '子代理已经结束或会话进程不存在' }, 404)
    const body = await readJson(req)
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (text === '') return json(res, { error: '消息不能为空' }, 400)
    await engine.sendTaskMessage(taskId, text)
    await this.patchMeta(session.id, { status: 'busy' })
    return json(res, { ok: true })
  }

  /**
   * Apply stop/background to one live task.
   * @param id - session id.
   * @param taskId - live CLI task id.
   * @param action - `stop` or `background`.
   * @param res - HTTP response.
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
        // 上下文读数落盘：冷会话（引擎已被挤出/进程关闭后）的状态栏仍然
        // 能显示这个会话的上下窗占用量，而不是一片空白。
        const snapshot = contextSnapshot(payload.context)
        if (snapshot !== undefined) {
          void this.patchMeta(sessionId, { lastContext: snapshot }).catch(() => {})
        }
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
      const dead = this.engines.get(sessionId)
      // Replay only what was actually in flight when the process died. A
      // termination that caught no turn running has nothing to replay — the
      // last delivered message is already committed in the CLI's store — and
      // anything still queued returns through the retained hand-off below
      // instead of through a replay.
      const replay = dead?.endedBusy === true ? dead.lastSend : undefined
      if (replay === undefined) return
      const engine = this.startEngine(session, fallback)
      // Close the spent engine before the replay: closing denies whatever it
      // left pending. Its slot is already taken, so this close cannot unseat
      // the replacement. The undelivered queue is carried over first — an
      // explicitly closed engine's end-of-life callback never runs.
      if (dead !== undefined && dead !== engine) {
        this.retainEngineQueue(sessionId, dead)
        await dead.close()
      }
      await this.patchMeta(sessionId, { model: fallback, lastError: undefined, status: 'idle' })
      await this.emitEvent(sessionId, {
        kind: 'system',
        subtype: 'model-fallback',
        data: { from, to: fallback, reason: error.message },
      })
      this.ctx.logger?.warn?.(`dsh-cc: session ${sessionId} fell back to ${fallback}: ${error.message}`)
      // No transcript echo: this message already got its row when the dead
      // engine took it into the turn that then failed. Only the carry-over
      // below holds messages that never reached a CLI, and those still echo.
      await engine.send(replay.text, replay.images, { echo: false })
      // The dead engine's undelivered queue rides behind the replayed turn,
      // original order intact; the replayed message itself is not in it.
      this.restoreRetainedQueue(sessionId, engine)
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
    const engine = this.liveEngine(sessionId)
    const pendingPermissions = engine?.pendingPermissionRequests() ?? []
    const pendingDialogs = engine?.pendingDialogRequests() ?? []
    return {
      seq: this.liveSeqs.get(sessionId) ?? 0,
      turn: this.liveTurns.get(sessionId) ?? null,
      ...(pendingPermissions.length > 0 ? { pendingPermissions } : {}),
      ...(pendingDialogs.length > 0 ? { pendingDialogs } : {}),
    }
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
   * Carry a dying engine's undelivered queue into the retained map, where
   * the next engine for the session re-enters it ({@link restoreRetainedQueue}).
   * @param id - the session id; also the retained map's key.
   * @param engine - the engine whose queue to carry over.
   */
  private retainEngineQueue(id: string, engine: SessionEngine): void {
    const entries = engine.takeQueued()
    if (entries.length === 0) return
    // Entries already retained are older than anything this engine still
    // held, so they keep their place ahead of the taken ones.
    this.retainedQueues.set(id, [...(this.retainedQueues.get(id) ?? []), ...entries])
  }

  /**
   * Re-enter a session's retained queue into its current engine. Called from
   * the send paths around the send itself, so the entries keep their
   * original order relative to the new message. An engine that cannot take
   * them (already closed or dead) keeps them retained — the next engine
   * picks them up; nothing is dropped on the floor.
   * @param sessionId - the session whose retained queue applies.
   * @param engine - the engine the entries go to.
   */
  private restoreRetainedQueue(sessionId: string, engine: SessionEngine): void {
    const retained = this.retainedQueues.get(sessionId)
    if (retained === undefined) return
    if (engine.isClosed || engine.isDead) return
    this.retainedQueues.delete(sessionId)
    engine.restoreQueue(retained)
  }

  /**
   * Recall one message from the retained half of a session's queue.
   * @param id - the session id.
   * @param uuid - the queued message's id.
   * @returns the removed entry, or undefined when the retained half does not hold it.
   */
  private removeRetainedQueued(id: string, uuid: string): QueuedMessage | undefined {
    const retained = this.retainedQueues.get(id)
    if (retained === undefined) return undefined
    const index = retained.findIndex(entry => entry.uuid === uuid)
    if (index < 0) return undefined
    const [removed] = retained.splice(index, 1)
    if (retained.length === 0) this.retainedQueues.delete(id)
    return removed
  }

  /**
   * The whole undelivered count for one session: the live engine's queue
   * plus the retained carry-over — together exactly the number the sessions
   * frame's `queued` field promises.
   * @param id - the session id.
   * @returns live plus retained queued messages.
   */
  private queuedTotal(id: string): number {
    return (this.liveEngine(id)?.queuedItems().length ?? 0)
      + (this.retainedQueues.get(id)?.length ?? 0)
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
      if (meta !== undefined) this.broadcastSession(sessionId)
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-cc: 会话 ${sessionId} 的元数据未能落盘：${String(error)}`)
    }
  }

  /**
   * Push ONE session's row rather than the whole list.
   *
   * The full frame is ~142KB on a well-used machine (312 rows, measured), and
   * almost everything that moves a session moves one field of one row: a queued
   * count, a status flip, a metered cost, a resolved native id. Sending the
   * catalog for each of those was three orders of magnitude of waste per
   * change, on every attached page.
   *
   * Falls back to the full frame when the row cannot be resolved — a session
   * that left the catalog, or one another account owns — because that is a
   * structural change and the page's own list needs to shrink.
   * @param id - the session whose row moved.
   */
  private broadcastSession(id: string): void {
    const session = this.catalog.row(id)
    if (session === undefined) {
      this.broadcastSessions()
      return
    }
    this.broadcast({ t: 'session', session: this.sessionView(session) })
  }

  private broadcastSessions(): void {
    // Coalesced to one frame per tick. The frame carries the WHOLE merged list
    // — hundreds of rows on a well-used machine — while most of what triggers
    // it is a single field moving (a queued count, a status flip, a cost
    // update), and one logical change routinely fires several patches in a row:
    // a turn's result alone patches status, queued, lastGoodModel and cost. One
    // list build, one sort, one serialization, one frame.
    if (this.sessionsFramePending) return
    this.sessionsFramePending = true
    setImmediate(() => {
      this.sessionsFramePending = false
      this.broadcast({ t: 'sessions', sessions: this.sessionViews(this.catalog.list()) })
    })
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
    this.write(res, { t: 'sessions', sessions: this.sessionViews(this.catalog.list()) })
    this.clients.add(res)
    // With nobody attached the rescan runs slowly, so that cached list can be
    // most of RESCAN_IDLE_MS old. The page gets it immediately anyway — a list
    // that renders now beats a blank rail — and this forced sweep corrects it.
    this.armRescan()
    // A page joining gets the corrected list whole: it has just been handed a
    // possibly-stale cache, and reconciling that against per-row frames would
    // be more fragile than one more full frame at the one moment it is cheap.
    void this.catalog.refresh().then(result => {
      if (result.changed) this.broadcastSessions()
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
    // An explicitly closed engine's finish() skips the end-of-life callback,
    // so its undelivered queue is carried over here or never.
    this.retainEngineQueue(id, engine)
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

/**
 * The wire shape of one queued message: identity, body, enqueue time, and
 * the attachment count. The built SDK message and its base64 image bodies
 * stay host-side — a recall returns to the composer as text, never payload.
 * @param entry - the queued entry.
 * @returns the GET/DELETE response row.
 */
function queuedMessageView(entry: QueuedMessage): QueuedMessageView {
  return {
    uuid: entry.uuid,
    text: entry.text,
    queuedAt: entry.queuedAt,
    imageCount: entry.images.length,
  }
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
