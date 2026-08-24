/**
 * The session catalog: one list over the Claude Code CLI's own on-disk store
 * plus the sidecar records dsh-cc keeps for what that store cannot represent.
 *
 * The CLI's store is authoritative for identity, titles, and transcripts, so
 * every conversation exists exactly once and every project the user has ever
 * run `claude` in is reachable from the page. The sidecar holds only the
 * fields the CLI has no place for — the session's model override, its
 * environment layer, its live status, and the cost dsh-cc has metered — plus
 * the transcripts of drafts that have not yet started a CLI session.
 *
 * A session is matched across the two stores by its native id: a sidecar
 * record carries it in `claudeSessionId` once the CLI reports one, and until
 * then the record is a draft that exists only here.
 *
 * @module dsh-cc/catalog
 */

import type { BlobStore } from './blobs.ts'
import { listNativeSessions } from './native-sessions.ts'
import { readNativeTranscript } from './native-transcript.ts'
import type { SessionStore } from './store.ts'
import type { CcEvent, SessionMeta } from './types.ts'

/**
 * Whether one transcript event has no counterpart in the CLI's own store and
 * must therefore be kept in the sidecar.
 *
 * The CLI records the conversation itself, so `user`, `assistant`, `thinking`,
 * and tool events would be stored twice. What remains is what dsh-cc
 * synthesises: its own failures, and the status notices it writes about how it
 * is running the session. `system/init` is excluded even though the CLI does
 * not record it — a fresh one is emitted every time an engine starts, so
 * keeping them would grow one stale "connected" line per turn.
 *
 * @param kind - the event kind.
 * @param subtype - the `system` event subtype, when the event has one.
 * @returns true when only the sidecar can hold the event.
 */
function sidecarOnly(kind: string, subtype: string | undefined): boolean {
  if (kind === 'error') return true
  return kind === 'system' && subtype !== 'init'
}

/**
 * A merged view over the CLI's session store and the dsh-cc sidecar.
 *
 * `list` is synchronous so the HTTP routes and the SSE broadcast can serve a
 * complete list without awaiting disk; it reads a cache that {@link refresh}
 * repopulates. A stale cache costs at most one list that misses a session
 * created outside the page since the last refresh.
 */
export class SessionCatalog {
  /** Native sessions from the last {@link refresh}, most recent first. */
  private native: SessionMeta[] = []
  /** Last-refresh fingerprint; equal strings mean nothing native moved. */
  private signature = ''

  /**
   * @param store - the dsh-cc sidecar.
   * @param blobs - where inline images from a native transcript are rehydrated.
   */
  constructor(
    private readonly store: SessionStore,
    private readonly blobs: BlobStore,
  ) {}

  /**
   * Re-read the CLI's session store across every project directory.
   *
   * A failure here is not fatal: the CLI store may be absent on a machine that
   * has only ever run Claude Code through this page, and the sidecar alone
   * still serves a working list.
   * @returns whether anything native changed — a moved `updatedAt` or a
   *   flipped status — so a poller can skip broadcasting a quiet store.
   */
  async refresh(): Promise<boolean> {
    let fresh: SessionMeta[]
    try {
      fresh = await listNativeSessions()
    } catch {
      // No readable CLI store: the sidecar list stands on its own.
      return false
    }
    this.native = fresh
    const signature = JSON.stringify(fresh.map(meta => `${meta.id}\n${meta.updatedAt}\n${meta.status}`))
    if (signature === this.signature) return false
    this.signature = signature
    return true
  }

