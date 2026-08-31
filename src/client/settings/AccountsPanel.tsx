/**
 * Account roots: the list of Claude Code homes (`CLAUDE_CONFIG_DIR`) and which
 * one the plugin is currently running against.
 *
 * The list edits like any other settings field and is saved with the dialog.
 * Switching, however, is applied immediately and on its own: it repoints the
 * whole plugin — sessions, credentials, memory, skills, the model catalog —
 * and the host refuses it mid-turn, so it cannot be a value that only takes
 * effect when the dialog is saved.
 *
 * @module dsh-cc/client/settings/AccountsPanel
 */

import { useState, type ReactElement } from 'react'
import { Button, IconFolderClose16, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { DirectoryPicker } from '../DirectoryPicker.tsx'
import { switchAccount } from '../api/settings.ts'
import { registerCss } from '../css.ts'
import type { CcAccount } from '../../types.ts'

registerCss('accounts-panel', `
.cc-accounts {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  overflow: hidden;
}

.cc-account-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  font: var(--dsw-font-xs-13);
}

.cc-account-row + .cc-account-row { border-top: 1px solid var(--dsw-alias-border-l2); }
.cc-account-row[data-active='true'] { background: var(--dsw-alias-bg-layer-1); }

.cc-account-name { width: 34%; flex: none; }
.cc-account-dir { flex: 1; min-width: 0; }
/* Input renders the class onto its wrapper span, so the native control inside
   has to be told to fill the width the row layout just assigned. */
.cc-account-row .cc-account-name input,
.cc-account-row .cc-account-dir input { width: 100%; min-width: 0; }

.cc-account-mark {
  flex: none;
  width: 4px;
  align-self: stretch;
  margin: -8px 0 -8px -10px;
  background: var(--dsw-alias-brand-primary);
}

.cc-account-mark[data-active='false'] { background: transparent; }

/* Every row ends with the same three slots — browse, switch, delete — so the
   default row, which has no directory to browse and cannot be deleted, holds
   their width open instead of letting its own controls drift left. */
.cc-account-browse, .cc-account-slot { flex: none; width: 34px; }
.cc-account-switch { flex: none; width: 62px; }

.cc-account-drop, .cc-account-drop-slot {
  flex: none;
  width: 26px;
}

.cc-account-drop {
  padding: 2px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-caption);
  cursor: pointer;
}

.cc-account-drop:hover { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }
.cc-account-drop:disabled { cursor: not-allowed; opacity: 0.4; }

.cc-account-actions { display: flex; gap: 6px; align-items: center; margin-top: 8px; }
.cc-account-actions .cc-hint { flex: 1; padding: 0; border: none; background: transparent; }
`)

/**
 * Mint an id for a newly added row.
 *
 * The host assigns one for a row that arrives without it, but the row needs an
 * identity before then: it is the React key while the user is still typing its
 * name, and index keys would reassign identity as rows above are removed.
 * @returns a fresh id.
 */
function nextAccountId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `account-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/**
 * Render the account list.
 * @param props.accounts - the edited list; saved with the rest of the dialog.
 * @param props.activeAccountId - the id currently in force, from the config summary.
 * @param props.defaultConfigDir - the root that applies with no account selected.
 * @param props.onChange - called with the edited list.
 * @param props.onPersist - saves the whole dialog, including the edited list.
 *   Awaited before every switch, so a row the user just added is known to the
 *   host by the time it is switched to.
 * @param props.onSwitched - called after a switch lands, so the owner can
 *   re-read the config and the session list it derives from.
 * @returns the panel node.
 */
export function AccountsPanel(props: {
  accounts: CcAccount[]
  activeAccountId: string
  defaultConfigDir: string
  onChange(accounts: CcAccount[]): void
  onPersist(): Promise<void>
  onSwitched(): void
}): ReactElement {
  const [picking, setPicking] = useState<string | undefined>()
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const patch = (id: string, fields: Partial<CcAccount>): void => {
    props.onChange(props.accounts.map(account => (account.id === id ? { ...account, ...fields } : account)))
  }

  const activate = (id: string): void => {
    setSwitching(true)
    setError(undefined)
    // The list is persisted first: a row added moments ago exists only in this
    // component's state, and the host answers 404 for an account it has never
    // been told about.
    props.onPersist()
      .then(() => switchAccount(id))
      .then(() => props.onSwitched())
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setSwitching(false))
  }

  // A row whose directory is still blank cannot be switched to, and the host
  // would drop it on save; saying so beats a silent no-op on click.
  const usable = (account: CcAccount): boolean => account.dir.trim() !== ''

  return (
    <div className="cc-settings">
      <div className="cc-section-title">账号（Claude Code 配置目录）</div>
      <div className="cc-accounts">
        <div className="cc-account-row" data-active={props.activeAccountId === ''}>
          <span className="cc-account-mark" data-active={props.activeAccountId === ''} />
          <span className="cc-account-name">默认</span>
          <span className="cc-account-dir cc-mono">{props.defaultConfigDir}</span>
          <span className="cc-account-slot" />
          <Button
            className="cc-account-switch"
            size="sm"
            disabled={switching || props.activeAccountId === ''}
            onClick={() => activate('')}
          >
            {props.activeAccountId === '' ? '使用中' : '切换'}
          </Button>
          <span className="cc-account-drop-slot" />
        </div>
        {props.accounts.map(account => (
          <div key={account.id} className="cc-account-row" data-active={account.id === props.activeAccountId}>
            <span className="cc-account-mark" data-active={account.id === props.activeAccountId} />
            <Input
              className="cc-account-name"
              value={account.name}
              placeholder="账号名"
              onChange={event => patch(account.id, { name: event.target.value })}
            />
            <Input
              className="cc-account-dir"
              value={account.dir}
              placeholder="配置目录，如 D:/dev/.claude-work"
              onChange={event => patch(account.id, { dir: event.target.value })}
            />
            <Button
              className="cc-account-browse"
              size="sm"
              icon={<IconFolderClose16 />}
              title="浏览目录"
              onClick={() => setPicking(account.id)}
            />
            <Button
              className="cc-account-switch"
              size="sm"
              disabled={switching || !usable(account) || account.id === props.activeAccountId}
              onClick={() => activate(account.id)}
            >
              {account.id === props.activeAccountId ? '使用中' : '切换'}
            </Button>
            <button
              type="button"
              className="cc-account-drop"
              title="删除"
              disabled={account.id === props.activeAccountId}
              onClick={() => props.onChange(props.accounts.filter(row => row.id !== account.id))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="cc-account-actions">
        <span className="cc-hint">
          切换会把会话列表、登录身份、模型目录、记忆与技能整体换到该目录下；有会话正在运行时无法切换。
          列表的增删改随「保存」生效，切换则立即生效。
        </span>
        <Button
          size="sm"
          onClick={() => props.onChange([...props.accounts, { id: nextAccountId(), name: '', dir: '' }])}
        >
          添加账号
        </Button>
      </div>
      {error !== undefined && <div className="cc-hint">{error}</div>}
      {picking !== undefined && (
        <DirectoryPicker
          initial={props.accounts.find(account => account.id === picking)?.dir ?? ''}
          onCancel={() => setPicking(undefined)}
          onPick={picked => {
            patch(picking, { dir: picked })
            setPicking(undefined)
          }}
        />
      )}
    </div>
  )
}
