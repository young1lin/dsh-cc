/**
 * The session rail: new-session entry, the session list with inline rename and
 * delete, and the connection footer.
 *
 * @module dsh-cc/client/SessionRail
 */

import { useEffect, useState, type ReactElement } from 'react'
import {
  Button,
  IconFolderClose16,
  IconFolderOpen16,
  IconPlusOutline16,
  IconTriangleRightFill14,
  Input,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { DirectoryPicker } from './DirectoryPicker.tsx'
import { registerCss } from './css.ts'
import type { ConfigSummary, SessionMeta } from '../types.ts'

registerCss('session-rail', `
.cc-new-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.cc-new-form .cc-row > span:first-child { flex: 1; }
`)

/** The model choices offered when creating a session. */
const MODEL_CHOICES: { value: string; label: string }[] = [
  { value: '', label: '默认（跟随配置）' },
  { value: 'opus', label: 'opus' },
  { value: 'sonnet', label: 'sonnet' },
  { value: 'haiku', label: 'haiku' },
]

/** One project directory and the sessions that ran in it, in list order. */
interface SessionGroup {
  cwd: string
  sessions: SessionMeta[]
}

/**
 * Bucket the newest-first session list by project directory.
 *
 * The catalog list arrives globally sorted by update time, so taking groups
 * in first-appearance order makes the most recently used project come first,
 * and pushing sessions in arrival order keeps each group newest-first too —
 * no re-sorting anywhere.
 * @param sessions - the merged catalog list, newest first.
 * @returns the groups, most recently used first.
 */
function groupByProject(sessions: SessionMeta[]): SessionGroup[] {
  const groups: SessionGroup[] = []
  const byCwd = new Map<string, SessionGroup>()
  for (const session of sessions) {
    const cwd = session.cwd.trim()
    let group = byCwd.get(cwd)
    if (group === undefined) {
      group = { cwd, sessions: [] }
      byCwd.set(cwd, group)
      groups.push(group)
    }
    group.sessions.push(session)
  }
  return groups
}

/**
 * Short label for a project group: the directory's final path segment, with
 * the full path kept on the header's tooltip. Sessions that never ran a turn
 * carry no cwd and label as unclassified.
 * @param cwd - the group's working directory, possibly empty.
 * @returns the label.
 */
function groupLabel(cwd: string): string {
  if (cwd.length === 0) return '未分类'
  const segments = cwd.split(/[\\/]/).filter(segment => segment.length > 0)
  return segments[segments.length - 1] ?? cwd
}

/**
 * Map a session's lifecycle to the host's four-state dot.
 * @param status - the session status.
 * @returns the dot state.
 */
function dotState(status: SessionMeta['status']): 'done' | 'ongoing' | 'error' {
  if (status === 'busy') return 'ongoing'
  if (status === 'error') return 'error'
  return 'done'
}

/**
 * Render one session row with inline rename.
 * @param props - the session, its selected state, and row callbacks.
 * @returns the row node.
 */
function SessionRow(props: {
  session: SessionMeta
  active: boolean
  onSelect(): void
  onDelete(): void
  onRename(name: string): void
}): ReactElement {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(props.session.name)

  const commit = (): void => {
    const name = draft.trim()
    if (name.length > 0 && name !== props.session.name) props.onRename(name)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="cc-session" data-active={props.active}>
        <StateDot state={dotState(props.session.status)} />
        <Input
          value={draft}
          autoFocus
          onChange={event => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={event => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') {
              event.stopPropagation()
              setDraft(props.session.name)
              setEditing(false)
            }
          }}
        />
      </div>
    )
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className="cc-session"
      data-active={props.active}
      title={props.session.terminalOwned === true ? '正由终端进程使用，网页端只读' : undefined}
      onClick={props.onSelect}
      onKeyDown={event => {
        if (event.key === 'Enter') props.onSelect()
      }}
      onDoubleClick={() => {
        setDraft(props.session.name)
        setEditing(true)
      }}
    >
      <StateDot state={dotState(props.session.status)} />
      <span className="cc-session-name" title={props.session.name}>{props.session.name}</span>
      <span className="cc-session-time">{props.session.updatedAt.slice(5, 16).replace('T', ' ')}</span>
      <button
        type="button"
        className="cc-session-action"
        title="重命名"
        onClick={event => {
          event.stopPropagation()
          setDraft(props.session.name)
          setEditing(true)
        }}
      >
        ✎
      </button>
      <button
        type="button"
        className="cc-session-action"
        data-danger="true"
        title="删除会话"
        onClick={event => {
          event.stopPropagation()
          props.onDelete()
        }}
      >
        ×
      </button>
    </div>
  )
}

/**
 * One project directory's collapsible section of the session list.
 *
 * Opens by default only when it holds the selected session (or when it is the
 * most recently used group and nothing is selected), so a long catalog shows
 * its structure instead of 200 rows. A selection that later moves into the
 * group — a newly created session, a resume — re-reveals it; a deliberate
 * manual collapse is still respected until that happens.
 *
 * The header row mirrors the host workspace browser's project row (figma cell
 * set 14:3080): folder glyph that swaps to a rotating chevron on hover, the
 * directory's title, and hover-revealed row actions — here the create button,
 * which starts a session directly in this directory.
 * @param props - the group, the selected session id, whether the group is the
 *   default-open one, and the row plus create callbacks.
 * @returns the section node.
 */
