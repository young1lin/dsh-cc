/**
 * Configuration endpoints: the effective config summary, the page-editable
 * settings layer, and the directory picker's filesystem listing.
 *
 * @module dsh-cc/client/api/settings
 */

import type { CcSettings, ConfigSummary, DirListing } from '../../types.ts'
import { api } from './http.ts'
import type { ModelRow } from './telemetry.ts'

/** GET /config — the configuration actually in force, with secrets masked. */
export function fetchConfig(): Promise<{ config: ConfigSummary }> {
  return api<{ config: ConfigSummary }>('/config')
}

/**
 * GET /models — the model catalog under the current global configuration.
 *
 * This is where a gateway's own aliases and model ids come from; nothing in
 * the page can know them. Reading it costs a CLI start on a host with no live
 * session, so call it when the settings dialog opens, not on every render.
 * @returns the catalog, and whether a CLI actually answered.
 */
export function fetchGlobalModels(): Promise<{ available: boolean; models: ModelRow[]; current: string }> {
  return api<{ available: boolean; models: ModelRow[]; current: string }>('/models')
}

/** GET /settings — the page-editable layer only, not the resolved values. */
export function fetchSettings(): Promise<{ settings: CcSettings }> {
  return api<{ settings: CcSettings }>('/settings')
}

/**
 * PUT /settings — replace the page-editable layer.
 * @param settings - the complete settings value; empty fields defer to cordis config.
 * @returns the acknowledgement.
 */
export function saveSettings(settings: CcSettings): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>('/settings', { method: 'PUT', body: JSON.stringify(settings) })
}

/**
 * POST /accounts/active — switch the whole plugin to one account's Claude Code
 * home, or back to the host default with an empty id.
 *
 * Everything read out of that root moves with it: the session list, the
 * authenticated identity, the model catalog, and the permission posture. The
 * host refuses (409) while any session is mid-turn, since a running CLI process
 * cannot be moved to another home.
 * @param id - the account id to activate; empty selects the host default.
 * @returns the acknowledgement carrying the id now in force.
 */
export function switchAccount(id: string): Promise<{ ok: boolean; activeAccountId: string }> {
  return api<{ ok: boolean; activeAccountId: string }>('/accounts/active', {
    method: 'POST',
    body: JSON.stringify({ id }),
  })
}

/**
 * GET /fs/list — one directory page for the working-directory picker.
 * @param path - directory to list; undefined lists the drive roots.
 * @returns the listing.
 */
export function listDir(path: string | undefined): Promise<DirListing> {
  const query = path === undefined || path === '' ? '' : '?path=' + encodeURIComponent(path)
  return api<DirListing>(`/fs/list${query}`)
}
