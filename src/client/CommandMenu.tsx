/**
 * The slash-command popup: the session's command list filtered by the draft's
 * first word. Presentational — the composer owns the selection index, the
 * keyboard, and the insert.
 *
 * @module dsh-cc/client/CommandMenu
 */

import type { ReactElement } from 'react'
import type { SlashCommand } from '../types.ts'
import { registerCss } from './css.ts'

// Shares .cc-menu-pop with the mention picker: one registration, two users
// (MentionPicker re-registers the same id harmlessly).
registerCss('composer-menus', `
.cc-menu-pop {
  position: absolute; bottom: 100%; left: 12px; right: 12px; z-index: 10;
  max-height: 240px; overflow-y: auto;
  margin-bottom: 4px; padding: 4px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-shadow-lv2);
  font: var(--dsw-font-xs-13);
}
.cc-menu-row { display: flex; align-items: baseline; gap: 8px; padding: 4px 8px; border-radius: 6px; cursor: pointer; }
.cc-menu-row[data-selected='true'] { background: var(--dsw-alias-bg-layer-3); }
.cc-menu-row-name { flex: none; color: var(--dsw-alias-label-primary); }
.cc-menu-row-args { flex: none; color: var(--dsw-alias-label-tertiary); }
.cc-menu-row-desc { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); }
.cc-menu-empty { padding: 8px; color: var(--dsw-alias-label-tertiary); }
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
 * Render the command popup; the composer only mounts it while open.
 * @param props.commands - the full cached list (already filtered by the caller).
 * @param props.filter - the typed text after the slash (unused for filtering;
 *   kept for a future empty-state message).
 * @param props.selected - the selected row index into `commands`.
 * @param props.onSelectedChange - hover/pointer moves the selection.
 * @param props.onPick - a row was activated.
 * @returns the popup node.
 */
export function CommandMenu(props: {
  commands: SlashCommand[]
  filter: string
  selected: number
  onSelectedChange(index: number): void
  onPick(command: SlashCommand): void
}): ReactElement {
  if (props.commands.length === 0) {
    return (
      <div className="cc-menu-pop">
        <div className="cc-menu-empty">没有匹配的命令</div>
      </div>
    )
  }
  return (
    <div className="cc-menu-pop" role="listbox">
      {props.commands.map((command, index) => (
        <div
          key={command.name}
          className="cc-menu-row"
          role="option"
          aria-selected={index === props.selected}
          data-selected={index === props.selected}
          onPointerEnter={() => props.onSelectedChange(index)}
          onClick={() => props.onPick(command)}
        >
          <span className="cc-menu-row-name">/{command.name}</span>
          {command.argumentHint !== '' && <span className="cc-menu-row-args">{command.argumentHint}</span>}
          {command.description !== '' && <span className="cc-menu-row-desc" title={command.description}>{command.description}</span>}
        </div>
      ))}
    </div>
  )
}
