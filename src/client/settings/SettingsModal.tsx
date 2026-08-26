/**
 * Global settings: account identity, the structured provider/proxy form,
 * default model, permission posture, and the raw environment the claude
 * process is spawned with.
 *
 * The dialog opens with the configuration that is ACTUALLY in force — every
 * variable and the layer that supplied it — because the common failure this
 * surface has to answer is "which endpoint and key am I even on right now",
 * and that answer is not visible from the page-editable layer alone.
 *
 * @module dsh-cc/client/settings/SettingsModal
 */

import { useEffect, useState, type ReactElement } from 'react'
import { Button, DisclosureRow, IconDataOutline16, IconSettingsOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { AccountPanel } from './AccountPanel.tsx'
import { AccountsPanel } from './AccountsPanel.tsx'
import { EnvEditor, fromRows, toRows, type EnvRow } from './EnvEditor.tsx'
import { ProviderForm } from './ProviderForm.tsx'
import { LAYER_LABELS, omitStructuredKeys, pickStructuredKeys } from './providerFields.ts'
import { fetchSettings, saveSettings } from '../api/settings.ts'
import { fetchGlobalModels, type ModelRow } from '../api/telemetry.ts'
import { registerCss } from '../css.ts'
import type { CcAccount, ConfigSummary, EnvPreset } from '../../types.ts'

// Shared atoms for the whole settings/ sub-tree (`.cc-field`, `.cc-row`, `.cc-hint`,
// `.cc-mono` come from theme.ts): ProviderForm and AccountPanel both reference the
// classes registered here, and are only ever mounted from inside this module, which
// guarantees this sheet is registered first.
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
  white-space: nowrap;
}

.cc-hint {
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-tertiary);
}

.cc-field-note { font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-tertiary); }

/* The preset bar: whole-layer switches for the provider key scope. */
.cc-preset-bar { display: flex; flex-wrap: wrap; gap: 8px 6px; align-items: center; }
.cc-preset-wrap { position: relative; display: inline-flex; }
.cc-preset-chip {
  padding: 3px 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xs-13);
  font-family: var(--dsw-font-family);
  cursor: pointer;
}
.cc-preset-chip:hover { border-color: var(--dsw-alias-border-l3); }
.cc-preset-chip[data-active='true'] {
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-brand-primary);
}
.cc-preset-drop {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12);
  line-height: 13px;
  cursor: pointer;
}
.cc-preset-drop:hover { color: var(--dsw-alias-state-error-primary); }
.cc-preset-save { display: flex; gap: 8px; align-items: center; }
.cc-preset-name { flex: 1; }

.cc-settings-disclosure-title { font: var(--dsw-font-xs-strong-13); }
.cc-settings-disclosure-body { padding: 8px 2px 0; display: flex; flex-direction: column; gap: 10px; }

/* The structured provider form outgrew the default 380px dialog: widen it and let the
   content column scroll internally so the header/footer chrome stays put. */
.cc-settings-dialog { width: min(560px, 100%); max-height: calc(100vh - 48px); overflow: hidden; }
.cc-settings-content { min-height: 0; overflow-y: auto; overscroll-behavior: contain; }

