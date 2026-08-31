/**
 * Turn copy: fold one conversation turn — a user message plus every
 * committed event after it, optionally the still-streaming tail — into
 * pasteable Markdown, and write it to the clipboard.
 *
 * The fold mirrors what the transcript column renders: thinking as a
 * labelled section, prose in place, each tool call paired with its result
 * by `toolUseId`, the same closing stats strip — so what lands on the
 * clipboard reads like the conversation on screen. Tool results are the
 * wire text with prompt scaffolding (`<system-reminder>`) stripped and each
 * call capped, so one huge Read cannot silently flood the paste.
 *
 * @module dsh-cc/client/turn-copy
 */

import type { LiveTurnState } from '../live-turn.ts'
import type { CcEvent } from '../types.ts'
import { compact } from './status/format.ts'
import { stripReminders, unwrapToolErrorText } from './tool/wire.ts'

/**
 * Characters of one tool result kept in a copy. The visual cards clip for
 * display; this is the same mercy for pastes, applied per call so a long
 * turn of small results still copies in full.
 */
const TOOL_OUTPUT_LIMIT = 12_000

/** Notice levels → the bracketed lead their quote line carries. */
const NOTICE_LEADS: Record<string, string> = {
  notice: '提示',
  suggestion: '建议',
  warning: '警告',
}

/** What「复制回合」folds into text. */
export interface TurnCopyInput {
  /** The whole committed transcript; the turn is sliced out of it by `userSeq`. */
  events: readonly CcEvent[]
  /** `seq` of the user message that anchors the turn. */
  userSeq: number
  /**
   * The session's in-flight turn. Its open blocks are appended — the same
   * blocks the live view still shows — when the anchor is the newest user
   * message; anything older has settled and copies from its events alone.
   */
  live?: LiveTurnState
}

/** One renderable piece of the assistant side, in transcript order. */
type Piece =
  | { k: 'thinking'; text: string }
  | { k: 'assistant'; text: string; aborted: boolean }
  | {
    k: 'tool'
    name: string
    input: unknown
    /** False when only the result survived the transcript tail cap. */
    hasCall: boolean
    /** True while the call's arguments are still streaming (live tail only). */
    calling?: true
    result?: { text: string; isError: boolean }
  }
  | { k: 'commandOutput'; text: string }
  | { k: 'quote'; line: string }
  | { k: 'error'; message: string }
  | { k: 'result'; stats: string; failure?: string }

/**
 * Fold one turn into Markdown for the clipboard.
 *
 * @param input - the transcript, the anchoring user message's `seq`, and the
 *   session's live turn when one may still be writing.
 * @returns the Markdown text; empty when no user event matches `userSeq`.
 */
