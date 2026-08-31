/**
 * Transcript projection and rendering.
 *
 * A turn's `tool_use` and its later `tool_result` are ONE thing to a reader,
 * so they are paired here by `toolUseId` and drawn as a single disclosure row —
 * the same shape the host uses for its own tool calls. Everything else is a
 * pure function of the event list, so a re-render never depends on arrival
 * order.
 *
 * This module owns the projection and the dispatch; how a given tool draws
 * lives under `tool/`.
 *
 * @module dsh-cc/client/Transcript
 */

import { memo, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import {
  DisclosureRow,
  IconBranchOutline16,
  IconCheckOutline16,
  IconCopyOutline16,
  IconRefreshOutline16,
  IconShareOutline16,
  IconThinkOutline14,
  MarkdownText,
  Tooltip,
  writeClipboard,
  type MarkdownFileMentions,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { commandToken, matchCommand } from './command-mentions.ts'
import { registerCss } from './css.ts'
import { FileViewer } from './FileViewer.tsx'
import { fileMentionsFor } from './file-mentions.ts'
import { compact } from './status/format.ts'
import { ToolRow } from './tool/ToolRow.tsx'
import { stringField } from './tool/wire.ts'
import { formatTurnForCopy, turnAssistantText } from './turn-copy.ts'
import type { LiveTurnState } from '../live-turn.ts'
import { MEDIA_TYPE_EXTENSIONS, type CcEvent, type SlashCommand } from '../types.ts'

registerCss('transcript', `
/* The user's own turn, drawn from the host's own bubble token and geometry
   (fill, r22, 16/24 type, 525px cap) so the two conversations match. */
.cc-user {
  align-self: flex-end;
  max-width: min(525px, 82%);
  padding: 10px 16px;
  border-radius: 22px;
  background: var(--dsw-specific-bubble);
  color: var(--dsw-alias-label-primary);
  font-size: 16px;
  line-height: 24px;
  white-space: pre-wrap;
  word-break: break-word;
}

/* The assistant owns the full column width with no card around it, so prose
   reads as prose. */
.cc-assistant { align-self: stretch; font: var(--dsw-font-markdown-base); }
.cc-assistant :where(p) { margin: 0.4em 0; }
.cc-assistant :where(h1, h2, h3, h4) { margin: 0.7em 0 0.3em; }
.cc-assistant :where(ul, ol) { margin: 0.4em 0; padding-left: 1.4em; }
.cc-assistant :where(table) { margin: 0.5em 0; border-collapse: collapse; }
.cc-assistant :where(th, td) { padding: 4px 10px; border: 1px solid var(--dsw-alias-border-l2); }

.cc-think { align-self: stretch; }
.cc-think-title { font: var(--dsw-font-s-14); font-weight: 400; color: var(--dsw-alias-label-primary); }
.cc-think-body {
  margin: 2px 0 4px 22px;
  white-space: pre-wrap;
  font: var(--dsw-font-xs-13);
  color: var(--dsw-alias-label-tertiary);
}

.cc-note {
  align-self: center;
  padding: 2px 12px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-tertiary);
}

/* A notice banner's level tint: warnings carry the error color, suggestions
   step up one shade; plain notices keep the quiet default above. */
.cc-note-warning { color: var(--dsw-alias-state-error-primary); }
.cc-note-suggestion { color: var(--dsw-alias-label-secondary); }

.cc-fail {
  align-self: stretch;
  padding: 8px 14px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  border-radius: 10px;
  background: var(--dsw-alias-state-error-secondary);
  color: var(--dsw-alias-state-error-primary);
  font: var(--dsw-font-xs-13);
}

/* Local slash-command output: assistant-style markdown set off by a quiet
   rail and titled, so it reads as the command's answer, not a model turn. */
.cc-command-output {
  align-self: stretch;
  border-left: 2px solid var(--dsw-alias-border-l3);
  padding-left: 10px;
  font: var(--dsw-font-markdown-base);
}
.cc-command-output :where(p) { margin: 0.4em 0; }
.cc-command-output-title {
  margin-bottom: 2px;
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-tertiary);
}

/* Turn tail: the same quiet stats strip the host closes a turn with. */
.cc-tail {
  align-self: center;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  padding: 2px 0 6px;
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-caption);
}

.cc-tail-sep { color: var(--dsw-alias-border-l3); }

/* Attachments sit above the sentence inside the user bubble, matching the
   order the model receives them in. */
.cc-user-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}

.cc-user-images img {
  display: block;
  max-width: 180px;
  max-height: 180px;
  border-radius: 10px;
}

/* A user turn plus its hover action row. The wrapper owns the right-edge
   alignment and width cap the bubble used to carry, so the actions can sit
   under the bubble without widening the conversation column. */
.cc-user-wrap {
  align-self: flex-end;
  max-width: min(525px, 82%);
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.cc-user-wrap .cc-user { max-width: 100%; }

/* The per-row icon action cluster, ported from the host's
   MessageIconActions: quiet until the row is hovered, opacity-only so the
   layout never shifts, and always reachable by keyboard (focus-within). */
.cc-user-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  height: calc(28px + var(--dsh-content-font-delta, 0px));
  padding: 2px 4px 0;
  opacity: 0;
  transition: opacity var(--ds-transition-duration) var(--ds-ease-in-out);
}

.cc-user-wrap:hover .cc-user-actions, .cc-user-actions:focus-within { opacity: 1; }

/* One icon action: the host's .action geometry — 28px round hover surface,
   15px glyph riding the content font delta. */
.cc-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: calc(28px + var(--dsh-content-font-delta, 0px));
  height: calc(28px + var(--dsh-content-font-delta, 0px));
  padding: 6px;
  border: none;
  border-radius: 28px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}

.cc-action svg {
  width: calc(15px + var(--dsh-content-font-delta, 0px));
  height: calc(15px + var(--dsh-content-font-delta, 0px));
}

.cc-action:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}

/* Assistant prose segment + its hover copy row. The row is reserved (no
   layout shift) but transparent until the segment is hovered — the same
   reveal contract the user rows use. */
.cc-assistant-wrap { align-self: stretch; }

.cc-msg-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  height: calc(26px + var(--dsh-content-font-delta, 0px));
  opacity: 0;
  transition: opacity var(--ds-transition-duration) var(--ds-ease-in-out);
}

.cc-assistant-wrap:hover .cc-msg-actions,
.cc-msg-actions:focus-within,
.cc-think:hover .cc-msg-actions { opacity: 1; }

/* The thinking disclosure seats its copy icon inside the header band, so the
   actions row overlays instead of stacking below the collapsible body. */
.cc-think { position: relative; }

.cc-think .cc-msg-actions {
  position: absolute;
  top: 0;
  right: 0;
  height: 24px;
}

/* The turn tail's copy rides inside the stats strip; revealed with the strip
   on hover so a settled transcript stays visually quiet. */
.cc-tail { cursor: default; }

.cc-tail .cc-msg-actions { height: auto; opacity: 0; transition: opacity var(--ds-transition-duration) var(--ds-ease-in-out); }

.cc-tail:hover .cc-msg-actions, .cc-tail .cc-msg-actions:focus-within { opacity: 1; }

/* A compaction boundary: the conversation was summarized here; the line reads
   as a quiet seam, not a message. */
.cc-compact {
  align-self: stretch;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 2px 0;
}

.cc-compact-line {
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-tertiary);
  letter-spacing: 1px;
  user-select: none;
}

.cc-compact-meta {
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-caption);
}
`)

/**
 * URL extension per image type for the blob route, from the shared table the
 * blob store itself stores under — a local copy could drift from what the
 * route actually serves.
 */
const IMAGE_EXTENSIONS = MEDIA_TYPE_EXTENSIONS

/** Chinese labels for a compaction boundary's trigger; unknown values pass through. */
const COMPACT_TRIGGERS: Record<string, string> = {
  manual: '手动 (/compact)',
  auto: '自动',
}

/** One tool call with its result, or any other transcript entry. */
type Item =
  | { k: 'event'; event: CcEvent }
  | {
    k: 'tool'
    id: string
    call?: Extract<CcEvent, { kind: 'tool_use' }>
    result?: Extract<CcEvent, { kind: 'tool_result' }>
  }

/**
 * Pair each `tool_use` with the `tool_result` that answers it, preserving the
 * order tool calls were made in. A result whose call never arrived (a
 * truncated transcript tail) still renders, as its own row.
 *
 * @param events - the transcript in order.
 * @returns renderable items in transcript order.
 */
export function projectTranscript(events: CcEvent[]): Item[] {
  const items: Item[] = []
  const byToolUseId = new Map<string, Extract<Item, { k: 'tool' }>>()
  for (const event of events) {
    if (event.kind === 'tool_use') {
      const item: Extract<Item, { k: 'tool' }> = { k: 'tool', id: event.toolUseId, call: event }
      byToolUseId.set(event.toolUseId, item)
      items.push(item)
      continue
    }
    if (event.kind === 'tool_result') {
      const pending = byToolUseId.get(event.toolUseId)
      if (pending !== undefined) {
        pending.result = event
        continue
      }
      items.push({ k: 'tool', id: event.toolUseId, result: event })
      continue
    }
    items.push({ k: 'event', event })
  }
  return items
}

/**
 * The one-line summary shown beside a tool's name while collapsed: the single
 * argument that identifies the call, not its whole JSON. A card may override it
 * once the call's own material is known.
 *
 * @param name - wire tool name.
 * @param input - the call arguments.
 * @returns the summary text; empty when no argument identifies the call.
 */
export function toolSummary(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const args = input as Record<string, unknown>
  const pick = (key: string): string => (typeof args[key] === 'string' ? args[key] : '')
  switch (name) {
    case 'Bash':
      return pick('command')
    case 'Read':
    case 'Edit':
    case 'Write':
      return pick('file_path')
    case 'NotebookEdit':
      return pick('notebook_path')
    case 'Grep':
    case 'Glob':
      return pick('pattern')
    case 'WebFetch':
      return pick('url')
    case 'WebSearch':
      return pick('query')
    case 'Task':
      return pick('description')
    case 'TodoWrite':
      return Array.isArray(args.todos) ? `${args.todos.length} 项` : ''
    default: {
      const first = Object.values(args).find(value => typeof value === 'string')
      return typeof first === 'string' ? first : ''
    }
  }
}

/**
 * The session's working directory, as the CLI reported it when the conversation
 * opened. It labels the terminal prompt and shortens every path a card shows,
 * so it is read from the transcript rather than threaded through the page: the
 * last init wins, since a resumed session re-announces its cwd.
 *
 * @param events - the transcript in order.
 * @returns the working directory, or undefined when no init event carried one.
 */
function sessionCwd(events: CcEvent[]): string | undefined {
  let cwd: string | undefined
  for (const event of events) {
    if (event.kind === 'system' && event.subtype === 'init') cwd = stringField(event.data, 'cwd') ?? cwd
  }
  return cwd
}

/** Thinking, shown as its own collapsed disclosure ahead of what it produced. */
function ThinkingItem(props: { text: string }): ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <div className="cc-think">
      <DisclosureRow
        titleClassName="cc-think-title"
        icon={<IconThinkOutline14 />}
        title="思考过程"
        open={open}
        expandable
        expandOnRowClick
        onToggle={() => setOpen(value => !value)}
      >
        <div className="cc-think-body">{props.text}</div>
      </DisclosureRow>
      <div className="cc-msg-actions">
        <CopyAction label="复制思考过程" build={() => props.text} />
      </div>
    </div>
  )
}

