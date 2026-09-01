/**
 * The bottom task panel: every task the session's CLI process is running —
 * subagents, backgrounded commands, monitors, workflows — as snapshot rows
 * off the `tasks` SSE frame, with stop and background controls.
 *
 * @module dsh-cc/client/TaskPanel
 */

import { useState, memo, type ReactElement } from 'react'
import { Button, DisclosureRow, IconCheckOutline14, IconQueueOutline14, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { registerCss } from './css.ts'
import { compact } from './status/format.ts'
import { useOverlay } from './overlay.ts'
import { SubagentTranscript } from './tool/ToolRow.tsx'
import type { CcEvent, TaskRow } from '../types.ts'

registerCss('task-panel', `
/* 子代理详情弹窗：比默认卡片宽，长转录才有阅读密度。 */
.cc-subagent-modal { width: min(760px, 92vw) !important; max-width: 92vw; }
.cc-tasks { border-top: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); font: var(--dsw-font-xxs-12); padding: 0 20px; }
.cc-tasks-title { color: var(--dsw-alias-label-secondary); }
.cc-tasks-body { padding: 2px 0 8px; }
.cc-task-row { display: flex; align-items: center; gap: 10px; padding: 3px 0; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.cc-task-row[data-terminal='true'] { color: var(--dsw-alias-label-caption); }
.cc-task-badge {
  flex: none; padding: 1px 7px; border-radius: 999px;
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-secondary);
}
.cc-task-desc { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cc-task-meta { flex: none; color: var(--dsw-alias-label-caption); }
.cc-task-actions { flex: none; display: flex; gap: 6px; }
.cc-task-detail { padding: 0 0 4px 22px; display: flex; flex-direction: column; gap: 1px; }
.cc-task-detail-line {
  color: var(--dsw-alias-label-caption);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cc-subagent-dialog-body { display: flex; flex-direction: column; gap: 10px; min-height: 320px; }
.cc-subagent-dialog-meta { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-tertiary); font: var(--dsw-font-xs-13); }
.cc-subagent-dialog-meta .cc-task-badge { font: var(--dsw-font-xxs-12); }
.cc-subagent-dialog-flow { flex: 1; min-height: 200px; max-height: 52vh; padding: 12px 12px 12px 0; overflow: auto; border-radius: 10px; background: var(--dsw-alias-bg-base); }
.cc-subagent-dialog-empty { padding: 24px 12px; text-align: center; color: var(--dsw-alias-label-caption); }
.cc-subagent-dialog-input { min-height: 64px; max-height: 160px; resize: vertical; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: var(--dsw-font-s-14); }
.cc-subagent-dialog-input:focus { outline: none; border-color: var(--dsw-alias-border-l3); }
.cc-subagent-dialog-error { color: var(--dsw-alias-state-error-primary); font: var(--dsw-font-xs-13); }
.cc-task-spin {
  flex: none; width: 12px; height: 12px; border-radius: 50%;
  border: 1.5px solid var(--dsw-alias-label-caption); border-top-color: transparent;
  animation: cc-task-rotate 0.8s linear infinite;
}
@keyframes cc-task-rotate { to { transform: rotate(360deg); } }
`)

/** Chinese badge per task discriminant; unknown types fall back to the raw tag. */
const TYPE_BADGES: Record<string, string> = {
  subagent: '子代理', shell: '命令', bash: '命令', monitor: '监视', workflow: '工作流', task: '任务',
}

/**
 * The row's badge: the subagent preset outranks the raw discriminant.
 * @param row - the task row.
 * @returns the badge text.
 */
function badgeFor(row: TaskRow): string {
  if (row.subagentType !== undefined) return `子代理 ${row.subagentType}`
  return TYPE_BADGES[row.type] ?? row.type
}

/**
 * One task row's glyph.
 * @param status - the row status.
 * @returns the glyph element, or null for terminal-but-unremarkable states.
 */
function glyphFor(status: TaskRow['status']): ReactElement | null {
  if (status === 'completed') return <IconCheckOutline14 />
  if (status === 'running' || status === 'paused') return <span className="cc-task-spin" aria-hidden />
  return null
}

/**
 * Format a running duration.
 * @param ms - the duration in milliseconds.
 * @returns e.g. `1:07`.
 */
function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * The model label a task row shows. A delegation without a model argument
 * inherits the session's current model — say so instead of leaving the field
 * silent, which reads as "unknown". A resolved wire id keeps only its base
 * name (the `[1m]` context suffix is status-bar material, not row material).
 * @param model - the row's model, when known.
 * @returns the display text.
 */
function modelLabel(model: string | undefined): string {
  if (model === undefined || model === '') return '当前模型'
  return model.replace(/\[.*\]$/, '')
}

/** A running subagent's interactive detail layer. */
function SubagentDialog(props: {
  task: TaskRow
  events: Extract<CcEvent, { kind: 'subagent' }>[]
  cwd: string
  onClose(): void
  onMessage(text: string): Promise<void>
}): ReactElement {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const submit = (): void => {
    const body = text.trim()
    if (body === '' || sending) return
    setSending(true)
    setError(undefined)
    void props.onMessage(body).then(() => {
      setText('')
    }).catch(cause => {
      setError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => setSending(false))
  }
  return (
    <Modal
      open
      onClose={props.onClose}
      className="cc-subagent-modal"
      title={`子代理 · ${props.task.description}`}
      closeLabel="关闭"
      footer={(
        <>
          <Button onClick={props.onClose}>关闭</Button>
          <Button variant="primary" disabled={text.trim() === '' || sending} onClick={submit}>
            {sending ? '发送中…' : '发送给子代理'}
          </Button>
        </>
      )}
    >
      <div className="cc-subagent-dialog-body">
        <div className="cc-subagent-dialog-meta">
          <span className="cc-task-badge">{badgeFor(props.task)}</span>
          <span>{props.task.isBackgrounded === true ? '后台运行' : '前台运行'}</span>
          <span>· 模型 {modelLabel(props.task.model)}</span>
          <span>· {duration(props.task.durationMs)}</span>
          {props.task.lastToolName !== undefined && <span>· {props.task.lastToolName}</span>}
        </div>
        <div className="cc-subagent-dialog-flow">
          {props.events.length > 0
            ? <SubagentTranscript events={props.events} cwd={props.cwd} />
            : <div className="cc-subagent-dialog-empty">等待子代理产生内容…</div>}
        </div>
        <textarea
          className="cc-subagent-dialog-input"
          value={text}
          placeholder="继续给这个子代理补充要求（Ctrl+Enter 发送）"
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && event.ctrlKey) {
              event.preventDefault()
              submit()
            }
          }}
        />
        {error !== undefined && <div className="cc-subagent-dialog-error">{error}</div>}
      </div>
    </Modal>
  )
}

