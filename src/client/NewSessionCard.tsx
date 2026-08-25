/**
 * The new-session card: a compact fixed-position popover collecting a working
 * directory and a model, replacing the old inline rail form.
 *
 * The card is portaled to document.body and positioned from the anchor's
 * rect (below it, or to its right against the collapsed strip). Its z-index
 * sits between the host's stacking bands — above the shell overlay layer
 * (z 20) that carries the surface itself, below the host modal (z 1000) and
 * menu (z 1100) portals the card opens, which is exactly the hierarchy
 * wanted: card over the page, directory picker over the card, model menu
 * over both.
 *
 * @module dsh-cc/client/NewSessionCard
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import {
  Button, IconChevronDownOutline14, Input, Menu, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { DirectoryPicker } from './DirectoryPicker.tsx'
import { registerCss } from './css.ts'
import { useOverlay } from './overlay.ts'
import { modelLabel } from './status/ModelMenu.tsx'
import { fetchGlobalModels, type ModelRow } from './api/telemetry.ts'
import type { ConfigSummary } from '../types.ts'

registerCss('new-session-card', `
.cc-new-card {
  position: fixed;
  left: 0;
  top: 0;
  /* Above the host shell overlay layer (z 20), below host modal (1000) and
     menu (1100) portals — see the module comment. */
  z-index: 30;
  width: 300px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-shadow-lv1);
  animation: cc-card-in 120ms var(--ds-ease-in-out);
}

@keyframes cc-card-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }

@media (prefers-reduced-motion: reduce) { .cc-new-card { animation: none; } }

.cc-new-card-head { display: flex; align-items: center; gap: 8px; }

.cc-new-card-head strong { flex: 1; font: var(--dsw-font-s-strong-14); }

.cc-new-card .cc-row > *:first-child { flex: 1; min-width: 0; }

/* Model trigger: same posture as the status strip's picker so the two read as
   one control. */
.cc-new-model-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 5px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 7px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xs-13);
  cursor: pointer;
}

.cc-new-model-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }

.cc-new-model-trigger svg { flex: none; color: var(--dsw-alias-label-tertiary); }

