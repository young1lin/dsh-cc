/**
 * dsh-cc — Claude Code inside the DeepSeek Harness web GUI (node half).
 *
 * A function plugin that mounts the /cc/api HTTP surface on the host
 * webserver, persists conversations under a JSONL store, and drives one
 * official Claude Agent SDK query per session. The browser half (the
 * sidebar entry and chat overlay) is discovered through the package's
 * dsh.client declaration; it needs no config row of its own.
 *
 * Configuration (model, proxy, API keys, permission posture) is plain
 * environment + config: edit the profile's cordis.patch.yml dsh-cc row and
 * restart, or set env keys through the row's env map.
 *
 * @module dsh-cc
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig, type ClaudeCodeConfig } from './config.ts'
import { CcRuntime } from './runtime.ts'

export { Config, type ClaudeCodeConfig } from './config.ts'

/** Plugin name. */
export const name = 'dsh-cc'

/** The plugin waits for the web HTTP carrier before mounting its routes. */
export const inject: string[] = ['webServer']

/**
 * The slice of the dsh webserver service this plugin mounts routes through.
 * Structural on purpose: the host declares the real service; this plugin
 * reads it with ctx.get to avoid importing host types.
 */
interface WebServerLike {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/**
 * Read the injected webserver service from the host store.
 * @param ctx - host context.
 * @returns the webserver service.
 */
function webServerOf(ctx: Context): WebServerLike {
  const service = ctx.get('webServer') as WebServerLike | undefined
  if (!service || typeof service.register !== 'function') {
    throw new Error('dsh-cc: webServer service is missing; mount dsh-cc only in a profile with the web app bundle')
  }
  return service
}

/**
 * Mount the Claude Code bridge.
 * @param ctx - host context (webServer available through inject).
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: ClaudeCodeConfig): void {
  const resolved = resolveConfig(config)
  const runtime = new CcRuntime(ctx, resolved)
  ctx.effect(() => {
    const disposeRoutes = webServerOf(ctx).register({
      kind: 'prefix',
      path: '/cc/api',
      handler: runtime.handle,
    })
    return () => {
      disposeRoutes()
      void runtime.dispose()
    }
  }, 'dsh-cc: /cc/api routes and engines')
  ctx.logger?.info?.(`dsh-cc: Claude Code 页面已挂载，数据目录 ${resolved.dataDir}`)
}
