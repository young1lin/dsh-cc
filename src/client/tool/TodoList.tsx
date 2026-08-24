/**
 * Checklist card for the `TodoWrite` tool: the list the model just wrote, with
 * its own derivation from the call arguments.
 *
 * `input.todos` is model-authored JSON — a rejected or mid-stream call keeps
 * whatever it wrote verbatim — so every item is narrowed here and an
 * unusable payload sends the row to the generic card.
 *
 * Several items may be `in_progress` at once, so the one-line summary names the
 * first and counts the rest instead of hiding them.
 *
 * @module dsh-cc/client/tool/TodoList
 */

import { useId, type ReactElement } from 'react'
import { IconCheckOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { asRecord } from './wire.ts'

/** Lifecycle of one checklist item, in Claude Code's own wording. */
type TodoStatus = 'pending' | 'in_progress' | 'completed'

/** One narrowed checklist item. */
export interface TodoItem {
  /** The task, in the active voice while it is running and the plain form otherwise. */
  label: string
  status: TodoStatus
}

/** The checklist material one `TodoWrite` call yields. */
export interface TodoCard {
  items: TodoItem[]
  /** The collapsed row's summary: the counts, plus the first running task when there is one. */
  summary: string
  /**
   * Running tasks beyond the first, rendered outside the ellipsized summary so
   * a narrow row clips the task name before this count. Null when there are none.
   */
  suffix: string | null
}

/**
 * Narrow one entry of `input.todos`.
 * @param value - the untrusted entry.
 * @returns the item, or null when it carries no usable content or status.
 */
function narrowItem(value: unknown): TodoItem | null {
  const entry = asRecord(value)
  if (entry === undefined) return null
  const { content, activeForm, status } = entry
  if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return null
  // The active form is the running task's own wording ("Fixing the parser");
  // it exists only for that state, so every other item reads its content.
  const preferred = status === 'in_progress' && typeof activeForm === 'string' ? activeForm : content
  const label = typeof preferred === 'string' && preferred.trim() !== '' ? preferred : content
  return typeof label === 'string' && label.trim() !== '' ? { label, status } : null
}

/**
 * Derive the checklist material for a `TodoWrite` call, or null when the
 * arguments are not a usable list and the call belongs on the generic card.
 * @param input - the `tool_use.input` for the call.
 * @returns the checklist material, or null for the generic path.
 */
export function todoCard(input: unknown): TodoCard | null {
  const todos = asRecord(input)?.todos
  if (!Array.isArray(todos) || todos.length === 0) return null
  const items: TodoItem[] = []
  for (const entry of todos) {
    const item = narrowItem(entry)
    if (item === null) return null
    items.push(item)
  }
  const done = items.filter(item => item.status === 'completed').length
  const active = items.filter(item => item.status === 'in_progress')
  const first = active[0]
  const head = `${done}/${items.length} 已完成`
  return {
    items,
    summary: first === undefined ? head : `${head} · ${first.label}`,
    suffix: active.length > 1 ? `+${active.length - 1}` : null,
  }
}

/** Pending: an unstarted dashed ring. */
function PendingGlyph(): ReactElement {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2.4 2.4" />
    </svg>
  )
}

/** In-progress: a ring fading out along its sweep; the CSS spins the svg. */
function ProgressGlyph(): ReactElement {
  const gradientId = useId()
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="2.5" y1="12" x2="10.5" y2="3.5" gradientUnits="userSpaceOnUse">
          <stop stopColor="currentColor" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <circle cx="7" cy="7" r="6.4" stroke={`url(#${gradientId})`} strokeWidth="1.2" />
    </svg>
  )
}

/**
 * The glyph for one item's state.
 * @param props.status - the item's state.
 * @returns the glyph element.
 */
function StatusGlyph(props: { status: TodoStatus }): ReactElement {
  switch (props.status) {
    case 'completed':
      return <IconCheckOutline14 />
    case 'in_progress':
      return <ProgressGlyph />
    default:
      return <PendingGlyph />
  }
}

/**
 * Render the written checklist. Completed items strike through, the running
 * ones keep the accent, and pending ones stay quiet.
 * @param props.items - the list, in the order the model wrote it.
 * @returns the checklist element.
 */
export function TodoList(props: { items: readonly TodoItem[] }): ReactElement {
  return (
    <ul className="cc-todo">
      {props.items.map((item, index) => (
        <li key={`${index}:${item.label}`} className="cc-todo-item" data-status={item.status}>
          <span className="cc-todo-glyph" aria-hidden><StatusGlyph status={item.status} /></span>
          <span className="cc-todo-label">{item.label}</span>
        </li>
      ))}
    </ul>
  )
}
