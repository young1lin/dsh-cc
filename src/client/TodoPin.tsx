/**
 * The pinned current-TODO panel above the composer: the session's live
 * checklist, derived from the transcript's checklist tool calls, so the plan
 * stays visible while typing instead of scrolling away in history. Both tool
 * generations fold: the classic `TodoWrite` snapshots and the newer
 * `TaskCreate`/`TaskUpdate` pairs this CLI now emits in its place. The
 * transcript keeps its own cards; this is the current-state readout, so
 * nothing here is persisted beyond the transcript itself.
 *
 * @module dsh-cc/client/TodoPin
 */

import { useMemo, useState, memo, type ReactElement } from 'react'
import { DisclosureRow, IconChecklistOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { registerCss } from './css.ts'
import { TodoList, todoCard, type TodoItem } from './tool/TodoList.tsx'
import type { CcEvent } from '../types.ts'

registerCss('todo-pin', `
.cc-todopin { padding: 4px 20px 0; border-top: 1px solid var(--dsw-alias-border-l2); font: var(--dsw-font-xxs-12); }
.cc-todopin-title { color: var(--dsw-alias-label-secondary); }
`)

/**
 * Derive the session's current checklist from its transcript: one forward
 * fold over every checklist tool call. `TodoWrite` replaces the whole list
 * (an emptied or unparsable one clears it); `TaskCreate` appends a pending
 * item whose CLI-assigned id arrives in the paired result text (`Task #3
 * created…`), and `TaskUpdate` patches one item's status through that id. An
 * empty final list leaves the pin hidden.
 * @param events - the transcript, in order.
 * @returns the items, or undefined when no usable list exists.
 */
export function currentTodos(events: readonly CcEvent[]): TodoItem[] | undefined {
  let items: TodoItem[] | undefined
  /** TaskCreate calls awaiting the id their result text will name. */
  const pendingIds = new Map<string, TodoItem>()
  /** CLI task id → the item it addresses. */
  const byTaskId = new Map<string, TodoItem>()
  const args = (input: unknown): Record<string, unknown> =>
    typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
  for (const event of events) {
    if (event.kind === 'tool_use') {
      if (event.name === 'TodoWrite') {
        // A new snapshot supersedes everything the older tools built.
        items = todoCard(event.input)?.items ?? []
        pendingIds.clear()
        byTaskId.clear()
        continue
      }
      if (event.name === 'TaskCreate') {
        const input = args(event.input)
        const label = typeof input.subject === 'string' && input.subject !== ''
          ? input.subject
          : typeof input.description === 'string' ? input.description : ''
        if (label === '') continue
        const item: TodoItem = { label, status: 'pending' }
        items = [...items ?? [], item]
        pendingIds.set(event.toolUseId, item)
        continue
      }
      if (event.name === 'TaskUpdate') {
        const input = args(event.input)
        const item = byTaskId.get(String(input.taskId ?? '').replace(/^#/, ''))
        if (item === undefined) continue
        if (input.status === 'pending' || input.status === 'in_progress' || input.status === 'completed') {
          item.status = input.status
        }
        continue
      }
      continue
    }
    if (event.kind === 'tool_result' && pendingIds.has(event.toolUseId)) {
      const item = pendingIds.get(event.toolUseId)
      pendingIds.delete(event.toolUseId)
      const id = /#(\S+)/.exec(event.text)?.[1]
      if (item !== undefined && id !== undefined) byTaskId.set(id, item)
    }
  }
  return items !== undefined && items.length > 0 ? items : undefined
}

/**
 * Render the pinned checklist; nothing when the session has no live list.
 * @param props.events - the session's transcript.
 * @returns the pin, or null.
 */
export const TodoPin = memo(function TodoPin(props: { events: CcEvent[] }): ReactElement | null {
  const items = useMemo(() => currentTodos(props.events), [props.events])
  const [open, setOpen] = useState(true)
  if (items === undefined) return null
  const done = items.filter(item => item.status === 'completed').length
  return (
    <div className="cc-todopin">
      <DisclosureRow
        icon={<IconChecklistOutline14 />}
        titleClassName="cc-todopin-title"
        title={`任务清单 ${done}/${items.length}`}
        open={open}
        expandable
        expandOnRowClick
        onToggle={() => setOpen(value => !value)}
      >
        <TodoList items={items} />
      </DisclosureRow>
    </div>
  )
})
