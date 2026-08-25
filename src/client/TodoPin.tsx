/**
 * The pinned current-TODO panel above the composer: the session's live
 * checklist, derived from the last committed TodoWrite in the transcript, so
 * the plan stays visible while typing instead of scrolling away in history.
 * The transcript keeps its own TodoWrite cards; this is the current-state
 * readout, so nothing here is persisted beyond the transcript itself.
 *
 * @module dsh-cc/client/TodoPin
 */

import { useMemo, useState, type ReactElement } from 'react'
import { DisclosureRow, IconChecklistOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { registerCss } from './css.ts'
import { TodoList, todoCard, type TodoItem } from './tool/TodoList.tsx'
import type { CcEvent } from '../types.ts'

registerCss('todo-pin', `
.cc-todopin { padding: 4px 20px 0; border-top: 1px solid var(--dsw-alias-border-l2); font: var(--dsw-font-xxs-12); }
.cc-todopin-title { color: var(--dsw-alias-label-secondary); }
`)

/**
 * Derive the session's current checklist from its transcript tail: the last
 * committed TodoWrite wins, and an unparsable or emptied list clears the pin.
 * @param events - the transcript, in order.
 * @returns the items, or undefined when no usable list exists.
 */
export function currentTodos(events: readonly CcEvent[]): TodoItem[] | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event.kind !== 'tool_use' || event.name !== 'TodoWrite') continue
    return todoCard(event.input)?.items
  }
  return undefined
}

/**
 * Render the pinned checklist; nothing when the session has no live list.
 * @param props.events - the session's transcript.
 * @returns the pin, or null.
 */
export function TodoPin(props: { events: CcEvent[] }): ReactElement | null {
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
}
