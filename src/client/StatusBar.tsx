/**
 * The session status strip: model and effort selection, context-window
 * occupancy, and account usage.
 *
 * Usage has two mutually exclusive modes, chosen by what the account actually
 * has. A claude.ai subscription reports rate-limit windows; an API key or a
 * third-party gateway has none — for those the meaningful figures are the
 * session's cumulative cost, tokens, and cache hit rate, all of which the CLI
 * reports either way. Showing "unavailable" to a gateway user hides data we
 * already hold, so the mode switch is on `subscription_type`, not on failure.
 *
 * @module dsh-cc/client/StatusBar
 */

import { useEffect, useState, type ReactElement } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  fetchModels, setEffort, setModel,
  type ContextUsage, type ModelRow, type UsageInfo,
} from './api/telemetry.ts'
import { registerCss } from './css.ts'

registerCss('status-bar', `
.cc-status {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  padding: 5px 20px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-tertiary);
}

.cc-status select {
  max-width: 220px;
  padding: 2px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 7px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xxs-12);
  outline: none;
}

/* Context occupancy: one segmented bar in the CLI's own category order, so the
   whole window is legible at a glance rather than a single percentage. */
.cc-ctx { display: flex; align-items: center; gap: 8px; }

.cc-ctx-bar {
  display: flex;
  width: 132px;
  height: 6px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-3);
}

.cc-ctx-seg { height: 100%; }
.cc-ctx-seg[data-role='system'] { background: var(--dsw-alias-label-caption); }
.cc-ctx-seg[data-role='messages'] { background: var(--dsw-alias-brand-primary); }
.cc-ctx-seg[data-role='other'] { background: var(--dsw-alias-state-warn-primary); }

.cc-usage { display: flex; align-items: center; gap: 12px; margin-left: auto; }
.cc-usage strong { color: var(--dsw-alias-label-primary); font-weight: 500; }

.cc-usage-tag {
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
}
`)

/** Effort levels the CLI accepts, strongest first. */
const EFFORT_LEVELS = ['max', 'xhigh', 'high', 'medium', 'low']

/**
 * Which bar colour a CLI context category takes. The CLI's own colour tags are
 * display hints for a terminal palette, so they are folded into three roles
 * rather than mapped one-to-one.
 *
 * @param name - the category name the CLI reported.
 * @returns the bar role.
 */
function categoryRole(name: string): 'system' | 'messages' | 'other' {
  if (name === 'Messages') return 'messages'
  if (name === 'Free space') return 'other'
  return 'system'
}

/**
 * Format a token count compactly.
 * @param tokens - the count.
 * @returns e.g. `37.0K`.
 */
function compact(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : String(tokens)
}

/**
 * How long until a rate-limit window resets.
 * @param resetsAt - ISO timestamp, or null.
 * @param now - current epoch ms.
 * @returns e.g. `2h31m`, or empty when there is nothing to say.
 */
