/**
 * The Claude Code surface: session rail, status strip, transcript, pending
 * interactions, and the composer.
 *
 * This module owns cross-cutting state only — the live SSE subscription, the
 * selected session, and the per-session transcript cache. Each region is its
 * own module so they can evolve independently.
 *
 * Escape is handled here rather than at the layer entry, and only when no
 * floating layer is open: modals, the inline directory picker, a rename edit
 * all report themselves through the overlay signal (see ./overlay.ts), and the
 * surface reads that count from a ref at key-press time, so an Escape that
 * closes one layer can never fall through and close the surface under it.
 *
 * @module dsh-cc/client/App
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { Composer } from './Composer.tsx'
import { PermissionCard, QuestionCard } from './Interaction.tsx'
import { SessionRail } from './SessionRail.tsx'
import { StatusBar } from './StatusBar.tsx'
import { LiveTurnView } from './LiveTurnView.tsx'
import { reduceDelta, type LiveTurn } from '../live-turn.ts'
import { TodoPin } from './TodoPin.tsx'
import { TaskPanel } from './TaskPanel.tsx'
import { Transcript } from './Transcript.tsx'
import { QueuedList } from './QueuedList.tsx'
import { SettingsModal } from './settings/SettingsModal.tsx'
import { SessionEnvModal } from './settings/SessionEnvModal.tsx'
import { OverlayContext, useOverlay, type OverlaySignal } from './overlay.ts'
import { connectEvents } from './api/http.ts'
import { answerDialog, answerPermission, fetchCommands } from './api/interaction.ts'
import {
  backgroundTask, createSession, deleteSession, fetchSession, fetchSessions, forkSession, renameSession,
  rewindApply, rewindPreview, sendMessage, stopSession, stopTask, type RewindResult,
} from './api/sessions.ts'
import { fetchConfig } from './api/settings.ts'
import { fetchContext, fetchUsage, setPermissionMode, setEffort, type ContextUsage, type UsageInfo } from './api/telemetry.ts'
import type {
  CcEvent, ConfigSummary, LiveTurnSnapshot, PermissionAnswer, PermissionRequest, SessionMeta, SlashCommand,
  TaskRow,
} from '../types.ts'
import { PERMISSION_MODE_VALUES } from '../types.ts'

/** One pending permission request, tagged with the session it belongs to. */
interface PendingPermission {
  sessionId: string
  request: PermissionRequest
}

/** One pending dialog, tagged with the session it belongs to. */
interface PendingDialog {
  sessionId: string
  id: string
  payload: Record<string, unknown>
}

/**
 * One file-rewind in flight through its confirm popover: the anchor message,
 * the preview the CLI answered with, and whether the apply already ran (the
 * popover then shows the result posture with the CLI's own skipped-links
 * report instead of the confirm buttons).
 */
interface RewindTarget {
  sessionId: string
  userMessageId: string
  result: RewindResult
  applied: boolean
}

/** One session's folded live turn plus the delta counter it was folded to. */
interface LiveEntry {
  seq: number
  turn: LiveTurn | undefined
}

/** Shared empty transcript, so a session with no events keeps one stable identity. */
const NO_EVENTS: CcEvent[] = []

/** Shared empty command list, so an uncached session keeps one stable identity. */
const NO_COMMANDS: SlashCommand[] = []

/** Shared empty task list, so a task-less session keeps one stable identity. */
const NO_TASKS: TaskRow[] = []

/**
 * Field fingerprint of one sessions frame: the node half re-serializes the
 * whole catalog per rescan, so a broadcast carries fresh object identities
 * even when nothing visible moved (a busy turn bumps the CLI transcript's
 * mtime → the catalog signature → a frame every 2s for the whole list).
 * Returning `previous` from the state updater bails the re-render that would
 * otherwise rebuild the entire rail.
 * @param list - one sessions frame.
 * @returns the joined per-row rendered fields.
 */
function sessionFingerprint(list: SessionMeta[]): string {
  return list.map(session => [
    session.id, session.name, session.cwd, session.status, session.updatedAt,
    session.model, session.effort ?? '', session.permissionMode ?? '',
    session.gitBranch ?? '', session.lastGoodModel ?? '', session.lastError ?? '',
    session.messageCount, session.totalCostUsd, session.queued ?? 0,
    session.terminalOwned === true,
  ].join('')).join('')
}

/** localStorage key holding the last live slash-command catalog (see CcApp). */
const COMMAND_CACHE_KEY = 'dsh-cc:commands-v2'

/**
 * The persisted slash-command catalog, stamped with the environment it was
 * read under: the list mixes built-ins, project commands (`cwd`), and account
 * skills (`configDir`), so an unstamped cache would offer one project's
 * `/deploy` in another project's menu — and paint the recognition token on
 * drafts the CLI would reject.
 */
interface CommandCache {
  cwd: string
  configDir: string
  commands: SlashCommand[]
}

/**
 * Read the persisted slash-command catalog; anything unreadable, absent, or
 * wrong-shaped reads as absent (the first live fetch rewrites it).
 * @returns the stamped cache, or undefined.
 */
function readCommandCache(): CommandCache | undefined {
  try {
    const raw = localStorage.getItem(COMMAND_CACHE_KEY)
    if (raw === null) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const { cwd, configDir, commands } = parsed as { cwd?: unknown; configDir?: unknown; commands?: unknown }
    if (typeof cwd !== 'string' || typeof configDir !== 'string' || !Array.isArray(commands)) return undefined
    const clean = commands.filter((item): item is SlashCommand =>
      typeof item === 'object' && item !== null && typeof (item as SlashCommand).name === 'string')
    return { cwd, configDir, commands: clean }
  } catch {
    return undefined
  }
}

