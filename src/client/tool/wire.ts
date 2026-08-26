/**
 * Readers for Claude Code tool payloads.
 *
 * A `tool_use.input` is model-authored JSON and a `tool_result.text` is CLI
 * output text: both are wire data, so every field access narrows explicitly and
 * every parser returns `undefined`/`null` instead of throwing when the payload
 * is not what a card needs. That null is what routes the call to the generic
 * IN/OUT card.
 *
 * @module dsh-cc/client/tool/wire
 */

/** A settled tool result as the card derivations read it. */
export interface ToolResult {
  text: string
  isError: boolean
}

/**
 * Narrow a tool payload to a plain property bag.
 * @param value - the untrusted payload.
 * @returns the record, or undefined when the payload is not a non-null object.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Read one non-empty string argument off a tool payload.
 * @param input - the untrusted `tool_use.input`.
 * @param key - the argument name.
 * @returns the value, or undefined when absent, mistyped, or empty.
 */
export function stringField(input: unknown, key: string): string | undefined {
  const value = asRecord(input)?.[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Collapse a payload to its first line for a one-line summary.
 * @param text - the raw text.
 * @param cap - maximum characters kept before an ellipsis.
 * @returns the first line, capped.
 */
export function firstLine(text: string, cap = 120): string {
  const line = text.split('\n', 1)[0] ?? ''
  return line.length > cap ? `${line.slice(0, cap)}…` : line
}

/** The CLI wraps some tool failures in this pseudo-tag before they cross the wire. */
const TOOL_ERROR_TAG = /<tool_use_error>([\s\S]*?)<\/tool_use_error>/g

/**
 * Strip the pseudo-tag wrapper off an error result's text so the raw marker
 * never reaches the page; unwrapped text passes through unchanged.
 * @param text - the raw result text as it crossed the wire.
 * @returns the inner message when the tag is present, else the input.
 */
export function unwrapToolErrorText(text: string): string {
  return text.replace(TOOL_ERROR_TAG, '$1')
}

/**
 * Shorten an absolute path for display by dropping the session workspace
 * prefix. Both separators are accepted because the CLI reports POSIX paths on a
 * Windows host whose session cwd may use either.
 * @param text - the path as the tool received it.
 * @param cwd - the session workspace root; absent leaves the path as authored.
 * @returns the workspace-relative path, or the input when it is outside `cwd`.
 */
export function relativizeToCwd(text: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return text
  const root = cwd.replace(/[/\\]+$/, '')
  if (text.startsWith(`${root}/`) || text.startsWith(`${root}\\`)) return text.slice(root.length + 1)
  return text
}

/**
 * Drop the `<system-reminder>` blocks the CLI appends to some tool results.
 * They are prompt scaffolding addressed to the model, never part of the result
 * a card draws.
 * @param text - the raw result text.
 * @returns the text without reminder blocks, trimmed of the gap they left.
 */
export function stripReminders(text: string): string {
  return text.replace(/\n*<system-reminder>[\s\S]*?<\/system-reminder>\n*/g, '\n').trim()
}

/**
 * Split output text into its lines, treating a single trailing newline as the
 * last line's terminator rather than an extra empty line — the rule
 * `TerminalBlock` and `DiffBlock` both apply to their own bodies.
 * @param text - the output text.
 * @returns the content lines, without the terminating newline.
 */
export function contentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/**
 * The lowercased file extension of a path, which the markdown highlighter's
 * alias map resolves to a grammar (an unknown one renders plain, so no
 * extension table is needed here).
 * @param path - the file path.
 * @returns the extension without its dot, or undefined when the name has none.
 */
export function langFromPath(path: string): string | undefined {
  const name = path.split(/[/\\]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return undefined
  return name.slice(dot + 1).toLowerCase()
}
