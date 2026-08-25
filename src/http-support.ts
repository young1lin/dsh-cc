/**
 * Pure helpers behind the /cc/api HTTP surface: directory listings for the
 * path picker, text file reads for the viewer, the SDK version readout, and
 * the env projection the settings page renders. Nothing here touches the
 * session store or an engine, which is what lets the runtime file stay about
 * routing and lifecycle.
 *
 * @module dsh-cc/http-support
 */

import { existsSync, readFileSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import type { DirListing, EffectiveEnvEntry } from './types.ts'

/**
 * Environment variables Claude Code itself reads, matched by the families its
 * own documentation defines rather than by an enumerated list, so a variable
 * the CLI gains later is still reported. Used only to decide what is worth
 * showing on the settings page; it never filters what the CLI is given.
 */
const CLI_ENV_KEY = /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|API_TIMEOUT_MS$|(HTTPS?|NO)_PROXY$)/i

/**
 * Variables a parent Claude Code process injects into the processes it spawns.
 * They match {@link CLI_ENV_KEY} but are handoff plumbing, not configuration
 * anyone set — and two of them carry a live credential and IPC path of the
 * parent session, which must not be rendered onto a settings page.
 */
const CLI_ENV_INJECTED = /^CLAUDE_CODE_(SESSION_ID|CHILD_SESSION|ENTRYPOINT|EXECPATH|MESSAGING_.*)$/

/** Keys whose values are credentials; the page only ever sees them masked. */
const SECRET_KEY = /(TOKEN|KEY|SECRET|PASSWORD|COOKIE)$/i

/**
 * Read one directory page for the picker; an undefined path lists drive roots.
 * @param pathname - the requested directory, or undefined for the root level.
 * @returns the listing.
 */
export async function readDirListing(pathname: string | undefined): Promise<DirListing> {
  if (pathname === undefined || pathname.trim() === '') {
    const roots: string[] = []
    if (process.platform === 'win32') {
      for (let code = 65; code <= 90; code++) {
        const drive = `${String.fromCharCode(code)}:\\`
        if (existsSync(drive)) roots.push(drive)
      }
    } else {
      roots.push('/')
    }
    return { path: '', parent: null, entries: roots.map(root => ({ name: root, directory: true })) }
  }
  const dir = resolve(pathname.trim())
  const dirents = await readdir(dir, { withFileTypes: true })
  const entries = dirents
    .filter(dirent => dirent.isDirectory() || dirent.isFile())
    .map(dirent => ({ name: dirent.name, directory: dirent.isDirectory() }))
    .sort((left, right) =>
      left.directory === right.directory
        ? left.name.localeCompare(right.name)
        : left.directory ? -1 : 1)
  const parent = dirname(dir) !== dir ? dirname(dir) : null
  return { path: dir, parent, entries }
}

/** Largest file the viewer reads; bigger files deliver their head only. */
const MAX_FILE_BYTES = 2 * 1024 * 1024

/** One text file as the page viewer renders it. */
export interface FileContent {
  path: string
  content: string
  /** True when only the head of an oversized file was read. */
  truncated: boolean
}

/**
 * Read one text file for the viewer. A NUL byte in the head marks a binary
 * file and is refused rather than rendered; an oversized file is cut to its
 * head with the flag set so the viewer can say so.
 * @param pathname - the file to read.
 * @returns the content descriptor.
 * @throws when the path is empty, missing, unreadable, or not a text file.
 */
export async function readTextFile(pathname: string): Promise<FileContent> {
  const file = resolve(pathname.trim())
  if (file === '') throw new Error('未指定文件')
  const info = await stat(file).catch(() => {
    throw new Error('文件不存在或不可访问')
  })
  if (!info.isFile()) throw new Error('不是文件')
  const truncated = info.size > MAX_FILE_BYTES
  const size = truncated ? MAX_FILE_BYTES : info.size
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(size)
    await handle.read(buffer, 0, size, 0)
    if (buffer.includes(0)) throw new Error('不是文本文件')
    return { path: file, content: buffer.toString('utf8'), truncated }
  } finally {
    await handle.close()
  }
}

/** The pinned Agent SDK version, read from the installed package for diagnostics. */
export function readSdkVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    // The SDK exports map hides ./package.json, so resolve its entry and walk
    // up to the owning manifest.
    let dir = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'))
    for (;;) {
      const manifestPath = join(dir, 'package.json')
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string; version?: string }
        if (manifest.name === '@anthropic-ai/claude-agent-sdk') return manifest.version ?? ''
      }
      const parent = dirname(dir)
      if (parent === dir) return ''
      dir = parent
    }
  } catch {
    return ''
  }
}

/**
 * Project the environment layered onto the claude process, recording which
 * layer supplied each winning value so the page can show where a setting
 * actually comes from. Secret values are masked here — the raw value never
 * leaves the host.
 * @param plugin - the cordis plugin config env.
 * @param settings - the page-editable settings env, layered over it per key.
 * @param account - variables the active account root supplies. Applied last
 *   and reported as its own layer: CLAUDE_CONFIG_DIR is written onto this
 *   process when an account is selected, so the process layer would otherwise
 *   claim a value the account chose.
 * @returns one entry per variable, sorted by key.
 */
export function effectiveEnvEntries(
  plugin: Record<string, string>,
  settings: Record<string, string>,
  account: Record<string, string> = {},
): EffectiveEnvEntry[] {
  const winner = new Map<string, { value: string; layer: EffectiveEnvEntry['layer'] }>()
  // The CLI is spawned with this process's environment, so a variable set in
  // the shell that launched dsh reaches Claude Code even though no dsh-cc
  // layer mentions it. Reporting it is what makes "which endpoint am I
  // actually talking to" answerable from the page.
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (!CLI_ENV_KEY.test(key) || CLI_ENV_INJECTED.test(key)) continue
    winner.set(key, { value, layer: 'process' })
  }
  // Each layer overwrites the previous one key by key, mirroring
  // effectiveConfig: a settings entry beats the plugin entry of the same name,
  // and a plugin entry the settings layer never mentions survives. The process
  // layer underpins both — the CLI inherits it from the spawn regardless.
  for (const [key, value] of Object.entries(plugin)) winner.set(key, { value, layer: 'plugin' })
  for (const [key, value] of Object.entries(settings)) winner.set(key, { value, layer: 'settings' })
  for (const [key, value] of Object.entries(account)) winner.set(key, { value, layer: 'account' })
  return [...winner.entries()]
    .map(([key, { value, layer }]) => SECRET_KEY.test(key)
      ? { key, value: maskSecret(value), masked: true, layer }
      : { key, value, masked: false, layer })
    .sort((left, right) => left.key.localeCompare(right.key))
}

/**
 * Mask a credential down to a recognizable stub.
 * @param value - the raw secret.
 * @returns the masked form, e.g. `90cd…4e83`.
 */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '••••'
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}
