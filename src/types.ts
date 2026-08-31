/**
 * Wire and persistence types shared by the dsh-cc node and browser halves.
 *
 * The browser half cannot import `@anthropic-ai/claude-agent-sdk` (it is a
 * Node package), so every SDK-derived payload that must reach the page is
 * mirrored structurally here. The node half keeps these mirrors faithful to
 * the SDK version pinned in package.json.
 *
 * @module dsh-cc/types
 */

/** Lifecycle of one Claude Code conversation. */
export type SessionStatus = 'idle' | 'busy' | 'error'

/**
 * The full reasoning-effort ladder, used wherever a catalog row carries no
 * effort opinion of its own. The CLI marks unknown gateway models with no
 * `supportedEffortLevels` at all, and this deployment's standing rule is that
 * every model accepts the standard ladder, so absent data defaults to on
 * rather than to a disabled picker.
 */
export const DEFAULT_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** One selectable reasoning-effort level. */
export type EffortLevel = (typeof DEFAULT_EFFORT_LEVELS)[number]

/**
 * The six permission postures the CLI accepts, in wire spelling — the same
 * union the SDK's `PermissionMode` uses, mirrored so the browser half can
 * validate and label it without importing the Node-only SDK.
 */
export type PermissionModeValue = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions' | 'auto'

/** Every {@link PermissionModeValue}, for validating page-supplied input. */
export const PERMISSION_MODE_VALUES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions', 'auto'] as const

/**
 * Structured provider field names mapped onto the env var each one resolves
 * to. Shared by the node half's config resolution so the schema, the env
 * projection, and any future UI read one table instead of three diverging
 * copies. Field names match `ClaudeCodeProviderConfig` exactly.
 */
export const PROVIDER_ENV_KEYS = {
  baseUrl: 'ANTHROPIC_BASE_URL',
  authToken: 'ANTHROPIC_AUTH_TOKEN',
  apiKey: 'ANTHROPIC_API_KEY',
  model: 'ANTHROPIC_MODEL',
  opusModel: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnetModel: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haikuModel: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  smallFastModel: 'ANTHROPIC_SMALL_FAST_MODEL',
  httpsProxy: 'HTTPS_PROXY',
  httpProxy: 'HTTP_PROXY',
  noProxy: 'NO_PROXY',
  apiTimeoutMs: 'API_TIMEOUT_MS',
} as const

/** The structured provider fields {@link PROVIDER_ENV_KEYS} knows about. */
export type ProviderEnvField = keyof typeof PROVIDER_ENV_KEYS

/**
 * The env var names of {@link PROVIDER_ENV_KEYS}: the key scope a preset
 * owns while it is active. Shared by the runtime's preset composition and
 * the spawn-time deletion, so the two can never drift apart.
 */
export const PROVIDER_ENV_NAMES: readonly string[] = Object.values(PROVIDER_ENV_KEYS)

/** Values protected at rest with the current device's native credential facility. */
export const PROTECTED_ENV_NAMES: readonly string[] = [
  PROVIDER_ENV_KEYS.authToken,
  PROVIDER_ENV_KEYS.apiKey,
]

/** Opaque wire value meaning a secret exists and must be retained on save. */
export const SECRET_VALUE_SET = '__DSH_CC_SECRET_SET_V1__'

/** Opaque wire value meaning encrypted data came from another device and cannot be opened here. */
export const SECRET_VALUE_LOCKED = '__DSH_CC_SECRET_LOCKED_V1__'

/**
 * Whether an environment key names credential material that must never be
 * returned to the browser or exported in portable JSON.
 * @param key - environment variable name.
 * @returns true for token/key/secret/password/cookie variables.
 */
export function isSecretEnvKey(key: string): boolean {
  return /(TOKEN|KEY|SECRET|PASSWORD|COOKIE)$/i.test(key)
}

/**
 * Whether an environment key belongs to the narrow provider credential scope
 * encrypted at rest by dsh-cc.
 * @param key - environment variable name.
 * @returns true for Anthropic bearer-token and API-key variables.
 */
export function isProtectedEnvKey(key: string): boolean {
  return PROTECTED_ENV_NAMES.some(name => name.toUpperCase() === key.toUpperCase())
}

/**
 * Whether a browser-supplied secret value is the keep-existing sentinel.
 * @param value - submitted environment value.
 * @returns true when the host must retain its existing secret.
 */
