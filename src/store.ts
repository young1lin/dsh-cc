/**
 * Session persistence: an in-memory metadata map backed by index.json plus
 * one JSONL transcript file per session. Loads synchronously so the plugin
 * body can serve a complete session list immediately after apply().
 *
 * @module dsh-cc/store
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { CcEvent, SessionMeta } from './types.ts'

/** JSONL + index persistence for Claude Code conversations. */
export class SessionStore {
  private readonly sessions = new Map<string, SessionMeta>()
  private readonly seq = new Map<string, number>()
  /** Serialization chain: index writes must land in submission order. */
  private persistChain: Promise<void> = Promise.resolve()

  constructor(private readonly dataDir: string) {}

  /**
   * Create the store layout and load the session index synchronously.
   *
   * An unreadable index must not stop the plugin from mounting, and it must
   * not be silently overwritten either: the next metadata write would replace
   * a recoverable file with an empty list. A bad index is therefore moved
   * aside under a timestamped name and the store starts empty.
   */
  load(): void {
    mkdirSync(join(this.dataDir, 'sessions'), { recursive: true })
    const indexPath = join(this.dataDir, 'index.json')
    if (!existsSync(indexPath)) return
    let raw: SessionMeta[]
    try {
      const parsed: unknown = JSON.parse(readFileSync(indexPath, 'utf8'))
      if (!Array.isArray(parsed)) throw new Error('index.json is not an array')
      raw = parsed as SessionMeta[]
    } catch (error) {
      const aside = `${indexPath}.corrupt-${Date.now()}`
      try {
        renameSync(indexPath, aside)
      } catch {
        // Nothing else to try; starting empty still beats failing to mount.
      }
      console.warn(`dsh-cc: unreadable session index, moved to ${aside}`, error)
      return
    }
    for (const meta of raw) {
      // No engine survives the process, so a persisted busy flag is stale.
      if (meta.status === 'busy') meta.status = 'idle'
      this.sessions.set(meta.id, meta)
      // Seed the counter from the transcript tail so ids stay unique across restarts.
      this.seq.set(meta.id, this.lastSeq(meta.id))
    }
  }

