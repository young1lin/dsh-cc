/**
 * One throwaway engine used to ask the CLI for its model catalog when no live
 * session can answer. `supportedModels()` is served out of the CLI's own
 * resolved config: no API call, no transcript writes, and the process registry
 * entry unlinks on close — so the probe is free next to an idle CLI start and
 * must never wedge a settings dialog open on a silent gateway.
 *
 * @module dsh-cc/model-probe
 */

import { SessionEngine } from './engine.ts'

/** Hard ceiling on one disposable probe's patience, in milliseconds. */
const PROBE_TIMEOUT_MS = 15_000

/**
 * Warm one disposable engine, ask it for the catalog under a hard timeout,
 * and always close it — however the wait ends.
 * @param probe - the engine created purely for this question.
 * @param warn - the host's warning sink for a failed question.
 * @returns the catalog rows, or undefined when nothing answered in time.
 */
export async function probeCatalogOnce(
  probe: SessionEngine,
  warn: (message: string) => void,
): Promise<readonly unknown[] | undefined> {
  try {
    probe.warmUp()
    const models = await Promise.race([
      probe.supportedModels(),
      new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), PROBE_TIMEOUT_MS)),
    ])
    return models
  } catch (error) {
    warn(`dsh-cc: could not read the model catalog: ${String(error)}`)
    return undefined
  } finally {
    await probe.close().catch(() => {})
  }
}
