/**
 * The session rail: new-session entry, session search, the session list with
 * inline rename and delete, the resizable/collapsible chrome, and the
 * connection footer.
 *
 * @module dsh-cc/client/SessionRail
 */

import { useEffect, useMemo, useRef, useState, memo, type ReactElement } from 'react'
import {
  Button,
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconFolderClose16,
  IconFolderOpen16,
  IconPlusOutline16,
  IconSearchOutline16,
  IconTriangleRightFill14,
  Input,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { NewSessionCard } from './NewSessionCard.tsx'
import { useOverlay } from './overlay.ts'
import type { ConfigSummary, SessionMeta } from '../types.ts'

/** localStorage key holding the user's chosen rail width in px. */
const WIDTH_KEY = 'dsh-cc.rail-width'
/** localStorage key holding whether the rail is collapsed to the thin strip. */
const COLLAPSED_KEY = 'dsh-cc.rail-collapsed'
/** Rail width when nothing was ever stored. */
const WIDTH_DEFAULT = 240
/** Narrowest the rail can be dragged. */
const WIDTH_MIN = 180
/** Widest the rail can be dragged. */
const WIDTH_MAX = 480
/** How many px one arrow-key press on the resizer moves. */
const KEY_STEP = 16

/**
 * Clamp a candidate rail width into the draggable range.
 * @param value - the candidate width in px.
 * @returns the clamped width, rounded to whole px.
 */
function clampWidth(value: number): number {
  return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(value)))
}

/**
 * Read the persisted rail width; any missing or malformed entry falls back to
 * the default, and storage failures (sandboxed host) never break the rail.
 * @returns the stored width, clamped.
 */
function readWidth(): number {
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY)
    if (raw === null) return WIDTH_DEFAULT
    const value = Number.parseInt(raw, 10)
    if (!Number.isFinite(value)) return WIDTH_DEFAULT
    return clampWidth(value)
  } catch {
    return WIDTH_DEFAULT
  }
}

/**
 * Read whether the rail was left collapsed to the thin strip.
 * @returns true when collapsed.
 */
function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Persist one preference; storage failures are silently dropped.
 * @param key - the preference key.
 * @param value - the serialized value.
 */
function persist(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage unavailable; the width simply does not survive a reload.
  }
}

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
 * Filter the catalog down to sessions matching a query in their name, working
 * directory, or git branch — the cheap, instantly client-side kind of search.
 * Matching runs against the full cwd path, so a directory's middle segment
 * hits even though the group label shows only the last one.
 * @param sessions - the merged catalog list.
 * @param needle - the lower-cased, trimmed query.
 * @returns the matching sessions, list order (newest first) preserved.
 */
function filterSessions(sessions: SessionMeta[], needle: string): SessionMeta[] {
  return sessions.filter(session =>
    session.name.toLowerCase().includes(needle)
    || session.cwd.toLowerCase().includes(needle)
    || (session.gitBranch ?? '').toLowerCase().includes(needle))
}

/**
 * Render one session row with inline rename.
 * @param props - the session, its selected state, pending-interaction count,
 *   and row callbacks.
 * @returns the row node.
 */
function SessionRow(props: {
  session: SessionMeta
  active: boolean
  /** Permissions or questions waiting on this session, shown as a badge. */
  pending: number
  onSelect(): void
  onDelete(): void
  onRename(name: string): void
}): ReactElement {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(props.session.name)
  // The rename edit is a floating layer: its Escape cancels the edit only,
  // never the surface underneath.
  useOverlay(editing)

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
      {props.pending > 0 && (
        <span className="cc-session-alert" title="有等待处理的权限请求或问题">
          <span className="cc-session-alert-dot" aria-hidden />
          {props.pending > 1 ? props.pending : null}
        </span>
      )}
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
 *   default-open one, pending-interaction counts per session, and the row plus
 *   create callbacks.
 * @returns the section node.
 */
function ProjectGroup(props: {
  group: SessionGroup
  currentId: string | undefined
  defaultOpen: boolean
  /** Pending permissions/questions per session id, for the row badges. */
  pending: Record<string, number>
  onSelect(id: string): void
  onDelete(id: string): void
  onRename(id: string, name: string): void
  onCreate(form: { cwd?: string; model?: string }): void
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
          pending={props.pending[session.id] ?? 0}
          onSelect={() => props.onSelect(session.id)}
          onDelete={() => props.onDelete(session.id)}
          onRename={name => props.onRename(session.id, name)}
        />
      ))}
    </div>
  )
}

/**
 * The complete rail.
 * @param props - session list state, connection state, pending-interaction
 *   counts per session, and rail callbacks.
 * @returns the rail node.
 */