.cc-new-card-hint {
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-caption);
  user-select: none;
}
`)

/**
 * The new-session popover card.
 * @param props.anchor - the element the card is positioned against.
 * @param props.side - open below the anchor (`below`, default) or to its
 *   right (`right`, for the collapsed strip).
 * @param props.config - the effective config, for the default cwd.
 * @param props.onCancel - close without creating.
 * @param props.onCreate - create with the collected form.
 * @returns the card, portaled to document.body.
 */
export function NewSessionCard(props: {
  anchor: HTMLElement | null
  side?: 'below' | 'right'
  config: ConfigSummary | undefined
  onCancel(): void
  onCreate(form: { cwd?: string; model?: string }): void
}): ReactElement {
  const [cwd, setCwd] = useState(props.config?.defaultCwd ?? '')
  const [model, setModel] = useState('')
  const [rows, setRows] = useState<ModelRow[]>([])
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  /** Placement measured from the anchor rect; hidden until the first measure. */
  const [pos, setPos] = useState<{ left: number; top: number } | undefined>(undefined)
  // The card is a floating layer: its Escape closes the card only, never the
  // surface underneath (see ./overlay.ts).
  useOverlay(true)

  // The global catalog is cached server-side; one read per card open.
  useEffect(() => {
    let stale = false
    fetchGlobalModels()
      .then(result => {
        if (!stale) setRows(result.models)
      })
      .catch(() => {
        // The picker keeps its default entry; the status strip's catalog is
        // the same data if the user wants to switch after the first turn.
      })
    return () => {
      stale = true
    }
  }, [])

  useLayoutEffect(() => {
    const anchor = props.anchor
    const card = cardRef.current
    if (anchor === null || card === null) return
    const rect = anchor.getBoundingClientRect()
    const width = card.offsetWidth
    const height = card.offsetHeight
    let left = props.side === 'right' ? rect.right + 8 : rect.left
    let top = props.side === 'right' ? rect.top : rect.bottom + 6
    left = Math.min(Math.max(12, left), Math.max(12, window.innerWidth - width - 12))
    if (top + height > window.innerHeight - 12) top = Math.max(12, rect.top - height - 6)
    setPos({ left, top })
  }, [props.anchor, props.side])

  // A pointer press outside the card dismisses it — unless it lands in a
  // layer the card itself opened (the model menu portal, the directory
  // picker) or on the anchor, whose own click toggles the card.
  useEffect(() => {
    const onDown = (event: PointerEvent): void => {
      if (picking || modelMenuOpen) return
      const target = event.target
      if (target instanceof Node && cardRef.current?.contains(target)) return
      if (target instanceof Node && props.anchor?.contains(target)) return
      if (target instanceof Element && target.closest('[role="menu"]') !== null) return
      props.onCancel()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [props.anchor, props.onCancel, picking, modelMenuOpen])

  const loaded = rows.length > 0
  const modelItems: MenuEntry[] = [
    { id: '', label: '默认（跟随配置）' },
    ...rows.map(row => ({ id: row.value, label: modelLabel(row) })),
  ]
  const selectedRow = rows.find(row => row.value === model)
  const modelText = selectedRow?.displayName ?? (model !== '' ? model : '默认（跟随配置）')

  return createPortal(
    <div
      ref={cardRef}
      className="cc-new-card"
      style={pos === undefined ? { visibility: 'hidden' } : { left: `${pos.left}px`, top: `${pos.top}px` }}
      onKeyDown={event => {
        if (event.key !== 'Escape') return
        // The Escape of an IME composition belongs to the input, not the card.
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        // An inner layer (model menu, directory picker) takes the key first;
        // its own handler closes just that layer.
        if (picking || modelMenuOpen) return
        props.onCancel()
      }}
    >
      <div className="cc-new-card-head">
        <strong>新建会话</strong>
        <button
          type="button"
          className="cc-session-action"
          title="关闭"
          style={{ opacity: 1 }}
          onClick={props.onCancel}
        >
          ×
        </button>
      </div>
      <div className="cc-field">
        工作目录
        <div className="cc-row">
          <Input value={cwd} autoFocus placeholder={props.config?.defaultCwd} onChange={event => setCwd(event.target.value)} />
          <Button size="sm" onClick={() => setPicking(true)}>浏览…</Button>
        </div>
      </div>
      <div className="cc-field">
        模型
        <Menu
          open={modelMenuOpen}
          portal
          anchor={
            <button
              type="button"
              className="cc-new-model-trigger"
              title="选择新会话的模型"
              onClick={() => { setModelMenuOpen(previous => !previous) }}
            >
              <span className="cc-status-picker-label">{modelText}</span>
              <IconChevronDownOutline14 />
            </button>
          }
          items={loaded ? modelItems : [{ type: 'label', id: 'loading', text: '正在获取模型列表…' }]}
          selectedId={model}
          onSelect={id => {
            setModel(id)
            setModelMenuOpen(false)
          }}
          onClose={() => { setModelMenuOpen(false) }}
        />
      </div>
      <div className="cc-row">
        <Button
          variant="primary"
          size="sm"
          onClick={() => props.onCreate({ cwd: cwd || undefined, model: model || undefined })}
        >
          创建
        </Button>
        <Button size="sm" onClick={props.onCancel}>取消</Button>
        <span className="cc-spacer" />
        <span className="cc-new-card-hint">Esc 关闭</span>
      </div>
      {picking && (
        <DirectoryPicker
          initial={cwd}
          onCancel={() => setPicking(false)}
          onPick={picked => {
            setCwd(picked)
            setPicking(false)
          }}
        />
      )}
    </div>,
    document.body,
  )
}
