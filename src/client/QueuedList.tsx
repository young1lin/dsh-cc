/**
 * The expandable strip under the status bar listing the messages held
 * host-side for the session's next model-call boundary. Collapsed it is the
 * familiar one-line count notice; expanded, each row shows its enqueue time,
 * the message's first line, and a recall control that pulls the message back
 * into the composer before the CLI ever sees it. The sessions frame's queued
 * count is the change signal: every queue, delivery, recall, and engine-death
 * carry-over moves it, and each move re-reads the authoritative list.
 *
 * @module dsh-cc/client/QueuedList
 */

import { useEffect, useState, type ReactElement } from 'react'
import { IconChevronRightOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { fetchQueue, recallQueued } from './api/sessions.ts'
import type { QueuedMessageView } from '../types.ts'

/** First-line preview cap; rows also ellipsize in CSS as a backstop. */
const PREVIEW_LIMIT = 80

/**
 * The first line of one queued message, capped for the row preview.
 * @param text - the message body verbatim.
 * @returns the first line, truncated with an ellipsis past the cap.
 */
function firstLinePreview(text: string): string {
  const line = text.split(/\r?\n/, 1)[0]
  return line.length > PREVIEW_LIMIT ? `${line.slice(0, PREVIEW_LIMIT)}…` : line
}

/**
 * Local HH:MM for one queued message's enqueue stamp.
 * @param iso - the enqueue timestamp.
 * @returns the zero-padded local time of day, or '' when unparseable.
 */
function clock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => `${value}`.padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Render the queued-messages strip.
 * @param props - the session id, the sessions frame's queued count, and the
 *   callback that hands one recalled message's text to the composer.
 * @returns the strip node, or null with nothing queued.
 */
export function QueuedList(props: {
  sessionId: string
  count: number
  onRecall(text: string): void
}): ReactElement | null {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<QueuedMessageView[]>([])

  useEffect(() => {
    if (props.count <= 0) {
      setItems([])
      setOpen(false)
      return
    }
    let stale = false
    fetchQueue(props.sessionId)
      .then(result => {
        if (!stale) setItems(result.items)
      })
      .catch(() => {
        // Best effort; the next count change retries.
      })
    return () => {
      stale = true
    }
  }, [props.sessionId, props.count])

  if (props.count <= 0) return null

  /**
   * Recall one row: the DELETE returns the item, its text goes back to the
   * composer, and the row leaves the list. A rejection means the boundary
   * raced the click and delivered the message — the count frame corrects
   * the list, and there is nothing to restore.
   * @param item - the row being recalled.
   */
  const recall = (item: QueuedMessageView): void => {
    recallQueued(props.sessionId, item.uuid)
      .then(() => {
        setItems(previous => previous.filter(row => row.uuid !== item.uuid))
        props.onRecall(item.text)
      })
      .catch(() => {
        // Already delivered or gone; nothing to restore.
      })
  }

  return (
    <div className="cc-queued-strip">
      <button
        type="button"
        className="cc-queued-head"
        aria-expanded={open}
        onClick={() => setOpen(previous => !previous)}
      >
        <span className="cc-queued-chevron"><IconChevronRightOutline14 /></span>
        已排队 {props.count} 条消息，将在本轮结束后发出
      </button>
      {open && (
        <div className="cc-queued-rows">
          {items.length === 0 && <div className="cc-queued-empty">正在读取排队消息…</div>}
          {items.map(item => (
            <div className="cc-queued-row" key={item.uuid}>
              <span className="cc-queued-time">{clock(item.queuedAt)}</span>
              <span className="cc-queued-text" title={item.text}>
                {firstLinePreview(item.text)}
                {item.imageCount > 0 ? `（${item.imageCount} 张图片）` : ''}
              </span>
              <button type="button" className="cc-queued-recall" onClick={() => recall(item)}>撤回</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