/**
 * Union two views of one session's transcript by `seq`. The SSE stream and a
 * re-read snapshot can overlap arbitrarily — the same event seen over the wire
 * and again in a fetch — and a plain append would duplicate it. The first-seen
 * copy wins on a collision (events are immutable once committed); when the
 * incoming list adds nothing, the current array's identity is kept so
 * memoized rows below do not re-render for nothing.
 *
 * @param current - the events already held for the session, `seq`-ascending.
 * @param incoming - a server snapshot or another stream view of the same session.
 * @returns the merged list, `seq`-ascending; `current` itself when it already
 *   covers everything `incoming` carries.
 */
function mergeBySeq(current: CcEvent[], incoming: CcEvent[]): CcEvent[] {
  if (current.length === 0) return incoming
  const bySeq = new Map<number, CcEvent>()
  for (const event of current) bySeq.set(event.seq, event)
  let added = false
  for (const event of incoming) {
    if (bySeq.has(event.seq)) continue
    bySeq.set(event.seq, event)
    added = true
  }
  if (!added) return current
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq)
}

/**
 * The Claude Code surface.
 * @param props - the close callback, invoked by Escape or the close control.
 * @returns the surface node.
 */
export function CcApp(props: { onClose(): void }): ReactElement {
  const [config, setConfig] = useState<ConfigSummary | undefined>()
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [currentId, setCurrentId] = useState<string | undefined>()
  /**
   * The transcript tail of EVERY session that has streamed while the page was
   * open, keyed by session id. Switching sessions must never show one
   * session's events under another's title, and an event that lands while a
   * switch is in flight must land in its own session's list — both fall out
   * of keying, where the flat list needed race guards to approximate it.
   */
  const [eventsBySession, setEventsBySession] = useState<Record<string, CcEvent[]>>({})
  const [usage, setUsage] = useState<UsageInfo | undefined>()
  const [context, setContext] = useState<ContextUsage | undefined>()
  const [permissions, setPermissions] = useState<PendingPermission[]>([])
  const [dialogs, setDialogs] = useState<PendingDialog[]>([])
  /**
   * The in-flight turn of EVERY session, not just the selected one: a turn
   * keeps streaming while its session is in the background, and switching
   * back must restore it rather than restart the view from scratch.
   */
  const [liveBySession, setLiveBySession] = useState<Record<string, LiveEntry>>({})
  /**
   * The task snapshot of EVERY session, keyed by session id: tasks keep
   * running while their session is in the background, and the panel must
   * restore from the last snapshot when the user switches back.
   */
  const [tasksBySession, setTasksBySession] = useState<Record<string, TaskRow[]>>({})
  /**
   * The cached slash-command catalog of EVERY session, keyed by session id:
   * the composer's menu and the blue recognition token (draft and transcript
   * rows) read it, and it fills on selection, on menu open, and when a turn
   * ends — a catalog is readable only while the engine is live.
   */
  const [commandsBySession, setCommandsBySession] = useState<Record<string, SlashCommand[]>>({})
  /**
   * The last live catalog, persisted across page loads, stamped with the
   * environment it was read under (cwd + account root): the command list
   * mixes built-ins, project commands, and account skills, so the cache only
   * serves a session in the same environment. A live fetch always wins and
   * rewrites the cache.
   */
  const [commandCache, setCommandCache] = useState<CommandCache | undefined>(readCommandCache)
  const [connected, setConnected] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  /** Alt+P 信号：每次递增请求模型菜单自开（0 是未触发默认值，挂载永不生效）。 */
  const [modelMenuSignal, setModelMenuSignal] = useState(0)
  /** Alt+T 切换的回退档位：会话最近一次显式 effort，见下方热键 effect。 */
  const lastEffortRef = useRef('')
  const [envSessionId, setEnvSessionId] = useState<string | undefined>()
  /** 待确认/待展示结果的文件回滚，见 RewindTarget。 */
  const [rewindTarget, setRewindTarget] = useState<RewindTarget | undefined>()
  const [error, setError] = useState<string | undefined>()
  const currentIdRef = useRef(currentId)
  const scrollRef = useRef<HTMLDivElement>(null)
  /** Whether the transcript is pinned to the bottom (following the stream). */
  const pinnedRef = useRef(true)
  /** End-of-content marker; a pending card is nudged into view through it. */
  const attentionRef = useRef<HTMLDivElement>(null)
  /** Last delta counter folded per session; the ref mirror survives renders. */
  const liveSeqsRef = useRef<Record<string, number>>({})
  /** Sessions whose server fold needs re-fetching after a frame gap. */
  const liveGapPending = useRef<Set<string>>(new Set())
  /** Debounce for that re-fetch, so one reconnect costs one request. */
  const liveGapTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  /** Last native-session update mirrored into the page, per session. */
  const foreignSync = useRef<{ id: string; updatedAt: string } | undefined>(undefined)
  /** Debounce for that mirror, so a burst of frames collapses into one read. */
  const foreignSyncTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  /**
   * Every floating layer currently open, as opaque tokens. Escape reads this
   * set at key-press time; a layer's own handler then closes just that layer.
   */
  const overlaysRef = useRef<Set<object>>(new Set())
  const overlaySignal = useMemo<OverlaySignal>(() => ({
    register: () => {
      const token = {}
      overlaysRef.current.add(token)
      return () => {
        overlaysRef.current.delete(token)
      }
    },
  }), [])
  useOverlay(showSettings)
  useOverlay(envSessionId !== undefined)
  useOverlay(rewindTarget !== undefined)

  const current = sessions.find(session => session.id === currentId)
  const events = currentId !== undefined ? eventsBySession[currentId] ?? NO_EVENTS : NO_EVENTS
  const live = currentId !== undefined ? liveBySession[currentId]?.turn : undefined

  const fail = useCallback((cause: unknown): void => {
    setError(cause instanceof Error ? cause.message : String(cause))
  }, [])

  useEffect(() => {
    currentIdRef.current = currentId
  }, [currentId])

  /** Remove one session's folded turn; its result committed or it errored. */
  const dropLive = (sessionId: string): void => {
    setLiveBySession(previous => {
      if (!(sessionId in previous)) return previous
      const next = { ...previous }
      delete next[sessionId]
      return next
    })
  }

  /**
   * Fold one session's transcript tail with a server snapshot, deduplicated
   * by `seq` — see {@link mergeBySeq}.
   * @param sessionId - the session the events belong to.
   * @param incoming - the server's view of the same tail.
   */
  const mergeSessionEvents = (sessionId: string, incoming: CcEvent[]): void => {
    setEventsBySession(previous => {
      const merged = mergeBySeq(previous[sessionId] ?? [], incoming)
      if (merged === previous[sessionId]) return previous
      return { ...previous, [sessionId]: merged }
    })
  }

  /**
   * Adopt the server's folded turn for one session when it is not behind the
   * frames already folded locally — the snapshot is how a page that joins
   * mid-turn (selection, reload, reconnect gap) catches up without ever
   * regressing a turn it has been watching all along.
   * @param sessionId - the session the snapshot belongs to.
   * @param snapshot - the server fold with its delta counter; an old server
   *   half serves no `live` field at all, which degrades to a no-op rather
   *   than a crash (a rebuilt client can briefly outlive its server process).
   */
  const applyLiveSnapshot = (sessionId: string, snapshot: LiveTurnSnapshot | undefined): void => {
    if (snapshot === undefined || typeof snapshot.seq !== 'number') return
    if (snapshot.seq < (liveSeqsRef.current[sessionId] ?? 0)) return
    liveSeqsRef.current[sessionId] = snapshot.seq
    setLiveBySession(previous => ({ ...previous, [sessionId]: { seq: snapshot.seq, turn: snapshot.turn ?? undefined } }))
    // Replay requests that were parked while no page was watching: union by id,
    // so a card the live frames already delivered is never duplicated (and one
    // the frames missed — reload mid-request — still appears). Removal stays
    // with the *-done frames; the server auto-denies on turn stop/engine death.
    const perms = snapshot.pendingPermissions
    if (perms !== undefined && perms.length > 0) {
      setPermissions(previous => {
        const known = new Set(previous.map(item => item.request.id))
        const seeds = perms.filter(request => !known.has(request.id)).map(request => ({ sessionId, request }))
        return seeds.length > 0 ? [...previous, ...seeds] : previous
      })
    }
    const dialogsSnapshot = snapshot.pendingDialogs
    if (dialogsSnapshot !== undefined && dialogsSnapshot.length > 0) {
      setDialogs(previous => {
        const known = new Set(previous.map(item => item.id))
        const seeds = dialogsSnapshot.filter(request => !known.has(request.id)).map(({ id, payload }) => ({ sessionId, id, payload }))
        return seeds.length > 0 ? [...previous, ...seeds] : previous
      })
    }
  }

  /**
   * Re-fetch the server fold for sessions whose frame stream jumped — the
   * local fold has holes the reducer will not fill on its own. The same read
   * recovers events that committed during the gap: nothing re-sends them.
   * Debounced so one reconnect costs one request, not one per missed frame.
   * @param sessionId - the session whose stream showed a counter gap.
   */
  const scheduleLiveCatchUp = (sessionId: string): void => {
    if (liveGapPending.current.has(sessionId)) return
    liveGapPending.current.add(sessionId)
    clearTimeout(liveGapTimer.current)
    liveGapTimer.current = setTimeout(() => {
      const ids = [...liveGapPending.current]
      liveGapPending.current.clear()
      for (const id of ids) {
        fetchSession(id)
          .then(result => {
            applyLiveSnapshot(id, result.live)
            mergeSessionEvents(id, result.events)
            setTasksBySession(previous => ({ ...previous, [id]: result.tasks }))
          })
          .catch(() => {
            // Best effort; the next gap (or the next selection) retries.
          })
      }
    }, 250)
  }

  /**
   * Re-read whichever session is being watched. Used on SSE (re)connection
   * and on `hello`: a turn that ENDED while the stream was down leaves no
   * delta hole to detect, so a full re-read is the only carrier of the
   * events that committed during the gap.
   */
  const catchUpCurrent = (): void => {
    const id = currentIdRef.current
    if (id !== undefined) scheduleLiveCatchUp(id)
  }

  /**
   * Refresh the telemetry snapshots for one session.
   * @param id - the session to read, or undefined to do nothing.
   */
  const refreshTelemetry = (id: string | undefined): void => {
    if (id === undefined) return
    // Both readouts are single global states under the current session's
    // status bar; a slow answer from a session the user already left must
    // not land there (the currency check mirrors the commands fetch below).
    fetchUsage(id)
      .then(result => {
        if (currentIdRef.current === id) setUsage(result.usage)
      })
      .catch(() => {
        if (currentIdRef.current === id) setUsage(undefined)
      })
    fetchContext(id)
      .then(result => {
        if (currentIdRef.current === id && result.available && result.context !== undefined) {
          setContext(result.context)
        }
      })
      .catch(() => {
        // A cold session has no live process to ask; the meter stays hidden.
      })
  }

  /**
   * The sessions list mirrored into a ref, so stable callbacks can read the
   * current rows without depending on the state (and re-created per frame).
   */
  const sessionsRef = useRef(sessions)
  useEffect(() => {
    sessionsRef.current = sessions
  })

  /**
   * Adopt a freshly read catalog: per-session for freshness, and into the
   * persistent cache (stamped with this session's environment) so cold
   * sessions in the SAME project and account can open the menu after a
   * restart.
   * @param id - the session the catalog was read from.
   * @param commands - the live catalog.
   */
  const adoptCommands = useCallback((id: string, commands: SlashCommand[]): void => {
    setCommandsBySession(previous => ({ ...previous, [id]: commands }))
    if (commands.length === 0) return
    const session = sessionsRef.current.find(item => item.id === id)
    if (session === undefined) return
    const entry: CommandCache = { cwd: session.cwd, configDir: session.configDir ?? '', commands }
    setCommandCache(entry)
    try {
      localStorage.setItem(COMMAND_CACHE_KEY, JSON.stringify(entry))
    } catch {
      // Private mode or quota: the in-memory copy still serves this page.
    }
  }, [])

  /**
   * The command catalog a session should read right now: its live fetch when
   * one landed, else the persisted cache — but only when the cache was read
   * under the same cwd and account root, since the list is environment-bound.
   * @param session - the session the menu/token is for.
   * @returns the commands; a stable empty list when nothing applies.
   */
  const commandsFor = (session: SessionMeta): readonly SlashCommand[] => {
    const live = commandsBySession[session.id]
    if (live !== undefined) return live
    if (commandCache === undefined) return NO_COMMANDS
    return commandCache.cwd === session.cwd && commandCache.configDir === (session.configDir ?? '')
      ? commandCache.commands
      : NO_COMMANDS
  }

  /**
   * Refetch one session's slash-command catalog into the cache — the
   * composer's menu-open refresh and the turn-end warm both route here.
   * @param id - the session whose catalog to read.
   */
  const refreshCommands = useCallback((id: string): void => {
    fetchCommands(id)
      .then(result => {
        // A stale answer is the server's remembered catalog for a cold session;
        // adopting it is fine (it usually matches the local cache) but it must
        // not displace a live catalog that an earlier fetch already landed.
        if (result.available && !(result.stale === true && commandsBySession[id] !== undefined)) {
          adoptCommands(id, result.commands)
        }
      })
      .catch(() => {
        // Best effort; the next menu open retries.
      })
  }, [adoptCommands, commandsBySession])

  useEffect(() => {
    let disposed = false
    fetchConfig()
      .then(result => {
        if (!disposed) setConfig(result.config)
      })
      .catch(fail)
    fetchSessions()
      .then(result => {
        if (disposed) return
        setSessions(result.sessions)
        setCurrentId(previous => previous ?? result.sessions[0]?.id)
      })
      .catch(fail)

    const dispose = connectEvents(message => {
      switch (message.t) {
        case 'hello':
          setConfig(message.config)
          catchUpCurrent()
          break
        case 'sessions': {
          // Same-fields frame → same render: keep the previous array identity
          // and skip the rail rebuild (see sessionFingerprint).
          setSessions(previous =>
            sessionFingerprint(previous) === sessionFingerprint(message.sessions)
              ? previous
              : message.sessions)
          // A live entry whose session is no longer busy belongs to a turn
          // that finished while its result frame was missed (an SSE
          // reconnect); the committed transcript carries the content now.
          const busy = new Set(message.sessions
            .filter(session => session.status === 'busy')
            .map(session => session.id))
          setLiveBySession(previous => {
            let changed = false
            const next = { ...previous }
            for (const id of Object.keys(next)) {
              if (!busy.has(id)) {
                delete next[id]
                changed = true
              }
            }
            return changed ? next : previous
          })
          // Cached transcripts of sessions that left the catalog (deleted
          // here or in a terminal) go with them.
          setEventsBySession(previous => {
            const alive = new Set(message.sessions.map(session => session.id))
            let changed = false
            const next = { ...previous }
            for (const id of Object.keys(next)) {
              if (!alive.has(id)) {
                delete next[id]
                changed = true
              }
            }
            return changed ? next : previous
          })
          // Their task snapshots go with them too.
          setTasksBySession(previous => {
            const alive = new Set(message.sessions.map(session => session.id))
            let changed = false
            const next = { ...previous }
            for (const id of Object.keys(next)) {
              if (!alive.has(id)) {
                delete next[id]
                changed = true
              }
            }
            return changed ? next : previous
          })
          // And their cached slash commands.
          setCommandsBySession(previous => {
            const alive = new Set(message.sessions.map(session => session.id))
            let changed = false
            const next = { ...previous }
            for (const id of Object.keys(next)) {
              if (!alive.has(id)) {
                delete next[id]
                changed = true
              }
            }
            return changed ? next : previous
          })
          // A session a terminal CLI holds open advances its transcript with
          // no engine of ours involved, so nothing streams into the page for
          // it; re-reading is the only way to mirror it.
          //
          // `origin` cannot gate this: adopting a CLI session leaves origin
          // 'cli' even while this page drives it, so every web-driven turn was
          // re-reading — and overwriting — the events it had just streamed.
          // Ownership is the fact that actually distinguishes the two.
          const current = message.sessions.find(session => session.id === currentIdRef.current)
          if (current !== undefined && current.terminalOwned === true
            && (foreignSync.current === undefined
              || foreignSync.current.id !== current.id
              || foreignSync.current.updatedAt !== current.updatedAt)) {
            foreignSync.current = { id: current.id, updatedAt: current.updatedAt }
            clearTimeout(foreignSyncTimer.current)
            foreignSyncTimer.current = setTimeout(() => {
              const id = currentIdRef.current
              if (id === undefined) return
              fetchSession(id)
                .then(result => {
                  if (currentIdRef.current === id) mergeSessionEvents(id, result.events)
                })
                .catch(() => {
                  // The mirror is best-effort; the next change retries.
                })
            }, 800)
          }
          break
        }
        case 'event':
          // The turn's own end retires its live tail in every session, watched
          // or not — a background entry would otherwise ghost-render when the
          // user switches to it. Within a turn nothing is cleared: blocks
          // commit one at a time (the thinking event lands while the text
          // block is still streaming), and a block already committed is
          // hidden by its `closed` flag instead.
          if (message.event.kind === 'result' || message.event.kind === 'error') {
            dropLive(message.sessionId)
          }
          // Events are filed under the session they belong to, watched or
          // not: a background session's tail is complete when the user
          // switches to it, without a re-read racing the switch.
          setEventsBySession(previous => {
            const existing = previous[message.sessionId] ?? []
            return { ...previous, [message.sessionId]: [...existing, message.event] }
          })
          if (message.event.kind === 'result') {
            // A finished turn proves its engine is live, so its command
            // catalog reads now; warm the cache, watched session or not.
            // Telemetry needs no fetch here: the node half pushes its own
            // per-response `telemetry` frame with fresher numbers.
            refreshCommands(message.sessionId)
          }
          break
        case 'delta': {
          const { sessionId, seq } = message
          const last = liveSeqsRef.current[sessionId] ?? 0
          // An old server half sends no counter; the fold still works, only
          // the reconcile bookkeeping stays inert until an upgrade.
          if (typeof seq === 'number') {
            liveSeqsRef.current[sessionId] = seq
            // A counter jump means frames were lost on the way here; fold what
            // arrives, but line the session up for a server-fold catch-up.
            if (last > 0 && seq > last + 1) scheduleLiveCatchUp(sessionId)
          }
          // No currency filter: background turns fold too, so switching back
          // to them restores the stream instead of losing it.
          setLiveBySession(previous => {
            const turn = reduceDelta(previous[sessionId]?.turn, message.delta)
            return { ...previous, [sessionId]: { seq: typeof seq === 'number' ? seq : last, turn } }
          })
          break
        }
        case 'permission':
          setPermissions(previous => [...previous, { sessionId: message.sessionId, request: message.request }])
          break
        case 'permission-done':
          setPermissions(previous => previous.filter(item => item.request.id !== message.requestId))
          break
        case 'dialog':
          setDialogs(previous => [...previous, {
            sessionId: message.sessionId,
            id: message.request.id,
            payload: message.request.payload,
          }])
          break
        case 'dialog-done':
          setDialogs(previous => previous.filter(item => item.id !== message.requestId))
          break
        case 'tasks':
          // Snapshot rows replace the whole table: the frame is the server's
          // authoritative fold, so partial merges would only add staleness.
          setTasksBySession(previous => ({ ...previous, [message.sessionId]: message.tasks }))
          break
        case 'telemetry': {
          // Refreshed once per completed model response (the statusline
          // cadence) — no polling, no per-delta churn. Only the watched
          // session's status bar shows these; a background session's frame
          // is dropped here and refetched on switch.
          if (message.sessionId !== currentIdRef.current) break
          if (message.context !== undefined) setContext(message.context as ContextUsage)
          if (message.usage !== undefined) setUsage(message.usage as UsageInfo)
          break
        }
        default:
          // An unknown frame from a newer node half is ignored rather than
          // breaking the stream.
          break
      }
    }, up => {
      setConnected(up)
      // The stream coming back up is the one moment a re-read is needed
      // without a counter gap to announce it.
      if (up) catchUpCurrent()
    })

    return () => {
      disposed = true
      clearTimeout(foreignSyncTimer.current)
      clearTimeout(liveGapTimer.current)
      dispose()
    }
  }, [])

  useEffect(() => {
    if (currentId === undefined) return
    let stale = false
    // Entering a session starts pinned at the bottom of its transcript.
    pinnedRef.current = true
    fetchSession(currentId)
      .then(result => {
        if (stale) return
        // Merged, not replaced: events that streamed in over SSE while this
        // request was in flight must survive the snapshot landing.
        mergeSessionEvents(currentId, result.events)
        // The selection may land mid-turn (page opened on a running session,
        // or reloaded): adopt the server's fold unless local frames already
        // ran ahead of it.
        applyLiveSnapshot(currentId, result.live)
        // Seed the task snapshot the same way: tasks may have been running
        // since before the page opened, with no frame yet witnessed.
        setTasksBySession(previous => ({ ...previous, [currentId]: result.tasks }))
      })
      .catch(cause => {
        if (!stale) fail(cause)
      })
    setContext(undefined)
    setUsage(undefined)
    refreshTelemetry(currentId)
    // The command cache loads on selection when the engine is already live
    // (a returning visit); a cold session reads available:false and falls
    // back to the persisted global catalog until its first turn ends or the
    // composer's menu opens.
    fetchCommands(currentId)
      .then(result => {
        if (currentIdRef.current === currentId && result.available) {
          adoptCommands(currentId, result.commands)
        }
      })
      .catch(() => {
        // Best effort; the next menu open retries.
      })
    return () => {
      stale = true
    }
  }, [currentId])

  // Follow the stream only while the user is at the bottom: scrolling up to
  // read must not be fought by the stream appending below. Coming back within
  // the threshold resumes following. Deltas land many per painted frame; a
  // synchronous scrollHeight read + scrollTop write per delta would force a
  // full-transcript layout each time, so the follow coalesces to one per
  // painted frame.
  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    if (!pinnedRef.current) return
    const frame = requestAnimationFrame(() => {
      if (pinnedRef.current && element.isConnected) element.scrollTop = element.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [events.length, live, currentId])

  const currentPermissions = permissions.filter(item => item.sessionId === currentId)
  const currentDialogs = dialogs.filter(item => item.sessionId === currentId)
  const pendingKey = `${currentPermissions.map(item => item.request.id).join('|')}#${currentDialogs.map(item => item.id).join('|')}`

  // A permission or question card for the watched session arrives below the
  // fold exactly when it is most urgent; nudge it into view. `block: 'nearest'`
  // so an already-visible card does not move anything.
  useEffect(() => {
    if (currentPermissions.length === 0 && currentDialogs.length === 0) return
    attentionRef.current?.scrollIntoView({ block: 'nearest' })
  }, [pendingKey, currentPermissions.length, currentDialogs.length])

  /** Pending permission/question counts per session, for the rail's badges. */
  const pendingBySession = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const item of permissions) counts[item.sessionId] = (counts[item.sessionId] ?? 0) + 1
    for (const item of dialogs) counts[item.sessionId] = (counts[item.sessionId] ?? 0) + 1
    return counts
  }, [permissions, dialogs])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // The Escape that cancels an IME composition belongs to the input, not
      // the page; closing the surface here would eat a half-typed draft.
      if (event.isComposing || event.keyCode === 229) return
      // Any open layer — modal, directory picker, rename edit, new-session
      // form — owns the key and closes just itself through its own handler.
      if (overlaysRef.current.size > 0) return
      props.onClose()
    }
    // Capture phase, deliberately: a dialog closes itself from a `document`
    // bubble listener, and React flushes that state update at the microtask
    // checkpoint BETWEEN the two listeners. The overlay count lives in a ref
    // read here, at key-press time, so that flush cannot flip the answer.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [props.onClose])

  // 会话最近一次显式 effort 档：Alt+T 从「默认」切回时用它。
  useEffect(() => {
    if (current?.effort) lastEffortRef.current = current.effort
  }, [current?.effort])

  // CLI 三手势：Shift+Tab 轮换权限模式、Alt+P 开模型菜单、Alt+T 切换思考档。
  // 全部经 refs 读当前会话（流帧高频重渲本组件，effect 不随其重订阅）；守卫与
  // Esc 相同：IME 组合键与任何打开的浮层都让位。失败统一进错误条。
  useEffect(() => {
    const onHotkey = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229) return
      if (overlaysRef.current.size > 0) return
      const id = currentIdRef.current
      if (id === undefined) return
      const session = sessionsRef.current.find(item => item.id === id)
      if (session === undefined) return
      if (event.shiftKey && event.key === 'Tab') {
        event.preventDefault()
        const from = session.permissionMode || config?.permissionMode || 'auto'
        const index = PERMISSION_MODE_VALUES.indexOf(from as never)
        const next = PERMISSION_MODE_VALUES[(index + 1) % PERMISSION_MODE_VALUES.length]
        void setPermissionMode(id, next).catch(fail)
        return
      }
      if (event.altKey && (event.key === 'p' || event.key === 'P')) {
        event.preventDefault()
        setModelMenuSignal(value => value + 1)
        return
      }
      if (event.altKey && (event.key === 't' || event.key === 'T')) {
        event.preventDefault()
        const effort = session.effort ?? ''
        const target = effort !== '' ? '' : (lastEffortRef.current || 'high')
        void setEffort(id, target).catch(fail)
      }
    }
    window.addEventListener('keydown', onHotkey, true)
    return () => window.removeEventListener('keydown', onHotkey, true)
  }, [config?.permissionMode, fail])

  const decide = (requestId: string, answer: PermissionAnswer): void => {
    if (current === undefined) return
    answerPermission(current.id, requestId, answer).catch(fail)
  }

  /**
   * Sessions deleted from this page whose create response may still be in
   * flight. The create handler re-adds its row when that response lands; a
   * delete that beat it must veto the re-add, or the row resurrects with no
   * server twin and no later sessions frame ever comes to correct it (a
   * sidecar-only delete changes no native signature, so the rescan stays
   * silent).
   */
  const deletedIdsRef = useRef<Set<string>>(new Set())

  /**
   * A recalled queued message waiting to re-enter the composer's draft. The
   * nonce makes every recall a distinct request even when the text repeats;
   * the composer consumes it append-only, so nothing typed meanwhile is lost.
   */
  const [restoreRequest, setRestoreRequest] = useState<{ text: string; nonce: number } | undefined>()
  const restoreNonceRef = useRef(0)
  const recallQueuedText = useCallback((text: string): void => {
    restoreNonceRef.current += 1
    setRestoreRequest({ text, nonce: restoreNonceRef.current })
  }, [])

  // The rail/composer/status callbacks below are stable across delta frames:
  // every streaming frame re-renders this root, and inline closures would
  // defeat the child memoization that keeps a 268-row rail from reconciling
  // on each stream chunk. `currentIdRef`/`sessionsRef` carry the current
  // selection instead of closing over per-render state.
  const openSettings = useCallback(() => setShowSettings(true), [])
  const create = useCallback((form: { cwd?: string; model?: string; name?: string }) => {
    createSession(form)
      .then(result => {
        // Deleted while this response was in flight (frozen page or stalled
        // connection): the row must stay gone.
        if (deletedIdsRef.current.has(result.session.id)) return
        setSessions(previous => [
          result.session,
          ...previous.filter(session => session.id !== result.session.id),
        ])
        setCurrentId(result.session.id)
      })
      .catch(fail)
  }, [fail])
  const remove = useCallback((id: string) => {
    if (!window.confirm('删除该会话及全部聊天记录？')) return
    // Optimistic: the row leaves NOW, so a slow or stalled request can never
    // read as "the delete never completes" — the report behind this fix.
    deletedIdsRef.current.add(id)
    setSessions(previous => previous.filter(session => session.id !== id))
    setCurrentId(previous => (previous === id ? undefined : previous))
    deleteSession(id)
      .catch(error => {
        // 404 = already gone server-side (deleted here or in another tab);
        // the optimistic removal is the correct end state.
        if (error instanceof Error && error.message.includes('会话不存在')) return
        fail(error)
        // A real refusal (e.g. 409 terminal-owned) restores the row from
        // server truth rather than leaving a silent gap.
        fetchSessions()
          .then(result => setSessions(result.sessions))
          .catch(() => {
            // The next sessions frame lands the same truth.
          })
      })
  }, [fail])
  const rename = useCallback((id: string, name: string) => {
    renameSession(id, name).catch(fail)
  }, [fail])
  const refreshCommandsForCurrent = useCallback(() => {
    const id = currentIdRef.current
    if (id !== undefined) refreshCommands(id)
  }, [refreshCommands])
  const send = useCallback((text: string, images: Parameters<typeof sendMessage>[2]) => {
    const id = currentIdRef.current
    if (id === undefined) return Promise.reject(new Error('没有选中的会话'))
    // Returned, not caught here: the composer restores the draft it
    // optimistically cleared when a send never lands.
    return sendMessage(id, text, images)
  }, [])
  const stop = useCallback(() => {
    const id = currentIdRef.current
    if (id !== undefined) stopSession(id).catch(fail)
  }, [fail])
  const stopTaskForCurrent = useCallback((taskId: string) => {
    const id = currentIdRef.current
    if (id !== undefined) stopTask(id, taskId).catch(fail)
  }, [fail])
  const backgroundTaskForCurrent = useCallback((taskId: string) => {
    const id = currentIdRef.current
    if (id !== undefined) backgroundTask(id, taskId).catch(fail)
  }, [fail])
  // 时间旅行两入口：都从 refs 读当前会话（Transcript 是 memo 组件，回调必须
  // 稳定，否则每帧流式重渲都会击穿整列转录的 memo）。
  const forkFrom = useCallback((event: Extract<CcEvent, { kind: 'user' }>): void => {
    const id = currentIdRef.current
    const messageId = event.nativeMessageId
    if (id === undefined || messageId === undefined) return
    forkSession(id, { upToMessageId: messageId })
      .then(result => {
        setCurrentId(result.sessionId)
        // The fork route refreshed the catalog before answering, but its SSE
        // frame and this response race; one direct list read settles the new
        // row even when the frame was lost on a stalled stream.
        fetchSessions()
          .then(list => setSessions(list.sessions))
          .catch(() => {
            // The next sessions frame lands the same rows.
          })
      })
      .catch(fail)
  }, [fail])
  const rewindFrom = useCallback((event: Extract<CcEvent, { kind: 'user' }>): void => {
    const id = currentIdRef.current
    const messageId = event.nativeMessageId
    if (id === undefined || messageId === undefined) return
    rewindPreview(id, messageId)
      .then(result => {
        setRewindTarget({ sessionId: id, userMessageId: messageId, result, applied: false })
      })
      .catch(fail)
  }, [fail])
  const applyRewind = (): void => {
    const target = rewindTarget
    if (target === undefined || target.applied) return
    rewindApply(target.sessionId, target.userMessageId)
      .then(result => {
        setRewindTarget({ ...target, result, applied: true })
        // The files on disk changed; the transcript text did not, but a fresh
        // read is the cheapest way to settle anything derived from it.
        fetchSession(target.sessionId)
          .then(detail => mergeSessionEvents(target.sessionId, detail.events))
          .catch(() => {
            // The rewind itself succeeded; the next selection re-reads anyway.
          })
      })
      .catch(fail)
  }

  return (
    <OverlayContext.Provider value={overlaySignal}>
      <div className="cc-overlay">
        <SessionRail
          sessions={sessions}
          currentId={currentId}
          config={config}
          connected={connected}
          pending={pendingBySession}
          onSelect={setCurrentId}
          onCreate={create}
          onDelete={remove}
          onRename={rename}
          onOpenSettings={openSettings}
        />

        <main className="cc-main">
          <header className="cc-head">
            <div className="cc-head-title">
              <strong>{current?.name ?? 'Claude Code'}</strong>
              {current !== undefined && (
                <span className="cc-head-meta">
                  <span>{current.cwd}</span>
                  {current.lastGoodModel !== undefined && <span>· {current.lastGoodModel}</span>}
                  {config !== undefined && <span>· {config.permissionMode}</span>}
                </span>
              )}
            </div>
            {current !== undefined && (
              <Button size="sm" onClick={() => setEnvSessionId(current.id)}>会话环境</Button>
            )}
            <Button size="sm" onClick={props.onClose}>关闭 Esc</Button>
          </header>

          {current !== undefined && (
            <StatusBar
              sessionId={current.id}
              busy={current.status === 'busy'}
              sessionMode={current.permissionMode ?? ''}
              configMode={config?.permissionMode ?? 'auto'}
              context={context}
              usage={usage}
              fallbackCostUsd={current.totalCostUsd}
              modelMenuSignal={modelMenuSignal}
            />
          )}

          {current !== undefined && (current.queued ?? 0) > 0 && (
            <QueuedList
              sessionId={current.id}
              count={current.queued ?? 0}
              onRecall={recallQueuedText}
            />
          )}

          {error !== undefined && (
            <div className="cc-error-bar">
              <span className="cc-spacer">{error}</span>
              <Button size="sm" onClick={() => setError(undefined)}>关闭</Button>
            </div>
          )}

          {current === undefined
            ? <div className="cc-empty cc-center">从左侧选择或新建一个 Claude Code 会话</div>
            : (
              <>
                <div
                  className="cc-scroll"
                  ref={scrollRef}
                  onScroll={event => {
                    const element = event.currentTarget
                    pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
                  }}
                >
                  <Transcript events={events} commands={commandsFor(current)} onFork={forkFrom} onRewind={rewindFrom} />
                  <LiveTurnView turn={live} />
                  {events.length === 0 && live === undefined
                    && <div className="cc-empty">发送第一条消息，开始与 Claude Code 对话</div>}
                  {currentPermissions.map(item => (
                    <PermissionCard
                      key={item.request.id}
                      request={item.request}
                      onAnswer={answer => decide(item.request.id, answer)}
                    />
                  ))}
                  {currentDialogs.map(item => (
                    <QuestionCard
                      key={item.id}
                      payload={item.payload}
                      onAnswer={answers => {
                        answerDialog(current.id, item.id, answers).catch(fail)
                      }}
                      onCancel={() => {
                        answerDialog(current.id, item.id, undefined).catch(fail)
                      }}
                    />
                  ))}
                  <div ref={attentionRef} aria-hidden />
                </div>
                <TaskPanel
                  tasks={tasksBySession[current.id] ?? NO_TASKS}
                  onStop={stopTaskForCurrent}
                  onBackground={backgroundTaskForCurrent}
                />
                <TodoPin key={current.id} events={events} />
                <Composer
                  sessionId={current.id}
                  cwd={current.cwd}
                  configDir={current.configDir}
                  commands={commandsFor(current)}
                  onRefreshCommands={refreshCommandsForCurrent}
                  busy={current.status === 'busy'}
                  readOnly={current.terminalOwned === true}
                  onSend={send}
                  restoreRequest={restoreRequest}
                  onStop={stop}
                />
              </>
            )}
        </main>

        {showSettings && (
          <SettingsModal
            config={config}
            onClose={() => setShowSettings(false)}
            onSaved={() => {
              // The header shows fields of the effective config; without this
              // re-read it would keep the pre-save posture until reconnect.
              fetchConfig()
                .then(result => setConfig(result.config))
                .catch(() => {
                  // The save itself succeeded; the next hello frame retries.
                })
            }}
          />
        )}
        {envSessionId !== undefined && current !== undefined && current.id === envSessionId && (
          <SessionEnvModal
            session={current}
            onClose={() => setEnvSessionId(undefined)}
            onSaved={() => {
              fetchSessions().then(result => setSessions(result.sessions)).catch(fail)
            }}
          />
        )}
        {rewindTarget !== undefined && (
          <Modal
            open
            onClose={() => setRewindTarget(undefined)}
            title="回滚文件"
            closeLabel="关闭"
            footer={rewindTarget.applied
              ? <Button variant="primary" onClick={() => setRewindTarget(undefined)}>知道了</Button>
              : (
                <>
                  <Button onClick={() => setRewindTarget(undefined)}>取消</Button>
                  <Button variant="primary" onClick={applyRewind}>回滚</Button>
                </>
              )}
          >
            <div className="cc-rewind">
              <div className="cc-rewind-hint">
                {rewindTarget.applied
                  ? '已把会话修改过的文件恢复到该消息时的状态；对话记录本身不变。'
                  : '将把会话修改过的文件恢复到这条消息时的状态；对话记录本身不变，文件改动不经过回收站。'}
              </div>
              <div className="cc-rewind-stats">
                {rewindTarget.applied ? '已回滚 ' : '将回滚 '}
                {rewindTarget.result.filesChanged?.length ?? 0}
                {' 个文件'}
                {rewindTarget.result.insertions !== undefined || rewindTarget.result.deletions !== undefined
                  ? `（+${rewindTarget.result.insertions ?? 0} 行 / -${rewindTarget.result.deletions ?? 0} 行）`
                  : ''}
              </div>
              {(rewindTarget.result.skippedLinks ?? 0) > 0 && (
                <div className="cc-rewind-warn">
                  有 {rewindTarget.result.skippedLinks} 个文件因符号链接或备份不可读等原因未被回滚，请手动检查。
                </div>
              )}
            </div>
          </Modal>
        )}
      </div>
    </OverlayContext.Provider>
  )
}
