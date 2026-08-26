/**
 * Adapts the Claude Agent SDK's native session store — the same
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` files the `claude`
 * CLI itself reads and writes — onto dsh-cc's `SessionMeta` shape and
 * session-mutation vocabulary.
 *
 * @module dsh-cc/native-sessions
 */

import {
  deleteSession,
  forkSession,
  getSessionInfo,
  listSessions,
  renameSession,
  type SDKSessionInfo,
} from '@anthropic-ai/claude-agent-sdk'
import type { SessionMeta } from './types.ts'

/** A native transcript touched within this window reads as a running turn. */
const RECENT_WRITE_MS = 15_000

/** Options shared by every native-session lookup and mutation below. */
export interface NativeSessionOptions {
  /**
   * Project directory to scope the operation to (the SDK's `dir`). Omitting
   * it makes lookups search every project directory and makes mutations
   * search until they find a matching session file; passing it is faster
   * and avoids ambiguity when the same session id could theoretically
   * appear under more than one project.
   */
  cwd?: string
}

/** Options for {@link listNativeSessions}. */
export interface ListNativeSessionsOptions extends NativeSessionOptions {
  /** Maximum number of sessions to return. */
  limit?: number
  /** Number of sessions to skip from the start of the sorted result set. */
  offset?: number
  /** Include git-worktree sessions when `cwd` is set. SDK default: `true`. */
  includeWorktrees?: boolean
  /**
   * Include programmatic/headless sessions (SDK entrypoints, daemons) —
   * this covers sessions dsh-cc itself creates through `query()`, since
   * they are SDK-entrypoint sessions in the same on-disk store. SDK
   * default: `true`, which is what makes a dsh-cc-created session visible
   * here with no extra bookkeeping. Left as a pass-through rather than
   * hardcoded so a caller can opt into terminal-`/resume` parity (`false`).
   */
  includeProgrammatic?: boolean
}

/**
 * List sessions from the CLI's native on-disk store.
 * @param options - project directory and pagination; omit `cwd` to list
 *   across every project directory.
 * @returns the sessions, mapped to `SessionMeta`, in the store's own order.
 */
export async function listNativeSessions(options: ListNativeSessionsOptions = {}): Promise<SessionMeta[]> {
  let infos: SDKSessionInfo[]
  try {
    infos = await listSessions({
      dir: options.cwd,
      limit: options.limit,
      offset: options.offset,
      includeWorktrees: options.includeWorktrees,
      includeProgrammatic: options.includeProgrammatic,
    })
  } catch (error) {
    throw new Error('dsh-cc: failed to list native sessions', { cause: error })
  }
  return infos.map(info => toSessionMeta(info, options.cwd))
}

/**
 * Read one session's metadata from the CLI's native on-disk store.
 * @param sessionId - native session UUID.
 * @param options - project directory to narrow the search.
 * @returns the mapped metadata, or undefined when no such session file exists.
 */
export async function getNativeSession(
  sessionId: string,
  options: NativeSessionOptions = {},
): Promise<SessionMeta | undefined> {
  let info: SDKSessionInfo | undefined
  try {
    info = await getSessionInfo(sessionId, { dir: options.cwd })
  } catch (error) {
    throw new Error(`dsh-cc: failed to read native session ${sessionId}`, { cause: error })
  }
  return info === undefined ? undefined : toSessionMeta(info, options.cwd)
}

/**
 * Map one SDK session record to dsh-cc's `SessionMeta`.
 *
 * `SDKSessionInfo` carries no model, status, message count, or cost — the
 * CLI's on-disk store does not track them at the session level — so those
 * fields take defaults appropriate to a session with no attached engine:
 * `model: ''` (plugin default), `messageCount: 0`, `totalCostUsd: 0`. Status
 * comes from the transcript file's own recency: a file appended within the
 * window is a session someone — usually a terminal CLI — is actively driving,
 * so it reports `busy` and the page shows it as running. A quiet tool call
 * inside a longer turn simply reads as idle until its next write lands.
 *
 * @param info - one record from `listSessions`/`getSessionInfo`.
 * @param cwdFallback - working directory to use when `info.cwd` is absent
 *   (e.g. the project directory a `listNativeSessions({ cwd })` call was
 *   scoped to); defaults to `''` for an unscoped cross-project lookup.
 * @returns the mapped metadata, with `id === claudeSessionId === info.sessionId`.
 */
