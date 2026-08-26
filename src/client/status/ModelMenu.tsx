/**
 * Model and reasoning-effort pickers for the status strip, backed by the
 * session's live CLI model catalog.
 *
 * A gateway account's catalog can list several aliases that all resolve to
 * the same underlying model (e.g. `opus` and `sonnet` both pointing at one
 * GLM deployment, alongside the exact model id as its own row) — the CLI
 * gives them the same `displayName` in that case, so each row's label always
 * leads with the alias itself and only appends "→ resolved" when picking that
 * alias would not obviously tell you what it runs. Effort levels are read
 * from the selected row's own `supportedEffortLevels`, never a fixed list.
 *
 * @module dsh-cc/client/status/ModelMenu
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { IconChevronDownOutline14, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { fetchModels, setEffort, setModel, type ModelRow } from '../api/telemetry.ts'
import { DEFAULT_EFFORT_LEVELS } from '../../types.ts'
import { registerCss } from '../css.ts'

registerCss('status-model-menu', `
.cc-status-picker {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 220px;
  padding: 2px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 7px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xxs-12);
  cursor: pointer;
}

.cc-status-picker:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }

.cc-status-picker:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}

.cc-status-picker-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cc-status-picker svg { flex: none; color: var(--dsw-alias-label-tertiary); }

/* Model menu row: the alias first, what it resolves to only when that adds
   information, then the CLI's own description — three independently
   truncated lines so a long value on one never crowds the others out. */
.cc-model-row { display: flex; flex-direction: column; gap: 1px; min-width: 0; padding: 2px 0; }

.cc-model-alias,
.cc-model-resolved,
.cc-model-desc {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cc-model-alias { font: var(--dsw-font-xs-13); }
.cc-model-resolved,
.cc-model-desc { font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-tertiary); }

