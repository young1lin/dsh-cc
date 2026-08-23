/**
 * Key/value editor for the environment layered onto spawned claude processes.
 * Shared by the global settings dialog and the per-session override dialog.
 *
 * @module dsh-cc/client/settings/EnvEditor
 */

import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { registerCss } from '../css.ts'

registerCss('env-editor', `
.cc-env-row { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }

.cc-env-row input {
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-markdown-code-block-small);
  font-family: var(--ds-font-family-code);
  outline: none;
}

.cc-env-row input:focus { border-color: var(--dsw-alias-brand-primary); }
.cc-env-key { width: 42%; flex: none; }
.cc-env-value { flex: 1; min-width: 0; }

.cc-env-drop {
  flex: none;
  padding: 2px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-caption);
  cursor: pointer;
}

.cc-env-drop:hover { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }
`)

/** One editable environment entry. */
export interface EnvRow {
  key: string
  value: string
}

/**
 * Convert an env map into editor rows.
 * @param env - the map.
 * @returns rows in key order.
 */
export function toRows(env: Record<string, string>): EnvRow[] {
  return Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ key, value }))
}

/**
 * Collapse editor rows back into an env map, dropping unnamed rows.
 * @param rows - the editor rows.
 * @returns the map.
 */
export function fromRows(rows: EnvRow[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key.length === 0) continue
    env[key] = row.value
  }
  return env
}

/**
 * Render the editor.
 * @param props - the current rows and their change callback.
 * @returns the editor node.
 */
export function EnvEditor(props: {
  rows: EnvRow[]
  onChange(rows: EnvRow[]): void
}): ReactElement {
  const patch = (index: number, patchRow: Partial<EnvRow>): void => {
    props.onChange(props.rows.map((row, at) => (at === index ? { ...row, ...patchRow } : row)))
  }

  return (
    <>
      {props.rows.map((row, index) => (
        <div key={index} className="cc-env-row">
          <input
            className="cc-env-key"
            value={row.key}
            placeholder="变量名"
            onChange={event => patch(index, { key: event.target.value })}
          />
          <input
            className="cc-env-value"
            value={row.value}
            placeholder="值"
            onChange={event => patch(index, { value: event.target.value })}
          />
          <button
            type="button"
            className="cc-env-drop"
            title="删除"
            onClick={() => props.onChange(props.rows.filter((_, at) => at !== index))}
          >
            ×
          </button>
        </div>
      ))}
      <Button size="sm" onClick={() => props.onChange([...props.rows, { key: '', value: '' }])}>
        ＋ 添加变量
      </Button>
    </>
  )
}
