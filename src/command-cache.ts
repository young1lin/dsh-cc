/**
 * Server-side fallback cache for the slash-command catalog: the live list
 * comes from a running CLI process (engine.supportedCommands()), and a cold
 * session — never started, or evicted by the LRU cap — has nothing to show.
 * This module persists the last catalog seen per (configDir, cwd) account +
 * project pair under dataDir, so the menu can offer a stale-but-real list
 * instead of an empty popup while the session warms up.
 *
 * Cache file shape: { version, entries: { "<configDir>|<cwd>": { commands,
 * savedAt } } }; entries prune to the newest MAX_ENTRIES by savedAt. The file
 * is written atomically (tmp + rename), matching the store's own pattern.
 *
 * @module dsh-cc/command-cache
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SlashCommand } from './types.ts'

/** File name of the cache inside dataDir. */
const CACHE_FILE = 'commands-cache.json'

/** Cache format version; a mismatched file is discarded wholesale. */
const CACHE_VERSION = 1

/** How many (configDir, cwd) entries to keep; the newest win. */
const MAX_ENTRIES = 40

/** One cached catalog with its write time. */
interface CacheEntry {
  commands: SlashCommand[]
  savedAt: number
}

/** The on-disk cache document. */
interface CacheFile {
  version: number
  entries: Record<string, CacheEntry>
}

/** The cache key: one account root paired with one project directory. */
function entryKey(configDir: string, cwd: string): string {
  return configDir + '|' + cwd
}

/**
 * Load the whole cache file, or an empty cache when absent or malformed.
 * @param dataDir - the plugin's data directory.
 * @returns the parsed cache document; version mismatches yield an empty one.
 */
function loadCache(dataDir: string): CacheFile {
  try {
    const raw = readFileSync(join(dataDir, CACHE_FILE), 'utf8')
    const parsed = JSON.parse(raw) as CacheFile
    if (parsed.version !== CACHE_VERSION || typeof parsed.entries !== 'object' || parsed.entries === null) {
      return { version: CACHE_VERSION, entries: {} }
    }
    return parsed
  } catch {
    // Absent or unreadable: an empty cache, not an error — the fallback path
    // must never be the reason a request fails.
    return { version: CACHE_VERSION, entries: {} }
  }
}

/**
 * Persist the cache file atomically (tmp + rename, the store's pattern).
 * @param dataDir - the plugin's data directory.
 * @param cache - the complete cache document to write.
 */
function saveCache(dataDir: string, cache: CacheFile): void {
  const target = join(dataDir, CACHE_FILE)
  const staging = target + '.tmp'
  writeFileSync(staging, JSON.stringify(cache), 'utf8')
  renameSync(staging, target)
}

/**
 * Remember the catalog a live engine just reported for one account + project.
 * Overwrites any previous entry for the same key and prunes by savedAt.
 * @param dataDir - the plugin's data directory.
 * @param configDir - the account root the catalog came from.
 * @param cwd - the session working directory it came from.
 * @param commands - the live catalog, in the CLI's own order.
 */
export function rememberCommands(dataDir: string, configDir: string, cwd: string, commands: SlashCommand[]): void {
  const cache = loadCache(dataDir)
  cache.entries[entryKey(configDir, cwd)] = { commands, savedAt: Date.now() }
  const keys = Object.keys(cache.entries)
  if (keys.length > MAX_ENTRIES) {
    for (const key of keys.sort((left, right) => cache.entries[right].savedAt - cache.entries[left].savedAt).slice(MAX_ENTRIES)) {
      delete cache.entries[key]
    }
  }
  try {
    saveCache(dataDir, cache)
  } catch {
    // A failed cache write only costs the fallback its freshness.
  }
}

/**
 * Read the last catalog remembered for one account + project.
 * @param dataDir - the plugin's data directory.
 * @param configDir - the account root the session belongs to.
 * @param cwd - the session working directory.
 * @returns the cached commands with their save time, or undefined when this
 *   pair was never seen.
 */
export function cachedCommands(dataDir: string, configDir: string, cwd: string): { commands: SlashCommand[]; savedAt: number } | undefined {
  const entry = loadCache(dataDir).entries[entryKey(configDir, cwd)]
  if (entry === undefined || !Array.isArray(entry.commands)) return undefined
  return { commands: entry.commands, savedAt: entry.savedAt }
}