@media (max-height: 640px) {
  .cc-settings-dialog { max-height: calc(100dvh - 48px); }
}
`)

/**
 * The default-model choices, built from the catalog the CLI reports under the
 * current configuration rather than from a fixed list — a relay's aliases and
 * its raw model ids (`glm-5.3[1m]` and the like) exist only there.
 *
 * The CLI's own `default` row is folded into dsh-cc's empty value so there is
 * one canonical "unset" instead of two rows that mean the same thing.
 * @param rows - the catalog rows.
 * @param saved - the currently persisted value.
 * @returns the option list, in catalog order.
 */
function modelChoices(rows: ModelRow[], saved: string): { value: string; label: string }[] {
  const choices = [{ value: '', label: '默认（跟随 dsh 启动配置）' }]
  for (const row of rows) {
    if (row.value === '' || row.value === 'default') continue
    const resolved = row.resolvedModel !== undefined && row.resolvedModel !== row.value
      ? ` → ${row.resolvedModel}`
      : ''
    choices.push({ value: row.value, label: `${row.value}${resolved}` })
  }
  // A saved value the catalog no longer lists stays selectable: dropping it
  // would silently reset the setting the next time the dialog is saved.
  if (saved !== '' && !choices.some(choice => choice.value === saved)) {
    choices.push({ value: saved, label: `${saved}（当前配置未列出）` })
  }
  return choices
}

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

/**
 * Render the settings dialog.
 * @param props - the effective config summary, the close callback, and the
 *   saved callback (invoked once a save lands, so the owner can re-read the
 *   config it displays fields of).
 * @returns the dialog node.
 */
export function SettingsModal(props: {
  config: ConfigSummary | undefined
  onClose(): void
  onSaved(): void
}): ReactElement {
  const [model, setModel] = useState('')
  const [permissionMode, setPermissionMode] = useState('')
  const [env, setEnv] = useState<Record<string, string>>({})
  const [presets, setPresets] = useState<EnvPreset[]>([])
  const [activePresetId, setActivePresetId] = useState('')
  const [presetName, setPresetName] = useState('')
  const [accounts, setAccounts] = useState<CcAccount[]>([])
  const [advancedRows, setAdvancedRows] = useState<EnvRow[]>([])
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | undefined>()
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showFullEnv, setShowFullEnv] = useState(false)
  const [models, setModels] = useState<ModelRow[]>([])
  const [modelsLive, setModelsLive] = useState(false)

  useEffect(() => {
    fetchGlobalModels()
      .then(result => {
        setModels(result.models)
        setModelsLive(result.available)
      })
      .catch(() => {
        // The catalog is a convenience: the field still saves what is picked,
        // and ANTHROPIC_MODEL below remains the free-form escape hatch.
      })
    fetchSettings()
      .then(result => {
        setModel(result.settings.model)
        setPermissionMode(result.settings.permissionMode)
        // Structured form and KV editor own disjoint key sets, held as
        // separate state: re-deriving the rows from `env` on every keystroke
        // would rebuild their identities and lose input focus mid-edit.
        setEnv(pickStructuredKeys(result.settings.env))
        setAdvancedRows(toRows(omitStructuredKeys(result.settings.env)))
        setPresets(result.settings.presets)
        setActivePresetId(result.settings.activePresetId)
        setAccounts(result.settings.accounts)
        setReady(true)
      })
      .catch(cause => setMessage(cause instanceof Error ? cause.message : String(cause)))
  }, [])

  /** The form's env as one map: structured fields plus the advanced rows. */
  const formEnv = (): Record<string, string> => ({ ...env, ...fromRows(advancedRows) })

  /**
   * Apply one preset to the form (or clear back to per-key layering with
   * undefined): the whole page env layer becomes the preset's bundle.
   * @param preset - the preset to load, or none.
   */
  const applyPreset = (preset: EnvPreset | undefined): void => {
    setActivePresetId(preset?.id ?? '')
    setEnv(pickStructuredKeys(preset?.env ?? {}))
    setAdvancedRows(toRows(omitStructuredKeys(preset?.env ?? {})))
  }

  /**
   * Write the whole page-editable layer as the form currently stands. Shared by
   * the footer's save and by the account switch, which has to land the account
   * list before the host can be asked to activate a row from it.
   * @returns a promise settling when the save lands.
   */
  const persist = async (): Promise<void> => {
    // Saving while a preset is active syncs the form back into it: the form
    // IS that preset's editor (fill a token once, it stays in the bundle).
    const synced = activePresetId !== '' && presets.some(preset => preset.id === activePresetId)
      ? presets.map(preset => preset.id === activePresetId ? { ...preset, env: formEnv() } : preset)
      : presets
    setPresets(synced)
    await saveSettings({
      model,
      permissionMode,
      env: formEnv(),
      presets: synced,
      activePresetId,
      accounts,
      // Which account is active is switched through its own endpoint, never
      // saved from here; the host keeps whatever is in force.
      activeAccountId: props.config?.activeAccountId ?? '',
    })
  }

  const save = (): void => {
    setSaving(true)
    persist()
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
      title="Claude Code 设置"
      closeLabel="关闭"
      className="cc-settings-dialog"
      contentClassName="cc-settings-content"
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
        <AccountPanel account={props.config?.account} />

        <AccountsPanel
          accounts={accounts}
          activeAccountId={props.config?.activeAccountId ?? ''}
          defaultConfigDir={props.config?.defaultConfigDir ?? ''}
          onChange={setAccounts}
          onPersist={persist}
          onSwitched={props.onSaved}
        />

        <div className="cc-section-title">服务商与代理</div>
        <div className="cc-preset-bar">
          <button
            type="button"
            className="cc-preset-chip"
            data-active={activePresetId === ''}
            title="不启用任何预设：环境变量逐层叠加，沿用 dsh 启动配置"
            onClick={() => applyPreset(undefined)}
          >
            跟随启动配置
          </button>
          {presets.map(preset => (
            <span className="cc-preset-wrap" key={preset.id}>
              <button
                type="button"
                className="cc-preset-chip"
                data-active={activePresetId === preset.id}
                title={Object.keys(preset.env).length > 0
                  ? Object.entries(preset.env).map(([key, value]) => `${key}=${value}`).join('\n')
                  : '空预设：移除全部服务商变量'}
                onClick={() => applyPreset(preset)}
              >
                {preset.name}
              </button>
              <button
                type="button"
                className="cc-preset-drop"
                title="删除此预设"
                onClick={() => {
                  setPresets(previous => previous.filter(item => item.id !== preset.id))
                  if (activePresetId === preset.id) setActivePresetId('')
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="cc-preset-save">
          <input
            className="cc-preset-name"
            placeholder="预设名，如 GLM 中转"
            value={presetName}
            onChange={event => setPresetName(event.target.value)}
          />
          <Button
            size="sm"
            disabled={presetName.trim() === ''}
            onClick={() => {
              const name = presetName.trim()
              if (name === '') return
              const id = `p${Date.now().toString(36)}`
              setPresets(previous => [...previous, { id, name, env: formEnv() }])
              setActivePresetId(id)
              setPresetName('')
            }}
          >
            存为预设
          </Button>
        </div>
        <div className="cc-field-note">
          预设整体接管服务商相关变量（API 地址、密钥、模型别名、代理、超时）：选中的预设替换这一域，没列出的变量一律移除——包括 dsh 启动环境里带的。预设激活时保存，会把当前表单同步进该预设。
        </div>
        <ProviderForm env={env} onChange={setEnv} config={props.config} />

        <label className="cc-field">
          默认模型
          <select value={model} onChange={event => setModel(event.target.value)}>
            {modelChoices(models, model).map(choice => (
              <option key={choice.value} value={choice.value}>{choice.label}</option>
            ))}
          </select>
          <span className="cc-field-note">
            {modelsLive
              ? '当前配置下 Claude Code 报告的可选模型；箭头后是该别名实际解析到的模型。'
              : '暂时读不到实时模型目录，以下为通用别名；也可用上方 ANTHROPIC_MODEL 直接指定模型 id。'}
          </span>
        </label>
        <label className="cc-field">
          权限模式
          <select value={permissionMode} onChange={event => setPermissionMode(event.target.value)}>
            {PERMISSION_CHOICES.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
          </select>
        </label>

        <DisclosureRow
          icon={<IconSettingsOutline16 />}
          title="高级：其它环境变量"
          titleClassName="cc-settings-disclosure-title"
          open={showAdvanced}
          expandable
          expandOnRowClick
          onToggle={() => setShowAdvanced(previous => !previous)}
        >
          <div className="cc-settings-disclosure-body">
            <EnvEditor rows={advancedRows} onChange={setAdvancedRows} />
          </div>
        </DisclosureRow>

        <DisclosureRow
          icon={<IconDataOutline16 />}
          title="完整生效环境（只读）"
          titleClassName="cc-settings-disclosure-title"
          open={showFullEnv}
          expandable
          expandOnRowClick
          onToggle={() => setShowFullEnv(previous => !previous)}
        >
          <div className="cc-settings-disclosure-body">
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
          </div>
        </DisclosureRow>

        {message !== undefined && <div className="cc-error-bar">{message}</div>}
        <div className="cc-hint">
          保存后写入数据目录的 settings.json，对之后新启动的 claude 进程生效；进行中的回合不受影响。留空的字段沿用 dsh 启动配置。
        </div>
      </div>
    </Modal>
  )
}
