/**
 * Working-directory picker: a browse dialog over GET /cc/api/fs/list, with a
 * path field for typing a location directly.
 *
 * @module dsh-cc/client/DirectoryPicker
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import {
  Button,
  IconFolderClose16,
  IconListPenOutline16,
  Input,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { listDir } from './api/settings.ts'
import { registerCss } from './css.ts'
import { useOverlay } from './overlay.ts'
import type { DirListing } from '../types.ts'

registerCss('directory-picker', `
.cc-picker { display: flex; flex-direction: column; gap: 8px; min-height: 320px; }
.cc-picker-bar { display: flex; gap: 8px; align-items: center; }
.cc-picker-bar > span:first-child { flex: 1; }

.cc-picker-list {
  flex: 1;
  max-height: 340px;
  overflow-y: auto;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-base);
}

.cc-picker-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xs-13);
  text-align: left;
  cursor: pointer;
}

.cc-picker-row:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.cc-picker-row[data-file='true'] { color: var(--dsw-alias-label-caption); cursor: default; }
.cc-picker-row[data-file='true']:hover { background: transparent; color: var(--dsw-alias-label-caption); }
.cc-picker-note { padding: 18px; text-align: center; font: var(--dsw-font-xs-13); color: var(--dsw-alias-label-tertiary); }

.cc-picker-glyph {
  flex: none;
  display: inline-flex;
  color: var(--dsw-alias-label-tertiary);
}

.cc-picker-glyph svg { display: block; }
`)

/**
 * Browse for a directory.
 * @param props - the initial path, plus cancel and pick callbacks.
 * @returns the dialog node.
 */
export function DirectoryPicker(props: {
  initial: string
  onCancel(): void
  onPick(path: string): void
}): ReactElement {
  const [path, setPath] = useState(props.initial)
  const [draft, setDraft] = useState(props.initial)
  const [listing, setListing] = useState<DirListing | undefined>()
  const [error, setError] = useState<string | undefined>()
  /**
   * Request generation: quick clicks fire overlapping reads, and only the
   * newest response may land — a straggler would flip the list back to a
   * directory the user already left.
   */
  const loadSeq = useRef(0)
  // The picker is a floating layer: while it is open, Escape closes it (via
  // the modal's own handler), never the surface or the form beneath.
  useOverlay(true)

  const load = (target: string | undefined): void => {
    const seq = (loadSeq.current += 1)
    listDir(target)
      .then(result => {
        if (seq !== loadSeq.current) return
        setListing(result)
        setPath(result.path)
        setDraft(result.path)
        setError(undefined)
      })
      .catch(cause => {
        if (seq !== loadSeq.current) return
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }

  useEffect(() => {
    load(props.initial === '' ? undefined : props.initial)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- load once on open

  const enter = (entry: { name: string; directory: boolean }): void => {
    if (!entry.directory) return
    if (path === '') {
      load(entry.name)
      return
    }
    const separator = path.endsWith('\\') || path.endsWith('/') ? '' : '/'
    load(path + separator + entry.name)
  }

  return (
    <Modal
      open
      onClose={props.onCancel}
      title="选择工作目录"
      closeLabel="关闭"
      footer={(
        <>
          <Button onClick={props.onCancel}>取消</Button>
          <Button variant="primary" disabled={path === ''} onClick={() => props.onPick(path)}>选择此目录</Button>
        </>
      )}
    >
      <div className="cc-picker">
        <div className="cc-picker-bar">
          <Input
            value={draft}
            placeholder="直接输入路径，或从下方选择"
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') load(draft)
            }}
          />
          <Button size="sm" onClick={() => load(draft)}>前往</Button>
          {listing?.parent != null && (
            <Button size="sm" onClick={() => load(listing.parent ?? undefined)}>上一级</Button>
          )}
        </div>
        <div className="cc-picker-list">
          {error !== undefined && <div className="cc-picker-note">{error}</div>}
          {error === undefined && listing === undefined && <div className="cc-picker-note">读取中…</div>}
          {error === undefined && listing !== undefined && listing.entries.length === 0 && (
            <div className="cc-picker-note">空目录</div>
          )}
          {listing?.entries.map(entry => (
            <button
              key={entry.name}
              type="button"
              className="cc-picker-row"
              data-file={!entry.directory}
              onClick={() => enter(entry)}
            >
              <span className="cc-picker-glyph" aria-hidden>
                {entry.directory ? <IconFolderClose16 /> : <IconListPenOutline16 />}
              </span>
              <span>{entry.name}</span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}
