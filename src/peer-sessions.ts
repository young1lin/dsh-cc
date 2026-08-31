/**
 * Read-only view of the CLI's live-process registry: the
 * `~/.claude/sessions/<pid>.json` file every top-level claude process
 * writes at startup and unlinks on clean exit, so `claude ps` can enumerate
 * everything the user is running. Treat this directory as an observation
 * deck only — the `messagingSocketPath` advertised inside each file is a
 * private, PAKE-authenticated peer protocol with no stability promise, and
 * the sibling `*.key` files are its secrets; neither is ours to touch.
 *
 * @module dsh-cc/peer-sessions
 */

import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** One live CLI process currently holding a session open. */
export interface PeerSession {
  pid: number
  sessionId: string
  cwd: string
  kind: string
}

/**
 * The registry directory, honoring the same env override the CLI does.
 * @param dir - an explicit account root; defaults to the one in force.
 * @returns the `<root>/sessions` directory path.
 */
function sessionsDir(dir?: string): string {
  return join(dir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'sessions')
}

/**
 * Liveness probe: signal zero throws exactly when the pid is gone. EPERM
 * means the process exists but belongs to another user — still alive.
 * @param pid - the process id from a registry file.
 * @returns whether the process is running right now.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Every live CLI peer, keyed by the native session id it holds open.
 *
 * A dead process's stale file (crash, `kill -9`) contributes nothing, which
 * is what lets the catalog tell "a writer is still attached" from "the
 * transcript just happens to be fresh". When several processes hold the
 * same session (a resumed terminal plus a headless run), the last live
 * one read wins — callers only ask whether ANY live writer exists.
 * @param dir - the account root whose registry to read; defaults to the one
 *   in force. A session bound to another root still needs its ownership
 *   answered, and that answer lives in that root's own registry.
 * @returns the live peers; an empty map when the registry is absent or
 *   unreadable, which means nothing is terminal-owned.
 */
export async function readPeerSessions(dir?: string): Promise<Map<string, PeerSession>> {
  const peers = new Map<string, PeerSession>()
  let names: string[]
  try {
    names = await readdir(sessionsDir(dir))
  } catch {
    return peers
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue // Skip the *.key peer-auth secrets.
    try {
      const raw = JSON.parse(await readFile(join(sessionsDir(dir), name), 'utf8')) as Partial<PeerSession>
      if (typeof raw.pid !== 'number' || typeof raw.sessionId !== 'string') continue
      if (!isAlive(raw.pid)) continue
      peers.set(raw.sessionId, {
        pid: raw.pid,
        sessionId: raw.sessionId,
        cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
        kind: typeof raw.kind === 'string' ? raw.kind : '',
      })
    } catch {
      // Malformed or mid-rewrite entry: not a peer we can act on.
    }
  }
  return peers
}
