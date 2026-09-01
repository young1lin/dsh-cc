/**
 * One tool call as a single disclosure row over the host's block primitives.
 *
 * The collapsed row is always one line — leading state slot, tool name, a
 * separator dot, then the ellipsized summary — and expands into the block that
 * fits the call: a terminal, read, diff, search, or web card, the checklist, a
 * subagent report, or the generic IN/OUT card when no block's model fits. This
 * mirrors the host's own `ToolRow`, down to the running sweep and the
 * gutter-labelled IN/OUT card, because a Claude Code call and a harness call
 * must read as the same object.
 *
 * @module dsh-cc/client/tool/ToolRow
 */

import { memo, useState, type ReactElement, type ReactNode } from 'react'
import {
  DiffBlock,
  DisclosureRow,
  IconAgentPresetOutline16,
  IconChecklistOutline14,
  IconCodeOutline16,
  IconEditOutline16,
  IconGlobeOutline14,
  IconListPenOutline16,
  IconSearchOutline16,
  IconWarningOutline16,
  JsonTree,
  MarkdownText,
  ReadBlock,
  SearchBlock,
  StateDot,
  TerminalBlock,
  WebBlock,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { registerCss } from '../css.ts'
import { cardSummary, toolCard, type ToolCard } from './card-model.ts'
import { TodoList } from './TodoList.tsx'
import { asRecord, firstLine, unwrapToolErrorText, type ToolResult } from './wire.ts'
import { TOOL_ROW_CSS } from './tool-row-css.ts'
import type { CcEvent, SubagentEvent } from '../../types.ts'

registerCss('tool-row', TOOL_ROW_CSS)

/**
 * Body lines a card shows in the flow before collapsing its middle — half each
 * primitive's own default. The transcript is a scanning surface: a run of tool
 * calls has to stay readable, and every card cutting at the same place keeps
 * the column rhythm even.
 */
const CHAT_MAX_LINES = 8

/** Leading icon per tool; an unknown tool falls back to the warning glyph. */
const TOOL_ICONS: Record<string, ReactNode> = {
  Bash: <IconCodeOutline16 />,
  ExitPlanMode: <IconListPenOutline16 />,
  BashOutput: <IconCodeOutline16 />,
  KillShell: <IconCodeOutline16 />,
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
 * Run state of the row, which drives the leading slot and the sweep. `lost`
 * is the honest terminal for a call whose result never arrived — the turn is
 * over, so spinning would lie about work still running.
 */
type RowState = 'running' | 'ok' | 'error' | 'lost'

/** Screen-reader text for the states the dot and the sweep carry only in colour. */
const STATE_STATUS: Record<RowState, string | null> = {
  running: '运行中',
  error: '失败',
  lost: '无结果',
  ok: null,
}

export interface ToolRowProps {
  /** Wire tool name; also the row title. */
  name: string
  /** The call arguments as the model wrote them. */
  input: unknown
  /** The settled result, or undefined while the call is running. */
  result: ToolResult | undefined
  /** Argument-derived summary, used unless the card supplies a better one. */
  summary: string
  /** The session workspace, which shortens paths and labels the terminal prompt. */
  cwd: string | undefined
  /** Child envelopes owned by an Agent/Task call; absent for ordinary tools. */
  subagentEvents?: Extract<CcEvent, { kind: 'subagent' }>[]
  /**
   * Whether the session's turn has settled. A call without a result spins
   * only while work can still arrive; once the turn is over, the missing
   * result is a record loss (a compacted or truncated tail), not pending
   * work, and the row settles to a neutral「无结果」 instead of spinning.
   */
  settled?: boolean
}

/**
 * Stringify tool arguments for the generic card's input section.
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


/**
 * The generic IN/OUT card: structured arguments through the JSON inspector,
 * anything else as text, over the result's own text.
 * @param props.input - the call arguments.
 * @param props.result - the settled result, if any.
 * @returns the card element, or null when there is nothing to show.
 */
function GenericCard(props: { input: unknown; result: ToolResult | undefined }): ReactElement | null {
  const { input, result } = props
  const structured = asRecord(input) ?? (Array.isArray(input) ? input : undefined)
  const text = structured === undefined ? safeJson(input) : ''
  const hasInput = structured !== undefined || text !== ''
  if (!hasInput && result === undefined) return null
  return (
    <div className="cc-io">
      {hasInput && (
        <div className="cc-io-section">
          <span className="cc-io-label">IN</span>
          {structured === undefined
            ? <span className="cc-io-text">{text}</span>
            : <JsonTree data={structured} label="工具参数" className="cc-io-json" />}
        </div>
      )}
      {hasInput && result !== undefined && <div className="cc-io-divider" />}
      {result !== undefined && (
        <div className="cc-io-section">
          <span className="cc-io-label">OUT</span>
          <span className="cc-io-text" data-error={result.isError}>{unwrapToolErrorText(result.text)}</span>
        </div>
      )}
    </div>
  )
}

/**
 * The expanded body for a derived card.
 * @param props.card - the card to draw.
 * @param props.input - the call arguments, for the generic fallback.
 * @param props.result - the settled result, for the generic fallback.
 * @returns the body element, or null when the call has nothing to expand into.
 */
function CardBody(props: {
  card: ToolCard
  input: unknown
  result: ToolResult | undefined
  subagentEvents: Extract<CcEvent, { kind: 'subagent' }>[]
  cwd: string | undefined
}): ReactElement | null {
  const { card, input, result, subagentEvents, cwd } = props
  switch (card.kind) {
    case 'terminal':
      return (
        <TerminalBlock
          {...card.terminal.card}
          maxLines={Infinity}
          labels={card.terminal.labels}
          className="cc-card cc-card-terminal"
        />
      )
    case 'read':
      return (
        <>
          <ReadBlock {...card.read.card} maxLines={CHAT_MAX_LINES} className="cc-card cc-card-read" />
          {card.read.notice !== undefined && <div className="cc-note-line">{card.read.notice}</div>}
        </>
      )
    case 'diff':
      return <DiffBlock {...card.diff.card} maxLines={CHAT_MAX_LINES} className="cc-card cc-card-diff" />
    case 'search':
      return (
        <>
          <SearchBlock {...card.search.card} maxLines={CHAT_MAX_LINES} className="cc-card cc-card-search" />
          {card.search.notice !== undefined && <div className="cc-note-line">{card.search.notice}</div>}
        </>
      )
    case 'web':
      return <WebBlock {...card.web} className="cc-card cc-card-web" />
    case 'todo':
      return <TodoList items={card.todo.items} />
    case 'task':
      if (subagentEvents.length > 0) {
        return (
          <div className="cc-task cc-subagent-transcript">
            <SubagentTranscript events={subagentEvents} cwd={cwd} />
          </div>
        )
      }
      return card.task.report === undefined
        ? <div className="cc-task cc-subagent-waiting">子代理正在运行，活动会显示在这里…</div>
        : <div className="cc-task"><MarkdownText text={card.task.report} /></div>
    case 'plan':
      return <div className="cc-plan"><MarkdownText text={card.plan} /></div>
    default:
      return <GenericCard input={input} result={result} />
  }
}

/**
 * The leading 16px slot: the run state outranks the tool's own icon, so a
 * running or failed call is legible without reading the summary.
 * @param props.state - the row's run state.
 * @param props.name - wire tool name, which selects the settled icon.
 * @returns the slot element.
 */
function Leading(props: { state: RowState; name: string }): ReactElement {
  switch (props.state) {
    case 'running':
      return <StateDot state="ongoing" />
    case 'error':
      return <StateDot state="error" />
    default:
      return <>{TOOL_ICONS[props.name] ?? <IconWarningOutline16 />}</>
  }
}


/**
 * Render one tool call.
 *
 * Memo'd: a streaming turn re-renders the whole transcript column per delta,
 * and a settled row has nothing to recompute — the card parse below is the
 * expensive part, so stable props (`input`/`result` keep their event-object
 * identity, `summary`/`cwd` are strings) keep every finished row out of it.
 * @param props - see {@link ToolRowProps}.
 * @returns the row element.
 */
export const ToolRow = memo(function ToolRow(props: ToolRowProps): ReactElement {
  const { name, input, result, cwd } = props
  const [expanded, setExpanded] = useState(false)
  const state: RowState = result === undefined
    ? (props.settled === true ? 'lost' : 'running')
    : result.isError ? 'error' : 'ok'
  const card = toolCard(name, input, result, cwd)
  const body = (name === 'Task' || name === 'Agent')
    ? <CardBody card={card} input={input} result={result} subagentEvents={props.subagentEvents ?? []} cwd={cwd} />
    : <CardBody card={card} input={input} result={result} subagentEvents={[]} cwd={cwd} />
  const expandable = body !== null
  // A failed call's summary IS the failure: the first line of the error text
  // outranks both the arguments and anything the card would have said.
  const failure = state === 'error' && result !== undefined ? firstLine(unwrapToolErrorText(result.text)) : null
  const override = failure === null ? cardSummary(card) : null
  const summary = failure ?? override?.text ?? props.summary
  const suffix = failure === null ? override?.suffix ?? null : null
  const status = STATE_STATUS[state]
  return (
    <div className="cc-tool" data-tool={name} data-state={state}>
      {status !== null && <span className="cc-sr">{status}</span>}
      <DisclosureRow
        rowClassName="cc-tool-row"
        leadingClassName="cc-tool-lead"
        titleClassName="cc-tool-title"
        chevronClassName="cc-tool-chevron"
        icon={<Leading state={state} name={name} />}
        title={name}
        open={expanded && expandable}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => setExpanded(value => !value)}
        collapsedContent={summary !== '' && (
          <>
            <span className="cc-tool-sep" aria-hidden />
            <span className="cc-tool-summary" data-error={failure !== null}>{summary}</span>
            {suffix !== null && <span className="cc-tool-suffix">{suffix}</span>}
            {state === 'lost' && <span className="cc-tool-suffix">无结果</span>}
          </>
        )}
      >
        <div className="cc-tool-body">{body}</div>
      </DisclosureRow>
    </div>
  )
})

type NestedTool = {
  k: 'tool'
  id: string
  key: number
  call?: Extract<SubagentEvent, { kind: 'tool_use' }>
  result?: Extract<SubagentEvent, { kind: 'tool_result' }>
}

type NestedItem = NestedTool | { k: 'event'; key: number; event: Exclude<SubagentEvent, { kind: 'tool_use' | 'tool_result' }> }

/** Pair one subagent's tool calls/results without flattening them into the parent. */
function projectSubagent(events: Extract<CcEvent, { kind: 'subagent' }>[]): NestedItem[] {
  const items: NestedItem[] = []
  const tools = new Map<string, NestedTool>()
  for (const wrapper of events) {
    const event = wrapper.event
    if (event.kind === 'tool_use') {
      const item: NestedTool = { k: 'tool', id: event.toolUseId, key: wrapper.seq, call: event }
      tools.set(event.toolUseId, item)
      items.push(item)
    } else if (event.kind === 'tool_result') {
      const pending = tools.get(event.toolUseId)
      if (pending !== undefined) pending.result = event
      // An orphan result (its tool_use never arrived) carries no readable
      // identity; rendering it as a nameless placeholder row is pure noise.
    } else {
      items.push({ k: 'event', key: wrapper.seq, event })
    }
  }
  return items
}

/** A compact identifier for one nested tool call. */
function nestedSummary(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const value = Object.values(input).find(entry => typeof entry === 'string')
  return typeof value === 'string' ? value : ''
}

/**
 * Render a depth-1 agent's own conversation and tools. Exported so the task
 * detail layer and the durable parent Agent card show the exact same content.
 * @param props.events - child envelopes for one parent tool use.
 * @param props.cwd - owning session workspace.
 * @returns the nested transcript.
 */
export function SubagentTranscript(props: {
  events: Extract<CcEvent, { kind: 'subagent' }>[]
  cwd: string | undefined
}): ReactElement {
  const items = projectSubagent(props.events)
  // 第一条 user 事件是委派时的任务书（后续 user 才是用户从详情页补发的消息），
  // 两者视觉语义不同：任务书是左侧引用块，补充是右对齐气泡。
  let taskBriefShown = false
  return (
    <div className="cc-subagent-flow">
      {items.map(item => {
        if (item.k === 'tool') {
          const name = item.call?.name ?? '工具'
          return (
            <ToolRow
              key={`nested-tool:${item.id}:${item.key}`}
              name={name}
              input={item.call?.input}
              result={item.result}
              summary={nestedSummary(item.call?.input)}
              cwd={props.cwd}
            />
          )
        }
        const event = item.event
        switch (event.kind) {
          case 'assistant':
            return event.text !== ''
              ? <div key={item.key} className="cc-subagent-assistant"><MarkdownText text={event.text} /></div>
              : <div key={item.key} className="cc-subagent-error">{event.error ?? '子代理响应失败'}</div>
          case 'thinking':
            return (
              <details key={item.key} className="cc-subagent-thinking">
                <summary>思考过程</summary>
                <div>{event.text}</div>
              </details>
            )
          case 'user': {
            if (!taskBriefShown) {
              taskBriefShown = true
              return (
                <div key={item.key} className="cc-subagent-task">
                  <div className="cc-subagent-task-label">任务</div>
                  <div className="cc-subagent-task-body"><MarkdownText text={event.text} /></div>
                </div>
              )
            }
            return <div key={item.key} className="cc-subagent-user">{event.text}</div>
          }
        }
      })}
    </div>
  )
}