export function formatTurnForCopy(input: TurnCopyInput): string {
  const anchor = input.events.findIndex(event => event.seq === input.userSeq && event.kind === 'user')
  if (anchor < 0) return ''
  const user = input.events[anchor] as Extract<CcEvent, { kind: 'user' }>
  const rest = input.events.slice(anchor + 1)
  const next = rest.findIndex(event => event.kind === 'user')
  const turn = next < 0 ? rest : rest.slice(0, next)

  const pieces = foldPieces(turn)
  // The live tail belongs to this copy only when the anchor is the newest
  // user message; an in-flight turn with nothing streamed yet still marks the
  // copy, or it would read as a turn that already ended.
  const liveTurn = next < 0 ? input.live : undefined
  const livePieces = foldLive(liveTurn)

  const lines: string[] = ['## 用户', '']
  lines.push(user.text === '' ? '（仅图片）' : user.text)
  if (user.images !== undefined && user.images.length > 0) {
    const names = user.images.map(image => image.name ?? image.id.slice(0, 8)).join('、')
    lines.push('', `> 附图 ${user.images.length} 张：${names}`)
  }
  if (pieces.length > 0 || liveTurn !== undefined) {
    lines.push('', '## Claude Code', '')
    renderPieces(pieces, lines)
    renderPieces(livePieces, lines)
    if (liveTurn !== undefined) lines.push('', '*（回合仍在进行中，以上为复制时已生成的内容）*')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * Fold the turn's committed events into ordered pieces. Tool results attach
 * to their call's piece — the same `toolUseId` pairing the transcript
 * renders — so a call reads as one block wherever its answer landed.
 *
 * @param turn - the committed events between the anchor and the next user
 *   message (or the end of the transcript).
 * @returns the pieces in transcript order.
 */
function foldPieces(turn: readonly CcEvent[]): Piece[] {
  const pieces: Piece[] = []
  const tools = new Map<string, Extract<Piece, { k: 'tool' }>>()
  for (const event of turn) {
    switch (event.kind) {
      case 'thinking':
        if (event.text !== '') pieces.push({ k: 'thinking', text: event.text })
        break
      case 'assistant':
        if (event.text !== '' || event.aborted === true) {
          pieces.push({ k: 'assistant', text: event.text, aborted: event.aborted === true })
        }
        break
      case 'tool_use': {
        const piece: Extract<Piece, { k: 'tool' }> = {
          k: 'tool', name: event.name, input: event.input, hasCall: true,
        }
        tools.set(event.toolUseId, piece)
        pieces.push(piece)
        break
      }
      case 'tool_result': {
        const result = { text: event.text, isError: event.isError }
        const pending = tools.get(event.toolUseId)
        if (pending === undefined) {
          pieces.push({ k: 'tool', name: '工具', input: undefined, hasCall: false, result })
        } else {
          pending.result = result
        }
        break
      }
      case 'commandOutput':
        pieces.push({ k: 'commandOutput', text: event.text })
        break
      case 'notice':
        pieces.push({ k: 'quote', line: `> [${NOTICE_LEADS[event.level] ?? '提示'}] ${event.text}` })
        break
      case 'compactBoundary': {
        const parts: string[] = []
        if (event.preTokens !== undefined && event.postTokens !== undefined) {
          parts.push(`前 ${compact(event.preTokens)} tokens → 后 ${compact(event.postTokens)} tokens`)
        } else if (event.preTokens !== undefined) {
          parts.push(`压缩前 ${compact(event.preTokens)} tokens`)
        }
        pieces.push({
          k: 'quote',
          line: `> —— 对话已压缩${parts.length > 0 ? `：${parts.join(' · ')}` : ''} ——`,
        })
        break
      }
      case 'system':
        // init is connection bookkeeping, not conversation; anything else the
        // transcript renders as a note rides along as a quote line.
        if (event.subtype !== 'init') pieces.push({ k: 'quote', line: `> [system] ${event.subtype}` })
        break
      case 'error':
        pieces.push({ k: 'error', message: event.message })
        break
      case 'result': {
        // A clean zero-turn result closes a local slash command whose output
        // already rode its own piece; the stats strip under it is noise.
        if (event.isError) {
          const reason = event.errors?.join('；') ?? event.terminalReason ?? event.subtype
          pieces.push({ k: 'result', stats: '', failure: reason })
        } else if (event.numTurns > 0) {
          pieces.push({ k: 'result', stats: resultStats(event) })
        }
        break
      }
      default:
        break
    }
  }
  return pieces
}

/**
 * Fold the open blocks of the in-flight turn. A closed block's content has
 * already committed, so appending it would duplicate the transcript — the
 * same rule the live view renders by.
 *
 * @param live - the folded live turn, or undefined when none is in flight.
 * @returns the pieces worth appending.
 */
function foldLive(live: LiveTurnState | undefined): Piece[] {
  if (live === undefined) return []
  const pieces: Piece[] = []
  for (const block of live.blocks) {
    if (block.closed) continue
    if (block.type === 'thinking') {
      if (block.text !== '') pieces.push({ k: 'thinking', text: block.text })
    } else if (block.type === 'text') {
      if (block.text !== '') pieces.push({ k: 'assistant', text: block.text, aborted: false })
    } else if (block.toolName !== undefined) {
      // Arguments only parse once whole, so a streaming call copies by name.
      pieces.push({ k: 'tool', name: block.toolName, input: undefined, hasCall: true, calling: true })
    }
  }
  return pieces
}

/**
 * Append pieces to the output lines. Every piece closes with one blank line,
 * so consecutive pieces separate by exactly one blank line and nothing needs
 * a post-hoc newline collapse (which would corrupt fenced content).
 *
 * @param pieces - the ordered pieces.
 * @param lines - the output accumulator.
 */
function renderPieces(pieces: readonly Piece[], lines: string[]): void {
  for (const piece of pieces) {
    switch (piece.k) {
      case 'thinking':
        lines.push('**思考过程**', '', piece.text, '')
        break
      case 'assistant':
        lines.push(piece.text, '')
        if (piece.aborted) lines.push('*（已中断）*', '')
        break
      case 'tool':
        renderTool(piece, lines)
        break
      case 'commandOutput':
        lines.push('**命令输出**', '', piece.text, '')
        break
      case 'quote':
        lines.push(piece.line, '')
        break
      case 'error':
        lines.push(`**错误**：${piece.message}`, '')
        break
      case 'result':
        if (piece.failure !== undefined) lines.push(`**回合异常结束**：${piece.failure}`, '')
        else lines.push('---', '', piece.stats, '')
        break
    }
  }
}

/**
 * Append one tool call: header, arguments as JSON, result as fenced text.
 *
 * @param piece - the paired call and result.
 * @param lines - the output accumulator.
 */
function renderTool(piece: Extract<Piece, { k: 'tool' }>, lines: string[]): void {
  if (!piece.hasCall) {
    // A result whose call predates the kept transcript tail; label it as
    // output rather than inventing a call that was never seen.
    lines.push('**工具输出**', '', fenced(piece.result?.text ?? ''), '')
    return
  }
  lines.push(`**工具调用 · ${piece.name}**${piece.calling === true ? '（调用中）' : ''}`, '')
  const args = renderToolInput(piece.input)
  if (args !== undefined) lines.push('参数：', fenced(args, 'json'), '')
  if (piece.result === undefined || piece.calling === true) {
    lines.push('（尚无输出）', '')
    return
  }
  lines.push(piece.result.isError ? '输出（失败）：' : '输出：', fenced(renderToolOutput(piece.result.text)), '')
}

/**
 * Tool arguments as pretty JSON.
 *
 * @param input - the call's arguments as the model wrote them.
 * @returns the JSON text, the value's string form when it cannot be encoded,
 *   or undefined when the call carried no arguments.
 */
function renderToolInput(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined
  if (typeof input !== 'object') return String(input)
  try {
    return JSON.stringify(input, null, 2) ?? undefined
  } catch {
    // Not reachable through the wire (model-authored JSON), kept for safety.
    return String(input)
  }
}

/**
 * Wire result text as copyable content: prompt scaffolding stripped, the
 * CLI's error wrapper unwrapped, and the per-call cap applied.
 *
 * @param text - the raw result text as it crossed the wire.
 * @returns the cleaned text, capped with a marker when it exceeded the limit.
 */
function renderToolOutput(text: string): string {
  const clean = unwrapToolErrorText(stripReminders(text))
  if (clean.length <= TOOL_OUTPUT_LIMIT) return clean
  return `${clean.slice(0, TOOL_OUTPUT_LIMIT)}\n…（已截断，共 ${clean.length} 字符）`
}

/**
 * Wrap text in a code fence long enough not to collide with any backtick run
 * in the body — a Read of a Markdown file must not break out of its fence.
 *
 * @param body - the text to wrap.
 * @param lang - optional language tag.
 * @returns the fenced block.
 */
function fenced(body: string, lang = ''): string {
  let run = 0
  let longest = 0
  for (const ch of body) {
    if (ch === '`') {
      run += 1
      if (run > longest) longest = run
    } else {
      run = 0
    }
  }
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${lang}\n${body}\n${fence}`
}

/**
 * The turn's closing stats — the same fragments the transcript tail renders.
 * Duplicated from Transcript's `tailParts` on purpose: this module owns the
 * textual export of events, Transcript owns their rendering, and importing
 * one from the other would tie a projection to a component (and cycle the
 * bundle).
 *
 * @param event - the result event.
 * @returns the joined stats.
 */
function resultStats(event: Extract<CcEvent, { kind: 'result' }>): string {
  const parts = [`${event.numTurns} 步`, `${(event.durationMs / 1000).toFixed(1)}s`]
  if (event.apiDurationMs !== undefined && event.apiDurationMs > 0) {
    parts.push(`模型 ${(event.apiDurationMs / 1000).toFixed(1)}s`)
  }
  if (event.usage !== undefined) {
    const { inputTokens, outputTokens, cacheReadInputTokens } = event.usage
    parts.push(`输入 ${compact(inputTokens)} · 输出 ${compact(outputTokens)}`)
    const cacheable = inputTokens + cacheReadInputTokens
    if (cacheable > 0) parts.push(`缓存命中 ${Math.round((cacheReadInputTokens / cacheable) * 100)}%`)
  }
  if (event.totalCostUsd > 0) parts.push(`$${event.totalCostUsd.toFixed(4)}`)
  return parts.join(' · ')
}

/**
 * The turn's assistant prose — every `assistant` event between the user
 * message that opened the turn and the `result` that closed it, joined the
 * way the host's own tail copy joins a turn's text blocks. Tool calls and
 * thinking stay out: this is the reply-as-projection, not the full record.
 *
 * @param events - the whole committed transcript.
 * @param seq - `seq` of the turn's `result` event.
 * @returns the joined text; empty when the turn produced no prose.
 */
export function turnAssistantText(events: readonly CcEvent[], seq: number): string {
  const end = events.findIndex(event => event.seq === seq && event.kind === 'result')
  if (end < 0) return ''
  const texts: string[] = []
  for (let index = end - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) break
    if (event.kind === 'user') break
    if (event.kind === 'assistant' && event.text !== '') texts.unshift(event.text)
  }
  return texts.join('\n\n')
}
