/**
 * Plugin configuration: schemastery schema plus explicit default resolution.
 * Defaults are applied in resolveConfig, never inside run() helpers.
 *
 * @module dsh-cc/config
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Plugin config fields; every field is optional with a resolved default. */
export interface ClaudeCodeConfig {
  /** Session store directory; defaults to $DSH_HOME (or ~/.dsh) + /claude-code. */
  dataDir?: string
  /** Default working directory for new sessions; defaults to the dsh process cwd. */
  cwd?: string
  /** Default model id (e.g. claude-sonnet-4-5); empty = Claude Code picks. */
  model?: string
  /** Native permission posture for queries; the page can answer prompts in default mode. */
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'auto'
  /** Extra environment for the claude process, layered over the inherited environment. */
  env?: Record<string, string>
  /** Maximum simultaneously live CLI processes; idle overflow is closed and resumed later. */
  maxLiveSessions?: number
  /** Per-turn cap forwarded to the SDK; 0 = unlimited. */
  maxTurns?: number
  /** Optional pathToClaudeCodeExecutable override; empty = the SDK's pinned payload. */
  executablePath?: string
  /** Default reasoning effort for new sessions; unset = the CLI default. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

/** Runtime configuration schema for the dsh-cc plugin. */
export const Config: z<ClaudeCodeConfig> = z.object({
  dataDir: z.string(),
  cwd: z.string(),
  model: z.string(),
  permissionMode: z.union([
    z.const('default'),
    z.const('acceptEdits'),
    z.const('plan'),
    z.const('bypassPermissions'),
    z.const('auto'),
  ]),
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
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
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
    env: { ...config.env },
    maxLiveSessions: config.maxLiveSessions || 4,
    maxTurns: config.maxTurns || 0,
    executablePath: config.executablePath || '',
    ...(config.effort !== undefined ? { effort: config.effort } : {}),
  }
}
