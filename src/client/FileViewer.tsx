/**
 * The click-through file viewer: a modal that fetches the file's latest
 * content from disk and renders it as a line-numbered, syntax-highlighted
 * ReadBlock — the same surface the Read card draws.
 *
 * @module dsh-cc/client/FileViewer
 */

import { useEffect, useState, type ReactElement } from 'react'
import { Modal, ReadBlock, type ReadBlockLine } from '@deepseek-ai/dsh-client-ui-primitives'
import { fetchFile } from './api/fs.ts'
import { useOverlay } from './overlay.ts'
import { registerCss } from './css.ts'
import { contentLines, langFromPath } from './tool/wire.ts'

registerCss('file-viewer', `
.cc-fileviewer { display: flex; flex-direction: column; min-height: 120px; max-height: 70vh; }
.cc-fileviewer-note { padding: 16px 0; font: var(--dsw-font-xs-13); color: var(--dsw-alias-label-secondary); text-align: center; }
`)

/** The viewer's fetch states. */
type ViewState =
  | { phase: 'loading' }
  | { phase: 'ready'; lines: ReadBlockLine[]; totalLines: number; truncated: boolean; lang: string | undefined }
  | { phase: 'failed'; message: string }

/**
 * Render the file viewer modal.
 * @param props.path - the absolute path to display.
 * @param props.onClose - the close callback.
 * @returns the modal node.
 */
export function FileViewer(props: { path: string; onClose(): void }): ReactElement {
  const [state, setState] = useState<ViewState>({ phase: 'loading' })
  // Register with the surface's overlay signal so Escape closes the modal,
  // not the whole Claude Code surface under it.
  useOverlay(true)
  useEffect(() => {
    let stale = false
    setState({ phase: 'loading' })
    fetchFile(props.path)
      .then(result => {
        if (stale) return
        const rows = contentLines(result.file.content)
        setState({
          phase: 'ready',
          lines: rows.map((text, index) => ({ number: index + 1, text })),
          totalLines: rows.length,
          truncated: result.file.truncated,
          lang: langFromPath(result.file.path),
        })
      })
      .catch(cause => {
        if (!stale) setState({ phase: 'failed', message: cause instanceof Error ? cause.message : String(cause) })
      })
    return () => {
      stale = true
    }
  }, [props.path])
  return (
    <Modal
      open
      onClose={props.onClose}
      title={props.path}
      closeLabel="关闭文件"
      contentClassName="cc-fileviewer"
      description={state.phase === 'ready' && state.truncated ? '文件超过 2MB，仅显示开头部分' : undefined}
    >
      {state.phase === 'loading' && <div className="cc-fileviewer-note">读取中…</div>}
      {state.phase === 'failed' && <div className="cc-fileviewer-note">{state.message}</div>}
      {state.phase === 'ready' && (
        <ReadBlock lines={state.lines} totalLines={state.totalLines} lang={state.lang} maxLines={400} />
      )}
    </Modal>
  )
}