/**
 * One hover-revealed icon action with the host's tooltip chrome — the same
 * contract the host's MessageIconActions gives its rows, so a dsh-cc row
 * reads as native.
 *
 * @param props.label - the tooltip and aria-label.
 * @param props.onClick - the action.
 * @param props.children - the icon glyph.
 * @returns the action button.
 */
function IconAction(props: { label: string; onClick(): void; children: ReactNode }): ReactElement {
  return (
    <Tooltip label={props.label} side="bottom">
      <button type="button" className="cc-action" aria-label={props.label} onClick={props.onClick}>
        {props.children}
      </button>
    </Tooltip>
  )
}

/**
 * The copy icon action: the host's check swap for one second after the write
 * lands, with re-click gating so the window can neither re-copy nor stack
 * timers. Text is built on click — never during render — so streaming rows
 * never pay for a copy nobody asked for.
 *
 * @param props.label - the resting tooltip; swaps to 已复制 on success.
 * @param props.build - builds the text at click time.
 * @param props.icon - the resting glyph; defaults to the copy icon.
 * @returns the action button.
 */
function CopyAction(props: { label: string; build(): string; icon?: ReactNode }): ReactElement {
  const [copied, setCopied] = useState(false)
  const pending = useRef(false)
  const timer = useRef<number | null>(null)
  const epoch = useRef(0)
  useEffect(() => () => {
    epoch.current += 1
    pending.current = false
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])
  const onClick = (): void => {
    if (copied || pending.current) return
    const mark = epoch.current
    pending.current = true
    void writeClipboard(props.build()).then(ok => {
      if (mark !== epoch.current) return
      pending.current = false
      if (!ok) return
      setCopied(true)
      timer.current = window.setTimeout(() => {
        timer.current = null
        setCopied(false)
      }, 1000)
    })
  }
  const label = copied ? '已复制' : props.label
  return (
    <Tooltip label={label} side="bottom">
      <button type="button" className="cc-action" aria-label={label} onClick={onClick}>
        {copied ? <IconCheckOutline16 /> : props.icon ?? <IconCopyOutline16 />}
      </button>
    </Tooltip>
  )
}

