/**
 * Live git readout (branch / worktree / detached HEAD) for a session's cwd.
 *
 * The CLI's statusline computes its branch display by running git itself; the
 * SDK surfaces no branch query on the control channel, and the only branch it
 * does report (`listSessions` metadata) is a lagging end-of-session stamp
 * with no worktree name. So this module asks git directly — one `rev-parse`
 * spawn per cwd behind a short TTL cache — and the REST layer serves it to
 * the status strip for cold sessions as well as live ones.
 *
 * @module dsh-cc/git-info
 */

import { execFile } from 'node:child_process'

/** How long a probe's answer stays fresh; the strip re-reads per turn, not per tick. */
const CACHE_TTL_MS = 3000

/** Kill a hung git early — this feeds a status tag, not a user action. */
const GIT_TIMEOUT_MS = 2500

/** What the status strip shows about the session's working directory. */
export interface GitInfo {
  /** Currently checked-out branch; '' when HEAD is detached. */
  branch: string
  /** Short commit sha, shown when HEAD is detached. */
  detached?: string
  /** Linked-worktree name, when the cwd lives inside one. */
  worktree?: string
  /** Repository (or worktree) root, as git resolves it. */
  root?: string
}

/** Cache entry: the probe answer (undefined = not a repo) and when it was taken. */
interface CacheEntry {
  at: number
  info: GitInfo | undefined
}

/** Answers by cwd, including negative ones so non-repos don't respawn git per switch. */
const cache = new Map<string, CacheEntry>()

/** Probes already running, so concurrent asks for one cwd share a single spawn. */
const inFlight = new Map<string, Promise<GitInfo | undefined>>()

/**
 * Run git and collect stdout.
 * @param args - arguments to `git` (the cwd goes in as `-C <path>`).
 * @returns trimmed stdout.
 * @throws whatever git reported on failure (non-repo, missing git, timeout).
 */
function runGit(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error !== null) reject(error)
      else resolve(stdout.trim())
    })
  })
}

/**
 * Read the branch/worktree state of one directory.
 *
 * One `rev-parse` yields the root, the absolute git dir, and the branch
 * (or the literal `HEAD` when detached); the git dir's `worktrees/<name>`
 * suffix names the linked worktree. Only the detached case needs a second
 * spawn, for the short sha actually displayed.
 *
 * @param cwd - the session's working directory.
 * @returns the readout, or undefined when the cwd is outside any repo (or
 *   git is unusable there) — the caller hides the tag rather than guessing.
 */
export function gitInfoFor(cwd: string): Promise<GitInfo | undefined> {
  const hit = cache.get(cwd)
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.info)
  const running = inFlight.get(cwd)
  if (running !== undefined) return running
  const probe = probeGit(cwd)
    .then(info => {
      cache.set(cwd, { at: Date.now(), info })
      return info
    })
    .finally(() => {
      inFlight.delete(cwd)
    })
  inFlight.set(cwd, probe)
  return probe
}

/**
 * The uncached probe behind {@link gitInfoFor}.
 * @param cwd - the directory to read.
 * @returns the readout, or undefined outside a repo.
 */
async function probeGit(cwd: string): Promise<GitInfo | undefined> {
  let out: string
  try {
    out = await runGit(['-C', cwd, 'rev-parse', '--show-toplevel', '--absolute-git-dir', '--abbrev-ref', 'HEAD'])
  } catch {
    return undefined
  }
  const lines = out.split('\n')
  if (lines.length < 3) return undefined
  const root = lines[0] === '' ? undefined : lines[0]
  const gitDir = lines[1]
  const branch = lines[2]
  const worktreeMatch = /[\\/]worktrees[\\/](.+)$/.exec(gitDir)
  const info: GitInfo = {
    branch: branch === 'HEAD' ? '' : branch,
    ...(root !== undefined ? { root } : {}),
    ...(worktreeMatch !== null ? { worktree: worktreeMatch[1] } : {}),
  }
  if (branch === 'HEAD') {
    // Detached: the sha is the display name, so worth its own spawn.
    try {
      info.detached = await runGit(['-C', cwd, 'rev-parse', '--short', 'HEAD'])
    } catch {
      // Unborn or exotic HEAD — show the empty state, not an error.
    }
  }
  return info
}
