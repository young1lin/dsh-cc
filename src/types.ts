/**
 * Wire and persistence types shared by the dsh-cc node and browser halves.
 *
 * @module dsh-cc/types
 */

/** Lifecycle of one Claude Code conversation. */
export type SessionStatus = 'idle' | 'busy' | 'error'

/** Persisted and broadcast metadata for one session. */
export interface SessionMeta {
  /** dsh-cc session id (UUID); the Claude Code native id lives in claudeSessionId. */
  id: string
  /** Display name; defaults to a timestamp label. */
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
  status: SessionStatus
  lastError?: string
  /** Number of user messages sent. */
  messageCount: number
  totalCostUsd: number
  /** Per-session environment layered over the plugin settings; e.g. relay endpoints. */
  env?: Record<string, string>
}

/** One tool-permission request awaiting a page answer. */
export interface PermissionRequest {
  id: string
  toolName: string
  input: unknown
}

/** One transcript entry: one JSONL line and one SSE event payload. */
export type CcEvent =
  | { kind: 'user'; seq: number; ts: string; text: string }
  | { kind: 'assistant'; seq: number; ts: string; text: string }
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
    numTurns: number
    totalCostUsd: number
  }
  | { kind: 'error'; seq: number; ts: string; message: string }

/** A transcript entry before the store assigns seq/ts. */
export type CcEventInput = DistributiveOmit<CcEvent, 'seq' | 'ts'>

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** Effective plugin configuration summary; env VALUES never leave the host. */
export interface ConfigSummary {
  dataDir: string
  defaultCwd: string
  model: string
  permissionMode: string
  envKeys: string[]
  liveSessions: number
  sdkVersion: string
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

/** Server-to-browser push message (the SSE data payload). */
export type WireMessage =
  | { t: 'hello'; config: ConfigSummary }
  | { t: 'sessions'; sessions: SessionMeta[] }
  | { t: 'event'; sessionId: string; event: CcEvent }
  | { t: 'permission'; sessionId: string; request: PermissionRequest }
  | { t: 'permission-done'; sessionId: string; requestId: string; behavior: 'allow' | 'deny' }
  | { t: 'dialog'; sessionId: string; request: { id: string; kind: string; payload: Record<string, unknown> } }
  | { t: 'dialog-done'; sessionId: string; requestId: string }