export function isSecretPlaceholder(value: string): boolean {
  return value === SECRET_VALUE_SET || value === SECRET_VALUE_LOCKED
}

/**
 * Image media types mapped onto the file extension each one is stored under.
 * Shared by the blob store (forward direction) and the blob-serving URL
 * table (inverse), so the two can never drift apart.
 */
export const MEDIA_TYPE_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
} as const

/**
 * Which layer supplied a resolved configuration value. Later layers win:
 * a session override beats page settings, which beat the cordis plugin
 * config, which beats the environment dsh itself was launched with. An
 * active preset sits beside the page layer but owns the provider key
 * scope outright — its keys replace, its omissions remove.
 */
export type ConfigLayer = 'process' | 'plugin' | 'settings' | 'preset' | 'session' | 'account'

/**
 * One named Claude Code home. Switching to it repoints `CLAUDE_CONFIG_DIR` for
 * the whole plugin, which moves the credential, the settings file, the memory
 * and skills, the live-process registry, and the project transcripts together —
 * everything the CLI keeps under one root.
 */
export interface CcAccount {
  /** Stable id; minted by the host when a newly added row arrives without one. */
  id: string
  /** Display name; defaults to the directory's own basename. */
  name: string
  /** Absolute account root, i.e. what `CLAUDE_CONFIG_DIR` is set to. */
  dir: string
}

/** Where a session's transcript came from. */
export type SessionOrigin =
  /** Created through this page. */
  | 'dsh-cc'
  /** Discovered in the Claude Code CLI's own store, created elsewhere. */
  | 'cli'

/** Persisted and broadcast metadata for one session. */
export interface SessionMeta {
  /**
   * Stable page id. Once the CLI reports its native session id this is that
   * id, so the page, the CLI store, and `resume` all agree on one identity;
   * a session that has never run a turn carries a draft uuid instead.
   */
  id: string
  /** Display name; defaults to the CLI's own summary, else a timestamp label. */
  name: string
  /**
   * Where `name` came from. `user` marks a hand-set title nothing may
   * auto-replace; `auto` — and absent, on rows written before this flag
   * existed — marks a derived placeholder the runtime may overwrite with the
   * session's first user message, mirroring the CLI's own title behavior.
   */
  titleSource?: 'auto' | 'user'
  /** Working directory every CLI query of this session runs in. */
  cwd: string
  /** Model override for this session; empty string = Claude Code default. */
  model: string
  /**
   * Reasoning-effort override for this session; unset or empty = the resolved
   * config default. Effort is per session, not a runtime global: the page
   * renders the picker per session and a spawn reads its own session's level.
   */
  effort?: EffortLevel | ''
  /**
   * Permission-posture override for this session; unset or empty = the
   * resolved config default. Same lifecycle as `model`: persisted here,
   * spawn-time for a cold engine, hot-switched on a busy one.
   */
  permissionMode?: PermissionModeValue | ''
  /** Model id of the most recent successful turn; the fallback when a chosen model fails. */
  lastGoodModel?: string
  createdAt: string
  updatedAt: string
  /** Native Claude Code session id, learned from the init message; the resume anchor. */
  claudeSessionId?: string
  /** Which store this session came from. */
  origin: SessionOrigin
  status: SessionStatus
  lastError?: string
  /** Number of user messages sent through this page. */
  messageCount: number
  totalCostUsd: number
  /** Git branch the CLI recorded for the session, when it knows one. */
  gitBranch?: string
  /**
   * Provider-scope env captured when the row was created or adopted: the
   * endpoint, credential, tier-alias, proxy, and timeout keys a spawn started
   * at that moment would have carried. Together with `configDir` it is the
   * row's account binding — every later spawn of this session uses the
   * binding instead of whatever is globally active, so concurrent sessions
   * on different accounts cannot bleed quota or credentials into each other.
   * `{}` is a real binding ("account-direct, no provider env"); undefined
   * marks rows from before bindings existed, which keep following the
   * globally active account exactly as before.
   */
  accountEnv?: Record<string, string>
  /**
   * A live CLI process (terminal REPL, `claude -p`, another SDK client)
   * currently holds this session open, per the `~/.claude/sessions`
   * registry. The page is read-only for such a session: the other process
   * is a concurrent writer, and no signal of ours can reach its turn.
   */
  terminalOwned?: boolean
  /** The CLI's own one-line summary of the conversation. */
  summary?: string
  /**
   * Messages the live CLI process holds queued for this session — sent while a
   * turn was already running, waiting to drain into the next model call. Live
   * state only: cleared when the engine dies.
   */
  queued?: number
  /** Per-session environment layered over the plugin settings; e.g. relay endpoints. */
  env?: Record<string, string>
  /**
   * The Claude Code home this row's conversation lives under, stamped at
   * creation. A row belongs to exactly one account root, because its
   * `claudeSessionId` only resolves inside that root's `projects/` tree, so
   * the catalog shows only the rows matching the active root — without this
   * an account switch would leave the previous account's rows on the rail as
   * orphans whose transcripts cannot be read and whose sends cannot resume.
   *
   * Absent on rows written before accounts existed; those belong to the
   * baseline root.
   */
  configDir?: string
}

