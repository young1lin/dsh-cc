/**
 * Structured key/value editor for environment layers, with first-class secret
 * handling shared by global settings and per-session overrides.
 *
 * @module dsh-cc/client/settings/EnvEditor
 */

import { useState, type ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { registerCss } from '../css.ts'
import {
  SECRET_VALUE_LOCKED,
  isProtectedEnvKey,
  isSecretEnvKey,
  isSecretPlaceholder,
} from '../../types.ts'

registerCss('env-editor', `
.cc-env-list {
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-base);
}

.cc-env-row {
  display: grid;
  grid-template-columns: minmax(150px, 5fr) minmax(0, 7fr) 32px;
  gap: 12px;
  align-items: start;
  padding: 12px;
}

.cc-env-row + .cc-env-row { border-top: 1px solid var(--dsw-alias-border-l2); }
.cc-env-cell { min-width: 0; }

.cc-env-cell-label {
  display: block;
  margin: 0 0 6px 2px;
  color: var(--dsw-alias-label-caption);
  font: var(--dsw-font-xxs-12);
}

.cc-env-row input {
  box-sizing: border-box;
  width: 100%;
  min-height: 36px;
  padding: 7px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-markdown-code-block-small);
  font-family: var(--ds-font-family-code);
  outline: none;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}

.cc-env-row input:focus {
  border-color: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);
}
.cc-env-row input[readonly] { cursor: default; color: var(--dsw-alias-label-secondary); }

.cc-env-secret-line { position: relative; }
.cc-env-secret-line input { padding-right: 58px; }
.cc-env-secret-line.is-saved input {
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-1);
}

.cc-env-reveal {
  position: absolute;
  top: 50%;
  right: 5px;
  transform: translateY(-50%);
  padding: 4px 7px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12);
  cursor: pointer;
}
.cc-env-reveal:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }

.cc-env-secret-state {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 20px;
  margin-top: 5px;
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12);
}

.cc-env-secret-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--dsw-alias-state-success-primary, #16a16b);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary, #16a16b) 12%, transparent);
}
.cc-env-secret-state.is-locked { color: var(--dsw-alias-state-warning-primary, #b66a00); }
.cc-env-secret-state.is-locked .cc-env-secret-dot { background: var(--dsw-alias-state-warning-primary, #b66a00); }

.cc-env-drop {
  align-self: center;
  width: 32px;
  height: 32px;
  margin-top: 20px;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-caption);
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
}
.cc-env-drop:hover { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }

.cc-env-empty {
  padding: 24px 16px;
  text-align: center;
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xs-13);
}

.cc-env-add { margin-top: 10px; }

@media (max-width: 520px) {
  .cc-env-row { grid-template-columns: 1fr 32px; gap: 10px 8px; }
  .cc-env-cell:first-child { grid-column: 1 / -1; }
  .cc-env-drop { grid-column: 2; margin-top: 20px; }
}

@media (prefers-reduced-motion: reduce) {
  .cc-env-row input { transition: none; }
}
`)

/** One editable environment entry. */
export interface EnvRow {
  /** Stable identity while the key field itself is edited. */
  id: string
  key: string
  value: string
}

/** Monotonic source of row ids; see {@link EnvRow.id}. */
let rowSeq = 0

/** Mint one stable row id. */
function nextRowId(): string {
  rowSeq += 1
  return `env-row-${rowSeq}`
}

/**
 * Convert an env map into editor rows.
 * @param env - the map.
 * @returns rows in key order.
 */
export function toRows(env: Record<string, string>): EnvRow[] {
  return Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ id: nextRowId(), key, value }))
}

/**
 * Collapse editor rows back into an env map, dropping unnamed and empty-value
 * rows. An empty row means “inherit the lower layer”, never an explicit empty
 * spawn override.
 * @param rows - the editor rows.
 * @returns the map.
 */
export function fromRows(rows: EnvRow[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key.length === 0 || row.value === '') continue
    env[key] = row.value
  }
  return env
}

/**
 * Validate names and duplicates before a complete environment map is built.
 * @param rows - current editor rows.
 * @returns a Chinese validation message, or undefined when every row is safe.
 */
