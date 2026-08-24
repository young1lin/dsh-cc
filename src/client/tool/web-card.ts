/**
 * Web-card derivation for the `WebSearch` and `WebFetch` tools.
 *
 * Both land on `WebBlock`'s `search` shape — an answer over a citation list.
 * The `fetch` shape needs the response's HTTP status, which Claude Code never
 * reports, so a fetch renders as its retrieved text over the one URL it came
 * from rather than as a status card with a fabricated code.
 *
 * The card is result-side only: neither tool has sources before the CLI
 * answers, so a running call keeps the generic card.
 *
 * @module dsh-cc/client/tool/web-card
 */

import type { WebBlockProps, WebSourceView } from '@deepseek-ai/dsh-client-ui-primitives'
import { stringField, stripReminders, type ToolResult } from './wire.ts'

/** `WebSearch`'s citation block: a JSON array on its own `Links:` line. */
const LINKS_BLOCK = /^Links:[ \t]*(\[[\s\S]*?\])[ \t]*$/m

/** `WebSearch`'s echo of the query, which the row's own summary already carries. */
const QUERY_HEADER = /^Web search results for query:.*$/m

/**
 * Narrow the parsed `Links:` array to the sources the card draws. Every entry
 * needs a URL; a missing title is fine, since `WebBlock` labels such a source
 * by its hostname.
 * @param value - the parsed JSON array.
 * @returns the sources, or null when the payload is not a usable list.
 */
function narrowSources(value: unknown): WebSourceView[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const sources: WebSourceView[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null
    const { url, title } = entry as Record<string, unknown>
    if (typeof url !== 'string' || url === '') return null
    sources.push({ url, title: typeof title === 'string' && title !== '' ? title : undefined })
  }
  return sources
}

/**
 * Parse `WebSearch`'s answer text into its sources and prose. The query echo
 * and the `Links:` block are removed from the prose, which the card renders as
 * markdown above the citation list.
 * @param text - the settled result text.
 * @returns the card props.
 */
function searchResult(text: string): WebBlockProps {
  const block = LINKS_BLOCK.exec(text)
  let sources: WebSourceView[] | null = null
  if (block !== null) {
    try {
      sources = narrowSources(JSON.parse(String(block[1])))
    } catch {
      // Model-adjacent CLI output, not a schema: malformed JSON here costs the
      // citation list only, and the prose below still carries the answer.
      sources = null
    }
  }
  const prose = block === null ? text : text.replace(block[0], '')
  const answer = prose.replace(QUERY_HEADER, '').trim()
  return { kind: 'search', answer: answer === '' ? undefined : answer, sources: sources ?? [], truncated: false }
}

/**
 * Derive the web-card props for a `WebSearch` or `WebFetch` call, or null when
 * the call belongs on the generic card.
 * @param name - wire tool name (`WebSearch` or `WebFetch`).
 * @param input - the `tool_use.input` for the call.
 * @param result - the settled result, or undefined while the call is running.
 * @returns the `WebBlock` props, or null for the generic path.
 */
export function webCard(name: string, input: unknown, result: ToolResult | undefined): WebBlockProps | null {
  if (result === undefined || result.isError) return null
  const text = stripReminders(result.text)
  if (text === '') return null
  if (name === 'WebSearch') return searchResult(text)
  const url = stringField(input, 'url')
  if (url === undefined) return null
  return { kind: 'search', answer: text, sources: [{ url }], truncated: false }
}
