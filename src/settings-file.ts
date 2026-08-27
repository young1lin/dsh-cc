/**
 * The page-editable settings layer's file side: load, validate, seed, and
 * persist \`settings.json\` under the data directory. Pure storage — the cordis
 * config layer stays authoritative for anything this file does not carry, and
 * every reader here degrades to empties rather than throwing into a request.
 *
 * @module dsh-cc/settings-file
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR_ENV, normalizeAccounts } from './accounts.ts'
import { PROVIDER_ENV_NAMES } from './types.ts'
import type { CcSettings, EnvPreset } from './types.ts'

/** Default settings: every field empty, so the cordis config stays authoritative. */
const EMPTY_SETTINGS: Omit<CcSettings, 'presets' | 'activePresetId'> = {
  model: '', permissionMode: '', env: {}, accounts: [], activeAccountId: '',
}

/**
 * Validate the preset list from a settings write or a settings file: ids and
 * names must be non-empty strings, env keys follow the same shape rules as
 * the settings env (the account-owned key is refused earlier, in the route),
 * and the list is capped so a runaway writer cannot grow the file unbounded.
 * @param value - the raw `presets` field.
 * @returns the valid presets, in order.
 */
export function normalizePresets(value: unknown): EnvPreset[] {
  if (!Array.isArray(value)) return []
  const presets: EnvPreset[] = []
  for (const item of value.slice(0, 16)) {
    if (typeof item !== 'object' || item === null) continue
    const { id, name, env } = item as { id?: unknown; name?: unknown; env?: unknown }
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue
    if (typeof name !== 'string' || name.trim() === '') continue
    const clean: Record<string, string> = {}
    if (typeof env === 'object' && env !== null) {
      for (const [key, entry] of Object.entries(env as Record<string, unknown>)) {
        if (typeof entry !== 'string') continue
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
        clean[key] = entry
      }
    }
    presets.push({ id, name: name.trim(), env: clean })
  }
  return presets
}

/**
 * The presets a first run — or a settings file from before presets existed —
 * starts with. The GLM bundle snapshots whatever provider environment this
 * process itself inherited, so on a machine already pointed at a gateway the
 * preset works on first click; the account bundle is everything else stripped
 * back to just the proxy, which is what 账号直连 means on such a machine.
 * @returns the two seeded presets.
 */
function seedPresets(): EnvPreset[] {
  const proxy: Record<string, string> = {
    HTTP_PROXY: process.env.HTTP_PROXY ?? process.env.http_proxy ?? 'http://127.0.0.1:7890',
    HTTPS_PROXY: process.env.HTTPS_PROXY ?? process.env.https_proxy ?? 'http://127.0.0.1:7890',
    NO_PROXY: process.env.NO_PROXY ?? process.env.no_proxy ?? 'localhost,127.0.0.1',
  }
  const glm: Record<string, string> = {
    ...proxy,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? 'https://open.bigmodel.cn/api/anthropic',
  }
  // Snapshot every other provider-scope variable this process carries: the
  // tier-alias mapping (opus/sonnet/haiku) and a relay's long timeout ride
  // along with the endpoint and credential instead of silently falling back
  // to CLI defaults on first switch.
  for (const key of PROVIDER_ENV_NAMES) {
    if (key in glm) continue
    const value = process.env[key]
    if (value !== undefined && value !== '') glm[key] = value
  }
  return [
    { id: 'account', name: '账号直连', env: proxy },
    { id: 'glm', name: 'GLM 中转', env: glm },
  ]
}

/**
 * Load the page-editable settings file from the data directory.
 * @param dataDir - session store directory.
 * @returns the persisted settings, or empties when absent or unreadable.
 */
export function loadSettings(dataDir: string): CcSettings {
  try {
    const file = join(dataDir, 'settings.json')
    if (!existsSync(file)) {
      return { ...EMPTY_SETTINGS, env: {}, accounts: [], presets: seedPresets(), activePresetId: '' }
    }
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<CcSettings>
    const env: Record<string, string> = {}
    if (typeof raw.env === 'object' && raw.env !== null) {
      for (const [key, value] of Object.entries(raw.env)) {
        if (typeof value === 'string') env[key] = value
      }
    }
    // A file written before the key was reserved can still carry it; the
    // account layer owns it now, so it is dropped rather than obeyed.
    delete env[CONFIG_DIR_ENV]
    const accounts = normalizeAccounts(raw.accounts)
    const activeAccountId = typeof raw.activeAccountId === 'string'
      && accounts.some(account => account.id === raw.activeAccountId)
      ? raw.activeAccountId
      : ''
    // A file from before presets existed seeds them rather than loading an
    // empty list; the seed never activates anything, so behavior is
    // unchanged until a preset is clicked.
    const presets = raw.presets === undefined ? seedPresets() : normalizePresets(raw.presets)
    const activePresetId = typeof raw.activePresetId === 'string'
      && presets.some(preset => preset.id === raw.activePresetId)
      ? raw.activePresetId
      : ''
    return {
      model: typeof raw.model === 'string' ? raw.model : '',
      permissionMode: typeof raw.permissionMode === 'string' ? raw.permissionMode : '',
      env,
      presets,
      activePresetId,
      accounts,
      activeAccountId,
    }
  } catch {
    return { ...EMPTY_SETTINGS, env: {}, accounts: [], presets: seedPresets(), activePresetId: '' }
  }
}

/**
 * Persist the page-editable settings file.
 * @param dataDir - session store directory.
 * @param settings - the complete settings value.
 */
export function persistSettings(dataDir: string, settings: CcSettings): void {
  try {
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8')
  } catch (error) {
    // Settings are a convenience layer; the cordis config still boots without them.
    console.warn('dsh-cc: failed to persist settings', error)
  }
}
