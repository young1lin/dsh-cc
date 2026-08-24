/**
 * Transcript projection and rendering.
 *
 * A turn's `tool_use` and its later `tool_result` are ONE thing to a reader,
 * so they are paired here by `toolUseId` and drawn as a single disclosure row —
 * the same shape the host uses for its own tool calls. Everything else is a
 * pure function of the event list, so a re-render never depends on arrival
 * order.
 *
 * This module owns the projection and the dispatch; how a given tool draws
 * lives under `tool/`.
 *
 * @module dsh-cc/client/Transcript
 */

import { useState, type ReactElement } from 'react'
import { DisclosureRow, IconThinkOutline14, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { registerCss } from './css.ts'
import { ToolRow } from './tool/ToolRow.tsx'
import { stringField } from './tool/wire.ts'
import type { CcEvent } from '../types.ts'

registerCss('transcript', `
/* The user's own turn, drawn from the host's own bubble token and geometry
   (fill, r22, 16/24 type, 525px cap) so the two conversations match. */
.cc-user {
  align-self: flex-end;
  max-width: min(525px, 82%);
  padding: 10px 16px;
  border-radius: 22px;
  background: var(--dsw-specific-bubble);
  color: var(--dsw-alias-label-primary);
  font-size: 16px;
  line-height: 24px;
  white-space: pre-wrap;
  word-break: break-word;
}

/* The assistant owns the full column width with no card around it, so prose
   reads as prose. */
.cc-assistant { align-self: stretch; font: var(--dsw-font-markdown-base); }
.cc-assistant :where(p) { margin: 0.4em 0; }
.cc-assistant :where(h1, h2, h3, h4) { margin: 0.7em 0 0.3em; }
.cc-assistant :where(ul, ol) { margin: 0.4em 0; padding-left: 1.4em; }
.cc-assistant :where(table) { margin: 0.5em 0; border-collapse: collapse; }
.cc-assistant :where(th, td) { padding: 4px 10px; border: 1px solid var(--dsw-alias-border-l2); }

.cc-think { align-self: stretch; }
.cc-think-title { font: var(--dsw-font-s-14); font-weight: 400; color: var(--dsw-alias-label-primary); }
.cc-think-body {
  margin: 2px 0 4px 22px;
  white-space: pre-wrap;
  font: var(--dsw-font-xs-13);
  color: var(--dsw-alias-label-tertiary);
}

.cc-note {
  align-self: center;
  padding: 2px 12px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-tertiary);
}

.cc-fail {
  align-self: stretch;
  padding: 8px 14px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  border-radius: 10px;
  background: var(--dsw-alias-state-error-secondary);
  color: var(--dsw-alias-state-error-primary);
  font: var(--dsw-font-xs-13);
}

/* Turn tail: the same quiet stats strip the host closes a turn with. */
.cc-tail {
  align-self: center;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  padding: 2px 0 6px;
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-caption);
}

.cc-tail-sep { color: var(--dsw-alias-border-l3); }
`)

/** One tool call with its result, or any other transcript entry. */
type Item =
  | { k: 'event'; event: CcEvent }
  | {
    k: 'tool'
    id: string
    call?: Extract<CcEvent, { kind: 'tool_use' }>
    result?: Extract<CcEvent, { kind: 'tool_result' }>
  }

/**
 * Pair each `tool_use` with the `tool_result` that answers it, preserving the
 * order tool calls were made in. A result whose call never arrived (a
 * truncated transcript tail) still renders, as its own row.
 *
 * @param events - the transcript in order.
 * @returns renderable items in transcript order.
 */
export function projectTranscript(events: CcEvent[]): Item[] {
  const items: Item[] = []
  const byToolUseId = new Map<string, Extract<Item, { k: 'tool' }>>()
  for (const event of events) {
    if (event.kind === 'tool_use') {
      const item: Extract<Item, { k: 'tool' }> = { k: 'tool', id: event.toolUseId, call: event }
      byToolUseId.set(event.toolUseId, item)
      items.push(item)
      continue
    }
    if (event.kind === 'tool_result') {
      const pending = byToolUseId.get(event.toolUseId)
      if (pending !== undefined) {
        pending.result = event
        continue
      }
      items.push({ k: 'tool', id: event.toolUseId, result: event })
      continue
    }
    items.push({ k: 'event', event })
  }
  return items
}

/**
 * The one-line summary shown beside a tool's name while collapsed: the single
 * argument that identifies the call, not its whole JSON. A card may override it
 * once the call's own material is known.
 *
 * @param name - wire tool name.
 * @param input - the call arguments.
 * @returns the summary text; empty when no argument identifies the call.
 */
export function toolSummary(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const args = input as Record<string, unknown>
  const pick = (key: string): string => (typeof args[key] === 'string' ? args[key] : '')
  switch (name) {
    case 'Bash':
      return pick('command')
    case 'Read':
    case 'Edit':
    case 'Write':
      return pick('file_path')
    case 'NotebookEdit':
      return pick('notebook_path')
    case 'Grep':
    case 'Glob':
      return pick('pattern')
    case 'WebFetch':
      return pick('url')
    case 'WebSearch':
      return pick('query')
    case 'Task':
      return pick('description')
    case 'TodoWrite':
      return Array.isArray(args.todos) ? `${args.todos.length} 项` : ''
    default: {
      const first = Object.values(args).find(value => typeof value === 'string')
      return typeof first === 'string' ? first : ''
    }
  }
}

/**
 * The session's working directory, as the CLI reported it when the conversation
 * opened. It labels the terminal prompt and shortens every path a card shows,
 * so it is read from the transcript rather than threaded through the page: the
 * last init wins, since a resumed session re-announces its cwd.
 *
 * @param events - the transcript in order.
 * @returns the working directory, or undefined when no init event carried one.
 */
function sessionCwd(events: CcEvent[]): string | undefined {
  let cwd: string | undefined
  for (const event of events) {
    if (event.kind === 'system' && event.subtype === 'init') cwd = stringField(event.data, 'cwd') ?? cwd
  }
  return cwd
}

/** Thinking, shown as its own collapsed disclosure ahead of what it produced. */
function ThinkingItem(props: { text: string }): ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <div className="cc-think">
      <DisclosureRow
        titleClassName="cc-think-title"
        icon={<IconThinkOutline14 />}
        title="思考过程"
        open={open}
        expandable
        expandOnRowClick
        onToggle={() => setOpen(value => !value)}
      >
        <div className="cc-think-body">{props.text}</div>
      </DisclosureRow>
    </div>
  )
}

