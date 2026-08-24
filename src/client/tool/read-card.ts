/**
 * Read-card derivation for the `Read` tool.
 *
 * The card is result-side only: a read carries no file content until the CLI
 * answers, so a running call stays on the generic path. The result text is the
 * `cat -n` window the tool returns — `<line number><tab><text>` per line — and
 * parsing it is the wire boundary this module owns: a payload that is not that
 * window (an image read, a notebook, an error) yields null and the row falls
 * back to the generic card.
 *
 * @module dsh-cc/client/tool/read-card
 */

import type { ReadBlockLine, ReadBlockProps } from '@deepseek-ai/dsh-client-ui-primitives'
import { contentLines, langFromPath, relativizeToCwd, stringField, stripReminders, type ToolResult } from './wire.ts'

/** One numbered line of the window; the CLI writes a tab, older builds an arrow. */
const NUMBERED_LINE = /^\s*(\d+)(?:\t|→)([\s\S]*)$/

/** The `ReadBlock` material one `Read` call yields. */
export interface ReadCard {
  /**
   * The props `ReadBlock` draws. Nested so a render site spreads exactly the
   * primitive's own surface; `maxLines`/`className` belong to that site.
   */
  card: Pick<ReadBlockProps, 'label' | 'lines' | 'totalLines' | 'lang'>
  /**
   * Text that followed the numbered window — the CLI's truncation notice for a
   * capped read. The card draws only the window, so the row keeps this below it
   * rather than dropping the one statement that the read was cut.
   */
  notice: string | undefined
}

/**
 * Derive the read-card material for a `Read` call, or null when the result is
 * not a numbered file window and belongs on the generic card.
 *
 * `totalLines` is the highest line number the window returned, because Claude
 * Code does not report the file's length. For a whole-file read that is the
 * exact total and the card draws no window note; for a read past an `offset` it
 * is a lower bound, which the note then presents as the total.
 * @param input - the `tool_use.input` for the call.
 * @param result - the settled result, or undefined while the call is running.
 * @param cwd - the session workspace, which shortens the path label.
 * @returns the read-card material, or null for the generic path.
 */
export function readCard(input: unknown, result: ToolResult | undefined, cwd: string | undefined): ReadCard | null {
  if (result === undefined || result.isError) return null
  const path = stringField(input, 'file_path')
  if (path === undefined) return null
  const raw = contentLines(stripReminders(result.text))
  const lines: ReadBlockLine[] = []
  let index = 0
  for (; index < raw.length; index++) {
    const matched = NUMBERED_LINE.exec(raw[index] ?? '')
    if (matched === null) break
    lines.push({ number: Number(matched[1]), text: matched[2] ?? '' })
  }
  if (lines.length === 0) return null
  const notice = raw.slice(index).join('\n').trim()
  const last = lines[lines.length - 1]?.number ?? lines.length
  return {
    notice: notice === '' ? undefined : notice,
    card: {
      label: relativizeToCwd(path, cwd),
      lines,
      totalLines: Math.max(lines.length, last),
      lang: langFromPath(path),
    },
  }
}
