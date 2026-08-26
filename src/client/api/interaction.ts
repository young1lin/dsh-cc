/**
 * Blocking-interaction endpoints: tool-permission decisions, AskUserQuestion
 * dialog answers, and the CLI's slash-command catalog.
 *
 * @module dsh-cc/client/api/interaction
 */

import type { PermissionAnswer, SlashCommand } from '../../types.ts'
import { api } from './http.ts'

/** One question of a pending AskUserQuestion dialog. */
export interface DialogQuestion {
  question?: string
  header?: string
  multiSelect?: boolean
  options?: { label?: string; description?: string }[]
}

/**
 * POST /sessions/:id/permissions/:requestId — decide one tool request.
 * @param id - session id.
 * @param requestId - pending permission request id.
 * @param answer - the decision, an optional note to the model, and whether to
 * persist the request's suggested rules.
 * @returns the acknowledgement.
 */
export function answerPermission(
  id: string,
  requestId: string,
  answer: PermissionAnswer,
): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/sessions/${id}/permissions/${requestId}`, {
    method: 'POST',
    body: JSON.stringify(answer),
  })
}

/**
 * POST /sessions/:id/dialogs/:requestId — answer or cancel a pending dialog.
 * @param id - session id.
 * @param requestId - pending dialog id.
 * @param answers - the completed result payload; undefined cancels.
 * @returns the acknowledgement.
 */
export function answerDialog(id: string, requestId: string, answers: unknown): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/sessions/${id}/dialogs/${requestId}`, {
    method: 'POST',
    body: JSON.stringify(answers === undefined ? { cancel: true } : { answers }),
  })
}

/**
 * GET /sessions/:id/commands — the slash commands this session accepts,
 * including the user's own skills and project commands.
 * @param id - session id.
 * @returns the catalog; empty without a live process. A cold session that
 *  has a remembered catalog serves it with `stale: true` and its save time.
 */
export function fetchCommands(id: string): Promise<{ available: boolean; commands: SlashCommand[]; stale?: boolean; savedAt?: number }> {
  return api<{ available: boolean; commands: SlashCommand[]; stale?: boolean; savedAt?: number }>(`/sessions/${id}/commands`)
}