/* One-line switch failure beside the pickers; auto-clears after a moment. */
.cc-status-failure {
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-state-error-primary);
}
`)

/** The live catalog plus the session's current model and effort selections. */
interface Catalog {
  rows: ModelRow[]
  current: string
  effort: string
}

const EMPTY_CATALOG: Catalog = { rows: [], current: '', effort: '' }

/**
 * Build one model row's menu label: the alias/value first (bold), then what
 * it actually resolves to only when that is not already obvious from the
 * alias, then the CLI's description.
 * @param row - the catalog row.
 * @returns the label node for this row's menu entry.
 */
export function modelLabel(row: ModelRow): ReactElement {
  const resolved = row.resolvedModel
  const showsResolved = resolved !== undefined && resolved !== row.value
  return (
    <span className="cc-model-row">
      <span className="cc-model-alias">{row.value}</span>
      {showsResolved && <span className="cc-model-resolved">→ {resolved}</span>}
      {row.description !== undefined && row.description !== '' && (
        <span className="cc-model-desc">{row.description}</span>
      )}
    </span>
  )
}

/**
 * Render the model and effort pickers.
 * @param props.sessionId - the session whose catalog to fetch and mutate.
 * @param props.busy - whether a turn is running on this session.
 * @returns the two picker controls.
 */
export function ModelMenu(props: { sessionId: string; busy: boolean }): ReactElement {
  const [catalog, setCatalog] = useState<Catalog>(EMPTY_CATALOG)
  const [openMenu, setOpenMenu] = useState<'model' | 'effort' | null>(null)
  /** Bumped to re-read the catalog; see the turn-start effect below. */
  const [reload, setReload] = useState(0)
  const [failure, setFailure] = useState<string | undefined>()
  const wasBusy = useRef(false)
  const failureTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => () => clearTimeout(failureTimer.current), [])

  /**
   * Show the one-line switch failure and clear it again after a moment, so
   * the strip does not carry a stale error into the next turn.
   * @param detail - the underlying rejection, kept off the visible line (it
   *   is transport text, not product copy) but available on the tooltip.
   */
  const showFailure = (detail: string): void => {
    setFailure(detail)
    clearTimeout(failureTimer.current)
    failureTimer.current = setTimeout(() => setFailure(undefined), 4000)
  }

  // Switching sessions must not leave the previous session's selection on
  // screen while the new catalog loads. A reload of the SAME session keeps
  // what is already there, so the picker never blinks mid-turn.
  useEffect(() => {
    setCatalog(EMPTY_CATALOG)
  }, [props.sessionId])

  // A cold session can only be answered with the static aliases: the real
  // catalog — the gateway's own rows and their effort ladders — exists only
  // while a CLI process does, and the first message is what starts one. The
  // rising edge alone triggers the re-read; keying off `busy` itself would
  // spend a second control-channel round trip when the turn ends.
  useEffect(() => {
    const started = props.busy && !wasBusy.current
    wasBusy.current = props.busy
    if (started) setReload(value => value + 1)
  }, [props.busy])

  useEffect(() => {
    let stale = false
    fetchModels(props.sessionId)
      .then(result => {
        if (stale) return
        setCatalog({ rows: result.models, current: result.current, effort: result.effort ?? '' })
      })
      .catch(() => {
        // A cold session has no catalog yet; the pickers stay disabled until one starts.
      })
    return () => {
      stale = true
    }
  }, [props.sessionId, reload])

  const loaded = catalog.rows.length > 0
  const selectedRow = catalog.rows.find(row => row.value === catalog.current)
  // The catalog's effort opinion is advisory: a custom gateway model has no
  // matching row at all, and unknown rows carry no levels — the standing rule
  // is that every model here accepts the standard ladder, so absence never
  // disables the picker. Only an explicit false from the CLI wins.
  const supportsEffort = selectedRow?.supportsEffort !== false
  const effortLevels = selectedRow?.supportedEffortLevels !== undefined && selectedRow.supportedEffortLevels.length > 0
    ? selectedRow.supportedEffortLevels
    : [...DEFAULT_EFFORT_LEVELS]

  // Item arrays memoized on their inputs: this menu renders inside the status
  // strip, and rebuilding label elements per render showed up as stream-rate
  // churn before the strip was memoized.
  const modelItems = useMemo<MenuEntry[]>(() => [
    { id: '', label: '默认模型' },
    ...catalog.rows.map(row => ({ id: row.value, label: modelLabel(row) })),
  ], [catalog.rows])
  const effortItems = useMemo<MenuEntry[]>(() => [
    { id: '', label: '默认思考档位' },
    ...effortLevels.map(level => ({ id: level, label: level })),
  ], [effortLevels])

  const modelLabelText = selectedRow?.displayName ?? (catalog.current !== '' ? catalog.current : '默认模型')
  const effortLabelText = !loaded ? '…' : supportsEffort ? (catalog.effort !== '' ? catalog.effort : '默认思考档位') : '不支持思考档位'
  // Highlight the row matching the live selection; '' highlights the reset
  // entry when the session is genuinely on the plugin default rather than an
  // alias the catalog doesn't (yet, or no longer) list.
  const modelSelectedId = selectedRow !== undefined ? selectedRow.value : (catalog.current === '' ? '' : undefined)

  return (
    <>
      <Menu
        open={openMenu === 'model'}
        anchor={
          <button
            type="button"
            className="cc-status-picker"
            title="切换模型（对下一回合生效）"
            onClick={() => { setOpenMenu(previous => (previous === 'model' ? null : 'model')) }}
          >
            <span className="cc-status-picker-label">{modelLabelText}</span>
            <IconChevronDownOutline14 />
          </button>
        }
        items={loaded ? modelItems : [{ type: 'label', id: 'empty', text: '暂无可用模型' }]}
        selectedId={modelSelectedId}
        onSelect={id => {
          setOpenMenu(null)
          const previousModel = catalog.current
          setCatalog(previous => ({ ...previous, current: id }))
          setFailure(undefined)
          // The row highlights optimistically; a rejected switch rolls the
          // selection back so the picker never claims a model it lacks.
          void setModel(props.sessionId, id).catch((cause: unknown) => {
            setCatalog(previous => ({ ...previous, current: previousModel }))
            showFailure(cause instanceof Error ? cause.message : String(cause))
          })
        }}
        onClose={() => { setOpenMenu(null) }}
      />
      <Menu
        open={openMenu === 'effort'}
        compact
        anchor={
          <button
            type="button"
            className="cc-status-picker"
            title="思考程度"
            disabled={!loaded || !supportsEffort}
            onClick={() => { setOpenMenu(previous => (previous === 'effort' ? null : 'effort')) }}
          >
            <span className="cc-status-picker-label">{effortLabelText}</span>
            <IconChevronDownOutline14 />
          </button>
        }
        items={effortItems}
        selectedId={catalog.effort}
        onSelect={level => {
          setOpenMenu(null)
          const previousEffort = catalog.effort
          setCatalog(previous => ({ ...previous, effort: level }))
          setFailure(undefined)
          void setEffort(props.sessionId, level).catch((cause: unknown) => {
            setCatalog(previous => ({ ...previous, effort: previousEffort }))
            showFailure(cause instanceof Error ? cause.message : String(cause))
          })
        }}
        onClose={() => { setOpenMenu(null) }}
      />
      {failure !== undefined && (
        <span className="cc-status-failure" role="status" title={failure}>切换失败</span>
      )}
    </>
  )
}
