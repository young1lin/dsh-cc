/**
 * Per-session environment override with structured rows, device-bound secret
 * messaging, and portable import/export that never copies credentials.
 *
 * @module dsh-cc/client/settings/SessionEnvModal
 */

import { useState, type ReactElement } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { EnvEditor, fromRows, toRows, validateEnvRows, type EnvRow } from './EnvEditor.tsx'
import { registerCss } from '../css.ts'
import { setSessionEnv } from '../api/sessions.ts'
import {
  SECRET_VALUE_LOCKED,
  isSecretEnvKey,
  isSecretPlaceholder,
  type SessionMeta,
} from '../../types.ts'

registerCss('session-env-modal', `
.cc-session-env-dialog {
  width: min(680px, calc(100vw - 32px));
  max-height: calc(100dvh - 48px);
  overflow: hidden;
}

/* The host Modal injects its own max-height (content-box, ~20px margin) AFTER
   plugin sheets, which overflows the viewport once its padding is added. The
   doubled class out-specifies it and border-box makes the cap cover the whole
   box, so the dialog always fits with breathing room and scrolls inside. */
.cc-session-env-dialog.cc-session-env-dialog {
  box-sizing: border-box;
  max-height: calc(100dvh - 48px);
}

.cc-session-env-content { min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.cc-session-env-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
  padding-right: 2px;
}

.cc-env-hero {
  display: grid;
  grid-template-columns: 38px 1fr;
  gap: 12px;
  align-items: center;
  padding: 13px 14px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 24%, var(--dsw-alias-border-l2));
  border-radius: 12px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 6%, var(--dsw-alias-bg-layer-1));
}

.cc-env-hero-icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 11px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-brand-primary);
  font-size: 20px;
}
.cc-env-hero-title { color: var(--dsw-alias-label-primary); font: var(--dsw-font-xs-strong-13); }
.cc-env-hero-copy { margin-top: 3px; color: var(--dsw-alias-label-secondary); font: var(--dsw-font-xxs-12); line-height: 1.55; }

.cc-env-section { display: flex; flex-direction: column; gap: 9px; }
.cc-env-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.cc-env-section-title { color: var(--dsw-alias-label-primary); font: var(--dsw-font-xs-strong-13); }
.cc-env-section-subtitle { margin-top: 2px; color: var(--dsw-alias-label-tertiary); font: var(--dsw-font-xxs-12); }
.cc-env-actions { display: flex; align-items: center; gap: 6px; }

.cc-account-bind-card {
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}
.cc-account-bind-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 12px;
}
.cc-account-bind-title { color: var(--dsw-alias-label-primary); font: var(--dsw-font-xs-strong-13); }
.cc-account-bind-copy { margin-top: 2px; color: var(--dsw-alias-label-tertiary); font: var(--dsw-font-xxs-12); }
.cc-account-bind-root {
  padding: 9px 12px;
  border-top: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12);
}
.cc-account-bind-root code { color: var(--dsw-alias-label-primary); font-family: var(--ds-font-family-code); overflow-wrap: anywhere; }
.cc-account-env-grid { border-top: 1px solid var(--dsw-alias-border-l2); }
.cc-account-env-row {
  display: grid;
  grid-template-columns: minmax(170px, 1fr) minmax(0, 1.2fr) max-content;
  gap: 10px;
  align-items: center;
  padding: 8px 12px;
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-markdown-code-block-small);
  font-family: var(--ds-font-family-code);
}
.cc-account-env-row + .cc-account-env-row { border-top: 1px solid var(--dsw-alias-border-l2); }
.cc-account-env-value { min-width: 0; overflow-wrap: anywhere; }
.cc-env-pill {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12);
  font-family: var(--dsw-font-family);
  white-space: nowrap;
}

.cc-env-import {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}
.cc-env-import textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 112px;
  resize: vertical;
  padding: 9px 11px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-markdown-code-block-small);
  font-family: var(--ds-font-family-code);
  outline: none;
}
.cc-env-import textarea:focus { border-color: var(--dsw-alias-brand-primary); }
.cc-env-import-hint { color: var(--dsw-alias-label-tertiary); font: var(--dsw-font-xxs-12); }

.cc-env-notice {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12);
}

@media (max-width: 560px) {
  .cc-session-env-dialog { width: calc(100vw - 20px); max-height: calc(100dvh - 20px); }
  .cc-env-section-head { align-items: flex-start; flex-direction: column; }
  .cc-account-env-row { grid-template-columns: 1fr max-content; }
  .cc-account-env-value { grid-column: 1 / -1; grid-row: 2; }
}
`)

