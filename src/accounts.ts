/**
 * Claude Code home resolution: which `CLAUDE_CONFIG_DIR` every read and every
 * spawned process is pointed at, and the named accounts the page switches
 * between.
 *
 * The CLI keeps one account's entire world under a single root — credentials,
 * `settings.json`, memory, skills, the live-process registry, and the
 * `projects/<encoded-cwd>` transcripts. Nothing offers a per-call override for
 * it: the Agent SDK resolves the root from `process.env.CLAUDE_CONFIG_DIR` at
 * call time, and `peer-sessions` reads the same variable. Exactly one root is
 * therefore ever active, this module owns it, and switching accounts means
 * writing that variable on the dsh process itself before anything reads again.
 *
 * That single owner is also why `CLAUDE_CONFIG_DIR` is refused in the raw env
 * editors: an env layer would move the spawned process without moving the
 * reads, which is precisely the split-brain this module exists to prevent.
 *
 * @module dsh-cc/accounts
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { CcAccount } from './types.ts'

/**
 * The variable the CLI, the SDK, and this plugin all resolve the account root
 * from. Named once so no caller spells it by hand.
 */
export const CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR'

/** Sanity cap on the account list; a settings file is not a database. */
const MAX_ACCOUNTS = 32

/**
 * The value dsh itself was launched with, captured before this plugin ever
 * writes the variable. Every later read of "what did the host mean by default"
 * has to come from here rather than from `process.env`, which by then holds
 * whatever account is active.
 */
const LAUNCH_CONFIG_DIR = process.env[CONFIG_DIR_ENV]

/**
 * The root that applies when no account is selected and the cordis config
 * names none: what dsh was launched with, else the CLI's own default.
 * @returns the absolute baseline root.
 */
export function baselineConfigDir(): string {
  const launched = LAUNCH_CONFIG_DIR
  return launched !== undefined && launched.trim() !== ''
    ? resolve(launched.trim())
    : join(homedir(), '.claude')
}

/**
 * Validate a persisted or page-submitted account list.
 *
 * A row without a directory is meaningless and is dropped; a row without an id
 * is a newly added one and gets one here, so the page never has to mint ids
 * that must stay stable across saves. Duplicate ids collapse to the first.
 * @param raw - the untrusted value from the settings file or a request body.
 * @returns the accepted accounts, with absolute directories and non-empty names.
 */
export function normalizeAccounts(raw: unknown): CcAccount[] {
  if (!Array.isArray(raw)) return []
  const accounts: CcAccount[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (accounts.length >= MAX_ACCOUNTS) break
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Partial<CcAccount>
    const dir = typeof row.dir === 'string' ? row.dir.trim() : ''
    if (dir === '') continue
    const id = typeof row.id === 'string' && row.id.trim() !== '' ? row.id.trim() : randomUUID()
    if (seen.has(id)) continue
    seen.add(id)
    const absolute = resolve(dir)
    const name = typeof row.name === 'string' && row.name.trim() !== ''
      ? row.name.trim().slice(0, 40)
      : basename(absolute)
    accounts.push({ id, name, dir: absolute })
  }
  return accounts
}

/**
 * The root actually in force: the active account's directory, else the cordis
 * config's `configDir`, else the baseline.
 *
 * An `activeAccountId` naming an account that no longer exists resolves to the
 * fallback rather than failing — deleting the active account leaves a working
 * page pointed back at the host default.
 * @param accounts - the normalized account list.
 * @param activeAccountId - the selected account's id; empty selects none.
 * @param pluginConfigDir - the cordis config's resolved `configDir`; empty = unset.
 * @returns the absolute root every read and spawn must use.
 */
export function resolveAccountDir(
  accounts: readonly CcAccount[],
  activeAccountId: string,
  pluginConfigDir: string,
): string {
  const active = accounts.find(account => account.id === activeAccountId)
  if (active !== undefined) return active.dir
  if (pluginConfigDir !== '') return pluginConfigDir
  return baselineConfigDir()
}

/**
 * Point this process — and therefore the SDK's session reads, the peer
 * registry read, and every process spawned from it — at one account root.
 * @param dir - the absolute root to activate.
 * @returns nothing; the root takes effect on this process immediately.
 */
export function applyConfigDir(dir: string): void {
  process.env[CONFIG_DIR_ENV] = dir
}

/**
 * Put the variable back the way dsh was launched, so unloading the plugin
 * leaves no trace of an account switch on the host process.
 * @returns nothing; the launch-time value is written back in place.
 */
export function restoreConfigDir(): void {
  if (LAUNCH_CONFIG_DIR === undefined) delete process.env[CONFIG_DIR_ENV]
  else process.env[CONFIG_DIR_ENV] = LAUNCH_CONFIG_DIR
}

/**
 * Whether two paths name the same directory, case-insensitively on Windows.
 *
 * Sidecar rows are matched to the active root by path, so a row stamped
 * `C:\Users\x\.claude` must still match a root typed as `c:\users\x\.claude`.
 * @param left - one path.
 * @param right - the other path.
 * @returns true when both resolve to the same directory.
 */
export function sameDir(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}
