/**
 * Structured provider/proxy form: the well-known env keys that pick the
 * upstream endpoint, credential, model aliases, proxy, and timeout, rendered
 * as named fields instead of raw KV rows.
 *
 * Every field reads and writes the same `CcSettings.env` map the advanced KV
 * editor uses — see {@link "./providerFields.ts"} for the projection. Each
 * field shows which configuration layer currently supplies its value (from
 * `ConfigSummary.env`), so "why is it still hitting the old endpoint" is
 * answerable without leaving the page.
 *
 * @module dsh-cc/client/settings/ProviderForm
 */

import { useState, type ReactElement } from 'react'
import { Button, Input, Pill, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { registerCss } from '../css.ts'
import {
  activePresetId, applyProviderFields, CUSTOM_PRESET_ID, extractProviderFields, findEnvEntry,
  layerLabel, PROVIDER_PRESETS, type ProviderFormFields,
} from './providerFields.ts'
import type { ConfigSummary } from '../../types.ts'

/** DOM id of the API-address input; the 自定义中转 preset focuses it by id. */
const BASE_URL_INPUT_ID = 'cc-provider-base-url'

registerCss('provider-form', `
.cc-provider-presets { display: flex; flex-wrap: wrap; gap: 6px; }

.cc-provider-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
}

.cc-provider-group-title { font: var(--dsw-font-xs-strong-13); color: var(--dsw-alias-label-primary); }

.cc-provider-field-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 8px;
}

.cc-provider-effective {
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
}

.cc-provider-field input { width: 100%; }
`)

/**
 * Render one labeled field: input, provenance tag, and (for a value that
 * differs from the currently-forced one) a hint showing what is actually in
 * force right now.
 * @param props - the field's label, value/onChange pair, provenance lookup key, and optional reveal control.
 * @returns the field node.
 */
function ProviderField(props: {
  label: string
  placeholder: string
  value: string
  onChange(value: string): void
  provenanceKey: string
  config: ConfigSummary | undefined
  reveal?: { revealed: boolean; onToggle(): void }
  /** DOM id for the native input, so a preset can hand the caret over. */
  inputId?: string
}): ReactElement {
  const entry = findEnvEntry(props.config, props.provenanceKey)
  return (
    <label className="cc-field cc-provider-field">
      <span className="cc-provider-field-head">
        <span>{props.label}</span>
        <span className="cc-layer-tag">{layerLabel(entry)}</span>
      </span>
      <span className="cc-row">
        <Input
          className="cc-spacer"
          {...(props.inputId !== undefined ? { id: props.inputId } : {})}
          type={props.reveal !== undefined && !props.reveal.revealed ? 'password' : 'text'}
          placeholder={props.placeholder}
          value={props.value}
          onChange={event => props.onChange(event.target.value)}
        />
        {props.reveal !== undefined && (
          <Button size="sm" onClick={props.reveal.onToggle}>{props.reveal.revealed ? '隐藏' : '显示'}</Button>
        )}
      </span>
      {/* A masked entry (secrets) can never be compared against the raw draft value, so the
          hint is shown only for the plain-text fields where the comparison is meaningful. */}
      {entry !== undefined && !entry.masked && entry.value !== props.value && (
        <span className="cc-provider-effective">
          当前生效值：<span className="cc-mono">{entry.value || '（空）'}</span>，保存后以此表单为准
        </span>
      )}
    </label>
  )
}

/**
 * Render the structured provider/proxy/timeout form.
 * @param props.env - the page-editable settings environment (the single source of truth; the
 * structured fields and the advanced KV editor are both views over it).
 * @param props.onChange - called with a complete replacement env map on any field edit.
 * @param props.config - the effective config summary, for per-field provenance; undefined while loading.
 * @returns the form node.
 */
export function ProviderForm(props: {
  env: Record<string, string>
  onChange(env: Record<string, string>): void
  config: ConfigSummary | undefined
}): ReactElement {
  const [keyRevealed, setKeyRevealed] = useState(false)
  const fields = extractProviderFields(props.env)
  // Exactly one pill is active, derived from the field rather than matched per
  // pill: two presets share an empty baseUrl and both used to light up.
  const active = activePresetId(fields.baseUrl)

  const patch = (partial: Partial<ProviderFormFields>): void => {
    props.onChange(applyProviderFields(props.env, { ...fields, ...partial }))
  }

  return (
    <div className="cc-settings">
      <div className="cc-section-title">预设</div>
      <div className="cc-provider-presets">
        {PROVIDER_PRESETS.map(preset => (
          <Tooltip key={preset.id} label={preset.hint} side="bottom">
            <Pill
              active={active === preset.id}
              onClick={() => {
                patch({ baseUrl: preset.baseUrl })
                // 自定义中转 clears the field so the user can type their own
                // endpoint — but an empty field IS the official endpoint, so
                // the readout would swing to 官方 API and look like the click
                // picked the wrong pill. Handing over the caret makes the next
                // keystroke resolve it, which is what the preset actually means.
                // The Input primitive is not a forwardRef component, so the
                // caret is reached through the id it passes to the native input.
                if (preset.id === CUSTOM_PRESET_ID) {
                  document.getElementById(BASE_URL_INPUT_ID)?.focus()
                }
              }}
            >
              {preset.label}
            </Pill>
          </Tooltip>
        ))}
      </div>

      <ProviderField
        label="API 地址"
        placeholder="留空 = Claude 官方端点，例如 https://open.bigmodel.cn/api/anthropic"
        value={fields.baseUrl}
        onChange={baseUrl => patch({ baseUrl })}
        provenanceKey="ANTHROPIC_BASE_URL"
        config={props.config}
        inputId={BASE_URL_INPUT_ID}
      />

      <div className="cc-provider-group">
        <span className="cc-row">
          <span className="cc-provider-group-title cc-spacer">密钥</span>
          {/* Seam for the connection-test feature owned by another work package: it will call a
              host endpoint (e.g. POST /cc/api/settings/test-connection) with the drafted
              baseUrl/key so it can be verified before saving. Wiring that request is out of
              scope here; this control is left in place, disabled, so the seam is discoverable. */}
          <Tooltip label="即将支持：向当前填写的地址和密钥发起一次校验请求（由另一工作包实现）" side="top">
            <Button size="sm" disabled>测试连接</Button>
          </Tooltip>
        </span>
        <ProviderField
          label={`${fields.apiKeySourceKey}`}
          placeholder="sk-… 或网关签发的 Token"
          value={fields.apiKeyValue}
          onChange={apiKeyValue => patch({ apiKeyValue })}
          provenanceKey={fields.apiKeySourceKey}
          config={props.config}
          reveal={{ revealed: keyRevealed, onToggle: () => setKeyRevealed(previous => !previous) }}
        />
      </div>

      <div className="cc-provider-group">
        <span className="cc-provider-group-title">模型别名</span>
        <ProviderField
          label="ANTHROPIC_MODEL"
          placeholder="留空 = 不覆盖"
          value={fields.model}
          onChange={model => patch({ model })}
          provenanceKey="ANTHROPIC_MODEL"
          config={props.config}
        />
        <ProviderField
          label="ANTHROPIC_DEFAULT_OPUS_MODEL"
          placeholder="留空 = 不覆盖"
          value={fields.opusModel}
          onChange={opusModel => patch({ opusModel })}
          provenanceKey="ANTHROPIC_DEFAULT_OPUS_MODEL"
          config={props.config}
        />
        <ProviderField
          label="ANTHROPIC_DEFAULT_SONNET_MODEL"
          placeholder="留空 = 不覆盖"
          value={fields.sonnetModel}
          onChange={sonnetModel => patch({ sonnetModel })}
          provenanceKey="ANTHROPIC_DEFAULT_SONNET_MODEL"
          config={props.config}
        />
        <ProviderField
          label="ANTHROPIC_DEFAULT_HAIKU_MODEL"
          placeholder="留空 = 不覆盖"
          value={fields.haikuModel}
          onChange={haikuModel => patch({ haikuModel })}
          provenanceKey="ANTHROPIC_DEFAULT_HAIKU_MODEL"
          config={props.config}
        />
        <ProviderField
          label="ANTHROPIC_SMALL_FAST_MODEL"
          placeholder="留空 = 不覆盖"
          value={fields.smallFastModel}
          onChange={smallFastModel => patch({ smallFastModel })}
          provenanceKey="ANTHROPIC_SMALL_FAST_MODEL"
          config={props.config}
        />
      </div>

      <div className="cc-provider-group">
        <span className="cc-provider-group-title">代理与超时</span>
        <ProviderField
          label="HTTPS_PROXY"
          placeholder="http://127.0.0.1:7890"
          value={fields.httpsProxy}
          onChange={httpsProxy => patch({ httpsProxy })}
          provenanceKey="HTTPS_PROXY"
          config={props.config}
        />
        <ProviderField
          label="HTTP_PROXY"
          placeholder="http://127.0.0.1:7890"
          value={fields.httpProxy}
          onChange={httpProxy => patch({ httpProxy })}
          provenanceKey="HTTP_PROXY"
          config={props.config}
        />
        <ProviderField
          label="NO_PROXY"
          placeholder="localhost,127.0.0.1"
          value={fields.noProxy}
          onChange={noProxy => patch({ noProxy })}
          provenanceKey="NO_PROXY"
          config={props.config}
        />
        <ProviderField
          label="API_TIMEOUT_MS"
          placeholder="毫秒，例如 600000"
          value={fields.apiTimeoutMs}
          onChange={apiTimeoutMs => patch({ apiTimeoutMs })}
          provenanceKey="API_TIMEOUT_MS"
          config={props.config}
        />
      </div>
    </div>
  )
}
