/**
 * The @-mention file menu roster: the presentational half of the host's
 * ui-file-reference design. The composer owns the token, the index fetch,
 * the ranking, and the selection — this component only renders the ranked
 * rows (folder glyph in a fixed gutter so every path aligns, trailing type
 * label), the loading / no-match states, and the truncation notice. Popups
 * chrome (the .cc-menu-pop panel and row base) lives in the composer's
 * sheet; only the roster-specific rules are registered here.
 *
 * @module dsh-cc/client/MentionPicker
 */

import { useEffect, useRef, type ReactElement, type ReactNode } from 'react'
import { IconFolderClose16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { registerCss } from './css.ts'
import { metaLabel, type MenuRow, type RankedRow } from './mention-core.ts'

registerCss('mention-picker', `
/* The folder glyph rides in a fixed gutter so file paths align down the
   column whether or not their neighbor is a folder. */
.cc-mention-icon { flex: none; align-self: center; width: 18px; height: 16px; display: inline-flex; align-items: center; color: var(--dsw-alias-label-tertiary); }
.cc-mention-path { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }
.cc-mention-row-folder > .cc-mention-path::after { content: '/'; color: var(--dsw-alias-label-tertiary); }
.cc-mention-label { flex: none; margin-left: auto; color: var(--dsw-alias-label-tertiary); }
/* The one-line truncation notice rides above the roster as a group title:
   the rows below are the head of the tree, not the whole of it. */
.cc-mention-truncated { padding: 4px 8px; color: var(--dsw-alias-label-tertiary); }
`)

/** Which settling state the menu's data is in. */
export type MentionState = 'loading' | 'failed' | 'ready'

/**
 * Split a roster path into runs, wrapping the characters the query's fuzzy
 * hit matched in the highlight span — data the ranking already computed, so
 * a ranked row also shows WHY it ranked. The class itself lives in the
 * shell sheet (theme.ts), beside the composer's other recognition cues.
 * @param path - the row's full path.
 * @param matched - ascending indices of the matched characters, or undefined
 *   when the row was not ranked against a query.
 * @returns the path as alternating plain and highlighted runs.
 */
function renderPath(path: string, matched: readonly number[] | undefined): ReactNode {
  if (matched === undefined || matched.length === 0) return path
  const marks = new Set(matched)
  const runs: ReactNode[] = []
  let text = ''
  let hitting = false
  let key = 0
  const flush = (): void => {
    if (text === '') return
    runs.push(hitting
      ? <span className="cc-mention-hit" key={key}>{text}</span>
      : <span key={key}>{text}</span>)
    key += 1
    text = ''
  }
  for (let at = 0; at < path.length; at += 1) {
    const mark = marks.has(at)
    if (mark !== hitting) {
      flush()
      hitting = mark
    }
    text += path[at]
  }
  flush()
  return runs
}

/**
 * Render the mention roster; the composer only mounts it while a token is open.
 * @param props.rows - the ranked rows (already capped at MAX_MENU_ROWS),
 *   each carrying where the query matched it for the highlight.
 * @param props.state - whether the index/listing is still loading, failed, or settled.
 * @param props.truncated - a bound cut the underlying index or listing.
 * @param props.absolutePath - the absolute query's typed-reference row path, labeled as such.
 * @param props.selected - the selected row index.
 * @param props.onSelectedChange - hover/pointer moves the selection.
 * @param props.onPick - a row was picked (Enter/Tab/click).
 * @returns the popup node.
 */
export function MentionPicker(props: {
  rows: readonly RankedRow[]
  state: MentionState
  truncated: boolean
  absolutePath: string | undefined
  selected: number
  onSelectedChange(index: number): void
  onPick(row: MenuRow): void
}): ReactElement {
  // Same follow-the-selection scroll as the command menu (see the note
  // there): the highlighted row stays inside the popup's scroll box.
  const popRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    popRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [props.selected])
  return (
    <div className="cc-menu-pop" ref={popRef} role="listbox">
      {props.truncated && <div className="cc-mention-truncated">结果已截断 —— 只显示了部分文件</div>}
      {props.state === 'loading' && <div className="cc-menu-empty">正在建立项目索引…</div>}
      {props.state === 'failed' && <div className="cc-menu-empty">项目索引不可用；绝对路径仍然可以输入引用</div>}
      {props.state === 'ready' && props.rows.length === 0 && <div className="cc-menu-empty">没有匹配的文件</div>}
      {props.state === 'ready' && props.rows.map((row, index) => (
        <div
          key={row.path}
          className={row.directory === true ? 'cc-menu-row cc-mention-row-folder' : 'cc-menu-row'}
          role="option"
          aria-selected={index === props.selected}
          data-selected={index === props.selected}
          title={row.path}
          onPointerEnter={() => props.onSelectedChange(index)}
          // mousedown, not click: the textarea keeps focus and the pick runs
          // before any blur-driven state change.
          onMouseDown={event => event.preventDefault()}
          onClick={() => props.onPick(row)}
        >
          <span className="cc-mention-icon" aria-hidden>
            {row.directory === true && <IconFolderClose16 />}
          </span>
          <span className="cc-mention-path">{renderPath(row.path, row.matched)}</span>
          <span className="cc-mention-label">
            {props.absolutePath === row.path ? '绝对路径' : row.directory === true ? '文件夹' : metaLabel(row.path)}
          </span>
        </div>
      ))}
    </div>
  )
}
