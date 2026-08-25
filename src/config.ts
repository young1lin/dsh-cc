/**
 * Plugin configuration: schemastery schema plus explicit default resolution.
 * Defaults are applied in resolveConfig, never inside run() helpers.
 *
 * @module dsh-cc/config
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { PROVIDER_ENV_KEYS, type EffortLevel, type ProviderEnvField } from './types.ts'

/**
 * Structured Anthropic-compatible provider settings, resolved into the same
 * `env` map `ClaudeCodeConfig.env` layers onto the claude process — this is a
 * named, schema-validated way to set the same well-known variables the raw
 * `env` dict accepts, for a `cordis.patch.yml` that wants a gateway endpoint
 * without hand-writing env var names. An explicit `env` key always wins over
 * its structured counterpart, so `env` remains the escape hatch for anything
 * these fields don't cover.
 */
export interface ClaudeCodeProviderConfig {
  /** Anthropic-compatible endpoint; resolves to ANTHROPIC_BASE_URL. Empty = Claude's official API. */
  baseUrl?: string
  /** Bearer credential; resolves to ANTHROPIC_AUTH_TOKEN. */
  authToken?: string
  /** API-key credential; resolves to ANTHROPIC_API_KEY. Only takes effect when `authToken` is unset. */
  apiKey?: string
  /**
   * Model id or alias the CLI resolves through the provider's own catalog; resolves to
   * ANTHROPIC_MODEL. Distinct from `ClaudeCodeConfig.model`, which is the SDK's `model` query
   * option — the two are separate resolution mechanisms and either or both may be set.
   */
  model?: string
  /** Opus-tier alias; resolves to ANTHROPIC_DEFAULT_OPUS_MODEL. */
  opusModel?: string
  /** Sonnet-tier alias; resolves to ANTHROPIC_DEFAULT_SONNET_MODEL. */
  sonnetModel?: string
  /** Haiku-tier alias; resolves to ANTHROPIC_DEFAULT_HAIKU_MODEL. */
  haikuModel?: string
  /** Small/fast-tier alias; resolves to ANTHROPIC_SMALL_FAST_MODEL. */
  smallFastModel?: string
  /** HTTPS proxy; resolves to HTTPS_PROXY. */
  httpsProxy?: string
  /** HTTP proxy; resolves to HTTP_PROXY. */
  httpProxy?: string
  /** Proxy bypass list; resolves to NO_PROXY. */
  noProxy?: string
  /** Per-request timeout in milliseconds; resolves to API_TIMEOUT_MS. */
  apiTimeoutMs?: number
}

/** Plugin config fields; every field is optional with a resolved default. */
export interface ClaudeCodeConfig {
  /** Session store directory; defaults to $DSH_HOME (or ~/.dsh) + /claude-code. */
  dataDir?: string
  /** Default working directory for new sessions; defaults to the dsh process cwd. */
  cwd?: string
  /** Default model id (e.g. claude-sonnet-4-5); empty = Claude Code picks. */
  model?: string
  /** Native permission posture for queries; the page can answer prompts in default mode. */
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions' | 'auto'
  /** Structured provider/proxy settings, resolved into `env` before `env` itself is layered on. */
  provider?: ClaudeCodeProviderConfig
  /** Extra environment for the claude process, layered over the inherited environment. */
  env?: Record<string, string>
  /** Maximum simultaneously live CLI processes; idle overflow is closed and resumed later. */
  maxLiveSessions?: number
  /** Per-turn cap forwarded to the SDK; 0 = unlimited. */
  maxTurns?: number
  /** Optional pathToClaudeCodeExecutable override; empty = the SDK's pinned payload. */
  executablePath?: string
  /** Default reasoning effort for new sessions; unset = the CLI default. */
  effort?: EffortLevel
}

/** Runtime configuration schema for the structured provider settings. */
const ProviderConfigSchema: z<ClaudeCodeProviderConfig> = z.object({
  baseUrl: z.string(),
  authToken: z.string(),
  apiKey: z.string(),
  model: z.string(),
  opusModel: z.string(),
  sonnetModel: z.string(),
  haikuModel: z.string(),
  smallFastModel: z.string(),
  httpsProxy: z.string(),
  httpProxy: z.string(),
  noProxy: z.string(),
  apiTimeoutMs: z.natural(),
})

/** Runtime configuration schema for the dsh-cc plugin. */
export const Config: z<ClaudeCodeConfig> = z.object({
  dataDir: z.string(),
  cwd: z.string(),
  model: z.string(),
  permissionMode: z.union([
    z.const('default'),
    z.const('acceptEdits'),
    z.const('plan'),
    z.const('dontAsk'),
    z.const('bypassPermissions'),
    z.const('auto'),
  ]),
  provider: ProviderConfigSchema,
  env: z.dict(z.string()),
  maxLiveSessions: z.natural().max(64),
  maxTurns: z.natural(),
  executablePath: z.string(),
  effort: z.union([
    z.const('low'),
    z.const('medium'),
    z.const('high'),
    z.const('xhigh'),
    z.const('max'),
  ]),
})

/** Fully resolved configuration with every default applied. */
export interface ResolvedConfig {
  dataDir: string
  cwd: string
  model: string
  permissionMode: NonNullable<ClaudeCodeConfig['permissionMode']>
  env: Record<string, string>
  maxLiveSessions: number
  maxTurns: number
  executablePath: string
  effort?: EffortLevel
}

/**
 * Resolve user config into the complete runtime configuration.
 * @param config - validated plugin config; absent fields take their default.
 * @returns the resolved configuration with absolute paths.
 */
export function resolveConfig(config: ClaudeCodeConfig): ResolvedConfig {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return {
    dataDir: resolve(config.dataDir || join(dshHome, 'claude-code')),
    cwd: resolve(config.cwd || process.cwd()),
    model: config.model || '',
    permissionMode: config.permissionMode || 'auto',
    // The structured fields resolve first so an explicit `env` key can always override its
    // structured counterpart, matching `env`'s existing role as the escape hatch.
    env: { ...resolveProviderEnv(config.provider ?? {}), ...config.env },
    maxLiveSessions: config.maxLiveSessions || 4,
    maxTurns: config.maxTurns || 0,
    executablePath: config.executablePath || '',
    ...(config.effort !== undefined ? { effort: config.effort } : {}),
  }
}

/**
 * Project the structured provider settings onto their well-known env var
 * names, driven by the shared field-to-key table in types.ts.
 * @param provider - the structured provider config; absent fields are omitted.
 * @returns the env entries the structured fields set; a field left unset contributes no key.
 */
function resolveProviderEnv(provider: ClaudeCodeProviderConfig): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [field, envKey] of Object.entries(PROVIDER_ENV_KEYS) as [ProviderEnvField, string][]) {
    const value = provider[field]
    if (value === undefined || value === '') continue
    env[envKey] = String(value)
  }
  return env
}