/**
 * Format a turn's closing stats the way the host closes a turn.
 * @param event - the result event.
 * @returns the stats fragments.
 */
function tailParts(event: Extract<CcEvent, { kind: 'result' }>): string[] {
  const parts = [`${event.numTurns} 步`, `${(event.durationMs / 1000).toFixed(1)}s`]
  if (event.apiDurationMs !== undefined && event.apiDurationMs > 0) {
    parts.push(`模型 ${(event.apiDurationMs / 1000).toFixed(1)}s`)
  }
  if (event.usage !== undefined) {
    const { inputTokens, outputTokens, cacheReadInputTokens } = event.usage
    parts.push(`输入 ${compact(inputTokens)} · 输出 ${compact(outputTokens)}`)
    const cacheable = inputTokens + cacheReadInputTokens
    if (cacheable > 0) parts.push(`缓存命中 ${Math.round((cacheReadInputTokens / cacheable) * 100)}%`)
  }
  if (event.totalCostUsd > 0) parts.push(`$${event.totalCostUsd.toFixed(4)}`)
  return parts
}

/**
 * Render one non-tool transcript event.
 * @param props - the event, the file-mentions resolver its markdown renders
 *   with, the session's cached slash commands for the user row's blue command
 *   token, the optional whole-turn copy builder, and the optional time-travel
 *   actions shown on rows that carry a native message id.
 * @returns the node, or null for an entry with nothing to show.
 */
