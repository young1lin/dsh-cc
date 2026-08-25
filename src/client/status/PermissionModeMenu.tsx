/**
 * Permission-posture picker for the status strip: the six CLI modes plus a
 * reset-to-global entry, hot-switched on a busy process and persisted as the
 * session's own default — the same lifecycle the model picker follows.
 *
 * @module dsh-cc/client/status/PermissionModeMenu
 */

import { useState, type ReactElement } from 'react'
import { IconChevronDownOutline14, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { setPermissionMode } from '../api/telemetry.ts'
import { PERMISSION_MODE_VALUES, type PermissionModeValue } from '../../types.ts'
import { registerCss } from '../css.ts'

// No picker CSS of our own: `.cc-status-picker` / `.cc-status-failure` are
// registered by `status-model-menu`, and ModelMenu always co-mounts in the
// same strip, so the classes exist wherever this menu renders.
registerCss('status-permission-menu', `
/* Rows stack a bold label over the one-line hint, like the model menu's rows. */
.cc-mode-row { display: flex; flex-direction: column; gap: 1px; min-width: 0; padding: 2px 0; }
.cc-mode-label { font: var(--dsw-font-xs-13); }
.cc-mode-hint { font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-tertiary); }
`)

/** Chinese label and one-line explanation for each posture. */
const MODE_META: Record<PermissionModeValue, { label: string; hint: string }> = {
  default: { label: '默认', hint: '危险操作每次询问' },
  acceptEdits: { label: '接受编辑', hint: '自动允许文件编辑' },
  plan: { label: '计划模式', hint: '先规划，不实际执行工具' },
  dontAsk: { label: '免打扰', hint: '不询问，未预先批准则拒绝' },
  bypassPermissions: { label: '跳过全部确认', hint: '自动允许一切，仅在可信目录使用' },
  auto: { label: '自动', hint: '由模型分类器决定允许与否' },
}

/**
 * One mode's stacked menu-row label.
 * @param value - the posture to label.
 * @returns the label node for this mode's menu entry.
 */
function modeLabel(value: PermissionModeValue): ReactElement {
  return (
    <span className="cc-mode-row">
      <span className="cc-mode-label">{MODE_META[value].label}</span>
      <span className="cc-mode-hint">{MODE_META[value].hint}</span>
    </span>
  )
}

/**
 * Render the permission-posture picker.
 * @param props.sessionId - the session whose posture to mutate.
 * @param props.sessionMode - the session's own override; '' follows the global default.
 * @param props.configMode - the global default posture, shown when the session has no override.
 * @returns the picker control.
 */
export function PermissionModeMenu(props: { sessionId: string; sessionMode: string; configMode: string }): ReactElement {
  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | undefined>()
  const [mode, setMode] = useState(props.sessionMode)
  // Switching sessions must not leave the previous session's override on screen.
  const [lastSession, setLastSession] = useState(props.sessionId)
  if (lastSession !== props.sessionId) {
    setLastSession(props.sessionId)
    setMode(props.sessionMode)
  }
  const current = mode !== '' ? mode : props.configMode
  const labelText = `权限：${MODE_META[current as PermissionModeValue]?.label ?? current}`
  const items: MenuEntry[] = [
    { id: '', label: '跟随全局默认' },
    ...PERMISSION_MODE_VALUES.map(value => ({ id: value, label: modeLabel(value) })),
  ]
  return (
    <>
      <Menu
        open={open}
        anchor={
          <button
            type="button"
            className="cc-status-picker"
            title="权限模式（忙碌回合就地切换）"
            onClick={() => { setOpen(previous => !previous) }}
          >
            <span className="cc-status-picker-label">{labelText}</span>
            <IconChevronDownOutline14 />
          </button>
        }
        items={items}
        selectedId={mode}
        onSelect={id => {
          setOpen(false)
          const previousMode = mode
          setMode(id)
          setFailure(undefined)
          void setPermissionMode(props.sessionId, id).catch((cause: unknown) => {
            setMode(previousMode)
            setFailure(cause instanceof Error ? cause.message : String(cause))
          })
        }}
        onClose={() => { setOpen(false) }}
      />
      {failure !== undefined && <span className="cc-status-failure" role="status" title={failure}>切换失败</span>}
    </>
  )
}