/**
 * Format a turn's closing stats the way the host closes a turn.
 * @param event - the result event.
 * @returns the stats fragments.
 */
function tailParts(event: Extract<CcEvent, { kind: 'result' }>): string[] {
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
  return parts
}

/**
 * Abbreviate a token count.
 * @param tokens - the count.
 * @returns e.g. `35.9K`.
 */
function compact(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : String(tokens)
}

/**
 * Render one non-tool transcript event.
 * @param props - the event.
 * @returns the node, or null for an entry with nothing to show.
 */
function EventItem(props: { event: CcEvent }): ReactElement | null {
  const { event } = props
  switch (event.kind) {
    case 'user':
      return <div className="cc-user">{event.text}</div>
    case 'assistant':
      return (
        <div className="cc-assistant">
          <MarkdownText text={event.text} />
          {event.aborted === true && <div className="cc-note">已中断</div>}
        </div>
      )
    case 'thinking':
      return <ThinkingItem text={event.text} />
    case 'system': {
      if (event.subtype !== 'init') return <div className="cc-note">{event.subtype}</div>
      const model = typeof event.data.model === 'string' ? event.data.model : ''
      return <div className="cc-note">已连接 Claude Code{model !== '' ? ` · ${model}` : ''}</div>
    }
    case 'result': {
      if (event.isError) {
        const reason = event.errors?.join('；') ?? event.terminalReason ?? event.subtype
        return <div className="cc-fail">回合异常结束：{reason}</div>
      }
      const parts = tailParts(event)
      return (
        <div className="cc-tail">
          {parts.map((part, index) => (
            <span key={part}>
              {index > 0 && <span className="cc-tail-sep"> · </span>}
              {part}
            </span>
          ))}
        </div>
      )
    }
    case 'error':
      return <div className="cc-fail">{event.message}</div>
    default:
      return null
  }
}

/**
 * Render one paired tool call.
 * @param props.item - the paired call and result.
 * @param props.cwd - the session working directory.
 * @returns the row element.
 */
function ToolItem(props: { item: Extract<Item, { k: 'tool' }>; cwd: string | undefined }): ReactElement {
  const { call, result } = props.item
  const name = call?.name ?? '工具'
  return (
    <ToolRow
      name={name}
      input={call?.input}
      result={result === undefined ? undefined : { text: result.text, isError: result.isError }}
      summary={call === undefined ? '' : toolSummary(name, call.input)}
      cwd={props.cwd}
    />
  )
}

/**
 * Render a whole transcript.
 * @param props - the ordered events.
 * @returns the transcript nodes.
 */
export function Transcript(props: { events: CcEvent[] }): ReactElement {
  const items = projectTranscript(props.events)
  const cwd = sessionCwd(props.events)
  return (
    <>
      {items.map((item, index) => item.k === 'tool'
        ? <ToolItem key={`tool:${item.id}`} item={item} cwd={cwd} />
        : <EventItem key={`event:${item.event.seq}:${index}`} event={item.event} />)}
    </>
  )
}
