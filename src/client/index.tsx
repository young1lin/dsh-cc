/**
 * dsh-cc browser half: one entry in the host frame's `shell.overlay` layer.
 *
 * That layer is absolutely positioned over every column, click-through by
 * default, with each entry opting back into pointer events — so the launcher
 * dock and the full-bleed Claude Code surface both live there and neither
 * needs a portal or a z-index of its own. Rendering inside the host frame is
 * also what makes the host theme tokens apply without a bridge.
 *
 * Product copy is Chinese; comments are English.
 *
 * @module dsh-cc/client
 */

import { useLayoutEffect, useState, type ReactElement } from 'react'
import { CcApp } from './App.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { mountCss } from './css.ts'
import './theme.ts'

/** The slice of the client context this plugin touches. */
interface ApplyContext {
  slots: {
    inject(slotName: string, factory: () => () => void): void
    register(options: { name: string; id: string; order?: number }, component: unknown): () => void
  }
}

/** Required client services. */
export const inject: string[] = ['slots']

/** The terminal glyph the dock is marked with. */
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
 * The slot occupant: the right-edge dock, replaced by the full surface while
 * open. Escape is owned by the surface itself, so a dialog inside it consumes
 * the key first instead of the whole surface closing under an open dialog.
 *
 * @returns the dock or the open surface.
 */
function ClaudeCodeLayer(): ReactElement {
  const [open, setOpen] = useState(false)

  // Layout effect: the dock must carry its styles in the FIRST paint — an
  // effect would flash an unstyled sliver before the browser paints.
  useLayoutEffect(() => {
    mountCss()
  }, [])

  if (open) {
    return (
      <ErrorBoundary onDismiss={() => setOpen(false)}>
        <CcApp onClose={() => setOpen(false)} />
      </ErrorBoundary>
    )
  }
  return (
    <button type="button" className="cc-dock" title="打开 Claude Code" onClick={() => setOpen(true)}>
      <TerminalIcon />
      <span className="cc-dock-label">Claude Code</span>
    </button>
  )
}

/**
 * Client plugin body: contribute one entry to the frame-wide overlay layer.
 * @param ctx - client root context.
 * @returns nothing; the injected slot entry is disposed by the host.
 */
export function apply(ctx: ApplyContext): void {
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'claude-code' },
    ClaudeCodeLayer,
  ))
}
