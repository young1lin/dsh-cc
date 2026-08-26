/**
 * The in-flight tail of the transcript: text as the model writes it — fed
 * through the host markdown pipeline so the settled swap restyles nothing —
 * plus a caret and a running turn clock so a slow turn reads as working
 * rather than stalled.
 *
 * This renders {@link LiveTurnState} only, never committed events. The surface
 * clears the live turn as soon as its committed events arrive, so nothing here
 * is ever shown beside its persisted counterpart.
 *
 * @module dsh-cc/client/LiveTurnView
 */

import { useEffect, useState, type ReactElement } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { registerCss } from './css.ts'
import type { LiveTurnState } from '../live-turn.ts'

registerCss('live-turn', `
.cc-live { display: flex; flex-direction: column; gap: 8px; }

/* Streamed text renders through the host markdown pipeline, so it takes the
   same typography a committed assistant message gets (see Transcript's
   .cc-assistant): same font, same block margins, and the same table border
   override — which applies here for the same reason it applies there, the
   host's own table chrome does not fit this column, and a streamed table
   must not restyle when the committed event replaces it. pre-wrap is
   dropped on purpose: the markdown pipeline owns newlines now. */
.cc-live-text {
  font: var(--dsw-font-markdown-base);
  color: var(--dsw-alias-label-primary);
}
.cc-live-text :where(p) { margin: 0.4em 0; }
.cc-live-text :where(h1, h2, h3, h4) { margin: 0.7em 0 0.3em; }
.cc-live-text :where(ul, ol) { margin: 0.4em 0; padding-left: 1.4em; }
.cc-live-text :where(table) { margin: 0.5em 0; border-collapse: collapse; }
.cc-live-text :where(th, td) { padding: 4px 10px; border: 1px solid var(--dsw-alias-border-l2); }

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

/* The turn clock beside the wait copy; tabular digits keep the readout from
   jittering as it ticks, and one shade quieter than the wait text reads as
   telemetry rather than prose. */
.cc-live-elapsed {
  flex: none;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-caption);
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
 * Format a running elapsed time: `m:ss` under an hour, `h:mm:ss` past it.
 * @param ms - elapsed milliseconds; negative readings clamp to zero.
 * @returns the clock text.
 */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total / 60) % 60
  const seconds = total % 60
  const two = (digits: number): string => String(digits).padStart(2, '0')
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`
}

/**
 * Render the live tail of a running turn.
 * @param props.turn - the in-flight turn, or undefined when none is running.
 * @returns the live nodes, or null when there is nothing to show yet.
 */
export function LiveTurnView(props: { turn: LiveTurnState | undefined }): ReactElement | null {
  const turn = props.turn
  // One shared clock drives the elapsed readout. It ticks only while the
  // turn is actually writing — an idle surface holds no timer — and the
  // last tick freezes the reading once the turn stops, holding it steady
  // until the committed events drop the whole view. A turn without a
  // `startedAt` stamp (folded by an older half) simply shows no clock.
  const writing = turn !== undefined && !turn.stopped
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!writing) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [writing])
  if (turn === undefined) return null
  const elapsed = turn.startedAt === undefined ? undefined : formatElapsed(now - turn.startedAt)

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
        {elapsed !== undefined && <span className="cc-live-elapsed">{elapsed}</span>}
      </div>
    )
  }

  return (
    <div className="cc-live">
      {visible.map(block => {
        // Every visible block is open by construction; the caret stops only
        // when the turn itself has stopped (`writing`, hoisted above the
        // early returns next to the clock it shares a tick with).
        if (block.type === 'tool_use') {
          return (
            <div className="cc-live-tool" key={block.index}>
              {block.toolName}
              {writing && <span className="cc-live-dots" />}
            </div>
          )
        }
        // Text streams through the host markdown pipeline — `streaming`
        // keeps fences and TeX plain until the turn stops, and the settle
        // swap (committed event) is what adds highlighting. The caret sits
        // AFTER the markdown container, as a sibling: it is not part of the
        // markdown source, so an unclosed code fence can never swallow it,
        // and it simply rides the line below the last rendered block.
        // Thinking stays plain pre-wrap text, matching its committed
        // disclosure, so its caret stays inline at the text's end.
        return (
          <div
            className={block.type === 'thinking' ? 'cc-live-think' : 'cc-live-text'}
            key={block.index}
          >
            {block.type === 'thinking'
              ? block.text
              : <MarkdownText text={block.text} streaming={writing} />}
            {writing && <span className="cc-caret" />}
          </div>
        )
      })}
    </div>
  )
}
