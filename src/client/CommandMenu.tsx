/**
 * The slash-command popup: the session's command list filtered by the draft's
 * first word. Presentational — the composer owns the selection index, the
 * keyboard, and the insert.
 *
 * @module dsh-cc/client/CommandMenu
 */

import { useEffect, useRef, type ReactElement } from 'react'
import type { SlashCommand } from '../types.ts'
import { registerCss } from './css.ts'
import { isTerminalCommand, pageEquivalentFor } from './term-commands.ts'

// The popup chrome (.cc-menu-pop and the row rules) lives in the composer's
// own sheet — registerCss replaces whole sheets by id, so the shared rules
// must have exactly one owning module (see Composer.tsx). The command-shape
// chips below are this module's own rules under their own id, for the same
// reason: one owning module per sheet.
registerCss('command-menu', `
.cc-cmd-chip {
  flex: none;
  padding: 0 5px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 4px;
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12);
  line-height: 16px;
  white-space: nowrap;
}
.cc-cmd-chip[data-kind='page'] { color: var(--dsw-alias-brand-primary); }
.cc-cmd-chip[data-kind='term'] { color: var(--dsw-alias-state-error-primary); }
`)

/**
 * Filter a command list by the draft's first word: prefix match on name or
 * alias, case-insensitive; an empty filter lists everything.
 * @param commands - the session's command list.
 * @param filter - the typed text after the slash.
 * @returns the matching commands, original order.
 */
export function filterCommands(commands: readonly SlashCommand[], filter: string): SlashCommand[] {
  const needle = filter.trim().toLowerCase()
  if (needle === '') return [...commands]
  return commands.filter(command =>
    command.name.toLowerCase().startsWith(needle)
    || command.aliases?.some(alias => alias.toLowerCase().startsWith(needle)))
}

/**
 * The trailing shape chip for one command row: a page pointer for commands
 * the web surface already has a control for, a terminal warning for ones that
 * open an interactive CLI-only UI, nothing for the rest.
 * @param command - the row's command.
 * @returns the chip node, or null when the command needs no advice.
 */
function commandChip(command: SlashCommand): ReactElement | null {
  const equivalent = pageEquivalentFor(command.name)
  if (equivalent !== undefined) {
    return (
      <span className="cc-cmd-chip" data-kind="page" title={'页面已有对应功能：' + equivalent + '（带参数发送该命令同样生效）'}>页面</span>
    )
  }
  if (isTerminalCommand(command.name)) {
    return (
      <span className="cc-cmd-chip" data-kind="term" title="该命令在 CLI 里打开交互式终端界面，经流式通道发送可能看不到输出">终端</span>
    )
  }
  return null
}

/**
 * Render the command popup; the composer only mounts it while open.
 * @param props.commands - the full cached list (already filtered by the caller).
 * @param props.filter - the typed text after the slash (unused for filtering;
 *   kept for a future empty-state message).
 * @param props.emptyHint - what the empty popup says: no catalog at all vs
 *   no match against a known one (the caller knows which).
 * @param props.selected - the selected row index into `commands`.
 * @param props.onSelectedChange - hover/pointer moves the selection.
 * @param props.onPick - a row was activated.
 * @returns the popup node.
 */

export function CommandMenu(props: {
  commands: SlashCommand[]
  filter: string
  emptyHint?: string
  selected: number
  onSelectedChange(index: number): void
  onPick(command: SlashCommand): void
}): ReactElement {
  // Keyboard selection must stay on screen: the list scrolls inside its
  // 240px box, and without this the highlight walks out of view and the
  // arrows read as dead. `nearest` only scrolls the popup, never the page.
  const popRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    popRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [props.selected])
  if (props.commands.length === 0) {
    return (
      <div className="cc-menu-pop">
        <div className="cc-menu-empty">{props.emptyHint ?? '没有匹配的命令'}</div>
      </div>
    )
  }
  return (
    <div className="cc-menu-pop" ref={popRef} role="listbox">
      {props.commands.map((command, index) => (
        <div
          key={command.name}
          className="cc-menu-row"
          role="option"
          aria-selected={index === props.selected}
          data-selected={index === props.selected}
          onPointerEnter={() => props.onSelectedChange(index)}
          onMouseDown={event => event.preventDefault()}
          onClick={() => props.onPick(command)}
        >
          <span className="cc-menu-row-name">/{command.name}</span>
          {command.argumentHint !== '' && <span className="cc-menu-row-args">{command.argumentHint}</span>}
          {command.description !== '' && <span className="cc-menu-row-desc" title={command.description}>{command.description}</span>}
          {commandChip(command)}
        </div>
      ))}
    </div>
  )
}
