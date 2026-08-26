/**
 * The @-mention file popup: one directory page of the session cwd over GET
 * /fs/list, filtered by the typed segment. Presentational — the composer owns
 * the browsing directory, the fetch, the selection, and the insert. Row
 * semantics: Enter/Tab (or click) picks the row as the mention — folders are
 * mentionable, they inject a tree; the `..` row climbs one level up.
 *
 * @module dsh-cc/client/MentionPicker
 */

import { useEffect, useRef, type ReactElement } from 'react'
import { registerCss } from './css.ts'

// Only the folder marker is picker-specific: the popup chrome and row rules
// are shared and live in the composer's sheet (registerCss replaces whole
// sheets by id, so shared rules have exactly one owner — see Composer.tsx).
registerCss('mention-picker', `
.cc-menu-row-folder::after { content: '/'; color: var(--dsw-alias-label-tertiary); }
`)

/** Normalize separators to forward slashes. */
const posix = (path: string): string => path.split('\\').join('/')

/**
 * The token a picked entry inserts: cwd-relative when it sits under the cwd,
 * else absolute; forward slashes throughout.
 * @param cwd - the session working directory.
 * @param absolute - the picked entry's absolute path.
 * @returns the token text (no `@`).
 */
export function tokenFor(cwd: string, absolute: string): string {
  const base = posix(cwd).replace(/\/+$/, '') + '/'
  const target = posix(absolute)
  return target.toLowerCase().startsWith(base.toLowerCase())
    ? target.slice(base.length)
    : target
}

/**
 * Derive the browsing directory from the typed segment: everything up to its
 * last slash, resolved against the cwd (`..` segments walk); a bare segment
 * browses the cwd itself.
 * @param cwd - the session working directory.
 * @param segment - the typed text after the `@` (may contain slashes).
 * @returns the absolute directory to list.
 */
export function dirForSegment(cwd: string, segment: string): string {
  const cut = segment.lastIndexOf('/')
  const walked = cut === -1 ? '' : segment.slice(0, cut + 1)
  const base = posix(cwd).replace(/\/+$/, '').split('/')
  for (const part of walked.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') base.pop()
    else base.push(part)
  }
  return base.join('/') || '/'
}

/** One picker row: a directory entry, or the climb-up affordance. */
export interface MentionRow {
  name: string
  directory: boolean
  /** The `..` row: activation climbs instead of inserting. */
  climb: boolean
}

/**
 * Render the mention popup; the composer only mounts it while open.
 * @param props.rows - the rows to show (`..` first when climbing is possible).
 * @param props.loading - the directory page is still being fetched.
 * @param props.selected - the selected row index.
 * @param props.onSelectedChange - hover/pointer moves the selection.
 * @param props.onActivate - a row was activated (Enter/Tab/click).
 * @returns the popup node.
 */
export function MentionPicker(props: {
  rows: readonly MentionRow[]
  loading: boolean
  selected: number
  onSelectedChange(index: number): void
  onActivate(index: number): void
}): ReactElement {
  // Same follow-the-selection scroll as the command menu (see the note
  // there): the highlighted row stays inside the popup's scroll box.
  const popRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    popRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [props.selected])
  return (
    <div className="cc-menu-pop" ref={popRef} role="listbox">
      {props.loading && <div className="cc-menu-empty">读取目录中…</div>}
      {!props.loading && props.rows.length === 0 && <div className="cc-menu-empty">没有匹配的文件</div>}
      {props.rows.map((row, index) => (
        <div
          key={`${row.name}-${index}`}
          className="cc-menu-row"
          role="option"
          aria-selected={index === props.selected}
          data-selected={index === props.selected}
          title={row.climb ? '上一级' : row.directory ? '提及整个文件夹（注入目录树）' : '提及此文件'}
          onPointerEnter={() => props.onSelectedChange(index)}
          onMouseDown={event => event.preventDefault()}
          onClick={() => props.onActivate(index)}
        >
          <span className={row.directory ? 'cc-menu-row-name cc-menu-row-folder' : 'cc-menu-row-name'}>{row.name}</span>
        </div>
      ))}
    </div>
  )
}
