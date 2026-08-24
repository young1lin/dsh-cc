/**
 * Diff-card derivation for the `Edit`, `Write`, and `NotebookEdit` tools.
 *
 * Claude Code returns prose for these calls ("The file … has been updated"), so
 * the change itself is only ever in the call arguments: this derivation is
 * argument-side, and a running call already shows its intended diff. A failed
 * call takes the generic path instead — nothing was applied, so drawing the
 * arguments as an applied diff would state something untrue.
 *
 * @module dsh-cc/client/tool/diff-card
 */

import type { DiffBlockProps, DiffHunk } from '@deepseek-ai/dsh-client-ui-primitives'
import { asRecord, contentLines, relativizeToCwd, stringField, type ToolResult } from './wire.ts'

/** The `DiffBlock` material one file-mutation call yields. */
export interface DiffCard {
  /**
   * The props `DiffBlock` draws. Nested so a render site spreads exactly the
   * primitive's own surface; `maxLines`/`className` belong to that site.
   */
  card: Pick<DiffBlockProps, 'diffs'>
  /** Added lines across every hunk, counted the way `DiffBlock`'s own footer counts them. */
  added: number
  /** Removed lines across every hunk, counted the same way. */
  removed: number
}

/**
 * Read a string argument that is meaningful when empty — an `Edit` deleting
 * text passes `new_string: ""`, which {@link stringField} would reject.
 * @param input - the untrusted `tool_use.input`.
 * @param key - the argument name.
 * @returns the value, or undefined when absent or mistyped.
 */
function rawString(input: unknown, key: string): string | undefined {
  const value = asRecord(input)?.[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * The hunks one call describes, or null when its arguments do not describe a
 * file change.
 * @param name - wire tool name.
 * @param input - the `tool_use.input` for the call.
 * @param cwd - the session workspace, which shortens the hunk's path header.
 * @returns the hunks, or null for the generic path.
 */
function hunksFor(name: string, input: unknown, cwd: string | undefined): DiffHunk[] | null {
  if (name === 'NotebookEdit') {
    const path = stringField(input, 'notebook_path')
    const source = rawString(input, 'new_source')
    // A `delete` carries no source at all, and neither mode carries the cell's
    // prior content, so the card can only ever show the added side.
    if (path === undefined || source === undefined) return null
    const cell = stringField(input, 'cell_id')
    const header = relativizeToCwd(path, cwd)
    return [{ path: cell === undefined ? header : `${header} [${cell}]`, oldText: null, newText: source }]
  }
  const path = stringField(input, 'file_path')
  if (path === undefined) return null
  const header = relativizeToCwd(path, cwd)
  if (name === 'Write') {
    const content = rawString(input, 'content')
    return content === undefined ? null : [{ path: header, oldText: null, newText: content }]
  }
  const oldText = rawString(input, 'old_string')
  const newText = rawString(input, 'new_string')
  if (oldText === undefined || newText === undefined) return null
  return [{ path: header, oldText, newText }]
}

/**
 * Derive the diff-card material for a file-mutation call, or null when the
 * arguments do not describe a change and the call belongs on the generic card.
 * @param name - wire tool name (`Edit`, `Write`, or `NotebookEdit`).
 * @param input - the `tool_use.input` for the call.
 * @param result - the settled result, or undefined while the call is running.
 * @param cwd - the session workspace, which shortens the hunk's path header.
 * @returns the diff-card material, or null for the generic path.
 */
export function diffCard(
  name: string,
  input: unknown,
  result: ToolResult | undefined,
  cwd: string | undefined,
): DiffCard | null {
  if (result?.isError === true) return null
  const diffs = hunksFor(name, input, cwd)
  if (diffs === null) return null
  let added = 0
  let removed = 0
  for (const hunk of diffs) {
    added += contentLines(hunk.newText).length
    removed += hunk.oldText === null ? 0 : contentLines(hunk.oldText).length
  }
  return { card: { diffs }, added, removed }
}
