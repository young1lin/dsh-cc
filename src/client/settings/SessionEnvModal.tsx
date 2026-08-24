/**
 * Per-session environment override: the layer that lets one conversation run
 * against a different endpoint or key than the rest.
 *
 * @module dsh-cc/client/settings/SessionEnvModal
 */

import { useState, type ReactElement } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { EnvEditor, fromRows, toRows, type EnvRow } from './EnvEditor.tsx'
import { registerCss } from '../css.ts'
import { setSessionEnv } from '../api/sessions.ts'
import type { SessionMeta } from '../../types.ts'

registerCss('session-env-modal', `
.cc-env-import {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}

.cc-env-import textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 96px;
  resize: vertical;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-markdown-code-block-small);
  font-family: var(--ds-font-family-code);
  outline: none;
}

.cc-env-import textarea:focus { border-color: var(--dsw-alias-brand-primary); }

.cc-env-notice {
  margin-top: 8px;
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-secondary);
}
`)

/**
 * Parse an exported env JSON string into a string map, rejecting anything
 * that is not a flat `{ KEY: "value" }` object.
 * @param text - the pasted JSON.
 * @returns the parsed map, or undefined when the text is not one.
 */
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

/**
 * Render the per-session environment dialog.
 * @param props - the session plus close and saved callbacks.
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
    setSaving(true)
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
    if (Object.keys(env).length === 0) {
      setNotice('当前没有可导出的变量')
      return
    }
    const json = JSON.stringify(env, null, 2)
    navigator.clipboard.writeText(json).then(
      () => setNotice(`已复制 ${Object.keys(env).length} 个变量的 JSON 到剪贴板`),
      () => {
        // Clipboard write refused: surface the JSON for manual copying.
        setImporting(true)
        setImportText(json)
        setNotice('无法访问剪贴板，JSON 已填入下方文本框，请手动全选复制')
      },
    )
  }

  const applyImport = (): void => {
    const imported = parseEnvJson(importText)
    if (imported === undefined) {
      setMessage('导入失败：需要形如 {"KEY":"值"} 的纯字符串 JSON 对象')
      return
    }
    setMessage(undefined)
    setRows(toRows({ ...fromRows(rows), ...imported }))
    setImporting(false)
    setImportText('')
    setNotice(`已导入 ${Object.keys(imported).length} 个变量（同名覆盖，其余保留），保存后生效`)
  }

  return (
    <Modal
      open
      onClose={props.onClose}
      title={`会话环境变量 · ${props.session.name}`}
      closeLabel="关闭"
      footer={(
        <>
          <Button onClick={() => { setImporting(value => !value); setNotice(undefined) }}>
            {importing ? '收起导入' : '导入'}
          </Button>
          <Button onClick={exportEnv}>导出</Button>
          <span className="cc-spacer" />
          <Button onClick={props.onClose}>取消</Button>
          <Button variant="primary" disabled={saving} onClick={save}>{saving ? '保存中…' : '保存'}</Button>
        </>
      )}
    >
      <div className="cc-settings">
        <div className="cc-hint">
          只作用于这个会话的下一个 claude 进程，例如让它单独走另一个中转站：设置 ANTHROPIC_BASE_URL 与 ANTHROPIC_AUTH_TOKEN。留空则沿用全局设置；进行中的回合不受影响。导出会把当前变量以 JSON 复制到剪贴板，导入粘贴即可复用。
        </div>
        <EnvEditor rows={rows} onChange={setRows} />
        {importing && (
          <div className="cc-env-import">
            <textarea
              value={importText}
              autoFocus
              placeholder='粘贴导出的 JSON，例如 {"ANTHROPIC_BASE_URL":"https://example.com","ANTHROPIC_AUTH_TOKEN":"sk-…"}'
              onChange={event => setImportText(event.target.value)}
            />
            <div className="cc-row">
              <Button size="sm" variant="primary" onClick={applyImport}>应用导入</Button>
              <Button size="sm" onClick={() => { setImporting(false); setImportText('') }}>取消</Button>
            </div>
          </div>
        )}
        {notice !== undefined && <div className="cc-env-notice">{notice}</div>}
        {message !== undefined && <div className="cc-error-bar">{message}</div>}
      </div>
    </Modal>
  )
}