export const SessionRail = memo(function SessionRail(props: {
  sessions: SessionMeta[]
  currentId: string | undefined
  config: ConfigSummary | undefined
  connected: boolean
  /** Pending permissions/questions per session id, for the row badges. */
  pending: Record<string, number>
  onSelect(id: string): void
  onCreate(form: { cwd?: string; model?: string }): void
  onDelete(id: string): void
  onRename(id: string, name: string): void
  onOpenSettings(): void
}): ReactElement {
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const [width, setWidth] = useState(readWidth)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  /** Mirror of the drag target, so the pointerup handler persists the last value. */
  const widthRef = useRef(width)
  /** The ＋ control the new-session card anchors against, expanded or thin. */
  const plusRef = useRef<HTMLSpanElement>(null)
  // A search in progress holds one Escape: the key clears the query first and
  // only then reaches the surface close.
  useOverlay(query.trim().length > 0)
  useEffect(() => {
    widthRef.current = width
  }, [width])

  const needle = query.trim().toLowerCase()
  const searching = needle.length > 0
  const matched = searching ? filterSessions(props.sessions, needle) : []
  // Grouped once per sessions identity: the parent memoizes on props, and a
  // fresh array per render would reconcile every project group anyway.
  const groups = useMemo(() => groupByProject(props.sessions), [props.sessions])
  /** Total pending interactions across every session, for the thin strip. */
  const totalPending = Object.values(props.pending).reduce((sum, count) => sum + count, 0)

  /**
   * Begin a width drag from the rail's right edge: window-level move/up
   * listeners with the initial press as the origin, and a body class that
   * suppresses text selection and keeps the resize cursor for the drag.
   * @param event - the press on the resize handle.
   */
  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!event.isPrimary) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = widthRef.current
    document.body.classList.add('cc-resizing')
    const onMove = (move: PointerEvent): void => {
      const next = clampWidth(startWidth + move.clientX - startX)
      widthRef.current = next
      setWidth(next)
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      document.body.classList.remove('cc-resizing')
      persist(WIDTH_KEY, String(widthRef.current))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  /** Expand back to the remembered width. */
  const expand = (): void => {
    setCollapsed(false)
    persist(COLLAPSED_KEY, '0')
  }

  const newCard = creating
    ? (
        <NewSessionCard
          anchor={plusRef.current}
          side={collapsed ? 'right' : 'below'}
          config={props.config}
          onCancel={() => setCreating(false)}
          onCreate={form => {
            props.onCreate(form)
            setCreating(false)
          }}
        />
      )
    : undefined

  if (collapsed) {
    return (
      <aside className="cc-rail-thin">
        <div className="cc-thin-col">
          <span className="cc-new-anchor" ref={plusRef}>
            <button
              type="button"
              className="cc-thin-button"
              title="新建会话"
              onClick={() => setCreating(true)}
            >
              <IconPlusOutline16 />
            </button>
          </span>
          <button
            type="button"
            className="cc-thin-button"
            title="展开侧栏"
            onClick={expand}
          >
            <IconChevronRightOutline14 />
          </button>
        </div>
        <div className="cc-thin-spacer" />
        <div className="cc-thin-foot">
          {totalPending > 0 && (
            <span className="cc-session-alert" title="有等待处理的权限请求或问题">
              <span className="cc-session-alert-dot" aria-hidden />
              {totalPending > 1 ? totalPending : null}
            </span>
          )}
          <StateDot state={props.connected ? 'done' : 'warning'} />
        </div>
        {newCard}
      </aside>
    )
  }

  return (
    <aside className="cc-rail" style={{ width: `${width}px` }}>
      <div className="cc-rail-head">
        <div className="cc-rail-actions">
          <span className="cc-new-anchor" ref={plusRef}>
            <Button variant="primary" style={{ width: '100%' }} onClick={() => setCreating(value => !value)}>
              ＋ 新会话
            </Button>
          </span>
          <button
            type="button"
            className="cc-rail-collapse"
            title="收起侧栏"
            onClick={() => {
              setCollapsed(true)
              persist(COLLAPSED_KEY, '1')
            }}
          >
            <IconChevronLeftOutline14 />
          </button>
        </div>
        <Input
          icon={<IconSearchOutline16 />}
          value={query}
          placeholder="搜索会话（名称 / 目录 / 分支）"
          title="按名称、工作目录或 git 分支过滤会话"
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Escape') return
            // The Escape of an IME composition belongs to the input.
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
            setQuery('')
          }}
        />
      </div>
      <div className="cc-rail-list">
        {searching ? (
          matched.length === 0
            ? <div className="cc-empty">没有匹配的会话</div>
            : (
              <>
                <div className="cc-search-count">{matched.length} 个会话</div>
                {matched.map(session => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    active={session.id === props.currentId}
                    pending={props.pending[session.id] ?? 0}
                    onSelect={() => props.onSelect(session.id)}
                    onDelete={() => props.onDelete(session.id)}
                    onRename={name => props.onRename(session.id, name)}
                  />
                ))}
              </>
            )
        ) : (
          groups.map((group, index) => (
            <ProjectGroup
              key={group.cwd}
              group={group}
              currentId={props.currentId}
              defaultOpen={index === 0}
              pending={props.pending}
              onSelect={props.onSelect}
              onDelete={props.onDelete}
              onRename={props.onRename}
              onCreate={props.onCreate}
            />
          ))
        )}
        {props.sessions.length === 0 && !creating && <div className="cc-empty">暂无会话</div>}
      </div>
      <div className="cc-rail-foot">
        <StateDot state={props.connected ? 'done' : 'warning'} />
        <span>{props.connected ? '已连接' : '连接中…'}</span>
        <span className="cc-spacer" />
        <Button size="sm" onClick={props.onOpenSettings}>设置</Button>
      </div>
      <div
        className="cc-rail-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧栏宽度"
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={event => {
          const step = event.key === 'ArrowLeft' ? -KEY_STEP : event.key === 'ArrowRight' ? KEY_STEP : 0
          if (step === 0) return
          const next = clampWidth(widthRef.current + step)
          widthRef.current = next
          setWidth(next)
          persist(WIDTH_KEY, String(next))
        }}
      />
      {newCard}
    </aside>
  )
})
