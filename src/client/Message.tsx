/**
 * Transcript rendering: one component per event kind, plus a small
 * fenced-code-aware text renderer. Pure presentation over the event data.
 *
 * @module dsh-cc/client/Message
 */

import type { ReactElement } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CcEvent } from '../types.ts'

const FENCE_SPLIT = /```(?:[a-zA-Z0-9_-]*)\n?/

/**
 * Render assistant/user text with fenced code blocks as pre-formatted code.
 * @param text - the raw text.
 * @returns the rendered nodes.
 */
export function renderText(text: string): ReactElement {
  const parts = text.split(FENCE_SPLIT)
  return (
    <>
      {parts.map((part, index) => index % 2 === 1
        ? (
            <pre key={index} className="cc-pre">
              <code>{part.replace(/\n$/, '')}</code>
            </pre>
          )
        : (
            <span key={index} className="cc-text">{part}</span>
          ))}
    </>
  )
}

/** Compact pretty JSON for tool cards. */
function JsonBlock({ value }: { value: unknown }): ReactElement {
  let text: string
  try {
    text = JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    text = String(value)
  }
  return <div className="cc-json">{text}</div>
}

function ToolUse({ event }: { event: Extract<CcEvent, { kind: 'tool_use' }> }): ReactElement {
  return (
    <details className="cc-details">
      <summary>🔧 工具调用：{event.name}</summary>
      <div className="cc-details-body">
        <JsonBlock value={event.input} />
      </div>
    </details>
  )
}

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > 80 ? line.slice(0, 80) : line
}

function ToolResult({ event }: { event: Extract<CcEvent, { kind: 'tool_result' }> }): ReactElement {
  const isAnswer = event.text.startsWith('用户回答：') || event.text.startsWith('用户没有回答')
  if (isAnswer) {
    return <div className="cc-msg-system">✅ {event.text}</div>
  }
  return (
    <details className={event.isError ? 'cc-details cc-tool-error' : 'cc-details'}>
      <summary>
        {event.isError ? '❌ 工具结果（出错）' : '✅ 工具结果'}
        {event.text.trim().length > 0 && ' — ' + firstLine(event.text)}
      </summary>
      <div className="cc-details-body">
        <div className="cc-text cc-json">{event.text}</div>
      </div>
    </details>
  )
}

/**
 * Render one transcript event.
 * @param event - the event.
 * @returns the rendered node.
 */
export function CcMessage({ event }: { event: CcEvent }): ReactElement {
  switch (event.kind) {
    case 'user':
      return <div className="cc-msg cc-msg-user">{event.text}</div>
    case 'assistant':
      return (
        <div className="cc-msg cc-msg-assistant">
          <MarkdownText text={event.text} />
        </div>
      )
    case 'thinking':
      return (
        <details className="cc-msg-thinking">
          <summary>💭 思考过程</summary>
          <div className="cc-text">{event.text}</div>
        </details>
      )
    case 'tool_use':
      return <ToolUse event={event} />
    case 'tool_result':
      return <ToolResult event={event} />
    case 'system': {
      if (event.subtype !== 'init') return <div className="cc-msg-system">{event.subtype}</div>
      const model = typeof event.data.model === 'string' ? event.data.model : ''
      const cwd = typeof event.data.cwd === 'string' ? event.data.cwd : ''
      const suffix = (model !== '' ? ' · ' + model : '') + (cwd !== '' ? ' · ' + cwd : '')
      return <div className="cc-msg-system">已连接 Claude Code{suffix}</div>
    }
    case 'result': {
      if (event.isError) {
        return <div className="cc-msg-result cc-msg-result-error">回合结束（{event.subtype}）</div>
      }
      const seconds = Math.round(event.durationMs / 100) / 10
      const cost = event.totalCostUsd > 0 ? ' · $' + event.totalCostUsd.toFixed(4) : ''
      return <div className="cc-msg-result">回合完成 · {seconds}s · {event.numTurns} 步{cost}</div>
    }
    case 'error':
      return <div className="cc-msg-error">{event.message}</div>
    default:
      return <div />
  }
}
