/**
 * Filesystem watch over the Claude Code home, so the session catalog learns
 * about terminal-driven changes instead of polling for them.
 *
 * Why this exists: the catalog's sweep enumerates every project directory in
 * the CLI's store — measured at 171ms across 52 directories / 2209 transcript
 * files / 628MB — and it used to run every 2 seconds for as long as a page was
 * attached, whether or not anything had changed. That is a fraction of a core
 * burned around the clock on a question the operating system will answer for
 * free, and the cost grows with the user's history and never comes back down.
 *
 * Mechanism only, no policy: this module says "something under the Claude Code
 * home moved" and nothing else. What to re-read and whether to broadcast stays
 * with the caller.
 *
 * Two properties matter and are deliberate:
 *
 * - **Rate ceiling, not just debounce.** A turn running in a terminal appends
 *   to its transcript continuously, so raw events arrive in a stream. Left as a
 *   plain trailing debounce, an active turn would fire a sweep every debounce
 *   window — worse than the polling it replaces. The scheduler therefore runs
 *   the callback at most once per `minIntervalMs`, which makes the busy case no
 *   worse than the old cadence and the quiet case free.
 * - **Recursive watching or nothing.** Node only supports `recursive` on
 *   Windows and macOS. Elsewhere a non-recursive watch on `projects/` would see
 *   directories appear but never the writes inside them — worse than useless,
 *   because it looks like it works. On those platforms {@link watchClaudeHome}
 *   reports failure and the caller keeps polling.
 *
 * @module dsh-cc/store-watch
 */

import { watch, type FSWatcher } from 'node:fs'
import { join, sep } from 'node:path'

/** Platforms whose `fs.watch` honours `recursive`. */
const RECURSIVE_PLATFORMS: readonly NodeJS.Platform[] = ['win32', 'darwin']

/** A live watch over one Claude Code home. */
export interface StoreWatch {
  /** Stop watching and drop any pending scheduled run. */
  close(): void
}

/**
 * What changed since the last callback. Naming the affected project
 * directories is the whole point of watching rather than polling: a re-read
 * scoped to one directory is orders of magnitude cheaper than enumerating the
 * store, and a change that cannot be scoped says so instead of pretending.
 */
export interface StoreChange {
  /** Encoded project-directory names that saw writes (`projects/<name>/…`). */
  projects: string[]
  /**
   * True when this batch cannot be served by a scoped re-read: a project
   * directory itself appeared or vanished, the live-process registry moved, or
   * the platform handed us an event with no filename. The caller must sweep.
   */
  full: boolean
}

/** How the caller configures a watch. */
export interface StoreWatchOptions {
  /** The Claude Code home to watch (the account root in force). */
  configDir: string
  /**
   * Smallest gap between two callback runs. Events arriving inside a gap are
   * coalesced into one trailing run at its end.
   */
  minIntervalMs: number
  /** Called when something under the home has changed. */
  onChange(change: StoreChange): void
}

/**
 * Watch a Claude Code home for session-store changes.
 *
 * Two directories carry everything the catalog reads: `projects/` (the
 * transcripts, watched recursively) and `sessions/` (the live-process
 * registry, one flat file per running CLI). A home missing either directory
 * still watches the other — a fresh account root has no `sessions/` until the
 * first process starts.
 *
 * @param options - the home to watch, the rate ceiling, and the callback.
 * @returns the handle, or undefined when this platform or this home cannot be
 *   watched — the caller must fall back to polling rather than go blind.
 */
export function watchClaudeHome(options: StoreWatchOptions): StoreWatch | undefined {
  if (!RECURSIVE_PLATFORMS.includes(process.platform)) return undefined

  const watchers: FSWatcher[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastRun = 0
  let dirty = false
  let closed = false
  /** Project directories touched since the last run. */
  let projects = new Set<string>()
  /** Whether this batch has already lost the ability to be scoped. */
  let full = false

  /**
   * Run the callback now and reset the window. Never lets a throwing callback
   * escape into the watch's event handler, where nothing would catch it.
   */
  const run = (): void => {
    timer = undefined
    dirty = false
    const change: StoreChange = { projects: [...projects], full }
    projects = new Set()
    full = false
    lastRun = Date.now()
    try {
      options.onChange(change)
    } catch {
      // The caller's problem; the watch keeps running either way.
    }
  }

  /** Note a change and schedule the run the rate ceiling allows. */
  const schedule = (): void => {
    if (closed) return
    dirty = true
    if (timer !== undefined) return
    const wait = Math.max(0, options.minIntervalMs - (Date.now() - lastRun))
    timer = setTimeout(() => {
      if (dirty) run()
      else timer = undefined
    }, wait)
  }

  /**
   * Record one raw watch event against the batch being assembled.
   * @param child - which watched directory reported it.
   * @param filename - the path the event names, relative to that directory.
   */
  const record = (child: string, filename: string | Buffer | null): void => {
    if (child !== 'projects') {
      // The live-process registry: ownership can move for any session, and it
      // is not addressed by project directory.
      full = true
      return
    }
    const relative = typeof filename === 'string' ? filename : filename?.toString()
    // No filename (some platforms, some event kinds) means no way to scope it.
    if (relative === undefined || relative === '') {
      full = true
      return
    }
    const parts = relative.split(sep)
    // A bare entry directly under projects/ is a project directory appearing or
    // vanishing, not a write inside one — the session SET changes, so scoping
    // to that directory alone would miss nothing but prove nothing either.
    if (parts.length < 2) {
      full = true
      return
    }
    projects.add(parts[0])
  }

  for (const [child, recursive] of [['projects', true], ['sessions', false]] as const) {
    try {
      const watcher = watch(
        join(options.configDir, child),
        { recursive, persistent: false },
        (_event, filename) => {
          record(child, filename)
          schedule()
        },
      )
      // A watched directory that is deleted or replaced (an account root being
      // rebuilt) surfaces as an error; drop that watcher and let the caller's
      // backstop poll cover the gap rather than crash the process.
      watcher.on('error', () => {
        try {
          watcher.close()
        } catch {
          // Already closed.
        }
      })
      watchers.push(watcher)
    } catch {
      // Missing directory: the other one still carries useful signal.
    }
  }
  if (watchers.length === 0) return undefined

  return {
    close(): void {
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      for (const watcher of watchers) {
        try {
          watcher.close()
        } catch {
          // Already closed.
        }
      }
    },
  }
}
