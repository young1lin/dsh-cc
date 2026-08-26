/**
 * Policy for the `!` shell mode prefix: which sessions may run a shell line
 * directly, decided from the session's effective permission posture. The CLI's
 * own rule is that shell mode bypasses the model but not the user's trust
 * posture; the page's translation:
 *
 * - plan / default → the line must go through the existing approval card
 *   (the engine surfaces it as a permission request before running);
 * - acceptEdits / auto / dontAsk → run, but auto-mode commands stay visible
 *   in the transcript as commandOutput rows;
 * - bypassPermissions → run silently, like every other tool.
 *
 * Mechanism (spawn/timeout/cap) lives in shell-run.ts; this module only
 * answers "may this run without asking".
 *
 * @module dsh-cc/shell-policy
 */

import type { PermissionModeValue } from './types.ts'

/** The decision one shell-mode line gets. */
export type ShellPolicyDecision = 'run' | 'ask'

/**
 * Decide whether one shell-mode line may execute without an approval card.
 * @param mode - the session's effective permission posture.
 * @returns 'run' to execute directly, 'ask' to surface the approval card first.
 */
export function shellPolicyFor(mode: PermissionModeValue | string): ShellPolicyDecision {
  if (mode === 'default' || mode === 'plan') return 'ask'
  return 'run'
}