/**
 * One host-held queued message as the queue endpoints serve it: a message
 * submitted while a turn was running, still waiting for its model-call
 * boundary. The built SDK payload — base64 image bodies included — never
 * leaves the host; the page recalls by text, so only the count rides along.
 */
export interface QueuedMessageView {
  /** Stable per-message id, minted at submit time; the recall target. */
  uuid: string
  /** The message body verbatim, so a recall can refill the composer. */
  text: string
  /** When the message joined the queue (ISO timestamp). */
  queuedAt: string
  /** How many images the queued message carries. */
  imageCount: number
}

/**
 * Where an accepted permission rule is written. `session` dies with the CLI
 * process, `localSettings` is the gitignored per-project file, `projectSettings`
 * is checked in, and `userSettings` applies to every project.
 */
export type PermissionDestination =
  | 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg'

/**
 * A permission rule the CLI proposes so the page can offer "always allow".
 * Structural mirror of the SDK's `PermissionUpdate`; the node half passes
 * these through unchanged in both directions.
 */
export type PermissionSuggestion =
  | {
    type: 'addRules' | 'replaceRules' | 'removeRules'
    rules: { toolName: string; ruleContent?: string }[]
    behavior: 'allow' | 'deny' | 'ask'
    destination: PermissionDestination
  }
  | { type: 'setMode'; mode: string; destination: PermissionDestination }
  | { type: 'addDirectories' | 'removeDirectories'; directories: string[]; destination: PermissionDestination }

/** One tool-permission request awaiting a page answer. */
export interface PermissionRequest {
  id: string
  toolName: string
  input: unknown
  /** The CLI's own prompt sentence, e.g. "Claude wants to read foo.txt". */
  title?: string
  /** The CLI's short action label, e.g. "Read file". */
  displayName?: string
  /** The CLI's human subtitle explaining what access is granted. */
  description?: string
  /** Rule bundle that makes this decision permanent; absent = one-shot only. */
  suggestions?: PermissionSuggestion[]
  /** Path that tripped a deny rule, when the request is a blocked access. */
  blockedPath?: string
  /** Why the CLI is asking rather than auto-deciding. */
  decisionReason?: string
}

/** The page's answer to one permission request. */
export interface PermissionAnswer {
  behavior: 'allow' | 'deny'
  /**
   * Free text relayed to the model: on allow it arrives after the result, on
   * deny it is the refusal reason. Empty = no note.
   */
  message?: string
  /**
   * Persist the request's `suggestions` at this destination. Absent = decide
   * this one call only. Callers must not pass it for a request that carried no
   * suggestions, since there would be no rule to write.
   */
  remember?: PermissionDestination
}

/** Per-turn token accounting, mirrored from the SDK result message. */
export interface TurnUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

/** One image attached to a user message; bytes live beside the transcript. */
export interface ImageRef {
  /** Content-addressed blob id under the store's `blobs/` directory. */
  id: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  /** Original file name when the image came from a file rather than the clipboard. */
  name?: string
  bytes: number
}