  /**
   * Every session from both stores, most recently updated first.
   *
   * A session present in both is emitted once, with the sidecar's operational
   * fields over the CLI's identity fields.
   * @returns the merged list.
   */
  list(): SessionMeta[] {
    const sidecar = this.store.list()
    const adopted = new Map<string, SessionMeta>()
    for (const meta of sidecar) {
      if (meta.claudeSessionId !== undefined) adopted.set(meta.claudeSessionId, meta)
    }
    const merged = [
      ...sidecar,
      ...this.native.filter(meta => !adopted.has(meta.id)),
    ]
    for (const meta of this.native) {
      const own = adopted.get(meta.id)
      if (own !== undefined) mergeNativeInto(own, meta)
    }
    return merged.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /**
   * One session by page id, from either store.
   * @param id - the page id: a sidecar id, or a native session id.
   * @returns the session, or undefined when neither store has it.
   */
  get(id: string): SessionMeta | undefined {
    return this.store.get(id) ?? this.native.find(meta => meta.id === id)
  }

  /**
   * Make a CLI-created session usable from the page by giving it a sidecar
   * record, so it can carry a model override, an environment layer, and live
   * status like any session started here. Adopting resumes the existing CLI
   * conversation rather than starting a new one.
   *
   * Idempotent: a session that already has a sidecar record is returned as-is.
   * @param id - the native session id.
   * @returns the sidecar record, or undefined when no such native session exists.
   */
  async adopt(id: string): Promise<SessionMeta | undefined> {
    const existing = this.store.get(id)
    if (existing !== undefined) return existing
    const native = this.native.find(meta => meta.id === id)
    if (native === undefined) return undefined
    return await this.store.adopt({ ...native, claudeSessionId: native.id, origin: 'cli' })
  }

  /**
   * One session's transcript.
   *
   * A session the CLI knows reads from the CLI's own store, so the page shows
   * the same conversation `claude --resume` would; dsh-cc's operational
   * notices are merged in from the sidecar. A draft that has never started a
   * CLI session reads from the sidecar alone.
   * @param meta - the session to read.
   * @param limit - maximum events to return, newest kept.
   * @returns the transcript in order.
   */
  async transcript(meta: SessionMeta, limit = 800): Promise<CcEvent[]> {
    if (meta.claudeSessionId === undefined) return await this.store.transcript(meta.id, limit)
    let native: CcEvent[]
    try {
      native = await readNativeTranscript(meta.claudeSessionId, {
        cwd: meta.cwd,
        limit,
        storeImage: (mediaType, base64) => this.blobs.put(Buffer.from(base64, 'base64'), mediaType),
      })
    } catch {
      // The CLI file was removed or is mid-write; the sidecar is all we have.
      return await this.store.transcript(meta.id, limit)
    }
    const notices = (await this.store.transcript(meta.id, limit))
      .filter(event => sidecarOnly(event.kind, event.kind === 'system' ? event.subtype : undefined))
    if (notices.length === 0) return native
    return [...native, ...notices].sort((a, b) => a.ts.localeCompare(b.ts))
  }

  /**
   * Whether one transcript event still belongs in the sidecar.
   *
   * A draft the CLI has never seen is stored here in full, because nothing
   * else holds it. Once the CLI owns the conversation only the events dsh-cc
   * synthesises are kept, so no message is stored twice and the two copies
   * cannot drift.
   * @param meta - the session the event belongs to.
   * @param event - the event about to be persisted.
   * @returns true when the sidecar must persist the event.
   */
  static persists(meta: SessionMeta | undefined, event: CcEvent): boolean {
    if (meta?.claudeSessionId === undefined) return true
    return sidecarOnly(event.kind, event.kind === 'system' ? event.subtype : undefined)
  }
}

/**
 * Fold the CLI's identity fields into a sidecar record in place. The CLI owns
 * the summary, the branch, and the recorded activity time; the sidecar owns
 * everything about how dsh-cc runs the session.
 * @param own - the sidecar record to update.
 * @param native - the CLI's record for the same session.
 */
function mergeNativeInto(own: SessionMeta, native: SessionMeta): void {
  if (native.summary !== undefined) own.summary = native.summary
  if (native.gitBranch !== undefined) own.gitBranch = native.gitBranch
  if (native.updatedAt.localeCompare(own.updatedAt) > 0) own.updatedAt = native.updatedAt
}
