/**
 * dsh-cc browser half: registers one sidebar footer action as its mount
 * point, but renders the launcher as a fixed vertical dock on the right
 * screen edge. Everything portals into document.body (light DOM) with the
 * plugin stylesheet injected once, so the host markdown styles apply inside
 * the transcript. Product copy is Chinese; comments are English.
 *
 * @module dsh-cc/client
 */

import { useEffect, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { CcApp } from './App.tsx'
import { CSS, injectOnce } from './styles.ts'

/** The slice of the client context this plugin touches. */
interface ApplyContext {
  slots: {
    inject(slotName: string, factory: () => () => void): void
    register(options: { name: string; id: string; order?: number }, component: unknown): () => void
  }
}

/** Required client services. */
export const inject: string[] = ['slots']

/** The terminal glyph used by the dock launcher. */
function TerminalIcon(): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" style={{ flexShrink: 0 }}>
      <rect x="1.2" y="2.2" width="13.6" height="11.6" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 6l3 2.4L4 10.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="8.6" y1="10.8" x2="12" y2="10.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/**
 * The slot occupant: renders nothing in the sidebar; instead it portals the
 * right-edge dock and overlay into document.body. The dock hides while the
 * overlay is open.
 *
 * @returns the portal node.
 */
function DockHost(): ReactElement {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    injectOnce('dsh-cc-styles', CSS)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return createPortal(
    <>
      {!open && (
        <button
          type="button"
          className="cc-dock"
          title="打开 Claude Code"
          onClick={() => setOpen(true)}
        >
          <TerminalIcon />
          <span className="cc-dock-label">Claude Code</span>
        </button>
      )}
      {open && <CcApp onClose={() => setOpen(false)} />}
    </>,
    document.body,
  )
}

/**
 * Client plugin body: register the footer action as the mount point; the
 * component renders only the always-on right-edge dock host.
 * @param ctx - client root context.
 */
export function apply(ctx: ApplyContext): void {
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'claude-code', order: 20 },
    DockHost,
  ))
}
