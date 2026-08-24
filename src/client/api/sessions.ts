/**
 * Session endpoints: list, open, create, rename, delete, send, interrupt, and
 * the per-session environment layer.
 *
 * @module dsh-cc/client/api/sessions
 */

import type { CcEvent, ImageRef, SessionMeta } from '../../types.ts'
import { api } from './http.ts'

/** GET /sessions — every session the store knows, newest first. */
export function fetchSessions(): Promise<{ sessions: SessionMeta[] }> {
  return api<{ sessions: SessionMeta[] }>('/sessions')
}

/**
 * GET /sessions/:id — metadata plus the transcript tail.
 * @param id - session id.
 * @returns the session and its events.
 */
export function fetchSession(id: string): Promise<{ session: SessionMeta; events: CcEvent[] }> {
  return api<{ session: SessionMeta; events: CcEvent[] }>(`/sessions/${id}`)
}

/**
 * POST /sessions — create a session.
 * @param form - new-session fields; omitted fields take the plugin default.
 * @returns the created session.
 */
export function createSession(
  form: { name?: string; cwd?: string; model?: string },
): Promise<{ session: SessionMeta }> {
  return api<{ session: SessionMeta }>('/sessions', { method: 'POST', body: JSON.stringify(form) })
}

/**
 * DELETE /sessions/:id.
 * @param id - session id.
 * @returns the acknowledgement.
 */
export function deleteSession(id: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/sessions/${id}`, { method: 'DELETE' })
}

/**
 * PUT /sessions/:id/name — rename a session.
 * @param id - session id.
 * @param name - the new display name (1-80 chars).
 * @returns the acknowledgement.
 */
export function renameSession(id: string, name: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/sessions/${id}/name`, { method: 'PUT', body: JSON.stringify({ name }) })
}

/**
 * POST /sessions/:id/messages — submit one user turn.
 * @param id - session id.
 * @param text - message body.
 * @returns the acknowledgement; the turn itself arrives over SSE.
 */
export function sendMessage(id: string, text: string, images: ImageRef[] = []): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/sessions/${id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text, ...(images.length > 0 ? { images } : {}) }),
  })
}

/**
 * POST /sessions/:id/stop — interrupt the running turn, keeping the process.
 * @param id - session id.
 * @returns the acknowledgement.
 */
export function stopSession(id: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/sessions/${id}/stop`, { method: 'POST' })
}

/**
 * PUT /sessions/:id/env — environment for this session's next process.
 * @param id - session id.
 * @param env - complete env map; empty clears the session layer.
 * @returns the acknowledgement.
 */
export function setSessionEnv(id: string, env: Record<string, string>): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/sessions/${id}/env`, { method: 'PUT', body: JSON.stringify({ env }) })
}

/**
 * Upload one pasted or dropped image, returning the reference to attach to a
 * message. The body is the raw file; the server reads its type from the
 * `content-type` header rather than parsing a multipart envelope.
 * @param file - the image to upload.
 * @returns the stored reference.
 */
export function uploadImage(file: File): Promise<{ image: ImageRef }> {
  return api<{ image: ImageRef }>('/images', {
    method: 'POST',
    headers: {
      'content-type': file.type,
      // Header values must be Latin-1; a Chinese file name would otherwise
      // throw before the request is sent.
      'x-image-name': encodeURIComponent(file.name),
    },
    body: file,
  })
}