/** Parse a flat string-valued JSON object. */
function parseEnvJson(text: string): Record<string, string> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') return undefined
    env[key] = value
  }
  return env
}

/** Display one already-wire-redacted account binding value. */
function boundValue(key: string, value: string): { value: string; label: string } {
  if (!isSecretEnvKey(key)) return { value, label: '账号绑定' }
  return value === SECRET_VALUE_LOCKED
    ? { value: '无法在此设备解密', label: '需重新输入' }
    : { value: '••••••••', label: '设备加密' }
}

/**
 * Render the per-session environment dialog.
 * @param props - session plus close and saved callbacks.
 * @returns the dialog node.
 */
export function SessionEnvModal(props: {
  session: SessionMeta
  onClose(): void
  onSaved(): void
}): ReactElement {
  const [rows, setRows] = useState<EnvRow[]>(toRows(props.session.env ?? {}))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const [importing, setImporting] = useState(false)
  const [importText, setImportText] = useState('')

  const save = (): void => {
    const invalid = validateEnvRows(rows)
    if (invalid !== undefined) {
      setMessage(invalid)
      return
    }
    setSaving(true)
    setMessage(undefined)
    setSessionEnv(props.session.id, fromRows(rows))
      .then(() => {
        props.onSaved()
        props.onClose()
      })
      .catch(cause => {
        setSaving(false)
        setMessage(cause instanceof Error ? cause.message : String(cause))
      })
  }

  const exportEnv = (): void => {
    const env = fromRows(rows)
    const portable = Object.fromEntries(Object.entries(env).filter(([key]) => !isSecretEnvKey(key)))
    const omitted = Object.keys(env).length - Object.keys(portable).length
    if (Object.keys(portable).length === 0 && omitted === 0) {
      setNotice('当前没有可导出的变量')
      return
    }
    const json = JSON.stringify(portable, null, 2)
    const success = omitted > 0
      ? `已复制 ${Object.keys(portable).length} 个变量；${omitted} 个密钥已安全省略`
      : `已复制 ${Object.keys(portable).length} 个变量到剪贴板`
    const fallback = (): void => {
      setImporting(true)
      setImportText(json)
      setNotice(omitted > 0
        ? `剪贴板不可用，已在下方生成不含密钥的 JSON；${omitted} 个密钥已省略`
        : '剪贴板不可用，已在下方生成 JSON，请手动复制')
    }
    if (navigator.clipboard === undefined) fallback()
    else navigator.clipboard.writeText(json).then(() => setNotice(success), fallback)
  }

  const applyImport = (): void => {
    const imported = parseEnvJson(importText)
    if (imported === undefined) {
      setMessage('导入失败：需要形如 {"KEY":"值"} 的纯字符串 JSON 对象')
      return
    }
    const accepted: Record<string, string> = {}
    let skipped = 0
    let replacementSecrets = 0
    for (const [key, value] of Object.entries(imported)) {
      if (isSecretEnvKey(key) && (value === '' || isSecretPlaceholder(value) || /^•+$/.test(value))) {
        skipped += 1
        continue
      }
      if (isSecretEnvKey(key)) replacementSecrets += 1
      accepted[key] = value
    }
    setMessage(undefined)
    setRows(toRows({ ...fromRows(rows), ...accepted }))
    setImporting(false)
    setImportText('')
    setNotice(`已导入 ${Object.keys(accepted).length} 个变量${replacementSecrets > 0 ? `，其中 ${replacementSecrets} 个密钥将替换本机原值` : ''}${skipped > 0 ? `；跳过 ${skipped} 个空白/占位密钥` : ''}；保存后生效`)
  }

  const accountEntries = Object.entries(props.session.accountEnv ?? {})
  return (
    <Modal
      open
      className="cc-session-env-dialog"
      contentClassName="cc-session-env-content"
      onClose={props.onClose}
      title={`会话环境 · ${props.session.name}`}
      closeLabel="关闭"
      footer={(
        <>
          <span className="cc-spacer" />
          <Button onClick={props.onClose}>取消</Button>
          <Button variant="primary" disabled={saving} onClick={save}>{saving ? '安全保存中…' : '保存更改'}</Button>
        </>
      )}
    >
      <div className="cc-session-env-body">
        <div className="cc-env-hero">
          <div className="cc-env-hero-icon" aria-hidden="true">♢</div>
          <div>
            <div className="cc-env-hero-title">密钥随设备加密</div>
            <div className="cc-env-hero-copy">
              ANTHROPIC_AUTH_TOKEN 与 API Key 使用本机凭据系统保护，页面不会回读明文。复制配置到另一台设备也无法解密。
            </div>
          </div>
        </div>

        {props.session.accountEnv !== undefined && (
          <section className="cc-account-bind-card">
            <div className="cc-account-bind-top">
              <div>
                <div className="cc-account-bind-title">账号绑定</div>
                <div className="cc-account-bind-copy">创建会话时固定；之后切换全局账号不会影响此会话</div>
              </div>
              <span className="cc-env-pill">会话快照</span>
            </div>
            <div className="cc-account-bind-root">根目录　<code>{props.session.configDir ?? '（未记录）'}</code></div>
            {accountEntries.length > 0 ? (
              <div className="cc-account-env-grid">
                {accountEntries.map(([key, raw]) => {
                  const display = boundValue(key, raw)
                  return (
                    <div key={key} className="cc-account-env-row">
                      <span>{key}</span>
                      <span className="cc-account-env-value">{display.value}</span>
                      <span className="cc-env-pill">{display.label}</span>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="cc-account-bind-root">账号直连 · 凭据来自该根目录的登录态</div>
            )}
          </section>
        )}

        <section className="cc-env-section">
          <div className="cc-env-section-head">
            <div>
              <div className="cc-env-section-title">会话覆盖</div>
              <div className="cc-env-section-subtitle">仅在下一个 Claude 进程启动时生效；留空则沿用账号与全局设置</div>
            </div>
            <div className="cc-env-actions">
              <Button size="sm" onClick={() => { setImporting(value => !value); setNotice(undefined) }}>
                {importing ? '收起导入' : '导入 JSON'}
              </Button>
              <Button size="sm" onClick={exportEnv}>安全导出</Button>
            </div>
          </div>
          <EnvEditor rows={rows} onChange={setRows} />
        </section>

        {importing && (
          <div className="cc-env-import">
            <div className="cc-env-import-hint">粘贴字符串键值 JSON。安全导出不会包含密钥；如需迁移，请在新设备上重新输入。</div>
            <textarea
              value={importText}
              autoFocus
              aria-label="导入环境变量 JSON"
              placeholder={'{\n  "ANTHROPIC_BASE_URL": "https://example.com",\n  "ANTHROPIC_MODEL": "model-name"\n}'}
              onChange={event => setImportText(event.target.value)}
            />
            <div className="cc-row">
              <Button size="sm" variant="primary" onClick={applyImport}>应用导入</Button>
              <Button size="sm" onClick={() => { setImporting(false); setImportText('') }}>取消</Button>
            </div>
          </div>
        )}
        {notice !== undefined && <div className="cc-env-notice" aria-live="polite">{notice}</div>}
        {message !== undefined && <div className="cc-error-bar" role="alert">{message}</div>}
      </div>
    </Modal>
  )
}
