/**
 * Transcript projection and rendering.
 *
 * A turn's `tool_use` and its later `tool_result` are ONE thing to a reader,
 * so they are paired here by `toolUseId` and drawn as a single disclosure row —
 * the same shape the host uses for its own tool calls. Everything else is a
 * pure function of the event list, so a re-render never depends on arrival
 * order.
 *
 * @module dsh-cc/client/Transcript
 */

import { useState, type ReactElement, type ReactNode } from 'react'
import {
  DisclosureRow,
  IconAgentPresetOutline16,
  IconChecklistOutline14,
  IconCodeOutline16,
  IconEditOutline16,
  IconGlobeOutline14,
  IconListPenOutline16,
  IconSearchOutline16,
  IconThinkOutline14,
  IconWarningOutline16,
  MarkdownText,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { registerCss } from './css.ts'
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

.cc-tool { align-self: stretch; }

.cc-tool-row { position: relative; overflow: hidden; }

.cc-tool-title { font: var(--dsw-font-s-14); font-weight: 400; color: var(--dsw-alias-label-primary); }

.cc-tool-sep {
  flex: none;
  width: 2px;
  height: 2px;
  margin: 0 8px;
  border-radius: 1px;
  background: var(--dsw-alias-label-caption);
}

.cc-tool-summary {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: var(--dsw-font-s-14);
  color: var(--dsw-alias-label-tertiary);
}

.cc-tool-summary[data-error='true'] { color: var(--dsw-alias-state-error-primary); }

/* Expanded IN/OUT card: the host's gutter-labelled two-section layout on the
   code-block surface. */
.cc-io {
  display: flex;
  flex-direction: column;
  margin: 4px 0 4px 4px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-markdown-code-block);
  font: var(--dsw-font-markdown-code-block-small);
  font-family: var(--ds-font-family-code);
}

.cc-io-section {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: 14px;
  align-items: baseline;
  max-height: 220px;
  padding: 10px 14px;
  overflow: auto;
}

.cc-io-label { position: sticky; top: 0; align-self: start; color: var(--dsw-alias-label-caption); }
.cc-io-divider { flex: none; height: 1px; background: var(--dsw-alias-border-l2); }

.cc-io-text {
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--dsw-alias-label-secondary);
}

.cc-io-text[data-error='true'] { color: var(--dsw-alias-state-error-primary); }

.cc-think { align-self: stretch; }
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

/** Tool names whose row carries a specific icon and title. */
const TOOL_ICONS: Record<string, ReactNode> = {
  Bash: <IconCodeOutline16 />,
  BashOutput: <IconCodeOutline16 />,
  Read: <IconListPenOutline16 />,
  NotebookEdit: <IconEditOutline16 />,
  Edit: <IconEditOutline16 />,
  Write: <IconEditOutline16 />,
  Grep: <IconSearchOutline16 />,
  Glob: <IconSearchOutline16 />,
  WebFetch: <IconGlobeOutline14 />,
  WebSearch: <IconGlobeOutline14 />,
  TodoWrite: <IconChecklistOutline14 />,
  Task: <IconAgentPresetOutline16 />,
  Agent: <IconAgentPresetOutline16 />,
}

/**
 * The one-line summary shown beside a tool's name while collapsed: the single
 * argument that identifies the call, not its whole JSON.
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
    case 'NotebookEdit':
      return pick('file_path')
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
 * Collapse a payload to its first line for a one-line summary.
 * @param text - the raw text.
 * @returns the first line, capped.
 */
function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? ''
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}

/**
 * Render one tool call as a single disclosure row.
 * @param props - the paired call and result.
 * @returns the row node.
 */
function ToolItem(props: { item: Extract<Item, { k: 'tool' }> }): ReactElement {
  const [open, setOpen] = useState(false)
  const { call, result } = props.item
  const name = call?.name ?? '工具'
  const failed = result?.isError === true
  const running = result === undefined
  const inputText = call === undefined ? '' : safeJson(call.input)
  const summary = failed && result !== undefined
    ? firstLine(result.text)
    : call === undefined ? '' : toolSummary(name, call.input)

  return (
    <div className="cc-tool">
      <DisclosureRow
        rowClassName="cc-tool-row"
        titleClassName="cc-tool-title"
        icon={failed ? <StateDot state="error" /> : running ? <StateDot state="ongoing" /> : TOOL_ICONS[name] ?? <IconWarningOutline16 />}
        title={name}
        open={open}
        expandable
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => setOpen(value => !value)}
        collapsedContent={summary !== '' && (
          <>
            <span className="cc-tool-sep" aria-hidden />
            <span className="cc-tool-summary" data-error={failed}>{summary}</span>
          </>
        )}
      >
        <div className="cc-io">
          {inputText !== '' && (
            <div className="cc-io-section">
              <span className="cc-io-label">IN</span>
              <span className="cc-io-text">{inputText}</span>
            </div>
          )}
          {inputText !== '' && result !== undefined && <div className="cc-io-divider" />}
          {result !== undefined && (
            <div className="cc-io-section">
              <span className="cc-io-label">OUT</span>
              <span className="cc-io-text" data-error={failed}>{result.text}</span>
            </div>
          )}
        </div>
      </DisclosureRow>
    </div>
  )
}

/**
 * Stringify tool arguments for the expanded input section.
 * @param value - the arguments.
 * @returns pretty JSON, or the value's string form when it cannot be encoded.
 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    // Tool arguments come from the model as JSON, so a cycle is not reachable
    // through the wire; a host-side caller passing one still gets a readable row.
    return String(value)
  }
}

/** Thinking, shown as its own collapsed disclosure ahead of what it produced. */
function ThinkingItem(props: { text: string }): ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <div className="cc-think">
      <DisclosureRow
        titleClassName="cc-tool-title"
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
 * Render a whole transcript.
 * @param props - the ordered events.
 * @returns the transcript nodes.
 */
export function Transcript(props: { events: CcEvent[] }): ReactElement {
  const items = projectTranscript(props.events)
  return (
    <>
      {items.map((item, index) => item.k === 'tool'
        ? <ToolItem key={`tool:${item.id}`} item={item} />
        : <EventItem key={`event:${item.event.seq}:${index}`} event={item.event} />)}
    </>
  )
}
