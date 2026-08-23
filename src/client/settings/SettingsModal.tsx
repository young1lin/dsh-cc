/**
 * Global settings: default model, permission posture, and the environment the
 * claude process is spawned with.
 *
 * The dialog opens with the configuration that is ACTUALLY in force — every
 * variable and the layer that supplied it — because the common failure this
 * surface has to answer is "which endpoint and key am I even on right now",
 * and that answer is not visible from the page-editable layer alone.
 *
 * @module dsh-cc/client/settings/SettingsModal
 */

import { useEffect, useState, type ReactElement } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { EnvEditor, fromRows, toRows, type EnvRow } from './EnvEditor.tsx'
import { fetchSettings, saveSettings } from '../api/settings.ts'
import { registerCss } from '../css.ts'
import type { ConfigSummary, ConfigLayer } from '../../types.ts'

registerCss('settings-modal', `
.cc-settings { display: flex; flex-direction: column; gap: 12px; }

.cc-section-title {
  margin-top: 4px;
  font: var(--dsw-font-xs-strong-13);
  color: var(--dsw-alias-label-secondary);
}

.cc-effective {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  overflow: hidden;
}

.cc-effective-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr) max-content;
  gap: 10px;
  align-items: baseline;
  padding: 5px 12px;
  font: var(--dsw-font-markdown-code-block-small);
  font-family: var(--ds-font-family-code);
  color: var(--dsw-alias-label-secondary);
}

.cc-effective-row + .cc-effective-row { border-top: 1px solid var(--dsw-alias-border-l2); }
.cc-effective-row span:first-child { color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.cc-effective-row span:nth-child(2) { overflow-wrap: anywhere; }

.cc-layer-tag {
  justify-self: end;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  font: var(--dsw-font-xxs-12);
  font-family: var(--dsw-font-family);
  color: var(--dsw-alias-label-tertiary);
}

.cc-hint {
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-tertiary);
}
`)

/** The model aliases offered as the global default. */
const MODEL_CHOICES = [
  { value: '', label: '默认（跟随 dsh 启动配置）' },
  { value: 'opus', label: 'opus' },
  { value: 'sonnet', label: 'sonnet' },
  { value: 'haiku', label: 'haiku' },
]

/** Permission postures the CLI accepts, with what each one means here. */
const PERMISSION_CHOICES = [
  { value: '', label: '跟随启动配置' },
  { value: 'auto', label: 'auto — 由分类器模型自动判定（推荐）' },
  { value: 'default', label: 'default — 每次都在本页面询问' },
  { value: 'acceptEdits', label: 'acceptEdits — 自动接受文件编辑' },
  { value: 'plan', label: 'plan — 只读，只出方案' },
  { value: 'dontAsk', label: 'dontAsk — 未预先允许的一律拒绝' },
  { value: 'bypassPermissions', label: 'bypassPermissions — 跳过全部确认' },
]

/** Human label for each configuration layer. */
const LAYER_LABELS: Record<ConfigLayer, string> = {
  process: 'dsh 进程环境',
  plugin: 'cordis 配置',
  settings: '页面设置',
  session: '会话覆盖',
}

/**
 * Render the settings dialog.
 * @param props - the effective config summary and the close callback.
 * @returns the dialog node.
 */
export function SettingsModal(props: {
  config: ConfigSummary | undefined
  onClose(): void
}): ReactElement {
  const [model, setModel] = useState('')
  const [permissionMode, setPermissionMode] = useState('')
  const [rows, setRows] = useState<EnvRow[]>([])
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | undefined>()

  useEffect(() => {
    fetchSettings()
      .then(result => {
        setModel(result.settings.model)
        setPermissionMode(result.settings.permissionMode)
        setRows(toRows(result.settings.env))
        setReady(true)
      })
      .catch(cause => setMessage(cause instanceof Error ? cause.message : String(cause)))
  }, [])

  const save = (): void => {
    setSaving(true)
    saveSettings({ model, permissionMode, env: fromRows(rows) })
      .then(props.onClose)
      .catch(cause => {
        setSaving(false)
        setMessage(cause instanceof Error ? cause.message : String(cause))
      })
  }

  return (
    <Modal
      open
      onClose={props.onClose}
      title="Claude Code 设置"
      closeLabel="关闭"
      footer={(
        <>
          <Button onClick={props.onClose}>取消</Button>
          <Button variant="primary" disabled={!ready || saving} onClick={save}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </>
      )}
    >
      <div className="cc-settings">
        <label className="cc-field">
          默认模型
          <select value={model} onChange={event => setModel(event.target.value)}>
            {MODEL_CHOICES.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
          </select>
        </label>
        <label className="cc-field">
          权限模式
          <select value={permissionMode} onChange={event => setPermissionMode(event.target.value)}>
            {PERMISSION_CHOICES.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
          </select>
        </label>

        <div className="cc-section-title">当前生效的环境</div>
        {props.config === undefined || props.config.env.length === 0
          ? <div className="cc-hint">没有额外环境变量：claude 进程直接继承 dsh 启动时的环境。</div>
          : (
              <div className="cc-effective">
                {props.config.env.map(entry => (
                  <div key={entry.key} className="cc-effective-row">
                    <span>{entry.key}</span>
                    <span>{entry.value}</span>
                    <span className="cc-layer-tag">{LAYER_LABELS[entry.layer]}</span>
                  </div>
                ))}
              </div>
            )}

        <div className="cc-section-title">页面设置的环境变量</div>
        <EnvEditor rows={rows} onChange={setRows} />

        {message !== undefined && <div className="cc-error-bar">{message}</div>}
        <div className="cc-hint">
          保存后写入数据目录的 settings.json，对之后新启动的 claude 进程生效；进行中的回合不受影响。留空的字段沿用 dsh 启动配置。
        </div>
      </div>
    </Modal>
  )
}
