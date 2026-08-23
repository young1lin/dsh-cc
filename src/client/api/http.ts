/**
 * Browser transport primitives: one JSON fetch helper and the shared SSE
 * connection. Domain modules beside this file own their own endpoints, so a
 * feature never edits a shared API surface.
 *
 * @module dsh-cc/client/api/http
 */

import type { WireMessage } from '../../types.ts'

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
