/**
 * The page-editable settings layer's file side: load, validate, seed, and
 * persist \`settings.json\` under the data directory. Provider credentials
 * are sealed at this boundary; malformed JSON degrades to defaults, while an
 * encryption failure propagates rather than silently writing plaintext.
 *
 * @module dsh-cc/settings-file
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR_ENV, normalizeAccounts } from './accounts.ts'
import { isSealedSecret, sealEnvForStorage, stripProtectedEnv } from './secret-box.ts'
import { PROVIDER_ENV_NAMES, isProtectedEnvKey } from './types.ts'
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
        if (typeof entry !== 'string' || entry === '') continue
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
 * starts with. Both bundles snapshot only what this process itself actually
 * inherited: the proxy trio keeps live values only (a machine with no proxy
 * env seeds 账号直连 as a true empty bundle, which is direct account
 * connection by definition), and the GLM bundle is seeded only when this
 * machine already points at a gateway — ANTHROPIC_BASE_URL set — snapshotting
 * the whole provider scope then. No endpoint or proxy port is ever baked in:
 * a public install never defaults into anyone's relay.
 * @returns the seeded presets — always 账号直连, plus GLM 中转 on gateway machines.
 */
function seedPresets(dataDir: string): EnvPreset[] {
  const proxy: Record<string, string> = {}
  const httpProxy = process.env.HTTP_PROXY ?? process.env.http_proxy
  const httpsProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy
  if (httpProxy) proxy.HTTP_PROXY = httpProxy
  if (httpsProxy) proxy.HTTPS_PROXY = httpsProxy
  if (noProxy) proxy.NO_PROXY = noProxy
  else if (httpProxy || httpsProxy) proxy.NO_PROXY = 'localhost,127.0.0.1'
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) return [{ id: 'account', name: '账号直连', env: sealLoadedEnv(dataDir, proxy, '首启账号预设') }]
  const glm: Record<string, string> = { ...proxy, ANTHROPIC_BASE_URL: baseUrl }
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
    { id: 'account', name: '账号直连', env: sealLoadedEnv(dataDir, proxy, '首启账号预设') },
    { id: 'glm', name: 'GLM 中转', env: sealLoadedEnv(dataDir, glm, '首启中转预设') },
  ]
}

/**
 * Load the page-editable settings file from the data directory.
 * @param dataDir - session store directory.
 * @returns the persisted settings, or empties when absent or unreadable.
 */
export function loadSettings(dataDir: string): CcSettings {
  const file = join(dataDir, 'settings.json')
  if (!existsSync(file)) {
    return { ...EMPTY_SETTINGS, env: {}, accounts: [], presets: seedPresets(dataDir), activePresetId: '' }
  }
  let raw: Partial<CcSettings>
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<CcSettings>
  } catch {
    return { ...EMPTY_SETTINGS, env: {}, accounts: [], presets: seedPresets(dataDir), activePresetId: '' }
  }
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
  // empty list; the seed never activates anything, so behavior is unchanged
  // until a preset is clicked.
  const rawPresets = raw.presets === undefined ? seedPresets(dataDir) : normalizePresets(raw.presets)
  const settings: CcSettings = {
    model: typeof raw.model === 'string' ? raw.model : '',
    permissionMode: typeof raw.permissionMode === 'string' ? raw.permissionMode : '',
    env: sealLoadedEnv(dataDir, env, '页面设置'),
    presets: rawPresets.map(preset => ({
      ...preset,
      env: sealLoadedEnv(dataDir, preset.env, `预设“${preset.name}”`),
    })),
    activePresetId: '',
    accounts,
    activeAccountId,
  }
  settings.activePresetId = typeof raw.activePresetId === 'string'
    && settings.presets.some(preset => preset.id === raw.activePresetId)
    ? raw.activePresetId
    : ''
  // One-way legacy migration: as soon as plaintext is read successfully, the
  // same validated settings are atomically rewritten as device-bound envelopes.
  if (hasPlainProtectedSecret(env) || rawPresets.some(preset => hasPlainProtectedSecret(preset.env))) {
    persistSettings(dataDir, settings)
  }
  return settings
}

/**
 * Persist the page-editable settings file atomically. Credential fields are
 * sealed defensively even when a caller already supplied envelopes. Failures
 * propagate: reporting success while leaving a new token in plaintext is not
 * an acceptable fallback.
 * @param dataDir - session store directory.
 * @param settings - the complete settings value.
 */
export function persistSettings(dataDir: string, settings: CcSettings): void {
  const protectedSettings: CcSettings = {
    ...settings,
    env: sealEnvForStorage(dataDir, settings.env),
    presets: settings.presets.map(preset => ({
      ...preset,
      env: sealEnvForStorage(dataDir, preset.env),
    })),
  }
  const target = join(dataDir, 'settings.json')
  const tmp = `${target}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(protectedSettings, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, target)
}

/** Seal legacy plaintext or drop it when the native backend is unavailable. */
function sealLoadedEnv(dataDir: string, env: Record<string, string>, context: string): Record<string, string> {
  try {
    return sealEnvForStorage(dataDir, env)
  } catch (error) {
    console.warn(`dsh-cc: ${context} 的旧版明文密钥无法设备加密，已从活动配置与磁盘移除，请在页面重新输入`, error)
    return stripProtectedEnv(env)
  }
}

/** Whether a map still contains a legacy plaintext protected credential. */
function hasPlainProtectedSecret(env: Record<string, string>): boolean {
  return Object.entries(env).some(([key, value]) =>
    isProtectedEnvKey(key) && value !== '' && !isSealedSecret(value))
}
