/**
 * Well-known Anthropic-compatible provider environment keys, and the pure
 * helpers that project them to and from `CcSettings.env`.
 *
 * The structured provider form (`ProviderForm`) and the advanced free-form KV
 * editor (`EnvEditor`) both read and write the same `env` map — there is no
 * separate persistence mechanism for structured fields. They stay disjoint by
 * construction: every key in {@link STRUCTURED_ENV_KEYS} is owned by the
 * structured form and is filtered out of the rows the KV editor shows.
 *
 * @module dsh-cc/client/settings/providerFields
 */

import type { ConfigLayer, ConfigSummary, EffectiveEnvEntry } from '../../types.ts'

/** The env var the 密钥 field writes to when neither credential key is already present. */
export const PRIMARY_KEY_ENV = 'ANTHROPIC_AUTH_TOKEN'
/** The credential env var the 密钥 field falls back to reading when the primary key is absent. */
export const FALLBACK_KEY_ENV = 'ANTHROPIC_API_KEY'

/**
 * Every env key the structured form owns. A key edited here must never also
 * appear as a row in the advanced KV editor.
 */
export const STRUCTURED_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_BASE_URL',
  PRIMARY_KEY_ENV,
  FALLBACK_KEY_ENV,
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'API_TIMEOUT_MS',
]

/** The structured form's in-memory field values, projected from an env map. */
export interface ProviderFormFields {
  baseUrl: string
  /** The credential value, read from whichever of the two credential env vars is set. */
  apiKeyValue: string
  /** Which env var the credential is written back to; sticky to whichever key was already present. */
  apiKeySourceKey: typeof PRIMARY_KEY_ENV | typeof FALLBACK_KEY_ENV
  model: string
  opusModel: string
  sonnetModel: string
  haikuModel: string
  smallFastModel: string
  httpsProxy: string
  httpProxy: string
  noProxy: string
  apiTimeoutMs: string
}

/**
 * Project the structured fields out of a settings env map.
 * @param env - the page-editable settings environment.
 * @returns the form field values; a key absent from `env` becomes an empty string.
 */
export function extractProviderFields(env: Record<string, string>): ProviderFormFields {
  return {
    baseUrl: env.ANTHROPIC_BASE_URL ?? '',
    apiKeyValue: env[PRIMARY_KEY_ENV] ?? env[FALLBACK_KEY_ENV] ?? '',
    apiKeySourceKey: PRIMARY_KEY_ENV in env ? PRIMARY_KEY_ENV : FALLBACK_KEY_ENV in env ? FALLBACK_KEY_ENV : PRIMARY_KEY_ENV,
    model: env.ANTHROPIC_MODEL ?? '',
    opusModel: env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? '',
    sonnetModel: env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? '',
    haikuModel: env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? '',
    smallFastModel: env.ANTHROPIC_SMALL_FAST_MODEL ?? '',
    httpsProxy: env.HTTPS_PROXY ?? '',
    httpProxy: env.HTTP_PROXY ?? '',
    noProxy: env.NO_PROXY ?? '',
    apiTimeoutMs: env.API_TIMEOUT_MS ?? '',
  }
}

/**
 * Rebuild the structured-key subset of a settings env map from form fields,
 * preserving every key the structured form does not own (the advanced rows).
 * @param env - the settings environment to patch.
 * @param fields - the current form field values.
 * @returns a new env map with the structured keys replaced; an empty field omits its key entirely.
 */
export function applyProviderFields(env: Record<string, string>, fields: ProviderFormFields): Record<string, string> {
  const next = { ...env }
  for (const key of STRUCTURED_ENV_KEYS) delete next[key]
  const set = (key: string, value: string): void => {
    if (value.trim() !== '') next[key] = value
  }
  set('ANTHROPIC_BASE_URL', fields.baseUrl)
  set(fields.apiKeySourceKey, fields.apiKeyValue)
  set('ANTHROPIC_MODEL', fields.model)
  set('ANTHROPIC_DEFAULT_OPUS_MODEL', fields.opusModel)
  set('ANTHROPIC_DEFAULT_SONNET_MODEL', fields.sonnetModel)
  set('ANTHROPIC_DEFAULT_HAIKU_MODEL', fields.haikuModel)
  set('ANTHROPIC_SMALL_FAST_MODEL', fields.smallFastModel)
  set('HTTPS_PROXY', fields.httpsProxy)
  set('HTTP_PROXY', fields.httpProxy)
  set('NO_PROXY', fields.noProxy)
  set('API_TIMEOUT_MS', fields.apiTimeoutMs)
  return next
}

/**
 * Split a settings env map into its structured-key subset and the rest.
 * @param env - the page-editable settings environment.
 * @returns the entries whose key belongs to {@link STRUCTURED_ENV_KEYS}.
 */
export function pickStructuredKeys(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of STRUCTURED_ENV_KEYS) if (key in env) result[key] = env[key]!
  return result
}

/**
 * Split a settings env map into its structured-key subset and the rest.
 * @param env - the page-editable settings environment.
 * @returns the entries whose key does NOT belong to {@link STRUCTURED_ENV_KEYS} — the rows the
 * advanced KV editor is responsible for.
 */
export function omitStructuredKeys(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!STRUCTURED_ENV_KEYS.includes(key)) result[key] = value
  }
  return result
}

/** One one-click provider fill. A preset only fills `baseUrl`; it never touches the credential field. */
export interface ProviderPreset {
  id: string
  label: string
  baseUrl: string
  hint: string
}

/** Offered presets, in display order. */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: 'official', label: '官方 API', baseUrl: '', hint: '清空 API 地址，直连 Claude 官方端点' },
  { id: 'zhipu-glm', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/anthropic', hint: '智谱 Anthropic 兼容网关' },
  { id: 'custom', label: '自定义中转', baseUrl: '', hint: '清空 API 地址，手动填写中转站地址' },
]

/** Human label for each configuration layer, shared by the settings dialog and the provider form. */
export const LAYER_LABELS: Record<ConfigLayer, string> = {
  process: 'dsh 进程环境',
  plugin: 'cordis 配置',
  settings: '页面设置',
  session: '会话覆盖',
}

/**
 * Find one key's entry in the effective config summary.
 * @param config - the effective config summary, or undefined while still loading.
 * @param key - the env var name to look up.
 * @returns the matching entry, or undefined when the key is not currently layered onto the process.
 */
export function findEnvEntry(config: ConfigSummary | undefined, key: string): EffectiveEnvEntry | undefined {
  return config?.env.find(entry => entry.key === key)
}

/**
 * Render an entry's layer as its display label.
 * @param entry - the entry, or undefined when the key carries no value in any layer the host reports.
 * @returns the layer label, or a neutral "not set" label when the key is absent from every reported layer.
 */
export function layerLabel(entry: EffectiveEnvEntry | undefined): string {
  return entry === undefined ? '未设置' : LAYER_LABELS[entry.layer]
}
