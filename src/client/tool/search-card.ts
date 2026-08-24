/**
 * Search-card derivation for the `Grep` and `Glob` tools.
 *
 * Both tools answer in plain text and the shape depends on the mode the model
 * chose, so this parses the RESULT rather than trusting `input.output_mode`:
 * `path:line:text` rows become the grouped-matches card, bare rows become the
 * path-list card, and anything else — `Grep`'s count mode, an error, a message
 * this parser does not recognise — yields null so the row keeps the generic
 * card with the tool's own text intact.
 *
 * @module dsh-cc/client/tool/search-card
 */

import type { SearchBlockProps, SearchFileGroup } from '@deepseek-ai/dsh-client-ui-primitives'
import { contentLines, stripReminders, type ToolResult } from './wire.ts'

/**
 * Distributive `Omit`: a plain `Omit` over the union would keep only the keys
 * both members share, dropping the `files`/`paths` discriminated fields.
 */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

/** The `SearchBlockProps` union minus the render site's own fields. */
type SearchBlockModelProps = DistributiveOmit<SearchBlockProps, 'maxLines' | 'className'>

/** The `SearchBlock` material one search call yields. */
export interface SearchCard {
  /**
   * The props `SearchBlock` draws. Nested so a render site spreads exactly the
   * primitive's own surface; `maxLines`/`className` belong to that site.
   */
  card: SearchBlockModelProps
  /**
   * The tool's own note about a capped result. The card draws only the retained
   * rows, so the row keeps this below it rather than dropping the one statement
   * that results were dropped.
   */
  notice: string | undefined
}

/** `Found 12 files` / `Found 30 lines` — the count header both modes may open with. */
const FOUND_HEADER = /^Found (\d+) (?:files?|lines?|matches?)\b/i

/** An empty answer, in either tool's wording. */
const EMPTY_RESULT = /^No (?:files|matches|results) found/i

/** A match row: `path:line:text`, with the path taken up to the first `:<digits>:`. */
const MATCH_ROW = /^(.+?):(\d+):([\s\S]*)$/

/** A context row (`-A`/`-B`/`-C`): the same columns joined by `-` instead of `:`. */
const CONTEXT_ROW = /^(.+?)-(\d+)-([\s\S]*)$/

/** `Grep`'s count mode: `path:count` and nothing after it. */
const COUNT_ROW = /^.+:\d+$/

/**
 * Whether a line is the tool's cap notice rather than a result. Parenthesised
 * because `Glob` writes its note that way, and word-matched because `Grep`
 * writes an unparenthesised sentence.
 * @param line - an unparsed result line.
 * @returns whether the line reports truncation.
 */
function isCapNotice(line: string): boolean {
  return /truncat/i.test(line) || (line.startsWith('(') && line.endsWith(')'))
}

/**
 * Group `path:line:text` rows by file in first-seen order. Context rows join a
 * group only when their path already appeared as a real match, since the
 * context pattern would otherwise claim any path containing `-<digits>-`.
 * @param lines - the result rows, without the header and cap notice.
 * @returns the groups, or null when a row is not a match or context row.
 */
function groupMatches(lines: string[]): SearchFileGroup[] | null {
  const groups = new Map<string, SearchFileGroup>()
  for (const line of lines) {
    if (line === '--') continue
    const match = MATCH_ROW.exec(line)
    if (match !== null) {
      const path = String(match[1])
      const group = groups.get(path) ?? { path, matches: [] }
      group.matches.push({ lineNumber: Number(match[2]), line: match[3] ?? '' })
      groups.set(path, group)
      continue
    }
    const context = CONTEXT_ROW.exec(line)
    if (context === null) return null
    const group = groups.get(String(context[1]))
    if (group === undefined) return null
    group.matches.push({ lineNumber: Number(context[2]), line: context[3] ?? '' })
  }
  return [...groups.values()]
}

/**
 * Derive the search-card material for a `Grep` or `Glob` call, or null when the
 * result is not a shape the card draws.
 *
 * The card is result-side only: a search has no matches before the CLI answers,
 * so a running call keeps the generic card.
 * @param result - the settled result, or undefined while the call is running.
 * @returns the search-card material, or null for the generic path.
 */
export function searchCard(result: ToolResult | undefined): SearchCard | null {
  if (result === undefined || result.isError) return null
  const text = stripReminders(result.text)
  if (EMPTY_RESULT.test(text)) {
    return { notice: undefined, card: { kind: 'paths', paths: [], truncated: false, total: 0 } }
  }
  const rows = contentLines(text).filter(line => line.trim() !== '')
  const header = FOUND_HEADER.exec(rows[0] ?? '')
  const body = header === null ? rows : rows.slice(1)
  if (body.length === 0) return null
  const notices = body.filter(isCapNotice)
  const results = body.filter(line => !isCapNotice(line))
  if (results.length === 0) return null
  // Count mode reports `path:count`, which the path card would draw as paths
  // with a number glued on; its own text is already readable, so it stays generic.
  if (results.every(line => COUNT_ROW.test(line))) return null
  const notice = notices.length === 0 ? undefined : notices.join('\n')
  const stated = header === null ? undefined : Number(header[1])
  if (results.some(line => MATCH_ROW.test(line))) {
    // Any `path:line:text` row makes this the grouped-matches shape; a sibling
    // row that then fails to parse means the text is not that shape after all.
    const files = groupMatches(results)
    if (files === null) return null
    const shown = files.reduce((sum, file) => sum + file.matches.length, 0)
    return { notice, card: { kind: 'matches', files, ...capping(stated, shown, notice) } }
  }
  return { notice, card: { kind: 'paths', paths: results, ...capping(stated, results.length, notice) } }
}

/**
 * The card's cap fields, reconciling the header's pre-cap count with what the
 * result actually carried.
 * @param stated - the count the `Found N …` header reported, if any.
 * @param shown - the rows the card holds.
 * @param notice - the tool's cap notice, if it wrote one.
 * @returns the `total`/`truncated` pair.
 */
function capping(
  stated: number | undefined,
  shown: number,
  notice: string | undefined,
): { total: number; truncated: boolean } {
  const total = stated !== undefined && stated > shown ? stated : shown
  return { total, truncated: notice !== undefined || total > shown }
}
