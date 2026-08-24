/**
 * The in-flight tail of the transcript: text as the model writes it, plus a
 * caret so a slow turn reads as working rather than stalled.
 *
 * This renders {@link LiveTurn} only, never committed events. The surface
 * clears the live turn as soon as its committed events arrive, so nothing here
 * is ever shown beside its persisted counterpart.
 *
 * @module dsh-cc/client/LiveTurnView
 */

import type { ReactElement } from 'react'
import { registerCss } from './css.ts'
import type { LiveTurn } from './stream.ts'

registerCss('live-turn', `
.cc-live { display: flex; flex-direction: column; gap: 8px; }

.cc-live-text {
  font: var(--dsw-font-base-16);
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

/* Thinking streams in the muted voice its committed disclosure uses, so the
   turn does not visibly restyle when the real event replaces it. */
.cc-live-think {
  font: var(--dsw-font-xs-13);
  color: var(--dsw-alias-label-tertiary);
  white-space: pre-wrap;
  word-break: break-word;
}

.cc-live-tool {
  font: var(--dsw-font-xs-13);
  color: var(--dsw-alias-label-tertiary);
}

.cc-caret {
  display: inline-block;
  width: 7px;
  height: 1em;
  margin-left: 1px;
  vertical-align: text-bottom;
  background: var(--dsw-alias-label-tertiary);
  animation: cc-blink 1s steps(2, start) infinite;
}

@keyframes cc-blink { to { visibility: hidden; } }

.cc-live-wait {
  display: flex;
  align-items: center;
  gap: 6px;
  font: var(--dsw-font-xs-13);
  color: var(--dsw-alias-label-tertiary);
}

.cc-live-dots::after {
  content: '';
  animation: cc-dots 1.4s steps(4, end) infinite;
}

@keyframes cc-dots {
  0% { content: ''; }
  25% { content: '·'; }
  50% { content: '··'; }
  75% { content: '···'; }
}

@media (prefers-reduced-motion: reduce) {
  .cc-caret { animation: none; }
  .cc-live-dots::after { content: '···'; animation: none; }
}
`)

/**
 * Render the live tail of a running turn.
 * @param props.turn - the in-flight turn, or undefined when none is running.
 * @returns the live nodes, or null when there is nothing to show yet.
 */
export function LiveTurnView(props: { turn: LiveTurn | undefined }): ReactElement | null {
  const turn = props.turn
  if (turn === undefined) return null

  // A closed block has been committed to the transcript, which renders it in
  // full; showing the streamed copy too would duplicate it. Only blocks still
  // being written belong here.
  const visible = turn.blocks.filter(
    block => !block.closed && (block.type !== 'tool_use' || block.toolName !== undefined),
  )
  if (visible.length === 0) {
    // Between blocks, and before the first one, the turn is working with
    // nothing to show yet. Once it has stopped there is nothing left to wait
    // for, and the committed events stand alone.
    if (turn.stopped) return null
    return (
      <div className="cc-live-wait">
        <span>思考中</span>
        <span className="cc-live-dots" />
      </div>
    )
  }

  return (
    <div className="cc-live">
      {visible.map(block => {
        // Every visible block is open by construction; the caret stops only
        // when the turn itself has stopped.
        const writing = !turn.stopped
        if (block.type === 'tool_use') {
          return (
            <div className="cc-live-tool" key={block.index}>
              {block.toolName}
              {writing && <span className="cc-live-dots" />}
            </div>
          )
        }
        return (
          <div
            className={block.type === 'thinking' ? 'cc-live-think' : 'cc-live-text'}
            key={block.index}
          >
            {block.text}
            {writing && <span className="cc-caret" />}
          </div>
        )
      })}
    </div>
  )
}
