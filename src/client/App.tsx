/**
 * The Claude Code overlay: session rail, transcript, composer, permission
 * cards, and an editable settings panel (model / permission / environment).
 * Directories are picked through a browse dialog over /cc/api/fs. All state
 * is component-local; live updates arrive through one shared SSE stream.
 *
 * @module dsh-cc/client/App
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import {
  answerDialog,
  answerPermission,
  connectEvents,
  createSession,
  deleteSession,
  fetchConfig,
  fetchContext,
  fetchModels,
  fetchSession,
  fetchSessions,
  fetchSettings,
  fetchUsage,
  listDir,
  renameSession,
  setEffort,
  setModel,
  setSessionEnv,
  saveSettings,
  sendMessage,
  stopSession,
  type CcSettings,
  type ConfigSummary,
  type CcEvent,
  type DirListing,
  type PermissionRequest,
  type ContextUsage,
  type DialogQuestion,
  type ModelRow,
  type SessionMeta,
  type UsageInfo,
} from './api.ts'
import { CcMessage } from './Message.tsx'

const MODEL_OPTIONS = [
  { value: '', label: '默认（跟随配置）' },
  { value: 'opus', label: 'opus' },
  { value: 'sonnet', label: 'sonnet' },
  { value: 'haiku', label: 'haiku' },
]

const PERMISSION_MODES = [
  { value: '', label: '跟随启动配置' },
  { value: 'auto', label: 'auto（原生分类器自动决策，推荐）' },
  { value: 'default', label: 'default（逐项询问本页面）' },
  { value: 'acceptEdits', label: 'acceptEdits（自动接受文件编辑）' },
  { value: 'plan', label: 'plan（仅规划）' },
  { value: 'bypassPermissions', label: 'bypassPermissions（跳过全部确认）' },
]

const PERMISSION_LABELS: Record<string, string> = {
  default: 'default',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
  auto: 'auto',
  bypassPermissions: 'bypassPermissions',
}

function statusDot(status: SessionMeta['status']): string {
  if (status === 'busy') return 'cc-dot cc-dot-busy'
  if (status === 'error') return 'cc-dot cc-dot-error'
  return 'cc-dot cc-dot-idle'
}

function shortTime(iso: string): string {
  return iso.slice(5, 16).replace('T', ' ')
}

function JsonBlockish({ value }: { value: unknown }): ReactElement {
  let text: string
  try {
    text = JSON.stringify(value, null, 2) ?? ''
  } catch {
    text = String(value)
  }
  return <div className="cc-json" style={{ maxHeight: 160, overflowY: 'auto' }}>{text}</div>
}

/**
 * Directory browse dialog over GET /cc/api/fs/list.
 * @param props - initial path, cancel, and pick callbacks.
 * @returns the dialog node.
 */