export function validateEnvRows(rows: EnvRow[]): string | undefined {
  const seen = new Set<string>()
  for (const row of rows) {
    const key = row.key.trim()
    if (key === '' && row.value === '') continue
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return `变量名“${key || '（空）'}”无效：只能使用字母、数字和下划线，且不能以数字开头`
    }
    const normalized = key.toUpperCase()
    if (seen.has(normalized)) return `变量名“${key}”重复，请只保留一行`
    seen.add(normalized)
  }
  return undefined
}

/** One row's secret-aware value field. */
function EnvValue(props: { row: EnvRow; onChange(value: string): void }): ReactElement {
  const [revealed, setRevealed] = useState(false)
  const secret = isSecretEnvKey(props.row.key)
  const saved = secret && isSecretPlaceholder(props.row.value)
  const protectedKey = isProtectedEnvKey(props.row.key)
  const locked = props.row.value === SECRET_VALUE_LOCKED
  if (!secret) {
    return (
      <input
        className="cc-env-value"
        value={props.row.value}
        placeholder="变量值"
        aria-label={`${props.row.key || '环境变量'}的值`}
        spellCheck={false}
        onChange={event => props.onChange(event.target.value)}
      />
    )
  }
  return (
    <>
      <div className={`cc-env-secret-line${saved ? ' is-saved' : ''}`}>
        <input
          className="cc-env-value"
          type={revealed ? 'text' : 'password'}
          value={saved ? '' : props.row.value}
          placeholder={locked ? '此密钥属于另一台设备；输入新值替换' : saved ? '已加密保存；输入新值替换' : '输入密钥'}
          aria-label={`${props.row.key || '密钥'}的值`}
          autoComplete="new-password"
          spellCheck={false}
          onChange={event => props.onChange(event.target.value)}
        />
        {!saved && props.row.value !== '' && (
          <button
            type="button"
            className="cc-env-reveal"
            aria-pressed={revealed}
            onClick={() => setRevealed(value => !value)}
          >
            {revealed ? '隐藏' : '显示'}
          </button>
        )}
      </div>
      <div className={`cc-env-secret-state${locked ? ' is-locked' : ''}`} aria-live="polite">
        <span className="cc-env-secret-dot" aria-hidden="true" />
        {locked
          ? '无法在本机解密，保存新值后会重新绑定'
          : saved
            ? protectedKey ? '已由本机凭据系统加密' : '敏感值已隐藏，页面不会回读'
            : protectedKey ? '保存后仅在本机可解密' : '敏感值不会在页面回显'}
      </div>
    </>
  )
}

/**
 * Render the structured editor.
 * @param props - current rows and complete-list change callback.
 * @returns the editor node.
 */
export function EnvEditor(props: {
  rows: EnvRow[]
  onChange(rows: EnvRow[]): void
  emptyLabel?: string
}): ReactElement {
  const patch = (index: number, patchRow: Partial<EnvRow>): void => {
    props.onChange(props.rows.map((row, at) => (at === index ? { ...row, ...patchRow } : row)))
  }

  return (
    <>
      <div className="cc-env-list">
        {props.rows.length === 0 && <div className="cc-env-empty">{props.emptyLabel ?? '尚未添加会话变量'}</div>}
        {props.rows.map((row, index) => (
          <div key={row.id} className="cc-env-row">
            <label className="cc-env-cell">
              <span className="cc-env-cell-label">变量名</span>
              <input
                className="cc-env-key"
                value={row.key}
                placeholder="例如 ANTHROPIC_BASE_URL"
                aria-label="变量名"
                autoCapitalize="off"
                autoComplete="off"
                spellCheck={false}
                readOnly={isSecretPlaceholder(row.value)}
                title={isSecretPlaceholder(row.value) ? '已保存密钥的变量名不可改；如需更名，请删除后重新添加' : undefined}
                onChange={event => patch(index, { key: event.target.value })}
              />
            </label>
            <div className="cc-env-cell">
              <span className="cc-env-cell-label">变量值</span>
              <EnvValue row={row} onChange={value => patch(index, { value })} />
            </div>
            <button
              type="button"
              className="cc-env-drop"
              title="删除变量"
              aria-label={`删除 ${row.key || '未命名变量'}`}
              onClick={() => props.onChange(props.rows.filter((_, at) => at !== index))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="cc-env-add">
        <Button size="sm" onClick={() => props.onChange([...props.rows, { id: nextRowId(), key: '', value: '' }])}>
          ＋ 添加变量
        </Button>
      </div>
    </>
  )
}
