/**
 * Last-resort error boundary for the Claude Code surface.
 *
 * The surface hangs directly off the host's React root, so one malformed frame
 * anywhere in the tree would otherwise blank the host page. React 18 has no
 * error-boundary hook, so this is the one class component in the client: it
 * swaps the crashed subtree for a quiet Chinese fallback with a retry that
 * remounts the tree from scratch.
 *
 * @module dsh-cc/client/ErrorBoundary
 */

import { Component, Fragment, type ReactElement, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { registerCss } from './css.ts'

registerCss('error-boundary', `
/* The fallback occupies the overlay slot the crashed surface held, so the host
   page keeps its shape while the surface is down. */
.cc-crash {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 32px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
}

.cc-crash-title { font: var(--dsw-font-s-strong-14); }

.cc-crash-detail {
  box-sizing: border-box;
  max-width: min(560px, 100%);
  max-height: 30vh;
  overflow: auto;
  padding: 8px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  font: var(--dsw-font-markdown-code-block-small);
  font-family: var(--ds-font-family-code);
  color: var(--dsw-alias-label-tertiary);
  white-space: pre-wrap;
  word-break: break-word;
}
`)

/** One open overlay slot; the boundary's own props. */
interface ErrorBoundaryProps {
  children: ReactNode
  /** Way back to the dock for the fallback, since the surface's own close control crashed with it. */
  onDismiss(): void
}

/** The caught error, plus a counter that forces a fresh remount on retry. */
interface ErrorBoundaryState {
  error: Error | undefined
  attempt: number
}

/**
 * Catch a render error below this point and show the fallback instead.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: undefined, attempt: 0 }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error }
  }

  /**
   * Retry: drop the error and bump the counter, so the subtree comes back as a
   * fresh mount rather than resuming whatever internal state it died in.
   */
  private readonly retry = (): void => {
    this.setState(previous => ({ error: undefined, attempt: previous.attempt + 1 }))
  }

  render(): ReactElement {
    const { error, attempt } = this.state
    if (error !== undefined) {
      return (
        <div className="cc-crash">
          <div className="cc-crash-title">Claude Code 面板渲染出错</div>
          <div className="cc-crash-detail">{error.message}</div>
          <div className="cc-row">
            <Button size="sm" variant="primary" onClick={this.retry}>重试</Button>
            <Button size="sm" onClick={this.props.onDismiss}>关闭面板</Button>
          </div>
        </div>
      )
    }
    return <Fragment key={attempt}>{this.props.children}</Fragment>
  }
}