function untilText(resetsAt: string | null | undefined, now: number): string {
  if (resetsAt === null || resetsAt === undefined || resetsAt === '') return ''
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at) || at <= now) return ''
  const minutes = Math.round((at - now) / 60000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return minutes % 60 > 0 ? `${hours}h${minutes % 60}m` : `${hours}h`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** The context-window meter. */
function ContextMeter(props: { context: ContextUsage }): ReactElement {
  const { context } = props
  const max = context.maxTokens > 0 ? context.maxTokens : 1
  const used = context.categories?.filter(category => category.name !== 'Free space') ?? []
  const percent = context.percentage ?? Math.round((context.totalTokens / max) * 100)
  const detail = used.length > 0
    ? used.map(category => `${category.name} ${compact(category.tokens)}`).join('\n')
    : `已用 ${compact(context.totalTokens)}`
  return (
    <Tooltip label={detail}>
      <span className="cc-ctx">
        <span className="cc-ctx-bar">
          {used.map(category => (
            <span
              key={category.name}
              className="cc-ctx-seg"
              data-role={categoryRole(category.name)}
              style={{ width: `${(category.tokens / max) * 100}%` }}
            />
          ))}
        </span>
        <span>{compact(context.totalTokens)}/{compact(context.maxTokens)}（{percent}%）</span>
      </span>
    </Tooltip>
  )
}

/** Subscription windows, or cumulative spend when the account has no plan. */
function UsageReadout(props: { info: UsageInfo | undefined }): ReactElement | null {
  const { info } = props
  if (info === undefined) return null

  const limits = info.rate_limits_available === true ? info.rate_limits : null
  const five = limits?.five_hour?.utilization
  const seven = limits?.seven_day?.utilization
  if (five != null || seven != null) {
    const now = Date.now()
    const fiveReset = untilText(limits?.five_hour?.resets_at, now)
    const sevenReset = untilText(limits?.seven_day?.resets_at, now)
    return (
      <div className="cc-usage">
        {info.subscription_type != null && info.subscription_type !== '' && (
          <span className="cc-usage-tag">{info.subscription_type}</span>
        )}
        <span title={fiveReset !== '' ? `5 小时窗口 ${fiveReset} 后重置` : undefined}>
          5h <strong>{five == null ? '—' : `${Math.round(five)}%`}</strong>
        </span>
        <span title={sevenReset !== '' ? `周窗口 ${sevenReset} 后重置` : undefined}>
          周 <strong>{seven == null ? '—' : `${Math.round(seven)}%`}</strong>
        </span>
      </div>
    )
  }

  // No plan windows: an API key or a relay gateway. Cost and tokens are the
  // figures that exist for this account, and the CLI always reports them.
  const session = info.session
  if (session === undefined) return null
  let input = 0
  let output = 0
  let cacheRead = 0
  for (const usage of Object.values(session.model_usage ?? {})) {
    input += usage.inputTokens
    output += usage.outputTokens
    cacheRead += usage.cacheReadInputTokens
  }
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

/**
 * Render the status strip.
 * @param props - the session id plus its latest context and usage snapshots.
 * @returns the strip node.
 */
export function StatusBar(props: {
  sessionId: string
  context: ContextUsage | undefined
  usage: UsageInfo | undefined
}): ReactElement {
  const [catalog, setCatalog] = useState<{ rows: ModelRow[]; current: string; effort: string }>({
    rows: [], current: '', effort: '',
  })

  useEffect(() => {
    let stale = false
    fetchModels(props.sessionId)
      .then(result => {
        if (stale) return
        setCatalog({ rows: result.models, current: result.current, effort: result.effort ?? '' })
      })
      .catch(() => {
        // A cold session has no catalog yet; the static aliases still switch.
      })
    return () => {
      stale = true
    }
  }, [props.sessionId])

  return (
    <div className="cc-status">
      <select
        value={catalog.rows.some(row => row.value === catalog.current) ? catalog.current : ''}
        title="切换模型（对下一回合生效）"
        onChange={event => {
          const value = event.target.value
          setCatalog(previous => ({ ...previous, current: value }))
          void setModel(props.sessionId, value).catch(() => {})
        }}
      >
        <option value="">默认模型</option>
        {catalog.rows.map(row => (
          <option key={row.value} value={row.value}>
            {row.displayName}
            {row.resolvedModel !== undefined && row.resolvedModel !== row.displayName ? ` → ${row.resolvedModel}` : ''}
          </option>
        ))}
      </select>
      <select
        value={catalog.effort}
        title="思考程度"
        onChange={event => {
          const value = event.target.value
          setCatalog(previous => ({ ...previous, effort: value }))
          void setEffort(props.sessionId, value).catch(() => {})
        }}
      >
        <option value="">默认思考档位</option>
        {EFFORT_LEVELS.map(level => <option key={level} value={level}>{level}</option>)}
      </select>
      {props.context !== undefined && <ContextMeter context={props.context} />}
      <UsageReadout info={props.usage} />
    </div>
  )
}