function EventItem(props: {
  event: CcEvent
  mentions: MarkdownFileMentions
  commands: readonly SlashCommand[]
  buildTurnText?: (event: Extract<CcEvent, { kind: 'user' }>) => string
  buildReplyText?: (event: Extract<CcEvent, { kind: 'result' }>) => string
  onFork?: (event: Extract<CcEvent, { kind: 'user' }>) => void
  onRewind?: (event: Extract<CcEvent, { kind: 'user' }>) => void
}): ReactElement | null {
  const { event } = props
  switch (event.kind) {
    case 'user': {
      // The leading token of a slash command, recognized against the
      // session's catalog, keeps the composer's blue recognition span in the
      // settled row too — the same "this will invoke that command" feedback.
      // The .cc-cmd-token rule itself lives in the composer's sheet, which
      // co-mounts with the transcript in every session view.
      const lead = commandToken(event.text)
      const hit = lead !== undefined ? matchCommand(lead, props.commands) : undefined
      const body = hit !== undefined && lead !== undefined
        ? (
          <>
            <span className="cc-cmd-token">{lead}</span>
            {event.text.slice(lead.length)}
          </>
        )
        : event.text
      return (
        <div className="cc-user-wrap">
          <div className="cc-user">
            {event.images !== undefined && event.images.length > 0 && (
              <div className="cc-user-images">
                {event.images.map(image => (
                  <a
                    key={image.id}
                    href={`/cc/api/blobs/${image.id}.${IMAGE_EXTENSIONS[image.mediaType]}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <img
                      src={`/cc/api/blobs/${image.id}.${IMAGE_EXTENSIONS[image.mediaType]}`}
                      alt={image.name ?? '附件'}
                    />
                  </a>
                ))}
              </div>
            )}
            {body}
          </div>
          {/* Host-parity icon chrome: 复制/复制回合 work off the events list
              alone so they show on every user row; 分叉/回滚 still need the
              native-message anchor. Tooltips carry what the glyphs don't say. */}
          <div className="cc-user-actions">
            <CopyAction label="复制" build={() => event.text} />
            {props.buildTurnText !== undefined && (
              <CopyAction
                label="复制回合（输入 + 回复 + 工具与思考）"
                icon={<IconShareOutline16 />}
                build={() => props.buildTurnText?.(event) ?? ''}
              />
            )}
            {event.nativeMessageId !== undefined && props.onFork !== undefined && (
              <IconAction label="分叉：从此消息开新会话" onClick={() => { props.onFork?.(event) }}>
                <IconBranchOutline16 />
              </IconAction>
            )}
            {event.nativeMessageId !== undefined && props.onRewind !== undefined && (
              <IconAction label="回滚文件：恢复到此消息时" onClick={() => { props.onRewind?.(event) }}>
                <IconRefreshOutline16 />
              </IconAction>
            )}
          </div>
        </div>
      )
    }
    case 'compactBoundary': {
      const parts: string[] = []
      if (event.preTokens !== undefined && event.postTokens !== undefined) {
        parts.push(`前 ${compact(event.preTokens)} tokens → 后 ${compact(event.postTokens)} tokens`)
      } else if (event.preTokens !== undefined) {
        parts.push(`压缩前 ${compact(event.preTokens)} tokens`)
      }
      const trigger = COMPACT_TRIGGERS[event.trigger] ?? event.trigger
      if (trigger !== '') parts.push(`触发：${trigger}`)
      return (
        <div className="cc-compact">
          <div className="cc-compact-line">── 对话已压缩 ──</div>
          {parts.length > 0 && <div className="cc-compact-meta">{parts.join(' · ')}</div>}
        </div>
      )
    }
    case 'assistant':
      return (
        <div className="cc-assistant-wrap">
          <div className="cc-assistant">
            <MarkdownText text={event.text} fileMentions={props.mentions} />
            {event.aborted === true && <div className="cc-note">已中断</div>}
          </div>
          {/* The host closes every assistant turn with a copy control; a
              dsh-cc turn interleaves several prose segments around tool
              calls, so each segment carries its own. */}
          <div className="cc-msg-actions">
            <CopyAction label="复制" build={() => event.text} />
          </div>
        </div>
      )
    case 'thinking':
      return <ThinkingItem text={event.text} />
    case 'system': {
      if (event.subtype !== 'init') return <div className="cc-note">{event.subtype}</div>
      const model = typeof event.data.model === 'string' ? event.data.model : ''
      return <div className="cc-note">已连接 Claude Code{model !== '' ? ` · ${model}` : ''}</div>
    }
    case 'result': {
      if (event.isError) {
        const reason = event.errors?.join('；') ?? event.terminalReason ?? event.subtype
        return <div className="cc-fail">回合异常结束：{reason}</div>
      }
      // A zero-turn result closes a local slash command's bypass: the
      // command's own output and notices already ride their rows, and
      // 「0 步 · 0.0s · 输入 0 · 输出 0」 under them is pure noise.
      if (event.numTurns === 0) return null
      const parts = tailParts(event)
      return (
        <div className="cc-tail">
          {parts.map((part, index) => (
            <span key={part}>
              {index > 0 && <span className="cc-tail-sep"> · </span>}
              {part}
            </span>
          ))}
          {/* Host-parity tail copy: the turn's whole prose as one text, the
              same thing the host's turn tail writes. */}
          {props.buildReplyText !== undefined && (
            <span className="cc-msg-actions">
              <CopyAction label="复制整段回复" build={() => props.buildReplyText?.(event) ?? ''} />
            </span>
          )}
        </div>
      )
    }
    case 'error':
      return <div className="cc-fail">{event.message}</div>
    case 'commandOutput':
      return (
        <div className="cc-command-output">
          <div className="cc-command-output-title">命令输出</div>
          <MarkdownText text={event.text} fileMentions={props.mentions} />
        </div>
      )
    case 'notice':
      return <div className={`cc-note cc-note-${event.level}`}>{event.text}</div>
    default:
      return null
  }
}

/**
 * Render one paired tool call.
 * @param props.item - the paired call and result.
 * @param props.cwd - the session working directory.
 * @returns the row element.
 */
function ToolItem(props: { item: Extract<Item, { k: 'tool' }>; cwd: string | undefined }): ReactElement {
  const { call, result } = props.item
  const name = call?.name ?? '工具'
  return (
    <ToolRow
      name={name}
      input={call?.input}
      // The result event itself, not a reshaped copy: ToolRow is memo'd, and
      // the event's identity is stable in the events array while a fresh
      // `{ text, isError }` object per render would defeat that memo.
      result={result}
      summary={call === undefined ? '' : toolSummary(name, call.input)}
      cwd={props.cwd}
    />
  )
}

/**
 * Render a whole transcript.
 *
 * Memo'd on its props: the parent re-renders on every stream delta, but the
 * current session's events array keeps its identity until an event actually
 * commits, and the commands array only changes when the session's cached
 * catalog does, so the O(n) projection and every ToolRow's card parse run
 * only when the transcript really changed. The action callbacks must be
 * stable for the same reason — the parent passes useCallback'd handlers, and
 * the live turn arrives as a ref (identity-stable, read at click time)
 * precisely because passing its value would re-render the whole column per
 * delta.
 * @param props - the ordered events, the session's cached slash commands
 *   (the user row's blue command token is best-effort: no cache, no blue),
 *   the optional fork / file-rewind callbacks for user rows that carry a
 *   native message id, and the parent's ref to the in-flight turn so「复制
 *   回合」on the newest row includes what is still streaming.
 * @returns the transcript nodes.
 */
export const Transcript = memo(function Transcript(props: {
  events: CcEvent[]
  commands: readonly SlashCommand[]
  onFork?: (event: Extract<CcEvent, { kind: 'user' }>) => void
  onRewind?: (event: Extract<CcEvent, { kind: 'user' }>) => void
  liveRef?: { readonly current: LiveTurnState | undefined }
}): ReactElement {
  const items = useMemo(() => projectTranscript(props.events), [props.events])
  const cwd = useMemo(() => sessionCwd(props.events), [props.events])
  // The state setter is identity-stable, so the resolver changes only when
  // the cwd does; a settled render's mentions cannot go stale mid-turn.
  const [viewPath, setViewPath] = useState<string | undefined>()
  const mentions = useMemo(() => fileMentionsFor(cwd, setViewPath), [cwd])
  // Built per settled render, read only on click: the events array here is
  // the committed truth, while the live turn is fetched through the ref so
  // the newest block a click catches is the newest block there is.
  const buildTurnText = (event: Extract<CcEvent, { kind: 'user' }>): string =>
    formatTurnForCopy({ events: props.events, userSeq: event.seq, live: props.liveRef?.current })
  // The turn-tail copy: the turn's whole prose as one text, host semantics.
  const buildReplyText = (event: Extract<CcEvent, { kind: 'result' }>): string =>
    turnAssistantText(props.events, event.seq)
  return (
    <>
      {items.map((item, index) => item.k === 'tool'
        ? <ToolItem key={`tool:${item.id}`} item={item} cwd={cwd} />
        : <EventItem
            key={`event:${item.event.seq}:${index}`}
            event={item.event}
            mentions={mentions}
            commands={props.commands}
            buildTurnText={buildTurnText}
            buildReplyText={buildReplyText}
            onFork={props.onFork}
            onRewind={props.onRewind}
          />)}
      {viewPath !== undefined && <FileViewer path={viewPath} onClose={() => setViewPath(undefined)} />}
    </>
  )
})