/** One transcript entry: one JSONL line and one SSE event payload. */
export type CcEvent =
  | {
    kind: 'user'
    seq: number
    ts: string
    text: string
    images?: ImageRef[]
    /**
     * The CLI transcript record's own UUID, when this row was mapped from a
     * native session file — the anchor the fork and file-rewind endpoints
     * address. Absent on rows that only ever lived in the sidecar.
     */
    nativeMessageId?: string
  }
  | { kind: 'assistant'; seq: number; ts: string; text: string; error?: string; aborted?: boolean }
  | { kind: 'thinking'; seq: number; ts: string; text: string }
  | { kind: 'tool_use'; seq: number; ts: string; toolUseId: string; name: string; input: unknown }
  | { kind: 'tool_result'; seq: number; ts: string; toolUseId: string; text: string; isError: boolean }
  | { kind: 'system'; seq: number; ts: string; subtype: string; data: Record<string, unknown> }
  /**
   * A compaction boundary the CLI wrote into the native transcript: the
   * conversation was summarized here, and the token counts straddle the cut.
   */
  | {
    kind: 'compactBoundary'
    seq: number
    ts: string
    /** What caused the compaction, e.g. `manual` (`/compact`) or `auto`. */
    trigger: string
    /** Context tokens before the cut, when the CLI recorded them. */
    preTokens?: number
    /** Context tokens after the cut, when the CLI recorded them. */
    postTokens?: number
    /** Tokens dropped by compactions so far in this session, when recorded. */
    cumulativeDroppedTokens?: number
  }
  /** Output of a local slash command (`/compact`, `/usage`, …) — no model turn ran. */
  | { kind: 'commandOutput'; seq: number; ts: string; text: string }
  /** A loop banner: hook feedback, slash-command notices; level picks the styling. */
  | { kind: 'notice'; seq: number; ts: string; text: string; level: 'notice' | 'suggestion' | 'warning' }
  | {
    kind: 'result'
    seq: number
    ts: string
    subtype: string
    text: string
    isError: boolean
    durationMs: number
    /** Wall-clock time spent inside model requests, when the CLI reports it. */
    apiDurationMs?: number
    numTurns: number
    totalCostUsd: number
    /** Human-readable reasons a turn stopped abnormally (max turns, budget, retries). */
    errors?: string[]
    /** The CLI's terminal-reason tag, e.g. `budget_exhausted`, `max_turns`. */
    terminalReason?: string
    /** Token counts for this turn. */
    usage?: TurnUsage
  }
  | { kind: 'error'; seq: number; ts: string; message: string }

/** A transcript entry before the store assigns seq/ts. */
export type CcEventInput = DistributiveOmit<CcEvent, 'seq' | 'ts'>

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/**
 * One incremental piece of a turn, pushed while the model is still writing.
 * Deltas are never persisted: the final `CcEvent` carrying the same content is
 * the authoritative record, and the page drops its delta buffer once that
 * arrives. Deltas ARE folded in memory on both halves, so a page that joins
 * mid-turn is handed the folded turn instead of missing the earlier frames.
 */
export type StreamDelta =
  /** A new assistant message began; `messageId` correlates it with the final event. */
  | { d: 'turn-start'; messageId: string; ttftMs?: number }
  /** A content block opened at `index`; tool blocks carry their identity up front. */
  | { d: 'block-start'; index: number; type: 'text' | 'thinking' | 'tool_use'; toolName?: string; toolUseId?: string }
  | { d: 'text'; index: number; text: string }
  | { d: 'thinking'; index: number; text: string }
  /**
   * A fragment of a tool call's JSON arguments. Fragments only parse once
   * concatenated through the block's `block-stop`, so a consumer must not
   * parse them incrementally.
   */
  | { d: 'tool-input'; index: number; partialJson: string }
  | { d: 'block-stop'; index: number }
  | { d: 'turn-stop'; stopReason?: string }
  /**
   * A CLI status flip (SDKStatusMessage): most visibly `compacting` while a
   * /compact or auto-compact runs, back to null when it settles. Transient
   * display state — folded into the live turn, never persisted.
   */
  | { d: 'status'; phase: 'compacting' | 'requesting' | null }

/** One environment variable as it will actually reach the claude process. */
export interface EffectiveEnvEntry {
  key: string
  /** Secret-looking values arrive masked; the raw value never leaves the host. */
  value: string
  masked: boolean
  /** Which configuration layer supplied the winning value. */
  layer: ConfigLayer
}

