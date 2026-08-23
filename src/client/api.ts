/**
 * Browser-side transport: JSON fetch helpers plus one shared SSE connection.
 *
 * @module dsh-cc/client/api
 */

import type {
  CcEvent, CcSettings, ConfigSummary, DirListing, PermissionRequest, SessionMeta, WireMessage,
} from '../types.ts'

/**
 * Call one /cc/api JSON endpoint.
 * @param path - path below /cc/api.
 * @param init - optional fetch init.
 * @returns the parsed response body.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/cc/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const data: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = typeof data === 'object' && data !== null && 'error' in data
      ? String((data as { error: unknown }).error)
      : `HTTP ${response.status}`
    throw new Error(message)
  }
  return data as T
}

/** GET /config. */
export function fetchConfig(): Promise<{ config: ConfigSummary }> {
  return api<{ config: ConfigSummary }>('/config')
}

/** GET /sessions. */
export function fetchSessions(): Promise<{ sessions: SessionMeta[] }> {
  return api<{ sessions: SessionMeta[] }>('/sessions')
}

/** GET /sessions/:id. */
export function fetchSession(id: string): Promise<{ session: SessionMeta; events: CcEvent[] }> {
  return api<{ session: SessionMeta; events: CcEvent[] }>(`/sessions/${id}`)
}

/**
 * POST /sessions.
 * @param form - new-session fields.
 */
export function createSession(form: { name?: string; cwd?: string; model?: string }): Promise<{ session: SessionMeta }> {
  return api<{ session: SessionMeta }>('/sessions', { method: 'POST', body: JSON.stringify(form) })
}

/** DELETE /sessions/:id. */
export function deleteSession(id: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/sessions/${id}`, { method: 'DELETE' })
}

/**
 * POST /sessions/:id/messages.
 * @param id - session id.
 * @param text - message body.
 */
export function sendMessage(id: string, text: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ text }) })
}

/** POST /sessions/:id/stop. */
export function stopSession(id: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/sessions/${id}/stop`, { method: 'POST' })
}

/** One plan rate-limit window slice of the usage response. */
export interface UsageWindow {
  utilization?: number | null
  resets_at?: string | null
}

/** The parts of the SDK usage response the page renders. */
export interface UsageInfo {
  subscription_type?: string | null
  rate_limits_available?: boolean
  rate_limits?: {
    five_hour?: UsageWindow
    seven_day?: UsageWindow
  } | null
}

/** GET /sessions/:id/usage. */
export function fetchUsage(id: string): Promise<{ available: boolean; reason?: string; usage?: UsageInfo }> {
  return api<{ available: boolean; reason?: string; usage?: UsageInfo }>(`/sessions/${id}/usage`)
}

/** Context window usage from the SDK control channel. */
export interface ContextUsage {
  totalTokens: number
  maxTokens: number
}

/** One selectable model row from the live CLI catalog. */
export interface ModelRow {
  value: string
  displayName: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
}

/** GET /sessions/:id/context. */
export function fetchContext(id: string): Promise<{ available: boolean; context?: ContextUsage }> {
  return api<{ available: boolean; context?: ContextUsage }>(`/sessions/${id}/context`)
}

/** GET /sessions/:id/models. */
export function fetchModels(id: string): Promise<{
  available: boolean
  models: ModelRow[]
  current: string
  effort?: string
}> {
  return api<{ available: boolean; models: ModelRow[]; current: string; effort?: string }>(`/sessions/${id}/models`)
}

/**
 * POST /sessions/:id/model.
 * @param id - session id.
 * @param model - model id or alias; empty resets to default.
 */
export function setModel(id: string, model: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/sessions/${id}/model`, { method: 'POST', body: JSON.stringify({ model }) })
}

/**
 * POST /sessions/:id/effort.
 * @param id - session id.
 * @param effort - effort level; empty resets to default.
 */
export function setEffort(id: string, effort: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/sessions/${id}/effort`, { method: 'POST', body: JSON.stringify({ effort }) })
}

/**
 * PUT /sessions/:id/env — per-session environment for the next spawned process.
 * @param id - session id.
 * @param env - complete env map; empty clears the session layer.
 */
export function setSessionEnv(id: string, env: Record<string, string>): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/sessions/${id}/env`, { method: 'PUT', body: JSON.stringify({ env }) })
}

/**
 * PUT /sessions/:id/name — rename a session.
 * @param id - session id.
 * @param name - the new display name (1-80 chars).
 */
export function renameSession(id: string, name: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/sessions/${id}/name`, { method: 'PUT', body: JSON.stringify({ name }) })
}

/** One question of a pending AskUserQuestion dialog. */
export interface DialogQuestion {
  question?: string
  header?: string
  multiSelect?: boolean
  options?: { label?: string; description?: string }[]
}

/**
 * POST /sessions/:id/dialogs/:requestId — answer or cancel a pending dialog.
 * @param id - session id.
 * @param requestId - pending dialog id.
 * @param answers - the completed result payload; undefined cancels.
 */
export function answerDialog(id: string, requestId: string, answers: unknown): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/sessions/${id}/dialogs/${requestId}`, {
    method: 'POST',
    body: JSON.stringify(answers === undefined ? { cancel: true } : { answers }),
  })
}

/**
 * POST /sessions/:id/permissions/:requestId.
 * @param id - session id.
 * @param requestId - pending permission request id.
 * @param behavior - the decision.
 */
export function answerPermission(id: string, requestId: string, behavior: 'allow' | 'deny'): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/sessions/${id}/permissions/${requestId}`, {
    method: 'POST',
    body: JSON.stringify({ behavior }),
  })
}

/** GET /settings. */
export function fetchSettings(): Promise<{ settings: CcSettings }> {
  return api<{ settings: CcSettings }>('/settings')
}

/**
 * PUT /settings.
 * @param settings - the complete settings value.
 */
export function saveSettings(settings: CcSettings): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>('/settings', { method: 'PUT', body: JSON.stringify(settings) })
}

/**
 * GET /fs/list.
 * @param path - directory to list; undefined lists the drive roots.
 */
export function listDir(path: string | undefined): Promise<DirListing> {
  const query = path === undefined || path === '' ? '' : '?path=' + encodeURIComponent(path)
  return api<DirListing>(`/fs/list${query}`)
}

export type { ConfigSummary, CcEvent, CcSettings, DirListing, PermissionRequest, SessionMeta, WireMessage }

/**
 * Open the shared SSE stream with manual reconnection.
 * @param onMessage - called with every parsed push message.
 * @param onStatus - called with the connection up/down state.
 * @returns the disposer closing the stream.
 */
export function connectEvents(
  onMessage: (message: WireMessage) => void,
  onStatus?: (up: boolean) => void,
): () => void {
  let disposed = false
  let source: EventSource | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  const connect = (): void => {
    if (disposed) return
    source = new EventSource('/cc/api/events')
    source.onopen = () => onStatus?.(true)
    source.onmessage = event => {
      try {
        onMessage(JSON.parse(event.data as string) as WireMessage)
      } catch {
        // One malformed frame is dropped; the stream stays usable.
      }
    }
    source.onerror = () => {
      onStatus?.(false)
      source?.close()
      retry = setTimeout(connect, 2000)
    }
  }
  connect()
  return () => {
    disposed = true
    if (retry !== undefined) clearTimeout(retry)
    source?.close()
    onStatus?.(false)
  }
}