function ProjectGroup(props: {
  group: SessionGroup
  currentId: string | undefined
  defaultOpen: boolean
  onSelect(id: string): void
  onDelete(id: string): void
  onRename(id: string, name: string): void
  onCreate(form: { name?: string; cwd?: string; model?: string }): void
}): ReactElement {
  const containsCurrent =
    props.currentId !== undefined && props.group.sessions.some(session => session.id === props.currentId)
  const [open, setOpen] = useState(containsCurrent || props.defaultOpen)

  useEffect(() => {
    if (containsCurrent) setOpen(true)
  }, [containsCurrent])

  return (
    <div className="cc-group">
      <div
        className="cc-project-row"
        role="treeitem"
        aria-expanded={open}
        title={props.group.cwd.length > 0 ? props.group.cwd : '尚未运行过回合的会话，没有记录工作目录'}
        onClick={() => setOpen(value => !value)}
      >
        <span className="cc-slot cc-folder" data-active={open && containsCurrent}>
          {open ? <IconFolderOpen16 /> : <IconFolderClose16 />}
        </span>
        <span className="cc-slot cc-chevron">
          <IconTriangleRightFill14 />
        </span>
        <span className="cc-project-text">
          <span className="cc-title">{groupLabel(props.group.cwd)}</span>
        </span>
        {props.group.cwd.length > 0 && (
          <span className="cc-row-actions">
            <button
              type="button"
              className="cc-icon-button"
              aria-label={`在 ${groupLabel(props.group.cwd)} 新建会话`}
              title={`在此目录新建会话：${props.group.cwd}`}
              onClick={event => {
                event.stopPropagation()
                props.onCreate({ cwd: props.group.cwd })
              }}
            >
              <IconPlusOutline16 />
            </button>
          </span>
        )}
      </div>
      {open && props.group.sessions.map(session => (
        <SessionRow
          key={session.id}
          session={session}
          active={session.id === props.currentId}
          onSelect={() => props.onSelect(session.id)}
          onDelete={() => props.onDelete(session.id)}
          onRename={name => props.onRename(session.id, name)}
        />
      ))}
    </div>
  )
}

/**
 * The new-session form; shown inline under the rail head.
 * @param props - the effective config for defaults, plus submit and cancel.
 * @returns the form node.
 */
function NewSessionForm(props: {
  config: ConfigSummary | undefined
  onCancel(): void
  onCreate(form: { name?: string; cwd?: string; model?: string }): void
}): ReactElement {
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState(props.config?.defaultCwd ?? '')
  const [model, setModel] = useState('')
  const [picking, setPicking] = useState(false)

  return (
    <div className="cc-new-form">
      <label className="cc-field">
        名称（可选）
        <Input value={name} placeholder="默认按时间命名" onChange={event => setName(event.target.value)} />
      </label>
      <div className="cc-field">
        工作目录
        <div className="cc-row">
          <Input value={cwd} placeholder={props.config?.defaultCwd} onChange={event => setCwd(event.target.value)} />
          <Button size="sm" onClick={() => setPicking(true)}>浏览…</Button>
        </div>
      </div>
      <label className="cc-field">
        模型
        <select value={model} onChange={event => setModel(event.target.value)}>
          {MODEL_CHOICES.map(choice => (
            <option key={choice.value} value={choice.value}>{choice.label}</option>
          ))}
        </select>
      </label>
      <div className="cc-row">
        <Button
          variant="primary"
          size="sm"
          onClick={() => props.onCreate({
            name: name || undefined,
            cwd: cwd || undefined,
            model: model || undefined,
          })}
        >
          创建
        </Button>
        <Button size="sm" onClick={props.onCancel}>取消</Button>
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
    </div>
  )
}

/**
 * The complete rail.
 * @param props - session list state, connection state, and rail callbacks.
 * @returns the rail node.
 */
export function SessionRail(props: {
  sessions: SessionMeta[]
  currentId: string | undefined
  config: ConfigSummary | undefined
  connected: boolean
  onSelect(id: string): void
  onCreate(form: { name?: string; cwd?: string; model?: string }): void
  onDelete(id: string): void
  onRename(id: string, name: string): void
  onOpenSettings(): void
}): ReactElement {
  const [creating, setCreating] = useState(false)

  return (
    <aside className="cc-rail">
      <div className="cc-rail-head">
        <Button variant="primary" style={{ width: '100%' }} onClick={() => setCreating(value => !value)}>
          ＋ 新会话
        </Button>
      </div>
      {creating && (
        <NewSessionForm
          config={props.config}
          onCancel={() => setCreating(false)}
          onCreate={form => {
            props.onCreate(form)
            setCreating(false)
          }}
        />
      )}
      <div className="cc-rail-list">
        {groupByProject(props.sessions).map((group, index) => (
          <ProjectGroup
            key={group.cwd}
            group={group}
            currentId={props.currentId}
            defaultOpen={index === 0}
            onSelect={props.onSelect}
            onDelete={props.onDelete}
            onRename={props.onRename}
            onCreate={props.onCreate}
          />
        ))}
        {props.sessions.length === 0 && !creating && <div className="cc-empty">暂无会话</div>}
      </div>
      <div className="cc-rail-foot">
        <StateDot state={props.connected ? 'done' : 'warning'} />
        <span>{props.connected ? '已连接' : '连接中…'}</span>
        <span className="cc-spacer" />
        <Button size="sm" onClick={props.onOpenSettings}>设置</Button>
      </div>
    </aside>
  )
}
