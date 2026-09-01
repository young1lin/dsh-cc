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

import { baselineConfigDir, sameDir } from './accounts.ts'
import type { BlobStore } from './blobs.ts'
import { listNativeSessions } from './native-sessions.ts'
import { encodeProjectDir, readNativeTranscript } from './native-transcript.ts'
import type { PeerSession } from './peer-sessions.ts'
import { readPeerSessions } from './peer-sessions.ts'
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
  // Local-command output and loop banners are display-only in the CLI — it
  // never writes them to its transcript — so the sidecar is their only
  // durable home.
  if (kind === 'commandOutput' || kind === 'notice' || kind === 'subagent') return true
  return kind === 'system' && subtype !== 'init'
}

/** What one catalog refresh found. */
export interface CatalogRefresh {
  /** Whether anything moved at all; false means skip broadcasting entirely. */
  changed: boolean
  /**
   * Whether the SET of sessions changed — one appeared or disappeared. No
   * per-row frame can express that, so the caller must send the whole list.
   */
  structural: boolean
  /** Native ids of rows that changed in place; broadcast one frame each. */
  moved: string[]
}

/** The answer for a sweep that found nothing, or could not run at all. */
const QUIET_REFRESH: CatalogRefresh = { changed: false, structural: false, moved: [] }

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
  /**
   * Per-session fingerprint from the last {@link refresh}, keyed by native id.
   *
   * Per session rather than one string over the whole store, because "did
   * anything change" is the wrong question to answer: a terminal appending to
   * ONE transcript moved one row, and answering only "yes" forced a full
   * session-list broadcast — 135KB on this machine — for a row that fits in
   * under a kilobyte. The map answers "which rows moved".
   */
  private signatures = new Map<string, string>()
  /**
   * The refresh currently running, if any. The rescan timer and concurrent
   * requests all funnel through {@link refresh}; sharing one sweep keeps the
   * cache mutation (native array + signature) single-threaded and spares the
   * disk a second identical sweep per tick.
   */
  private refreshInFlight: Promise<CatalogRefresh> | undefined
  /**
   * Live terminal writers under roots OTHER than the active one, keyed by
   * normalized root path, as sets of native session ids. Bound sessions on
   * those roots need their ownership answered too — the send and delete gates
   * read it — and their registry lives in their own root, not the active one.
   */
  private foreignPeers = new Map<string, Set<string>>()

  /**
   * Re-read the live-process registries of every non-active root that bound
   * sidecar rows point at.
   *
   * Usually zero or one extra directory read per refresh; roots with no bound
   * rows are not touched, so an account that once had sessions here costs
   * nothing after they are gone.
   * @returns nothing; {@link foreignPeers} is replaced on success. A failed
   *   root read keeps that root's previous answer rather than failing the
   *   whole refresh.
   */
  private async refreshForeignPeers(): Promise<void> {
    const roots = new Map<string, string>()
    for (const meta of this.store.list()) {
      if (meta.accountEnv === undefined || meta.claudeSessionId === undefined) continue
      if (meta.configDir === undefined || sameDir(meta.configDir, this.activeConfigDir())) continue
      roots.set(this.rootKey(meta.configDir), meta.configDir)
    }
    if (roots.size === 0) {
      this.foreignPeers = new Map()
      return
    }
    const next = new Map<string, Set<string>>()
    await Promise.all([...roots.entries()].map(async ([key, dir]) => {
      try {
        const peers = await readPeerSessions(dir)
        next.set(key, new Set(peers.keys()))
      } catch {
        next.set(key, this.foreignPeers.get(key) ?? new Set())
      }
    }))
    this.foreignPeers = next
  }

  /**
   * Normalize a root path for {@link foreignPeers} keying.
   * @param root - the absolute account root.
   * @returns the map key for that root.
   */
  private rootKey(root: string): string {
    return process.platform === 'win32' ? root.toLowerCase() : root
  }

  /**
   * Stamp terminal ownership onto one merged row whose root is not active.
   *
   * Active-root rows get their ownership from the native merge; a bound row on
   * another root has no native counterpart here, so its answer comes from
   * {@link foreignPeers}. Our own engines never count as terminal writers.
   * @param row - the merged copy about to be returned to the page.
   */
  private stampForeignOwnership(row: SessionMeta): void {
    if (row.accountEnv === undefined || row.claudeSessionId === undefined) return
    if (row.configDir === undefined || sameDir(row.configDir, this.activeConfigDir())) return
    const owned = this.foreignPeers.get(this.rootKey(row.configDir))?.has(row.claudeSessionId) === true
    row.terminalOwned = owned && !this.drivesNative(row.claudeSessionId)
  }

  /**
   * @param store - the dsh-cc sidecar.
   * @param blobs - where inline images from a native transcript are rehydrated.
   * @param drivesNative - whether one of the HOST's own engines currently
   *   holds a native session open. Those engines register in the CLI's
   *   live-process registry under the same session id a terminal would, so
   *   without this the two are indistinguishable and ownership can only be
   *   answered by refusing to answer it.
   * @param activeConfigDir - the Claude Code home currently in force. Read
   *   through a callback rather than captured, because switching accounts
   *   moves it under a catalog that outlives the switch.
   * @param accountEnv - the provider-scope environment in force right now,
   *   stamped onto rows this catalog adopts (the binding a spawn of them
   *   will use from then on). Also a callback, for the same reason.
   */
  constructor(
    private readonly store: SessionStore,
    private readonly blobs: BlobStore,
    private readonly drivesNative: (claudeSessionId: string) => boolean = () => false,
    private readonly activeConfigDir: () => string = baselineConfigDir,
    private readonly accountEnv: () => Record<string, string> = () => ({}),
  ) {}

  /**
   * Drop the cached native view so the next {@link refresh} is a cold read
   * that always reports a change.
   *
   * The signature exists to suppress broadcasts for a quiet store, but after
   * an account switch the store is not quiet — it is a different store, and a
   * coincidentally equal signature would leave the page on the old account's
   * list.
   */
  invalidate(): void {
    this.native = []
    this.signatures.clear()
  }

  /**
   * Whether one sidecar row belongs to the Claude Code home in force.
   *
   * A row's `claudeSessionId` only resolves inside the root it was created
   * under — unless the row carries an account binding, whose stamped root and
   * provider scope are exactly what a spawn of it uses, transcript reads
   * included. Bound rows therefore stay listed and usable whatever root is
   * active; rows written before bindings existed carry no stamp and follow
   * the active root as before.
   * @param meta - the sidecar row.
   * @returns true when the row is in scope for the active root.
   */
  private inScope(meta: SessionMeta): boolean {
    return meta.accountEnv !== undefined
      || sameDir(meta.configDir ?? baselineConfigDir(), this.activeConfigDir())
  }

  /**
   * Re-read the CLI's session store across every project directory and the
   * live-process registry alongside it.
   *
   * Single-flight: while one sweep runs, every further caller (the rescan
   * timer, a concurrent request) joins it instead of starting an overlapping
   * sweep over the same mutable cache.
   *
   * A failure here is not fatal: the CLI store may be absent on a machine
   * that has only ever run Claude Code through this page, and the sidecar
   * alone still serves a working list.
   * @returns what moved: nothing, a set of rows, or the list itself. A caller
   *   broadcasts per row when only `moved` is populated and the whole list only
   *   when `structural` says the set of sessions itself changed.
   */
  async refresh(): Promise<CatalogRefresh> {
    const running = this.refreshInFlight
    if (running !== undefined) return await running
    const run = this.refreshOnce()
      .catch((error: unknown) => {
        // The sweep must never reject: callers hang `void ...then(...)` off it.
        console.warn('dsh-cc: 会话目录刷新失败', error)
        return QUIET_REFRESH
      })
      .finally(() => {
        this.refreshInFlight = undefined
      })
    this.refreshInFlight = run
    return await run
  }

  /**
   * One disk sweep; only ever reached through the single-flight guard in
   * {@link refresh}, so its await points never interleave with another
   * refresh writing the same cache.
   */
  private async refreshOnce(): Promise<CatalogRefresh> {
    let fresh: SessionMeta[]
    let peers: Map<string, PeerSession>
    try {
      ;[fresh, peers] = await Promise.all([listNativeSessions(), readPeerSessions()])
    } catch {
      // No readable CLI store: the sidecar list stands on its own.
      return QUIET_REFRESH
    }
    await this.refreshForeignPeers()
    this.applyPeers(fresh, peers)
    this.native = fresh
    return this.commit(fresh)
  }

  /**
   * Re-read ONLY the project directories that changed.
   *
   * This is why the store is watched rather than polled. A terminal appending
   * to one transcript changes one directory; enumerating all of them to notice
   * it costs 171ms on a well-used machine (52 directories / 2209 files), and
   * paying that at the watch's rate ceiling is the same bill polling ran up. A
   * scoped read touches one directory.
   *
   * Refuses — returns undefined — whenever the scoped path cannot be trusted to
   * see everything: an empty cache to resolve directory names against, or a
   * named directory this catalog has never seen (a project that appeared, whose
   * cwd cannot be recovered from an encoded name, since the encoding is lossy).
   * The caller then falls back to {@link refresh}. Refusing is always safe;
   * guessing is not.
   *
   * @param encodedDirs - project-directory names under `projects/`, as the
   *   watch reported them.
   * @returns what moved, or undefined when the caller must sweep instead.
   */
  async refreshProjects(encodedDirs: readonly string[]): Promise<CatalogRefresh | undefined> {
    if (encodedDirs.length === 0 || this.native.length === 0) return undefined
    if (this.refreshInFlight !== undefined) return await this.refreshInFlight
    // The encoding is one-way, so the only way back to a cwd is a session we
    // already know about in that directory.
    const cwdByDir = new Map<string, string>()
    for (const meta of this.native) {
      if (meta.cwd === '') continue
      const encoded = encodeProjectDir(meta.cwd)
      if (!cwdByDir.has(encoded)) cwdByDir.set(encoded, meta.cwd)
    }
    const targets: string[] = []
    for (const dir of encodedDirs) {
      const cwd = cwdByDir.get(dir)
      if (cwd === undefined) return undefined
      targets.push(cwd)
    }
    let scoped: SessionMeta[][]
    let peers: Map<string, PeerSession>
    try {
      ;[scoped, peers] = await Promise.all([
        Promise.all(targets.map(cwd => listNativeSessions({ cwd }))),
        readPeerSessions(),
      ])
    } catch {
      return undefined
    }
    // Scoped reads only cover the active root; a bound session on another
    // root can still gain or lose a terminal writer while nobody switched.
    void this.refreshForeignPeers().catch(() => undefined)
    const touched = new Set(encodedDirs)
    // Everything outside the touched directories is carried over untouched;
    // inside them the scoped read is authoritative, which is what lets a
    // session deleted from one of those directories disappear.
    const fresh = this.native.filter(meta => meta.cwd === '' || !touched.has(encodeProjectDir(meta.cwd)))
    for (const rows of scoped) fresh.push(...rows)
    this.applyPeers(fresh, peers)
    fresh.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    this.native = fresh
    return this.commit(fresh)
  }

  /**
   * Resolve live ownership over a freshly-read native list.
   * @param rows - the native rows to stamp, mutated in place.
   * @param peers - the live-process registry.
   */
  private applyPeers(rows: SessionMeta[], peers: Map<string, PeerSession>): void {
    for (const meta of rows) {
      // A live peer holds the session open — unless that peer is one of the
      // host's own engines, which is this page driving the session rather than
      // a terminal holding it.
      meta.terminalOwned = peers.has(meta.id) && !this.drivesNative(meta.id)
      // A fresh transcript with no live writer at all is a crashed or finished
      // turn, not a running one — the mtime heuristic alone would call it
      // busy for the full recency window after a `kill -9`.
      if (meta.status === 'busy' && !peers.has(meta.id)) meta.status = 'idle'
    }
  }

  /**
   * Fingerprint the new native view against the previous one and adopt it.
   * @param rows - the native rows now in force.
   * @returns what moved, in the shape callers broadcast from.
   */
  private commit(rows: readonly SessionMeta[]): CatalogRefresh {
    const next = new Map<string, string>()
    for (const meta of rows) {
      next.set(meta.id, `${meta.updatedAt}\n${meta.status}\n${meta.terminalOwned === true}\n${meta.name}`)
    }
    // A session appearing or disappearing changes the LIST, which no per-row
    // frame can express — the page has to be handed the whole thing. A session
    // whose fingerprint merely moved is one row.
    let structural = false
    const moved: string[] = []
    for (const [id, fingerprint] of next) {
      const before = this.signatures.get(id)
      if (before === undefined) structural = true
      else if (before !== fingerprint) moved.push(id)
    }
    if (!structural) {
      for (const id of this.signatures.keys()) {
        if (!next.has(id)) {
          structural = true
          break
        }
      }
    }
    this.signatures = next
    return { changed: structural || moved.length > 0, structural, moved }
  }

  /**
   * Every session from both stores, most recently updated first.
   *
   * A session present in both is emitted once, with the sidecar's operational
   * fields over the CLI's identity fields.
   *
   * Every row is a copy. This is a read — it runs on every broadcast — and the
   * merge below writes CLI-derived state onto the row it returns; folding that
   * into the store's own records would carry it into the next index write and
   * persist a live fact as a stored one.
   * @returns the merged list.
   */
  list(): SessionMeta[] {
    const adopted = new Map<string, SessionMeta>()
    const merged: SessionMeta[] = []
    for (const meta of this.store.list()) {
      if (!this.inScope(meta)) continue
      const row = { ...meta }
      this.stampForeignOwnership(row)
      merged.push(row)
      if (row.claudeSessionId !== undefined) adopted.set(row.claudeSessionId, row)
    }
    for (const native of this.native) {
      const own = adopted.get(native.id)
      if (own === undefined) merged.push({ ...native })
      else mergeNativeInto(own, native)
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
   * One session in exactly the shape {@link list} would emit for it: the
   * sidecar row with the CLI's identity fields and live ownership merged in.
   *
   * {@link get} deliberately answers the raw stored row — the send and adopt
   * paths want the record, not the view. This is the view, and it exists so a
   * single-session wire frame cannot disagree with the full-list frame: a row
   * built from `get` would be missing `terminalOwned` and the CLI's own
   * summary/branch/updatedAt, and the page would render it differently
   * depending on which frame happened to deliver it.
   * @param id - the page id: a sidecar id, or a native session id.
   * @returns the merged copy, or undefined when no in-scope session matches.
   */
  row(id: string): SessionMeta | undefined {
    // A native id may name a session the page already adopted, which lives
    // under its OWN sidecar id. Resolving to the native row instead would hand
    // the page a second row for one conversation — the rescan path addresses
    // rows by native id, so this is the common case there, not a corner.
    const stored = this.store.get(id)
      ?? this.store.list().find(meta => meta.claudeSessionId === id)
    if (stored === undefined) {
      const native = this.native.find(meta => meta.id === id)
      return native === undefined ? undefined : { ...native }
    }
    if (!this.inScope(stored)) return undefined
    const row = { ...stored }
    this.stampForeignOwnership(row)
    const native = row.claudeSessionId === undefined
      ? undefined
      : this.native.find(meta => meta.id === row.claudeSessionId)
    if (native !== undefined) mergeNativeInto(row, native)
    return row
  }

  /**
   * Whether a terminal process currently holds the session open, answered
   * from the merged live view.
   *
   * Ownership is resolved per refresh and written only onto merged copies, so
   * a stored sidecar row never carries it — asking the store directly would
   * answer undefined even while a terminal drives the session. This is the
   * check the send path gates on.
   * @param id - the page id: a sidecar id, or a native session id.
   * @returns true when a live terminal peer owns the session right now.
   */
  terminalOwned(id: string): boolean {
    return this.list().some(row =>
      (row.id === id || row.claudeSessionId === id) && row.terminalOwned === true)
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
    // The persisted row must not inherit the native row's live-derived
    // display state: `terminalOwned` and `status` describe whoever is driving
    // the session at this instant, and snapshotting them would freeze a
    // mid-turn writer into the record — a read-only, running-looking row long
    // after that writer exited. Nothing on this page is driving the session
    // yet, so the record starts idle and unowned; this page's own engines set
    // status live through the store as they run turns.
    const snapshot: SessionMeta = {
      ...native,
      status: 'idle',
      claudeSessionId: native.id,
      origin: 'cli',
      // The native row came out of the root in force, so that is the root the
      // sidecar record belongs to for as long as it exists — and the binding
      // is the provider scope in force at adoption, so later page-level
      // switches cannot reroute this conversation's quota.
      configDir: this.activeConfigDir(),
      accountEnv: this.accountEnv(),
    }
    delete snapshot.terminalOwned
    return await this.store.adopt(snapshot)
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
        // The boundary reader needs the account root the session was recorded
        // under; a row without its own stamp belongs to the active root.
        configDir: meta.configDir ?? this.activeConfigDir(),
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
 * Fold the CLI's identity fields into one merged row. The CLI owns the
 * summary, the branch, and the recorded activity time; the sidecar owns
 * everything about how dsh-cc runs the session.
 *
 * `own` is a copy made by {@link SessionCatalog.list}, never a stored record,
 * so the live facts written here reach the page without being persisted.
 * @param own - the merged row to update.
 * @param native - the CLI's record for the same session.
 */
function mergeNativeInto(own: SessionMeta, native: SessionMeta): void {
  if (native.summary !== undefined) own.summary = native.summary
  if (native.gitBranch !== undefined) own.gitBranch = native.gitBranch
  if (native.updatedAt.localeCompare(own.updatedAt) > 0) own.updatedAt = native.updatedAt
  // Ownership is resolved live on every refresh, so an adopted session that a
  // terminal later picked up reads as terminal-owned here even though nothing
  // about that was stored when the page adopted it.
  own.terminalOwned = native.terminalOwned === true
  // While a terminal holds the session, that process is the only writer and
  // the authority on whether a turn is running; the sidecar's own status only
  // ever tracked turns this page drove.
  if (own.terminalOwned) own.status = native.status
}
