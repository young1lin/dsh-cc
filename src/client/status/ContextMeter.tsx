/**
 * The context-window occupancy meter: a bar segmented by the CLI's own
 * categories (everything but `Free space`, which is the bar's implicit
 * remainder), a hover breakdown of exact token counts, and — when the CLI
 * reports one — a marker for where auto-compaction kicks in. The slot
 * carries a 1px inner ring so the bar reads as a bar even at 4% occupancy,
 * where the colored segments shrink to a few pixels.
 *
 * @module dsh-cc/client/status/ContextMeter
 */

import type { ReactElement } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ContextCategory, ContextUsage } from '../api/telemetry.ts'
import { registerCss } from '../css.ts'
import { compact } from './format.ts'

registerCss('status-context', `
.cc-ctx { display: flex; align-items: center; gap: 8px; }

.cc-ctx-bar {
  position: relative;
  display: flex;
  width: 132px;
  height: 6px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-3);
  /* 低占比（4%）时彩色段只有几像素：一圈 1px 内描边把槽的轮廓
     钉在状态栏底色上，整根条任何时候都读得出「这是一根进度条」。 */
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l2);
}

.cc-ctx-seg { height: 100%; }
.cc-ctx-seg + .cc-ctx-seg { border-left: 1px solid var(--dsw-alias-bg-layer-3); }
.cc-ctx-seg[data-role='neutral'] { background: var(--dsw-alias-label-caption); }
.cc-ctx-seg[data-role='neutral-dim'] { background: var(--dsw-alias-label-tertiary); }
.cc-ctx-seg[data-role='accent'] { background: var(--dsw-alias-brand-primary); }
.cc-ctx-seg[data-role='warn'] { background: var(--dsw-alias-state-warn-primary); }
.cc-ctx-seg[data-role='error'] { background: var(--dsw-alias-state-error-primary); }
.cc-ctx-seg[data-role='success'] { background: var(--dsw-alias-state-success-primary); }

/* Auto-compact threshold marker: a thin line across the bar's full height,
   overflowing 2px top/bottom so it stays visible over any segment color. */
.cc-ctx-tick {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 2px;
  background: var(--dsw-alias-label-primary);
  pointer-events: none;
}
`)

/**
 * Which bar color a CLI context category takes, from the CLI's own color tag
 * rather than the category name — the tag set is CLI-owned and can grow, so
 * an unrecognized tag falls through to the neutral role instead of failing.
 * @param category - the category as the CLI reported it.
 * @returns the bar segment's color role.
 */
function categoryRole(category: ContextCategory): 'neutral' | 'neutral-dim' | 'accent' | 'warn' | 'error' | 'success' {
  const tag = category.color
  if (tag.includes('purple')) return 'accent'
  if (tag === 'warning') return 'warn'
  if (tag === 'error') return 'error'
  if (tag === 'success') return 'success'
  if (tag === 'permission') return 'neutral-dim'
  return 'neutral'
}

/**
 * Build the hover-breakdown text: one line per category, then the total and
 * (when the CLI reports it) the auto-compact state.
 * @param context - the context snapshot.
 * @param used - `context.categories` with `Free space` already excluded.
 * @param thresholdPercent - `autoCompactThreshold` as a percent of `maxTokens`, or undefined when the CLI reported none.
 * @returns the tooltip label, one fact per line.
 */
function buildDetail(context: ContextUsage, used: ContextCategory[], thresholdPercent: number | undefined): string {
  const lines = used.map(category => `${category.name} ${compact(category.tokens)}`)
  lines.push(`已用 ${compact(context.totalTokens)} / ${compact(context.maxTokens)}`)
  if (context.isAutoCompactEnabled === true) {
    lines.push(thresholdPercent !== undefined ? `自动压缩阈值 ${thresholdPercent}%` : '自动压缩：已启用')
  }
  return lines.join('\n')
}

/**
 * Render the context-window meter.
 * @param props.context - the session's latest context-window snapshot.
 * @returns the meter node.
 */
export function ContextMeter(props: { context: ContextUsage }): ReactElement {
  const { context } = props
  const max = context.maxTokens > 0 ? context.maxTokens : 1
  const used = context.categories?.filter(category => category.name !== 'Free space') ?? []
  const percent = context.percentage ?? Math.round((context.totalTokens / max) * 100)
  // The CLI reports the threshold as a token count in the same unit as
  // maxTokens, not a percent — convert it once here for both the tick's
  // position and the tooltip text.
  const thresholdPercent = context.autoCompactThreshold !== undefined
    ? Math.round((context.autoCompactThreshold / max) * 100)
    : undefined
  const detail = used.length > 0 ? buildDetail(context, used, thresholdPercent) : `已用 ${compact(context.totalTokens)}`
  // 持久化读数（冷会话）如实注明：这是上次记录，不是实时值。
  const label = context.persisted === true ? detail + '\n（上次记录的读数）' : detail

  return (
    <Tooltip label={label} side="bottom">
      <span className="cc-ctx">
        <span className="cc-ctx-bar">
          {used.map(category => (
            <span
              key={category.name}
              className="cc-ctx-seg"
              data-role={categoryRole(category)}
              style={{ width: `${(category.tokens / max) * 100}%` }}
            />
          ))}
          {context.isAutoCompactEnabled === true && thresholdPercent !== undefined && (
            <span className="cc-ctx-tick" style={{ left: `${thresholdPercent}%` }} />
          )}
        </span>
        <span>{compact(context.totalTokens)}/{compact(context.maxTokens)}（{percent}%）</span>
      </span>
    </Tooltip>
  )
}