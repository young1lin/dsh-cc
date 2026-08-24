/**
 * Account readout: who the CLI is currently authenticated as, when it can
 * tell us. Renders whatever fields `AccountSummary` carries and says plainly
 * when the host reports none, rather than guessing at absent fields.
 *
 * @module dsh-cc/client/settings/AccountPanel
 */

import { Fragment, type ReactElement } from 'react'
import { registerCss } from '../css.ts'
import type { AccountSummary } from '../../types.ts'

registerCss('account-panel', `
.cc-account-grid {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  font: var(--dsw-font-xs-13);
}

.cc-account-grid dt { color: var(--dsw-alias-label-tertiary); }
.cc-account-grid dd { margin: 0; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
`)

/** One account field's label paired with its accessor, in display order. */
const ACCOUNT_FIELDS: { label: string; read(account: AccountSummary): string | undefined }[] = [
  { label: '邮箱', read: account => account.email },
  { label: '组织', read: account => account.organization },
  { label: '订阅类型', read: account => account.subscriptionType },
  { label: '凭证来源', read: account => account.tokenSource },
  { label: '上游服务', read: account => account.apiProvider },
]

/**
 * Render the "当前登录身份" readout.
 * @param props.account - the effective config summary's account field; undefined when the CLI
 * reports no identity (API-key/gateway auth commonly carries none).
 * @returns the readout node.
 */
export function AccountPanel(props: { account: AccountSummary | undefined }): ReactElement {
  const account = props.account
  const rows = account === undefined
    ? []
    : ACCOUNT_FIELDS
      .map(field => ({ label: field.label, value: field.read(account) }))
      .filter((row): row is { label: string; value: string } => row.value !== undefined && row.value !== '')

  return (
    <div className="cc-settings">
      <div className="cc-section-title">当前登录身份</div>
      {rows.length === 0
        ? <div className="cc-hint">CLI 未报告登录身份（常见于纯 API Key/网关鉴权，或尚未产生过一次成功请求）。</div>
        : (
            <dl className="cc-account-grid">
              {rows.map(row => (
                <Fragment key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </Fragment>
              ))}
            </dl>
          )}
    </div>
  )
}
