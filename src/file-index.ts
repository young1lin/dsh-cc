/**
 * The @-mention menu's project index: a bounded BFS walk under the session
 * cwd collecting workspace-relative paths of regular files and enterable
 * folders. The menu (the browser half) filters and ranks client-side over
 * this one snapshot — typing `@` searches the whole project, it does not
 * browse one directory page at a time. Entry classes and the ignore rules
 * match the send-time injection exactly (opendir dirents, symlinks dropped,
 * SKIPPED_DIR from types.ts), so a menu row and its injected reference
 * describe one filesystem fact.
 *
 * @module dsh-cc/file-index
 */

import { opendir } from 'node:fs/promises'
import { SKIPPED_DIR, type FileIndex } from './types.ts'

/** Complete-result bound on collected rows (files and folders alike). */
const MAX_ROWS = 5000
/** Per-level bound; a wider level marks the index truncated. */
const MAX_PER_DIR = 2000
/** Maximum descent depth below the root (the root itself is depth 0). */
const MAX_DEPTH = 16

/** One walk-queue cell: the absolute directory plus its relative segments. */
interface Pending {
  readonly dir: string
  readonly segments: readonly string[]
  readonly depth: number
}

/**
 * Collect the menu index under one root: workspace-relative POSIX paths,
 * name-sorted per level for cross-platform stability, sorted once at the
 * end. Ignored directories are never entered; symlinks and other dirent
 * kinds are dropped (the injection's classification); an unreadable
 * subdirectory is skipped and marks the result truncated rather than
 * failing the walk — the menu still offers the readable majority.
 * @param root - absolute project root (the session cwd).
 * @returns the bounded, sorted index.
 */
export async function collectFileIndex(root: string): Promise<FileIndex> {
  const rows: FileIndex['rows'] = []
  let truncated = false
  const pending: Pending[] = [{ dir: root, segments: [], depth: 0 }]
  while (pending.length > 0) {
    const cell = pending.shift()
    if (cell === undefined) break
    // Children of a max-depth folder live one level deeper; the folder row
    // itself was already collected when it was enqueued.
    if (cell.depth >= MAX_DEPTH) {
      truncated = true
      continue
    }
    let level: Awaited<ReturnType<typeof readLevel>>
    try {
      level = await readLevel(cell.dir)
    } catch {
      // The root itself refusing reads leaves the caller an empty index;
      // anything deeper just disappears from the menu.
      if (cell.dir === root) return { rows: [], truncated: false }
      truncated = true
      continue
    }
    if (level.length > MAX_PER_DIR) truncated = true
    for (const entry of level.slice(0, MAX_PER_DIR)) {
      if (rows.length === MAX_ROWS) {
        truncated = true
        break
      }
      if (entry.isDirectory) {
        if (SKIPPED_DIR.test(entry.name)) continue
        const segments = [...cell.segments, entry.name]
        rows.push({ path: segments.join('/'), directory: true })
        pending.push({ dir: `${cell.dir}/${entry.name}`, segments, depth: cell.depth + 1 })
        continue
      }
      rows.push({ path: [...cell.segments, entry.name].join('/') })
    }
  }
  rows.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return { rows, truncated }
}

/** One level entry: the name plus the dirent classification. */
interface LevelEntry {
  readonly name: string
  readonly isFile: boolean
  readonly isDirectory: boolean
}

/**
 * Read one directory level via opendir: name-sorted (opendir order is not
 * guaranteed), regular files and directories only — symlinks and other
 * kinds classify false on both booleans and are dropped rather than probed.
 * @param dir - absolute directory to read.
 * @returns the level's name-sorted file and directory entries.
 */
async function readLevel(dir: string): Promise<readonly LevelEntry[]> {
  const level: LevelEntry[] = []
  const handle = await opendir(dir)
  try {
    for (;;) {
      const dirent = await handle.read()
      if (dirent === null) break
      const isFile = dirent.isFile()
      const isDirectory = dirent.isDirectory()
      if (!isFile && !isDirectory) continue
      level.push({ name: dirent.name, isFile, isDirectory })
    }
  } finally {
    await handle.close()
  }
  level.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return level
}

/** One cached walk: the settled index and the wall time it was taken. */
interface CacheEntry {
  readonly index: FileIndex
  readonly at: number
}

/**
 * Walks are not free (the 5000-row bound exists because real projects hit
 * it); the menu opens often, sessions share a process, and a project's
 * shape changes slowly. A short TTL cache per root keeps repeat gestures
 * instant while never serving a stale tree for long. In-flight walks are
 * deduped by holding the promise — two menus opening in the same breath
 * walk once.
 */
const CACHE_TTL_MS = 30_000

/**
 * Cache capacity in project roots. The TTL only refuses stale hits — without
 * a cap an entry would live forever, so the oldest root is evicted before an
 * insert once the cache is full.
 */
const MAX_CACHE_ROOTS = 16
const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<FileIndex>>()

/**
 * The menu index for one project root, from cache when fresh enough.
 * @param root - absolute project root (the session cwd).
 * @returns the bounded, sorted index.
 */
export function fileIndexFor(root: string): Promise<FileIndex> {
  const hit = cache.get(root)
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.index)
  const running = inFlight.get(root)
  if (running !== undefined) return running
  const walk = collectFileIndex(root)
    .then(index => {
      // Map keeps insertion order: evicting the first key drops the oldest
      // root, and a delete-then-set on an existing key refreshes recency.
      if (!cache.has(root) && cache.size >= MAX_CACHE_ROOTS) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
      cache.set(root, { index, at: Date.now() })
      return index
    })
    .finally(() => {
      inFlight.delete(root)
    })
  inFlight.set(root, walk)
  return walk
}
