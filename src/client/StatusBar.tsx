/**
 * The session status strip: model and effort selection, context-window
 * occupancy, and account usage. Each concern is its own module under
 * `./status/`; this file only lays them out in a row.
 *
 * @module dsh-cc/client/StatusBar
 */

import type { ReactElement } from 'react'
import type { ContextUsage, UsageInfo } from './api/telemetry.ts'
import { registerCss } from './css.ts'
import { ContextMeter } from './status/ContextMeter.tsx'
import { ModelMenu } from './status/ModelMenu.tsx'
import { UsageReadout } from './status/UsageReadout.tsx'

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
`)

/**
 * Render the status strip.
 * @param props.sessionId - the session id, for the model/effort catalog.
 * @param props.context - the session's latest context-window snapshot; absent for a cold session.
 * @param props.usage - the session's latest usage snapshot; absent for a cold session.
 * @param props.fallbackCostUsd - the session's cumulative cost from the session
 * list, shown when `usage` is unavailable (a cold session's live control
 * channel has no running process to ask, but its historical cost is still known).
 * @returns the strip node.
 */
export function StatusBar(props: {
  sessionId: string
  context: ContextUsage | undefined
  usage: UsageInfo | undefined
  fallbackCostUsd?: number
}): ReactElement {
  return (
    <div className="cc-status">
      <ModelMenu sessionId={props.sessionId} />
      {props.context !== undefined && <ContextMeter context={props.context} />}
      <UsageReadout info={props.usage} fallbackCostUsd={props.fallbackCostUsd} />
    </div>
  )
}
