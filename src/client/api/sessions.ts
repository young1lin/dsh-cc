/**
 * Session endpoints: list, open, create, rename, delete, send, interrupt, and
 * the per-session environment layer.
 *
 * @module dsh-cc/client/api/sessions
 */

import type { CcEvent, ImageRef, LiveTurnSnapshot, QueuedMessageView, SessionMeta, TaskRow } from '../../types.ts'
import { api } from './http.ts'

/**
 * GET /sessions — every session the store knows, newest first.
 * @returns the full merged session list, newest first.
 */
export function fetchSessions(): Promise<{ sessions: SessionMeta[] }> {
  return api<{ sessions: SessionMeta[] }>('/sessions')
}

/**
 * GET /sessions/:id — metadata, the transcript tail, the server's fold of the
 * in-flight turn (null turn when none is running), and the task snapshot.
 * @param id - session id.
 * @returns the session, its events, its live-turn snapshot, and its tasks.
 */
export function fetchSession(id: string): Promise<{
  session: SessionMeta
  events: CcEvent[]
  live: LiveTurnSnapshot
  tasks: TaskRow[]
}> {
  return api<{ session: SessionMeta; events: CcEvent[]; live: LiveTurnSnapshot; tasks: TaskRow[] }>(`/sessions/${id}`)
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
 * GET /sessions/:id/queue — the messages held host-side for the next
 * model-call boundary, oldest first. Serves the live engine's queue and the
 * carry-over of a dead one alike; a session with nothing queued is an empty list.
 * @param id - session id.
 * @returns the queued items in delivery order.
 */
export function fetchQueue(id: string): Promise<{ items: QueuedMessageView[] }> {
  return api<{ items: QueuedMessageView[] }>(`/sessions/${id}/queue`)
}

/**
 * DELETE /sessions/:id/queue/:uuid — recall one queued message before the
 * CLI ever sees it.
 * @param id - session id.
 * @param uuid - the queued message's id.
 * @returns the removed item; rejects when it was already delivered or never existed.
 */
export function recallQueued(id: string, uuid: string): Promise<{ item: QueuedMessageView }> {
  return api<{ item: QueuedMessageView }>(`/sessions/${id}/queue/${uuid}`, { method: 'DELETE' })
}

/**
 * POST /sessions/:id/tasks/:taskId/stop — stop one running task.
 * @param id - session id.
 * @param taskId - the task id from the panel's row.
 * @returns the acknowledgement.
 */
export function stopTask(id: string, taskId: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/sessions/${id}/tasks/${taskId}/stop`, { method: 'POST' })
}

/**
 * POST /sessions/:id/tasks/:taskId/background — background one foreground task.
 * @param id - session id.
 * @param taskId - the task id from the panel's row.
 * @returns the acknowledgement.
 */
export function backgroundTask(id: string, taskId: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/sessions/${id}/tasks/${taskId}/background`, { method: 'POST' })
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
 * POST /sessions/:id/fork — copy the session into a new native session, up to
 * an optional message, and switch to it.
 * @param id - session id.
 * @param body - the branch point (a user message's nativeMessageId) and an
 *   optional title; omit both for a full-copy fork.
 * @returns the new session's id.
 */
export function forkSession(
  id: string,
  body: { upToMessageId?: string; title?: string } = {},
): Promise<{ sessionId: string }> {
  return api<{ sessionId: string }>(`/sessions/${id}/fork`, { method: 'POST', body: JSON.stringify(body) })
}

/** The CLI's rewind answer: feasibility, per-file stats, link-safety refusals. */
export interface RewindResult {
  canRewind: boolean
  error?: string
  /** Tracked files the rewind would touch (or touched, after apply). */
  filesChanged?: string[]
  insertions?: number
  deletions?: number
  /**
   * Tracked files NOT restored because a symlink/hard link or an unreadable
   * backup sat at the tracked path. Only a real rewind reports it; a preview
   * never does.
   */
  skippedLinks?: number
}

/**
 * POST /sessions/:id/rewind-preview — what rewinding to one user message
 * would do to the files, without touching them.
 * @param id - session id.
 * @param userMessageId - the anchor message's nativeMessageId.
 * @returns the preview: file count and diff totals. Rejects when the CLI
 *   refuses (the refusal reason is the error message).
 */
export function rewindPreview(id: string, userMessageId: string): Promise<RewindResult> {
  return api<RewindResult>(`/sessions/${id}/rewind-preview`, {
    method: 'POST',
    body: JSON.stringify({ userMessageId }),
  })
}

/**
 * POST /sessions/:id/rewind — restore tracked files to their state at one
 * user message. The conversation itself is untouched.
 * @param id - session id.
 * @param userMessageId - the anchor message's nativeMessageId.
 * @returns what the rewind did, including link-safety refusals.
 */
export function rewindApply(id: string, userMessageId: string): Promise<RewindResult> {
  return api<RewindResult>(`/sessions/${id}/rewind`, {
    method: 'POST',
    body: JSON.stringify({ userMessageId }),
  })
}

/**
 * POST /sessions/:id/rewind-apply — rewind the CONVERSATION to one user
 * message: the session continues from the anchor, everything after it is
 * discarded, and the session-level settings (model / env / account binding)
 * carry over. Optionally restores the tracked files to the same point first.
 * @param id - session id.
 * @param body - the anchor message plus whether files roll back too.
 * @returns the rewound session's id (a new native id under the same name)
 *   and a warning string when part of the operation needs manual attention.
 */
export function rewindConversation(
  id: string,
  body: { userMessageId: string; restoreFiles: boolean },
): Promise<{ sessionId: string; warning?: string }> {
  return api<{ sessionId: string; warning?: string }>(`/sessions/${id}/rewind-apply`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
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
