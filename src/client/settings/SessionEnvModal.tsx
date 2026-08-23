/**
 * Per-session environment override: the layer that lets one conversation run
 * against a different endpoint or key than the rest.
 *
 * @module dsh-cc/client/settings/SessionEnvModal
 */

import { useState, type ReactElement } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { EnvEditor, fromRows, toRows, type EnvRow } from './EnvEditor.tsx'
import { setSessionEnv } from '../api/sessions.ts'
import type { SessionMeta } from '../../types.ts'

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

  return (
    <Modal
      open
      onClose={props.onClose}
      title={`会话环境变量 · ${props.session.name}`}
      closeLabel="关闭"
      footer={(
        <>
          <Button onClick={props.onClose}>取消</Button>
          <Button variant="primary" disabled={saving} onClick={save}>{saving ? '保存中…' : '保存'}</Button>
        </>
      )}
    >
      <div className="cc-settings">
        <div className="cc-hint">
          只作用于这个会话的下一个 claude 进程，例如让它单独走另一个中转站：设置 ANTHROPIC_BASE_URL 与 ANTHROPIC_AUTH_TOKEN。留空则沿用全局设置；进行中的回合不受影响。
        </div>
        <EnvEditor rows={rows} onChange={setRows} />
        {message !== undefined && <div className="cc-error-bar">{message}</div>}
      </div>
    </Modal>
  )
}
