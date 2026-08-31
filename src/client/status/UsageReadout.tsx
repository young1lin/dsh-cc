/**
 * Account usage, in whichever of the two mutually exclusive shapes the
 * account actually has. A claude.ai subscription reports 5-hour/7-day
 * rate-limit windows; an API key or a third-party gateway has none — for
 * those the meaningful figures are the session's cumulative cost, tokens,
 * and cache hit rate, all of which the CLI reports either way. The mode
 * switch is on `subscription_type`/`rate_limits_available`, not on failure,
 * so a gateway account never sees "quota unavailable" for data it simply
 * doesn't have.
 *
 * What the snapshot stores is the CLI's `resets_at` timestamp — never a
 * remaining duration — so the reset countdown is recomputed against the
 * user's own clock on a shared ticking timer, and keeps moving between
 * telemetry frames instead of freezing at whatever the last frame said.
 *
 * @module dsh-cc/client/status/UsageReadout
 */

import { useEffect, useState, type ReactElement } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UsageInfo, UsageWindow } from '../api/telemetry.ts'
import { registerCss } from '../css.ts'
import { compact, untilText } from './format.ts'

registerCss('status-usage', `
.cc-usage { display: flex; align-items: center; gap: 12px; margin-left: auto; }
.cc-usage strong { color: var(--dsw-alias-label-primary); font-weight: 500; }

.cc-usage-tag {
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
}

.cc-usage-meter { display: flex; align-items: center; gap: 6px; }
.cc-usage-meter-label { color: var(--dsw-alias-label-tertiary); }
/* tabular digits so the ticking countdown doesn't wobble as it counts down */
.cc-usage-meter-reset { color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }

.cc-usage-meter-bar {
  width: 46px;
  height: 5px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-3);
}

.cc-usage-meter-fill { display: block; height: 100%; border-radius: inherit; }
.cc-usage-meter-fill[data-tier='ok'] { background: var(--dsw-alias-brand-primary); }
.cc-usage-meter-fill[data-tier='warn'] { background: var(--dsw-alias-state-warn-primary); }
.cc-usage-meter-fill[data-tier='error'] { background: var(--dsw-alias-state-error-primary); }
`)

/** Utilization tier a rate-limit window's fill color takes. */
function utilizationTier(percent: number | null): 'ok' | 'warn' | 'error' {
  if (percent === null) return 'ok'
  if (percent >= 90) return 'error'
  if (percent >= 70) return 'warn'
  return 'ok'
}

/**
 * Whether a window still has a future reset stamp worth counting down to.
 * @param window - the window; null/undefined when the CLI reports none.
 * @returns true when `resets_at` parses to an instant still in the future.
 */
function hasFutureReset(window: UsageWindow | null | undefined): boolean {
  const at = Date.parse(window?.resets_at ?? '')
  return !Number.isNaN(at) && at > Date.now()
}

/**
 * The shared clock the reset countdowns count against. The snapshot carries
 * the CLI's `resets_at` timestamps, so the remaining time must be derived
 * from the user's own clock on every tick — computing it once per render
 * would freeze the text between telemetry frames. The timer runs only while
 * some window still has a future reset stamp (an idle or windowless account
 * holds no timer) and retires itself when the last stamp passes.
 * @param active - whether any visible window currently has a future reset.
 * @returns the current epoch ms.
 */
function useTickingNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/**
 * One rate-limit window as a small progress meter with a reset countdown.
 * @param props.label - window label, e.g. `5h`.
 * @param props.window - the window's utilization and reset time; undefined/null when the CLI has neither.
 * @param props.now - current epoch ms from the shared ticking clock, so the
 *   countdown derives from the stored stamp against the user's time, live.
 * @returns the meter node.
 */
function UsageMeter(props: { label: string; window: UsageWindow | null | undefined; now: number }): ReactElement {
  const { label, window, now } = props
  const percent = window?.utilization == null ? null : Math.round(window.utilization)
  const reset = untilText(window?.resets_at, now)
  const tier = utilizationTier(percent)
  return (
    <Tooltip label={reset !== '' ? `${label} 窗口 ${reset} 后重置` : `${label} 窗口`} side="bottom">
      <span className="cc-usage-meter">
        <span className="cc-usage-meter-label">{label}</span>
        <span className="cc-usage-meter-bar">
          <span className="cc-usage-meter-fill" data-tier={tier} style={{ width: `${percent ?? 0}%` }} />
        </span>
        <strong>{percent === null ? '—' : `${percent}%`}</strong>
        {reset !== '' && <span className="cc-usage-meter-reset">{reset}</span>}
      </span>
    </Tooltip>
  )
}

/**
 * Sum the input, output, and cache-read tokens across every model used in
 * the session.
 * @param session - the usage response's session accounting.
 * @returns cumulative input, output, and cache-read token counts.
 */
function sumTokens(session: NonNullable<UsageInfo['session']>): { input: number; output: number; cacheRead: number } {
  let input = 0
  let output = 0
  let cacheRead = 0
  for (const usage of Object.values(session.model_usage ?? {})) {
    input += usage.inputTokens
    output += usage.outputTokens
    cacheRead += usage.cacheReadInputTokens
  }
  return { input, output, cacheRead }
}

/**
 * Render the account-usage readout.
 * @param props.info - the session's latest usage snapshot; undefined when the
 * live control channel has none (a cold session with no running process).
 * @param props.fallbackCostUsd - the session's cumulative cost from the
 * session list, shown alone when `info` is unavailable — a cold session still
 * has a known historical cost even though the live meters cannot be recomputed
 * without a running process.
 * @returns the readout node, or null when there is nothing to show at all.
 */
export function UsageReadout(props: { info: UsageInfo | undefined; fallbackCostUsd?: number }): ReactElement | null {
  const { info, fallbackCostUsd } = props

  const limits = info?.rate_limits_available === true ? info.rate_limits : null
  const five = limits?.five_hour
  const seven = limits?.seven_day
  // Hooks cannot sit behind the early returns below, so the clock is
  // requested up front; it only ticks while a countdown actually exists.
  const now = useTickingNow(hasFutureReset(five) || hasFutureReset(seven))

  if (info === undefined) {
    if (fallbackCostUsd === undefined) return null
    return (
      <div className="cc-usage">
        <span>累计 <strong>${fallbackCostUsd.toFixed(4)}</strong></span>
      </div>
    )
  }

  if (five != null || seven != null) {
    return (
      <div className="cc-usage">
        {info.subscription_type != null && info.subscription_type !== '' && (
          <span className="cc-usage-tag">{info.subscription_type}</span>
        )}
        <UsageMeter label="5h" window={five} now={now} />
        <UsageMeter label="周" window={seven} now={now} />
      </div>
    )
  }

  // No plan windows: an API key or a relay gateway. Cost and tokens are the
  // figures that exist for this account, and the CLI always reports them.
  const session = info.session
  if (session === undefined) return null
  const { input, output, cacheRead } = sumTokens(session)
  const cacheable = input + cacheRead
  return (
    <div className="cc-usage">
      <span className="cc-usage-tag">按量计费</span>
      <span>累计 <strong>${session.total_cost_usd.toFixed(4)}</strong></span>
      <span>输入 <strong>{compact(input)}</strong> · 输出 <strong>{compact(output)}</strong></span>
      {cacheable > 0 && <span>缓存命中 <strong>{Math.round((cacheRead / cacheable) * 100)}%</strong></span>}
    </div>
  )
}