/**
 * Render only actionable live work; settled tasks leave the rail immediately.
 * A subagent row opens its own nested transcript and composer.
 */
export const TaskPanel = memo(function TaskPanel(props: {
  tasks: TaskRow[]
  events: CcEvent[]
  cwd: string
  onStop(id: string): void
  onBackground(id: string): void
  onMessage(id: string, text: string): Promise<void>
}): ReactElement | null {
  const [open, setOpen] = useState(true)
  const [expanded, setExpanded] = useState<string | undefined>()
  const [selected, setSelected] = useState<string | undefined>()
  const tasks = props.tasks.filter(task => task.status === 'running' || task.status === 'paused')
  const selectedTask = tasks.find(task => task.id === selected)
  useOverlay(selectedTask !== undefined)
  if (tasks.length === 0) return null
  return (
    <>
      <div className="cc-tasks">
        <DisclosureRow
          icon={<IconQueueOutline14 />}
          titleClassName="cc-tasks-title"
          title={`后台任务（${tasks.length}）`}
          open={open}
          expandable
          expandOnRowClick
          onToggle={() => setOpen(value => !value)}
        >
          <div className="cc-tasks-body">
            {tasks.map(task => {
              const subagent = task.type === 'subagent' || task.subagentType !== undefined
              const detail = expanded === task.id
              return (
                <div key={task.id}>
                  <div
                    className="cc-task-row"
                    title={subagent ? '点击进入子代理' : '点击展开详情'}
                    onClick={() => {
                      if (subagent) setSelected(task.id)
                      else setExpanded(previous => previous === task.id ? undefined : task.id)
                    }}
                  >
                    <span aria-hidden>{glyphFor(task.status)}</span>
                    <span className="cc-task-badge">{badgeFor(task)}</span>
                    <span className="cc-task-desc">{task.description}</span>
                    <span className="cc-task-meta">
                      {subagent && <>模型 {modelLabel(task.model)} · </>}
                      {compact(task.tokens)} · {duration(task.durationMs)}
                      {task.lastToolName !== undefined ? ` · ${task.lastToolName}` : ''}
                    </span>
                    <span className="cc-task-actions">
                      {task.isBackgrounded !== true && (
                        <Button size="sm" onClick={event => {
                          event.stopPropagation()
                          props.onBackground(task.id)
                        }}>转后台</Button>
                      )}
                      <Button size="sm" onClick={event => {
                        event.stopPropagation()
                        props.onStop(task.id)
                      }}>结束</Button>
                    </span>
                  </div>
                  {detail && (
                    <div className="cc-task-detail">
                      {task.prompt !== undefined && task.prompt !== '' && (
                        <div className="cc-task-detail-line" title={task.prompt}>任务：{task.prompt}</div>
                      )}
                      {task.summary !== undefined && task.summary !== '' && (
                        <div className="cc-task-detail-line">摘要：{task.summary}</div>
                      )}
                      <div className="cc-task-detail-line">工具调用 {task.toolUses} 次 · 状态 {task.status}</div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </DisclosureRow>
      </div>
      {selectedTask !== undefined && selectedTask.toolUseId !== undefined && (
        <SubagentDialog
          task={selectedTask}
          cwd={props.cwd}
          events={props.events.filter((event): event is Extract<CcEvent, { kind: 'subagent' }> =>
            event.kind === 'subagent' && event.parentToolUseId === selectedTask.toolUseId)}
          onClose={() => setSelected(undefined)}
          onMessage={text => props.onMessage(selectedTask.id, text)}
        />
      )}
    </>
  )
})
