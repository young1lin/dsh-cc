/**
 * The bottom task panel: every task the session's CLI process is running —
 * subagents, backgrounded commands, monitors, workflows — as snapshot rows
 * off the `tasks` SSE frame, with stop and background controls.
 *
 * @module dsh-cc/client/TaskPanel
 */

import { useState, type ReactElement } from 'react'
import { Button, DisclosureRow, IconCheckOutline14, IconQueueOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { registerCss } from './css.ts'
import { compact } from './status/format.ts'
import type { TaskRow } from '../types.ts'

registerCss('task-panel', `
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
 * Render the task panel; nothing at all when the table is empty.
 * @param props.tasks - the session's task snapshot.
 * @param props.onStop - stop one task by id.
 * @param props.onBackground - background one task by id.
 * @returns the panel, or null.
 */
export function TaskPanel(props: { tasks: TaskRow[]; onStop(id: string): void; onBackground(id: string): void }): ReactElement | null {
  const [open, setOpen] = useState(true)
  const [expanded, setExpanded] = useState<string | undefined>()
  if (props.tasks.length === 0) return null
  const running = props.tasks.filter(task => task.status === 'running' || task.status === 'paused').length
  return (
    <div className="cc-tasks">
      <DisclosureRow
        icon={<IconQueueOutline14 />}
        titleClassName="cc-tasks-title"
        title={`任务（${running} 运行中 / ${props.tasks.length}）`}
        open={open}
        expandable
        expandOnRowClick
        onToggle={() => setOpen(value => !value)}
      >
        <div className="cc-tasks-body">
          {props.tasks.map(task => {
            const terminal = task.status !== 'running' && task.status !== 'paused'
            const detail = expanded === task.id
            return (
              <div key={task.id}>
                <div
                  className="cc-task-row"
                  data-terminal={terminal}
                  title="点击展开详情"
                  onClick={() => { setExpanded(previous => previous === task.id ? undefined : task.id) }}
                >
                  <span aria-hidden>{glyphFor(task.status)}</span>
                  <span className="cc-task-badge">{badgeFor(task)}</span>
                  <span className="cc-task-desc">{task.description}</span>
                  <span className="cc-task-meta">
                    {compact(task.tokens)} · {duration(task.durationMs)}
                    {task.lastToolName !== undefined ? ` · ${task.lastToolName}` : ''}
                  </span>
                  {!terminal && (
                    <span className="cc-task-actions">
                      <Button size="sm" onClick={event => {
                        event.stopPropagation()
                        props.onBackground(task.id)
                      }}>转后台</Button>
                      <Button size="sm" onClick={event => {
                        event.stopPropagation()
                        props.onStop(task.id)
                      }}>结束</Button>
                    </span>
                  )}
                </div>
                {detail && (
                  <div className="cc-task-detail">
                    {task.prompt !== undefined && task.prompt !== '' && (
                      <div className="cc-task-detail-line" title={task.prompt}>任务：{task.prompt}</div>
                    )}
                    {task.summary !== undefined && task.summary !== '' && (
                      <div className="cc-task-detail-line">摘要：{task.summary}</div>
                    )}
                    {task.error !== undefined && task.error !== '' && (
                      <div className="cc-task-detail-line">错误：{task.error}</div>
                    )}
                    <div className="cc-task-detail-line">
                      工具调用 {task.toolUses} 次 · 状态 {task.status}
                      {task.isBackgrounded === true ? ' · 已转后台' : ''}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </DisclosureRow>
    </div>
  )
}