/** Who the CLI is authenticated as, when it can tell us. */
export interface AccountSummary {
  email?: string
  organization?: string
  /** `pro` / `max` / `team` / `enterprise`, or absent for API-key and gateway auth. */
  subscriptionType?: string
  /** Where the credential came from, e.g. `ANTHROPIC_AUTH_TOKEN`. */
  tokenSource?: string
  /** The upstream the CLI resolved, e.g. `firstParty`, `bedrock`. */
  apiProvider?: string
}

/** Effective plugin configuration summary; secret env VALUES are masked. */
export interface ConfigSummary {
  dataDir: string
  defaultCwd: string
  model: string
  permissionMode: string
  /** Every variable layered onto the claude process, with its winning layer. */
  env: EffectiveEnvEntry[]
  liveSessions: number
  sdkVersion: string
  account?: AccountSummary
  /** The Claude Code home in force; where sessions, credentials, and memory are read. */
  configDir: string
  /**
   * The home that applies when no account is selected: the cordis config's, else
   * what dsh was launched with. Distinct from {@link ConfigSummary.configDir},
   * which is whatever is active right now.
   */
  defaultConfigDir: string
  /** The configured account roots the page can switch between. */
  accounts: CcAccount[]
  /** The selected account's id; empty means the cordis/host default root. */
  activeAccountId: string
}

/** Page-editable runtime settings, layered over the cordis config. */
export interface CcSettings {
  /** Default model id; empty = keep the cordis config default. */
  model: string
  /** Permission posture; empty = keep the cordis config default. */
  permissionMode: string
  /**
   * Environment for the claude process, layered over the cordis config env per
   * key. `CLAUDE_CONFIG_DIR` is refused here — the account list owns it, and an
   * env entry would move the spawned process without moving the plugin's own
   * reads.
   */
  env: Record<string, string>
  /**
   * Named provider-env bundles the settings page switches between. While
   * {@link activePresetId} names one, it owns the provider key scope: its
   * keys replace every other layer, its omissions remove the key entirely —
   * including one inherited from the environment dsh itself was launched
   * with, which per-key layering can never express.
   */
  presets: EnvPreset[]
  /** The preset in force; empty = none, and `env` layers per key as before. */
  activePresetId: string
  /** Account roots the page can switch between. */
  accounts: CcAccount[]
  /** The selected account's id; empty = the cordis/host default root. */
  activeAccountId: string
}

/**
 * One named bundle of the provider-scope environment. Two seeded presets —
 * a logged-in account with nothing but the proxy, and a gateway relay —
 * are the switch this exists for; more can be saved from the form.
 */
export interface EnvPreset {
  /** Stable id; the seeded ones keep theirs across saves. */
  id: string
  /** Display name. */
  name: string
  /** The provider-scope env keys this preset applies; an empty value removes the key. */
  env: Record<string, string>
}

/** One entry of a directory listing. */
export interface DirEntry {
  name: string
  directory: boolean
}

/** One browsable directory page. */
export interface DirListing {
  /** Absolute path; empty string denotes the drive/root level. */
  path: string
  /** Parent path; null at the root level. */
  parent: string | null
  entries: DirEntry[]
  /** True when the page cap cut the level short of every entry. */
  truncated: boolean
}

/**
 * Directory names the mention menu's index walk, the menu's directory
 * navigation, and the send-time folder tree never enter: VCS metadata,
 * dependency/build caches, tool state, and dot-directories. This single
 * regex is the ignore authority for everything @-mention — the menu never
 * offers what an injection would skip, and no copy of the list drifts.
 */
export const SKIPPED_DIR = new RegExp([
  '^(?:node_modules|\\.git|\\.hg|\\.svn|dist|build|out|coverage|venv|__pycache__|target)$',
  '|^(?:\\.next|\\.nuxt|\\.turbo|\\.cache|\\.venv|\\.mypy_cache|\\.pytest_cache|\\.gradle|\\.idea|\\.vs)$',
  '|^[.]',
].join(''))

/** One row of the project file index: a workspace-relative POSIX path. */
export interface FileIndexRow {
  /** Path relative to the walk root, forward slashes, no leading separator. */
  path: string
  /** Present on folder rows: the pick inserts a listing reference. */
  directory?: true
}

/** One project's bounded menu index as GET /fs/index serves it. */
export interface FileIndex {
  rows: FileIndexRow[]
  /** True when a bound (rows / width / depth) cut the walk short. */
  truncated: boolean
}