function DirectoryPickerModal(props: {
  initial: string
  onCancel(): void
  onPick(path: string): void
}): ReactElement {
  const [path, setPath] = useState(props.initial)
  const [draft, setDraft] = useState(props.initial)
  const [listing, setListing] = useState<DirListing | undefined>()
  const [error, setError] = useState<string | undefined>()

  const load = (target: string | undefined): void => {
    listDir(target)
      .then(result => {
        setListing(result)
        setPath(result.path)
        setDraft(result.path)
        setError(undefined)
      })
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
  }
  useEffect(() => {
    load(props.initial === '' ? undefined : props.initial)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- load once on open

  const enter = (entry: { name: string; directory: boolean }): void => {
    if (!entry.directory) return
    if (path === '') load(entry.name)
    else load(path + (path.endsWith('\\') || path.endsWith('/') ? '' : '/') + entry.name)
  }

  return (
    <div className="cc-modal-backdrop" onClick={props.onCancel}>
      <div className="cc-modal" style={{ width: 620, display: 'flex', flexDirection: 'column' }} onClick={event => event.stopPropagation()}>
        <h3>选择工作目录</h3>
        <div className="cc-picker">
          <div className="cc-picker-bar">
            <input
              className="cc-picker-path"
              value={draft}
              placeholder="直接输入路径或从下方选择"
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') load(draft)
              }}
            />
            <button type="button" className="cc-btn" onClick={() => load(draft)}>前往</button>
            {listing?.parent != null && (
              <button type="button" className="cc-btn" onClick={() => load(listing.parent ?? undefined)}>上一级</button>
            )}
          </div>
          <div className="cc-picker-list">
            {error && <div className="cc-picker-empty">{error}</div>}
            {!error && listing === undefined && <div className="cc-picker-empty">读取中…</div>}
            {!error && listing !== undefined && listing.entries.length === 0 && <div className="cc-picker-empty">空目录</div>}
            {listing?.entries.map(entry => (
              <button
                key={entry.name}
                type="button"
                className={entry.directory ? 'cc-picker-row' : 'cc-picker-row cc-picker-row-file'}
                onClick={() => enter(entry)}
              >
                <span>{entry.directory ? '📁' : '📄'}</span>
                <span>{entry.name}</span>
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" className="cc-btn" onClick={props.onCancel}>取消</button>
          <button
            type="button"
            className="cc-btn cc-btn-primary"
            disabled={path === ''}
            onClick={() => props.onPick(path)}
          >
            选择此目录
          </button>
        </div>
      </div>
    </div>
  )
}

function NewSessionForm(props: {
  config: ConfigSummary | undefined
  onCancel(): void
  onCreate(form: { name?: string; cwd?: string; model?: string }): void
}): ReactElement {
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState(props.config?.defaultCwd ?? '')
  const [model, setModel] = useState('')
  const [customModel, setCustomModel] = useState('')
  const [picking, setPicking] = useState(false)
  const submit = (): void => {
    const chosen = model === '__custom' ? (customModel || undefined) : (model || undefined)
    props.onCreate({ name: name || undefined, cwd: cwd || undefined, model: chosen })
  }
  return (
    <div className="cc-form">
      <label className="cc-field">
        名称（可选）
        <input value={name} onChange={event => setName(event.target.value)} placeholder="默认按时间命名" />
      </label>
      <div className="cc-field">
        工作目录
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={cwd} onChange={event => setCwd(event.target.value)} placeholder={props.config?.defaultCwd} />
          <button type="button" className="cc-btn" onClick={() => setPicking(true)}>浏览…</button>
        </div>
      </div>
      <label className="cc-field">
        模型
        <select value={model} onChange={event => setModel(event.target.value)}>
          {MODEL_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
          <option value="__custom">自定义…</option>
        </select>
      </label>
      {model === '__custom' && (
        <label className="cc-field">
          模型 ID
          <input value={customModel} onChange={event => setCustomModel(event.target.value)} placeholder="claude-sonnet-4-5" />
        </label>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="cc-btn cc-btn-primary" onClick={submit}>创建</button>
        <button type="button" className="cc-btn" onClick={props.onCancel}>取消</button>
      </div>
      {picking && (
        <DirectoryPickerModal
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

function Composer(props: { busy: boolean; onSend(text: string): void; onStop(): void }): ReactElement {
  const [value, setValue] = useState('')
  const submit = (): void => {
    const text = value.trim()
    if (text.length === 0) return
    setValue('')
    props.onSend(text)
  }
  return (
    <div className="cc-composer">
      <textarea
        className="cc-input"
        value={value}
        placeholder={props.busy ? 'Claude Code 正在工作中…（仍可排队输入）' : '向 Claude Code 发送消息，Enter 发送，Shift+Enter 换行'}
        onChange={event => setValue(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            submit()
          }
        }}
      />
      {props.busy
        ? <button type="button" className="cc-btn cc-btn-danger" onClick={props.onStop}>停止</button>
        : (
            <button type="button" className="cc-btn cc-btn-primary" onClick={submit} disabled={value.trim().length === 0}>
              发送
            </button>
          )}
    </div>
  )
}

function PermissionCard(props: { request: PermissionRequest; onAnswer(behavior: 'allow' | 'deny'): void }): ReactElement {
  return (
    <div className="cc-perm">
      <div className="cc-perm-head">🔐 权限请求：{props.request.toolName}</div>
      <JsonBlockish value={props.request.input} />
      <div className="cc-perm-actions">
        <button type="button" className="cc-btn cc-btn-primary" onClick={() => props.onAnswer('allow')}>允许一次</button>
        <button type="button" className="cc-btn cc-btn-danger" onClick={() => props.onAnswer('deny')}>拒绝</button>
      </div>
    </div>
  )
}

interface EnvRow {
  key: string
  value: string
}

/**
 * Editable settings dialog: default model, permission posture, and the
 * environment layered onto every newly spawned claude process.
 * @param props - close callback.
 * @returns the dialog node.
 */
function SettingsModal(props: { onClose(): void }): ReactElement {
  const [model, setModel] = useState('')
  const [customModel, setCustomModel] = useState('')
  const [permissionMode, setPermissionMode] = useState('')
  const [rows, setRows] = useState<EnvRow[]>([])
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | undefined>()

  useEffect(() => {
    fetchSettings()
      .then(result => {
        setModel(result.settings.model === '' || MODEL_OPTIONS.some(o => o.value === result.settings.model) ? result.settings.model : '__custom')
        if (result.settings.model !== '' && !MODEL_OPTIONS.some(o => o.value === result.settings.model)) {
          setCustomModel(result.settings.model)
        }
        setPermissionMode(result.settings.permissionMode)
        setRows(Object.entries(result.settings.env).map(([key, value]) => ({ key, value })))
        setReady(true)
      })
      .catch(cause => setMessage(cause instanceof Error ? cause.message : String(cause)))
  }, [])

  const save = (): void => {
    const chosenModel = model === '__custom' ? customModel.trim() : model
    const env: Record<string, string> = {}
    for (const row of rows) {
      const key = row.key.trim()
      if (key.length === 0) continue
      env[key] = row.value
    }
    setSaving(true)
    saveSettings({ model: chosenModel, permissionMode, env })
      .then(() => {
        setSaving(false)
        props.onClose()
      })
      .catch(cause => {
        setSaving(false)
        setMessage(cause instanceof Error ? cause.message : String(cause))
      })
  }

  return (
    <div className="cc-modal-backdrop" onClick={props.onClose}>
      <div className="cc-modal" style={{ width: 560 }} onClick={event => event.stopPropagation()}>
        <h3>Claude Code 设置</h3>
        {!ready && <div className="cc-empty">读取中…</div>}
        {ready && (
          <>
            <label className="cc-field">
              默认模型
              <select value={model} onChange={event => setModel(event.target.value)}>
                {MODEL_OPTIONS.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
                <option value="__custom">自定义…</option>
              </select>
            </label>
            {model === '__custom' && (
              <label className="cc-field">
                模型 ID
                <input value={customModel} onChange={event => setCustomModel(event.target.value)} placeholder="claude-sonnet-4-5" />
              </label>
            )}
            <label className="cc-field">
              权限模式
              <select value={permissionMode} onChange={event => setPermissionMode(event.target.value)}>
                {PERMISSION_MODES.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <div className="cc-section-title">
              环境变量（对新启动的 Claude 进程生效；HTTPS_PROXY、ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN 等）
            </div>
            {rows.map((row, index) => (
              <div key={index} className="cc-env-row" style={{ marginBottom: 6 }}>
                <input
                  className="cc-env-key"
                  value={row.key}
                  placeholder="变量名"
                  onChange={event => setRows(previous => previous.map((item, i) => i === index ? { ...item, key: event.target.value } : item))}
                />
                <input
                  className="cc-env-val"
                  value={row.value}
                  placeholder="值"
                  onChange={event => setRows(previous => previous.map((item, i) => i === index ? { ...item, value: event.target.value } : item))}
                />
                <button
                  type="button"
                  className="cc-env-del"
                  title="删除"
                  onClick={() => setRows(previous => previous.filter((_, i) => i !== index))}
                >
                  ×
                </button>
              </div>
            ))}
            <button type="button" className="cc-btn" onClick={() => setRows(previous => [...previous, { key: '', value: '' }])}>
              ＋ 添加变量
            </button>
          </>
        )}
        {message && <div className="cc-error-bar" style={{ marginTop: 10 }}>{message}</div>}
        <div className="cc-hint">{'保存后立即写入数据目录的 settings.json，并对之后新启动的 Claude 进程生效（进行中的会话不受影响）。留空的字段沿用 dsh 启动配置（cordis.patch.yml）。'}</div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="cc-btn" onClick={props.onClose}>取消</button>
          <button type="button" className="cc-btn cc-btn-primary" disabled={!ready || saving} onClick={save}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** The effort-level choices shown in the status bar. */
const EFFORT_LEVELS = ['max', 'xhigh', 'high', 'medium', 'low']

/** Compact context meter like [████░░░░░░] 152.3K/1000K (15.2%). */
function ContextMeter(props: { context: ContextUsage }): ReactElement {
  const ratio = props.context.maxTokens > 0
    ? props.context.totalTokens / props.context.maxTokens
    : 0
  const filled = Math.round(Math.min(0.999, Math.max(0, ratio)) * 10)
  const fmt = (tokens: number): string =>
    tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'K' : String(tokens)
  return (
    <span className="cc-ctx-meter" title={'上下文占用 ' + Math.round(ratio * 100) + '%'}>
      <span className="cc-ctx-bar">{'█'.repeat(filled)}{'░'.repeat(10 - filled)}</span>
      {fmt(props.context.totalTokens)}/{fmt(props.context.maxTokens)} ({(ratio * 100).toFixed(1)}%)
    </span>
  )
}

/** The status strip: model selector, context meter, effort selector, quota windows. */
function StatusBar(props: {
  sessionId: string
  context: ContextUsage | undefined
  usage: { info: UsageInfo | undefined; note: string | undefined }
  onModelPicked(model: string): void
  onEffortPicked(effort: string): void
}): ReactElement | null {
  const [models, setModels] = useState<{ rows: ModelRow[]; current: string; effort: string }>({ rows: [], current: '', effort: '' })
  useEffect(() => {
    fetchModels(props.sessionId)
      .then(result => {
        setModels({ rows: result.models, current: result.current, effort: result.effort ?? '' })
      })
      .catch(() => {})
  }, [props.sessionId])
  return (
    <div className="cc-status-bar">
      <select
        className="cc-status-select"
        value={models.rows.some(row => row.value === models.current) ? models.current : ''}
        title="切换模型（对下一回合生效）"
        onChange={event => {
          setModels(previous => ({ ...previous, current: event.target.value }))
          props.onModelPicked(event.target.value)
        }}
      >
        <option value="">默认模型</option>
        {models.rows.map(row => (
          <option key={row.value} value={row.value}>{row.displayName}</option>
        ))}
      </select>
      {props.context !== undefined && <ContextMeter context={props.context} />}
      <select
        className="cc-status-select"
        value={models.effort}
        title="思考程度"
        onChange={event => {
          setModels(previous => ({ ...previous, effort: event.target.value }))
          props.onEffortPicked(event.target.value)
        }}
      >
        <option value="">💭 默认</option>
        {EFFORT_LEVELS.map(level => (
          <option key={level} value={level}>💭 {level}</option>
        ))}
      </select>
      <UsageBar info={props.usage.info} note={props.usage.note} />
    </div>
  )
}

/** Format the wait until a window resets, e.g. "2h31m" or "6d 3h". */
function untilText(resetsAt: string | null | undefined, now: number): string {
  if (resetsAt === null || resetsAt === undefined || resetsAt === '') return ''
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at) || at <= now) return ''
  const minutes = Math.round((at - now) / 60000)
  if (minutes < 60) return minutes + 'm'
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return hours + 'h' + (minutes % 60 > 0 ? Math.round(minutes % 60) + 'm' : '')
  const days = Math.floor(hours / 24)
  return days + 'd ' + (hours % 24) + 'h'
}

/** The plan-quota strip: subscription rate-limit windows with reset countdowns. */
function UsageBar(props: { info: UsageInfo | undefined; note: string | undefined }): ReactElement | null {
  const { info } = props
  const now = Date.now()
  if (info === undefined) return null
  const limits = info.rate_limits_available ? info.rate_limits : null
  const five = limits?.five_hour?.utilization
  const seven = limits?.seven_day?.utilization
  if (five === undefined && seven === undefined) {
    return <div className="cc-usage-note">{props.note ?? '额度数据不可用（API Key 或非订阅账户无计划限额）'}</div>
  }
  const pct = (value: number | undefined | null): string =>
    value === undefined || value === null ? '—' : Math.round(value) + '%'
  const fiveReset = untilText(limits?.five_hour?.resets_at, now)
  const sevenReset = untilText(limits?.seven_day?.resets_at, now)
  return (
    <div className="cc-usage-inline">
      {info.subscription_type != null && info.subscription_type !== '' && (
        <span className="cc-usage-tag">{info.subscription_type}</span>
      )}
      <span title={fiveReset !== '' ? '5h 窗口 ' + fiveReset + ' 后重置' : undefined}>
        5h <strong>{pct(five)}</strong>{fiveReset !== '' && <em className="cc-usage-reset">↻{fiveReset}</em>}
      </span>
      <span title={sevenReset !== '' ? '周限额 ' + sevenReset + ' 后重置' : undefined}>
        周 <strong>{pct(seven)}</strong>{sevenReset !== '' && <em className="cc-usage-reset">↻{sevenReset}</em>}
      </span>
    </div>
  )
}

/** Per-session environment editor (e.g. official vs relay endpoint). */
function SessionEnvModal(props: {
  session: SessionMeta
  onClose(): void
  onSaved(): void
}): ReactElement {
  const [rows, setRows] = useState<EnvRow[]>(
    Object.entries(props.session.env ?? {}).map(([key, value]) => ({ key, value })),
  )
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | undefined>()
  const save = (): void => {
    const env: Record<string, string> = {}
    for (const row of rows) {
      const key = row.key.trim()
      if (key.length === 0) continue
      env[key] = row.value
    }
    setSaving(true)
    setSessionEnv(props.session.id, env)
      .then(() => {
        setSaving(false)
        props.onSaved()
        props.onClose()
      })
      .catch(cause => {
        setSaving(false)
        setMessage(cause instanceof Error ? cause.message : String(cause))
      })
  }
  return (
    <div className="cc-modal-backdrop" onClick={props.onClose}>
      <div className="cc-modal" style={{ width: 560 }} onClick={event => event.stopPropagation()}>
        <h3>会话环境变量 · {props.session.name}</h3>
        <div className="cc-hint">{'只作用于这个会话的下一个 Claude 进程（例如让 B 会话走中转站：ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN；留空则沿用全局设置）。进行中的回合不受影响。'}</div>
        <div style={{ height: 10 }} />
        {rows.map((row, index) => (
          <div key={index} className="cc-env-row" style={{ marginBottom: 6 }}>
            <input
              className="cc-env-key"
              value={row.key}
              placeholder="变量名"
              onChange={event => setRows(previous => previous.map((item, i) => i === index ? { ...item, key: event.target.value } : item))}
            />
            <input
              className="cc-env-val"
              value={row.value}
              placeholder="值"
              onChange={event => setRows(previous => previous.map((item, i) => i === index ? { ...item, value: event.target.value } : item))}
            />
            <button
              type="button"
              className="cc-env-del"
              title="删除"
              onClick={() => setRows(previous => previous.filter((_, i) => i !== index))}
            >
              ×
            </button>
          </div>
        ))}
        <button type="button" className="cc-btn" onClick={() => setRows(previous => [...previous, { key: '', value: '' }])}>
          ＋ 添加变量
        </button>
        {message && <div className="cc-error-bar" style={{ marginTop: 10 }}>{message}</div>}
        <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="cc-btn" onClick={props.onClose}>取消</button>
          <button type="button" className="cc-btn cc-btn-primary" disabled={saving} onClick={save}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** One sidebar session row: name, status dot, inline rename, delete. */
function SessionRow(props: {
  session: SessionMeta
  active: boolean
  onSelect(): void
  onDelete(): void
  onRename(name: string): void
}): ReactElement {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(props.session.name)
  if (editing) {
    return (
      <div className="cc-session-row" style={{ gap: 6 }}>
        <span className={statusDot(props.session.status)} />
        <input
          className="cc-input"
          style={{ flex: 1, minHeight: 30, fontSize: 12, padding: '3px 8px' }}
          value={draft}
          autoFocus
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              const name = draft.trim()
              if (name.length > 0 && name !== props.session.name) props.onRename(name)
              setEditing(false)
            }
            if (event.key === 'Escape') {
              setDraft(props.session.name)
              setEditing(false)
            }
          }}
          onBlur={() => {
            const name = draft.trim()
            if (name.length > 0 && name !== props.session.name) props.onRename(name)
            setEditing(false)
          }}
          onClick={event => event.stopPropagation()}
        />
      </div>
    )
  }
  return (
    <div
      role="button"
      tabIndex={0}
      className={props.active ? 'cc-session-row cc-session-row-active' : 'cc-session-row'}
      onClick={props.onSelect}
      onKeyDown={event => {
        if (event.key === 'Enter') props.onSelect()
      }}
      onDoubleClick={() => {
        setDraft(props.session.name)
        setEditing(true)
      }}
    >
      <span className={statusDot(props.session.status)} />
      <span className="cc-session-name" title={props.session.name + '（双击重命名）'}>{props.session.name}</span>
      <span style={{ fontSize: 11, color: 'var(--cc-text-3)' }}>{shortTime(props.session.updatedAt)}</span>
      <button
        type="button"
        className="cc-session-del"
        title="重命名"
        style={{ fontSize: 12 }}
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
        className="cc-session-del"
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

/** Interactive question card for a pending AskUserQuestion dialog. */
function QuestionCard(props: {
  sessionId: string
  dialogId: string
  payload: Record<string, unknown>
  onAnswer(answers: unknown): void
  onCancel(): void
}): ReactElement {
  const questions = (Array.isArray(props.payload.questions) ? props.payload.questions : []) as DialogQuestion[]
  const [picks, setPicks] = useState<Record<number, string[]>>({})
  const [texts, setTexts] = useState<Record<number, string>>({})
  const toggle = (index: number, label: string, multi: boolean): void => {
    setPicks(previous => {
      const current = previous[index] ?? []
      if (multi) {
        return { ...previous, [index]: current.includes(label) ? current.filter(l => l !== label) : [...current, label] }
      }
      return { ...previous, [index]: [label] }
    })
  }
  const answered = (index: number): boolean =>
    (picks[index] ?? []).length > 0 || (texts[index] ?? '').trim().length > 0
  const submit = (): void => {
    const answers = questions.map((question, index) => {
      const custom = (texts[index] ?? '').trim()
      return {
        questionId: question.question ?? '',
        optionLabels: picks[index] ?? [],
        ...(custom !== '' ? { text: custom } : {}),
      }
    })
    props.onAnswer({ answers })
  }
  const picked = questions.length === 0 || questions.every((_, index) => answered(index))
  return (
    <div className="cc-perm">
      <div className="cc-perm-head">❓ Claude 想确认几个问题</div>
      {questions.map((question, index) => (
        <div key={index} style={{ marginBottom: 10 }}>
          {question.header !== undefined && question.header !== '' && (
            <div className="cc-q-header">{question.header}</div>
          )}
          <div className="cc-q-text">{question.question}</div>
          {(question.options ?? []).map((option, optionIndex) => {
            const label = option.label ?? ''
            const active = (picks[index] ?? []).includes(label)
            return (
              <button
                key={optionIndex}
                type="button"
                className={active ? 'cc-q-option cc-q-option-active' : 'cc-q-option'}
                onClick={() => toggle(index, label, question.multiSelect === true)}
              >
                <span className="cc-q-label">{label}</span>
                {option.description !== undefined && option.description !== '' && (
                  <span className="cc-q-desc">{option.description}</span>
                )}
              </button>
            )
          })}
          <input
            className="cc-input"
            style={{ minHeight: 34, fontSize: 12, marginTop: 4 }}
            placeholder="其他（可自行输入回答）…"
            value={texts[index] ?? ''}
            onChange={event => setTexts(previous => ({ ...previous, [index]: event.target.value }))}
          />
        </div>
      ))}
      <div className="cc-perm-actions">
        <button type="button" className="cc-btn cc-btn-primary" disabled={!picked} onClick={submit}>提交回答</button>
        <button type="button" className="cc-btn cc-btn-danger" onClick={props.onCancel}>取消（视为未答）</button>
      </div>
    </div>
  )
}

/** The full-screen Claude Code app. */
export function CcApp(props: { onClose(): void }): ReactElement {
  const [config, setConfig] = useState<ConfigSummary | undefined>()
  const [usage, setUsage] = useState<{ info: UsageInfo | undefined; note: string | undefined }>({ info: undefined, note: undefined })
  const [context, setContext] = useState<ContextUsage | undefined>()
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [currentId, setCurrentId] = useState<string | undefined>()
  const [events, setEvents] = useState<CcEvent[]>([])
  const [permissions, setPermissions] = useState<{ sessionId: string; request: PermissionRequest }[]>([])
  const [dialogs, setDialogs] = useState<{ sessionId: string; id: string; payload: Record<string, unknown> }[]>([])
  const [connected, setConnected] = useState(false)
  const [creating, setCreating] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [envSessionId, setEnvSessionId] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const currentIdRef = useRef(currentId)
  const scrollRef = useRef<HTMLDivElement>(null)

  const current = sessions.find(session => session.id === currentId)

  useEffect(() => {
    currentIdRef.current = currentId
  }, [currentId])

  useEffect(() => {
    let disposed = false
    const fail = (cause: unknown): void => {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
    }
    fetchConfig().then(result => {
      if (!disposed) setConfig(result.config)
    }).catch(fail)
    fetchSessions().then(result => {
      if (disposed) return
      setSessions(result.sessions)
      setCurrentId(previous => previous ?? result.sessions[0]?.id)
    }).catch(fail)
    const dispose = connectEvents(message => {
      switch (message.t) {
        case 'hello':
          setConfig(message.config)
          break
        case 'sessions':
          setSessions(message.sessions)
          break
        case 'event':
          if (message.sessionId === currentIdRef.current) {
            setEvents(previous => [...previous, message.event])
            if (message.event.kind === 'result') {
              fetchUsage(currentIdRef.current)
                .then(result => setUsage({
                  info: result.usage,
                  note: result.available ? undefined : result.reason,
                }))
                .catch(() => setUsage({ info: undefined, note: undefined }))
              fetchContext(currentIdRef.current)
                .then(result => {
                  if (result.available && result.context !== undefined) setContext(result.context)
                })
                .catch(() => {})
            }
          }
          break
        case 'permission':
          setPermissions(previous => [...previous, { sessionId: message.sessionId, request: message.request }])
          break
        case 'permission-done':
          setPermissions(previous => previous.filter(item => item.request.id !== message.requestId))
          break
        case 'dialog':
          setDialogs(previous => [...previous, { sessionId: message.sessionId, id: message.request.id, payload: message.request.payload }])
          break
        case 'dialog-done':
          setDialogs(previous => previous.filter(item => item.id !== message.requestId))
          break
      }
    }, setConnected)
    return () => {
      disposed = true
      dispose()
    }
  }, [])

  useEffect(() => {
    if (currentId === undefined) {
      setEvents([])
      return
    }
    let stale = false
    fetchSession(currentId)
      .then(result => {
        if (!stale) setEvents(result.events)
      })
      .catch(cause => {
        if (!stale) setError(cause instanceof Error ? cause.message : String(cause))
      })
    fetchUsage(currentId)
      .then(result => {
        if (!stale) setUsage({ info: result.usage, note: result.available ? undefined : result.reason })
      })
      .catch(() => {
        if (!stale) setUsage({ info: undefined, note: undefined })
      })
    setContext(undefined)
    fetchContext(currentId)
      .then(result => {
        if (!stale && result.available && result.context !== undefined) setContext(result.context)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [currentId])

  useEffect(() => {
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [events.length, currentId])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])

  const send = (text: string): void => {
    if (!current) return
    sendMessage(current.id, text).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
  }

  const create = (form: { name?: string; cwd?: string; model?: string }): void => {
    createSession(form)
      .then(result => {
        setSessions(previous => [result.session, ...previous.filter(session => session.id !== result.session.id)])
        setCurrentId(result.session.id)
        setCreating(false)
      })
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
  }

  const removeSession = (id: string): void => {
    if (!window.confirm('删除该会话及全部聊天记录？')) return
    deleteSession(id)
      .then(() => {
        setSessions(previous => previous.filter(session => session.id !== id))
        if (currentId === id) setCurrentId(undefined)
      })
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
  }

  const decide = (requestId: string, behavior: 'allow' | 'deny'): void => {
    if (!current) return
    answerPermission(current.id, requestId, behavior)
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
  }

  return (
    <div className="cc-overlay">
      <div className="cc-app">
        <aside className="cc-side">
          <div className="cc-side-head">
            <button
              type="button"
              className="cc-btn cc-btn-primary"
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={() => setCreating(value => !value)}
            >
              ＋ 新会话
            </button>
          </div>
          {creating && <NewSessionForm config={config} onCancel={() => setCreating(false)} onCreate={create} />}
          <div className="cc-session-list">
            {sessions.map(session => (
              <SessionRow
                key={session.id}
                session={session}
                active={session.id === currentId}
                onSelect={() => setCurrentId(session.id)}
                onDelete={() => removeSession(session.id)}
                onRename={name => {
                  renameSession(session.id, name).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
                }}
              />
            ))}
            {sessions.length === 0 && !creating && <div className="cc-empty">暂无会话</div>}
          </div>
          <div className="cc-side-foot">
            <span className={connected ? 'cc-dot cc-dot-ok' : 'cc-dot cc-dot-bad'} />
            <span>{connected ? '已连接' : '连接中…'}</span>
            <span className="cc-spacer" />
            <button type="button" className="cc-link" onClick={() => setShowSettings(true)}>设置</button>
          </div>
        </aside>
        <main className="cc-main">
          <header className="cc-head">
            <div className="cc-head-title">
              <strong>{current?.name ?? 'Claude Code'}</strong>
              {current && (
                <span className="cc-head-meta">
                  {current.cwd}
                  {current.model !== '' && ' · ' + current.model}
                  {config !== undefined && ' · ' + (PERMISSION_LABELS[config.permissionMode] ?? config.permissionMode)}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {current && (
                <button
                  type="button"
                  className="cc-btn"
                  title="本会话的环境变量（如中转站地址）"
                  onClick={() => setEnvSessionId(current.id)}
                >
                  ⚙ 环境
                </button>
              )}
              <button type="button" className="cc-btn" onClick={props.onClose}>关闭 Esc</button>
            </div>
          </header>
          {current && (
            <StatusBar
              sessionId={current.id}
              context={context}
              usage={usage}
              onModelPicked={model => setModel(current.id, model).catch(() => {})}
              onEffortPicked={effort => setEffort(current.id, effort).catch(() => {})}
            />
          )}
          {error && (
            <div className="cc-error-bar">
              <span style={{ flex: 1 }}>{error}</span>
              <button type="button" className="cc-link" onClick={() => setError(undefined)}>关闭</button>
            </div>
          )}
          {current
            ? (
                <>
                  <div className="cc-scroll" ref={scrollRef}>
                    {events.map(event => <CcMessage key={event.seq} event={event} />)}
                    {events.length === 0 && <div className="cc-empty">发送第一条消息，开始与 Claude Code 对话</div>}
                  </div>
                  {permissions
                    .filter(item => item.sessionId === current.id)
                    .map(item => (
                      <div key={item.request.id} style={{ padding: '0 16px 8px' }}>
                        <PermissionCard request={item.request} onAnswer={behavior => decide(item.request.id, behavior)} />
                      </div>
                    ))}
                  {dialogs
                    .filter(item => item.sessionId === current.id)
                    .map(item => (
                      <div key={item.id} style={{ padding: '0 16px 8px' }}>
                        <QuestionCard
                          sessionId={current.id}
                          dialogId={item.id}
                          payload={item.payload}
                          onAnswer={answers => {
                            answerDialog(current.id, item.id, answers).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
                          }}
                          onCancel={() => {
                            answerDialog(current.id, item.id, undefined).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
                          }}
                        />
                      </div>
                    ))}
                  <Composer
                    busy={current.status === 'busy'}
                    onSend={send}
                    onStop={() => stopSession(current.id).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))}
                  />
                </>
              )
            : <div className="cc-empty cc-center">从左侧选择或新建一个 Claude Code 会话</div>}
        </main>
        {envSessionId !== undefined && current && current.id === envSessionId && (
          <SessionEnvModal
            session={current}
            onClose={() => setEnvSessionId(undefined)}
            onSaved={() => {
              fetchSessions().then(result => setSessions(result.sessions)).catch(() => {})
            }}
          />
        )}
        {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      </div>
    </div>
  )
}