  /**
   * The highest persisted seq of a session, read from its transcript file.
   *
   * The maximum over every parseable line, not the last line's value:
   * concurrent writers can land events out of order, so the final line may
   * carry a smaller seq than one before it.
   * @param id - session id.
   * @returns the highest seq, or 0 without a transcript.
   */
  private lastSeq(id: string): number {
    try {
      const file = join(this.dataDir, 'sessions', `${id}.jsonl`)
      if (!existsSync(file)) return 0
      let max = 0
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line.trim().length === 0) continue
        try {
          const seq = (JSON.parse(line) as CcEvent).seq
          if (typeof seq === 'number' && seq > max) max = seq
        } catch {
          // A torn line contributes nothing; the rest of the file still counts.
        }
      }
      return max
    } catch {
      return 0
    }
  }

  /** All sessions, most recently updated first. */
  list(): SessionMeta[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /**
   * One session's metadata.
   * @param id - session id.
   * @returns the metadata, or undefined for an unknown id.
   */
  get(id: string): SessionMeta | undefined {
    return this.sessions.get(id)
  }

  /**
   * Create and persist a new session.
   * @param input - optional name, cwd, and model from the request body.
   * @param defaults - fallback cwd when the request supplies none.
   * @returns the created metadata.
   */
  async create(
    input: { name?: unknown; cwd?: unknown; model?: unknown; env?: unknown },
    defaults: { cwd: string },
  ): Promise<SessionMeta> {
    const now = new Date().toISOString()
    const name = typeof input.name === 'string' && input.name.trim().length > 0
      ? input.name.trim()
      : `会话 ${now.slice(5, 16).replace('T', ' ')}`
    const cwd = typeof input.cwd === 'string' && input.cwd.trim().length > 0
      ? resolve(input.cwd.trim())
      : defaults.cwd
    const model = typeof input.model === 'string' ? input.model.trim() : ''
    const env: Record<string, string> = {}
    if (typeof input.env === 'object' && input.env !== null) {
      for (const [key, value] of Object.entries(input.env as Record<string, unknown>)) {
        if (typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = value
      }
    }
    const meta: SessionMeta = {
      id: randomUUID(),
      name,
      cwd,
      model,
      createdAt: now,
      updatedAt: now,
      origin: 'dsh-cc',
      status: 'idle',
      messageCount: 0,
      totalCostUsd: 0,
      ...(Object.keys(env).length > 0 ? { env } : {}),
    }
    this.sessions.set(meta.id, meta)
    this.seq.set(meta.id, 0)
    await this.persistIndex()
    return meta
  }

  /**
   * One session's metadata by the native id it wraps.
   * @param claudeSessionId - the native Claude Code session id.
   * @returns the sidecar row carrying it, or undefined when none does.
   */
  findByClaudeId(claudeSessionId: string): SessionMeta | undefined {
    for (const meta of this.sessions.values()) {
      if (meta.claudeSessionId === claudeSessionId) return meta
    }
    return undefined
  }

  /**
   * Insert a sidecar record for a session that already exists in the CLI's own
   * store, preserving its native id so the two stores agree on one identity.
   *
   * Unlike {@link create} this mints no id: adopting a CLI session under a new
   * id would make the page resume a conversation it lists under a different
   * key, and the transcript would be read from the wrong file.
   *
   * The claudeSessionId is uniqueness-checked too: reaching a page-created
   * session through its native id must return that session's existing row,
   * not mint a second one for the same conversation — two rows for one native
   * session would both appear in the catalog list and diverge from there.
   * @param meta - the record to insert.
   * @returns the inserted record, or the existing one when the id or the
   *   claudeSessionId is already taken.
   */
  async adopt(meta: SessionMeta): Promise<SessionMeta> {
    const existing = this.sessions.get(meta.id)
      ?? (meta.claudeSessionId !== undefined ? this.findByClaudeId(meta.claudeSessionId) : undefined)
    if (existing !== undefined) return existing
    this.sessions.set(meta.id, meta)
    this.seq.set(meta.id, this.lastSeq(meta.id))
    await this.persistIndex()
    return meta
  }

  /**
   * Patch one session's metadata and refresh its updatedAt.
   *
   * A patch that would re-link this session onto a claudeSessionId another row
   * already holds is refused for that field alone (everything else in the
   * patch applies): one native session must map to at most one sidecar row,
   * and silently keeping two would resurrect the duplicate-row catalog bug.
   * @param id - session id.
   * @param patch - fields to overwrite.
   * @returns the updated metadata, or undefined for an unknown id.
   */
  async update(id: string, patch: Partial<SessionMeta>): Promise<SessionMeta | undefined> {
    const meta = this.sessions.get(id)
    if (!meta) return undefined
    const applied = { ...patch }
    if (typeof applied.claudeSessionId === 'string' && applied.claudeSessionId !== meta.claudeSessionId) {
      const holder = this.findByClaudeId(applied.claudeSessionId)
      if (holder !== undefined && holder.id !== id) {
        console.warn(`dsh-cc: 原生会话 ${applied.claudeSessionId} 已由会话 ${holder.id} 记录，不再重复关联到 ${id}`)
        delete applied.claudeSessionId
      }
    }
    Object.assign(meta, applied, { updatedAt: new Date().toISOString() })
    await this.persistIndex()
    return meta
  }

  /**
   * Count one more user message.
   *
   * The increment happens against the store's own record rather than a value
   * the caller read earlier, so two sends that overlap cannot both compute
   * the same next count and lose one.
   * @param id - session id.
   */
  async incrementMessageCount(id: string): Promise<void> {
    const meta = this.sessions.get(id)
    if (meta === undefined) return
    meta.messageCount += 1
    await this.persistIndex()
  }

  /**
   * Delete a session's metadata and transcript.
   * @param id - session id.
   * @returns true when the session existed.
   */
  async remove(id: string): Promise<boolean> {
    if (!this.sessions.delete(id)) return false
    this.seq.delete(id)
    await this.persistIndex()
    await rm(join(this.dataDir, 'sessions', `${id}.jsonl`), { force: true })
    return true
  }

  /**
   * Reserve the next transcript sequence number for a session.
   *
   * Reserving rather than peeking is what keeps the counter monotonic for a
   * session whose conversation the CLI owns: most of its events are broadcast
   * without ever being appended here, and a counter that only advanced on
   * append would hand every one of them the same number.
   * @param id - session id.
   * @returns the reserved seq.
   */
  nextSeq(id: string): number {
    const next = (this.seq.get(id) ?? 0) + 1
    this.seq.set(id, next)
    return next
  }

  /**
   * Append one transcript event to the session's JSONL file.
   * @param id - session id.
   * @param event - the complete event (seq/ts already assigned).
   */
  async append(id: string, event: CcEvent): Promise<void> {
    this.seq.set(id, Math.max(this.seq.get(id) ?? 0, event.seq))
    await appendFile(join(this.dataDir, 'sessions', `${id}.jsonl`), `${JSON.stringify(event)}\n`, 'utf8')
  }

  /**
   * Read a session transcript (tail-limited for page rendering).
   *
   * A line that fails to parse is skipped, not thrown: a crash mid-append
   * leaves a torn final line, and one bad byte must not turn every later read
   * of the session into a 500 — the parseable history is still the history.
   * This mirrors how the SDK's own transcript reader treats torn lines.
   * @param id - session id.
   * @param limit - maximum number of trailing events.
   * @returns the events in order; empty for a session without a transcript.
   */
  async transcript(id: string, limit = 800): Promise<CcEvent[]> {
    const file = join(this.dataDir, 'sessions', `${id}.jsonl`)
    if (!existsSync(file)) return []
    const events: CcEvent[] = []
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      if (line.trim().length === 0) continue
      try {
        events.push(JSON.parse(line) as CcEvent)
      } catch {
        // Torn line from a crash mid-append; skip it, keep the rest.
      }
    }
    return events.slice(-limit)
  }

  /**
   * Persist the index through the serialization chain: concurrent metadata
   * updates must reach disk in submission order, or a slow older snapshot
   * would overwrite a newer complete one after its rename.
   */
  private persistIndex(): Promise<void> {
    const next = this.persistChain.then(() => this.writeIndexOnce())
    this.persistChain = next.catch(() => {
      // A failed write must not poison the chain for later updates.
    })
    return next
  }

  private async writeIndexOnce(): Promise<void> {
    const target = join(this.dataDir, 'index.json')
    const tmp = `${target}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(this.list(), null, 2), 'utf8')
    await rename(tmp, target)
  }
}