/** One selectable slash command, mirrored from the CLI's own catalog. */
export interface SlashCommand {
  /** Command name without the leading slash. */
  name: string
  description: string
  /** Argument placeholder, e.g. `<file>`; empty when the command takes none. */
  argumentHint: string
  aliases?: string[]
}

/** One content block of the in-flight turn, accumulated from its deltas. */
export interface LiveBlock {
  index: number
  type: 'text' | 'thinking' | 'tool_use'
  /** Accumulated text; empty for a tool block, whose arguments stay unparsed. */
  text: string
  toolName?: string
  toolUseId?: string
  /** True once the block's `block-stop` arrived. */
  closed: boolean
}

/** The assistant turn currently being written. */
export interface LiveTurn {
  messageId: string
  /** Milliseconds from request to first token, when the CLI reported it. */
  ttftMs?: number
  blocks: LiveBlock[]
  /** True once `turn-stop` arrived; the turn stays visible until it commits. */
  stopped: boolean
  /** The CLI's last reported activity phase, e.g. compacting; absent when idle-normal. */
  status?: 'compacting' | 'requesting'
}

/**
 * The folded in-flight turn of one session, as the server hands it to a page
 * that arrives mid-turn (session fetch) and as the page reconciles against its
 * own fold.
 */
export interface LiveTurnSnapshot {
  /** Monotonic per-session delta counter at the moment of the snapshot. */
  seq: number
  /** The folded turn, or null when no turn is in flight. */
  turn: LiveTurn | null
  /**
   * Tool-permission requests parked awaiting a page answer when the snapshot
   * was taken. A page that opens (or catches up) mid-request replays them as
   * approval cards; the wire omits the field entirely on older node halves.
   */
  pendingPermissions?: PermissionRequest[]
  /** Question bridges still open at snapshot time, same replay contract. */
  pendingDialogs?: PendingDialogRequest[]
}

/** A dialog bridge request as snapshots and replays carry it. */
export interface PendingDialogRequest {
  id: string
  kind: string
  payload: Record<string, unknown>
}

/** One row of a session's live task table, folded from the CLI's task frames. */
export interface TaskRow {
  /** The CLI's task id; joins control calls back to the process. */
  id: string
  /** Task discriminant: `subagent`, `shell`, `monitor`, `workflow`, … */
  type: string
  status: 'running' | 'paused' | 'completed' | 'failed' | 'killed' | 'stopped'
  /** The model's own statement of what the task is for. */
  description: string
  /** The tool_use block that started the task, when the CLI reported one. */
  toolUseId?: string
  /** Subagent preset name, for `subagent` tasks. */
  subagentType?: string
  /** Joins the transcript Task/Bash card. */
  prompt?: string
  tokens: number
  toolUses: number
  durationMs: number
  lastToolName?: string
  summary?: string
  isBackgrounded?: boolean
  error?: string
}

/** The task statuses that end a task's life. */
export const TERMINAL_TASK_STATUSES = ['completed', 'failed', 'killed', 'stopped'] as const

/** Server-to-browser push message (the SSE data payload). */
export type WireMessage =
  | { t: 'hello'; config: ConfigSummary }
  | { t: 'sessions'; sessions: SessionMeta[] }
  /**
   * One session's row moved. Carries the same merged shape a `sessions` frame
   * would give this row (see `SessionCatalog.row`), so the page can replace it
   * in place; it says NOTHING about the rest of the list, so a receiver must
   * not use it to prune sessions the way a full frame does.
   */
  | { t: 'session'; session: SessionMeta }
  | { t: 'event'; sessionId: string; event: CcEvent }
  | { t: 'delta'; sessionId: string; seq: number; delta: StreamDelta }
  | { t: 'permission'; sessionId: string; request: PermissionRequest }
  | { t: 'permission-done'; sessionId: string; requestId: string; behavior: 'allow' | 'deny' }
  | { t: 'dialog'; sessionId: string; request: { id: string; kind: string; payload: Record<string, unknown> } }
  | { t: 'dialog-done'; sessionId: string; requestId: string }
  | { t: 'tasks'; sessionId: string; tasks: TaskRow[] }
  /**
   * Telemetry refreshed after one completed model response (the statusline
   * cadence). Payloads are the CLI control channel's answers, passed through
   * in the same shape the /context and /usage endpoints return.
   */
  | { t: 'telemetry'; sessionId: string; context?: unknown; usage?: unknown }