export function toSessionMeta(info: SDKSessionInfo, cwdFallback = ''): SessionMeta {
  return {
    id: info.sessionId,
    name: deriveName(info),
    cwd: info.cwd ?? cwdFallback,
    model: '',
    createdAt: new Date(info.createdAt ?? info.lastModified).toISOString(),
    updatedAt: new Date(info.lastModified).toISOString(),
    claudeSessionId: info.sessionId,
    origin: 'cli',
    status: Date.now() - info.lastModified < RECENT_WRITE_MS ? 'busy' : 'idle',
    messageCount: 0,
    totalCostUsd: 0,
    ...(info.gitBranch !== undefined ? { gitBranch: info.gitBranch } : {}),
    ...(info.summary !== undefined ? { summary: info.summary } : {}),
  }
}

/**
 * Derive a display name for a session with no manual title.
 * @param info - the session record.
 * @returns the user's custom title, else the CLI's own summary, else the
 *   first prompt, else a timestamp label matching the shadow store's
 *   `SessionStore.create` default-name format.
 */
function deriveName(info: SDKSessionInfo): string {
  if (info.customTitle !== undefined && info.customTitle.trim().length > 0) return info.customTitle.trim()
  if (info.summary.trim().length > 0) return info.summary.trim()
  if (info.firstPrompt !== undefined && info.firstPrompt.trim().length > 0) return info.firstPrompt.trim()
  const iso = new Date(info.createdAt ?? info.lastModified).toISOString()
  return `会话 ${iso.slice(5, 16).replace('T', ' ')}`
}

/**
 * Rename a session in the CLI's native store (appends a custom-title entry
 * to its transcript file — this is visible to the `claude` CLI itself, not
 * just to dsh-cc).
 * @param sessionId - native session UUID.
 * @param title - new display title.
 * @param options - project directory to narrow the search.
 * @returns a promise that resolves once the native store carries the new title.
 */
export async function renameNativeSession(
  sessionId: string,
  title: string,
  options: NativeSessionOptions = {},
): Promise<void> {
  try {
    await renameSession(sessionId, title, { dir: options.cwd })
  } catch (error) {
    throw new Error(`dsh-cc: failed to rename native session ${sessionId}`, { cause: error })
  }
}

/**
 * Delete a session from the CLI's native store: removes its transcript
 * file and subagent-transcript subdirectory. Throws if no matching session
 * file is found.
 * @param sessionId - native session UUID.
 * @param options - project directory to narrow the search.
 * @returns a promise that resolves once the transcript file and its
 *   subagent directory are removed.
 */
export async function deleteNativeSession(sessionId: string, options: NativeSessionOptions = {}): Promise<void> {
  try {
    await deleteSession(sessionId, { dir: options.cwd })
  } catch (error) {
    throw new Error(`dsh-cc: failed to delete native session ${sessionId}`, { cause: error })
  }
}

/** Options for {@link forkNativeSession}. */
export interface ForkNativeSessionOptions extends NativeSessionOptions {
  /** Slice the transcript up to this message UUID (inclusive); omit for a full copy. */
  upToMessageId?: string
  /** Title for the fork; omit to derive one from the source title. */
  title?: string
}

/**
 * Fork a session into a new session file with fresh message UUIDs, in the
 * CLI's native store.
 * @param sessionId - native UUID of the source session.
 * @param options - project directory, branch point, and fork title.
 * @returns the new session's UUID, resumable like any native session.
 */
export async function forkNativeSession(
  sessionId: string,
  options: ForkNativeSessionOptions = {},
): Promise<{ sessionId: string }> {
  try {
    return await forkSession(sessionId, { dir: options.cwd, upToMessageId: options.upToMessageId, title: options.title })
  } catch (error) {
    throw new Error(`dsh-cc: failed to fork native session ${sessionId}`, { cause: error })
  }
}
