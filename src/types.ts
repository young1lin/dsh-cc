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

/**
 * Which layer supplied a resolved configuration value. Later layers win:
 * a session override beats page settings, which beat the cordis plugin
 * config, which beats the environment dsh itself was launched with.
 */
export type ConfigLayer = 'process' | 'plugin' | 'settings' | 'session'

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
  /** Working directory every CLI query of this session runs in. */
  cwd: string
  /** Model override for this session; empty string = Claude Code default. */
  model: string
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
  /** The CLI's own one-line summary of the conversation. */
  summary?: string
  /** Per-session environment layered over the plugin settings; e.g. relay endpoints. */
  env?: Record<string, string>
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
  | { kind: 'user'; seq: number; ts: string; text: string; images?: ImageRef[] }
  | { kind: 'assistant'; seq: number; ts: string; text: string; error?: string; aborted?: boolean }
  | { kind: 'thinking'; seq: number; ts: string; text: string }
  | { kind: 'tool_use'; seq: number; ts: string; toolUseId: string; name: string; input: unknown }
  | { kind: 'tool_result'; seq: number; ts: string; toolUseId: string; text: string; isError: boolean }
  | { kind: 'system'; seq: number; ts: string; subtype: string; data: Record<string, unknown> }
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
}

/** Page-editable runtime settings, layered over the cordis config. */
export interface CcSettings {
  /** Default model id; empty = keep the cordis config default. */
  model: string
  /** Permission posture; empty = keep the cordis config default. */
  permissionMode: string
  /** Environment for the claude process; replaces the cordis config env when non-empty. */
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
}

/** Server-to-browser push message (the SSE data payload). */
export type WireMessage =
  | { t: 'hello'; config: ConfigSummary }
  | { t: 'sessions'; sessions: SessionMeta[] }
  | { t: 'event'; sessionId: string; event: CcEvent }
  | { t: 'delta'; sessionId: string; seq: number; delta: StreamDelta }
  | { t: 'permission'; sessionId: string; request: PermissionRequest }
  | { t: 'permission-done'; sessionId: string; requestId: string; behavior: 'allow' | 'deny' }
  | { t: 'dialog'; sessionId: string; request: { id: string; kind: string; payload: Record<string, unknown> } }
  | { t: 'dialog-done'; sessionId: string; requestId: string }
