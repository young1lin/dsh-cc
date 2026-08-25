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

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { Composer } from './Composer.tsx'
import { PermissionCard, QuestionCard } from './Interaction.tsx'
import { SessionRail } from './SessionRail.tsx'
import { StatusBar } from './StatusBar.tsx'
import { LiveTurnView } from './LiveTurnView.tsx'
import { reduceDelta, type LiveTurn } from '../live-turn.ts'
import { TodoPin } from './TodoPin.tsx'
import { Transcript } from './Transcript.tsx'
import { SettingsModal } from './settings/SettingsModal.tsx'
import { SessionEnvModal } from './settings/SessionEnvModal.tsx'
import { OverlayContext, useOverlay, type OverlaySignal } from './overlay.ts'
import { connectEvents } from './api/http.ts'
import { answerDialog, answerPermission } from './api/interaction.ts'
import {
  createSession, deleteSession, fetchSession, fetchSessions, renameSession, sendMessage, stopSession,
} from './api/sessions.ts'
import { fetchConfig } from './api/settings.ts'
import { fetchContext, fetchUsage, type ContextUsage, type UsageInfo } from './api/telemetry.ts'
import type {
  CcEvent, ConfigSummary, LiveTurnSnapshot, PermissionAnswer, PermissionRequest, SessionMeta,
} from '../types.ts'

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

/** One session's folded live turn plus the delta counter it was folded to. */
interface LiveEntry {
  seq: number
  turn: LiveTurn | undefined
}

/** Shared empty transcript, so a session with no events keeps one stable identity. */
const NO_EVENTS: CcEvent[] = []

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
  const [connected, setConnected] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [envSessionId, setEnvSessionId] = useState<string | undefined>()
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

  const current = sessions.find(session => session.id === currentId)
  const events = currentId !== undefined ? eventsBySession[currentId] ?? NO_EVENTS : NO_EVENTS
  const live = currentId !== undefined ? liveBySession[currentId]?.turn : undefined

  const fail = (cause: unknown): void => {
    setError(cause instanceof Error ? cause.message : String(cause))
  }

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
    fetchUsage(id)
      .then(result => setUsage(result.usage))
      .catch(() => setUsage(undefined))
    fetchContext(id)
      .then(result => {
        if (result.available && result.context !== undefined) setContext(result.context)
      })
      .catch(() => {
        // A cold session has no live process to ask; the meter stays hidden.
      })
  }

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
          setSessions(message.sessions)
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
          if (message.sessionId === currentIdRef.current && message.event.kind === 'result') {
            refreshTelemetry(currentIdRef.current)
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
      })
      .catch(cause => {
        if (!stale) fail(cause)
      })
    setContext(undefined)
    setUsage(undefined)
    refreshTelemetry(currentId)
    return () => {
      stale = true
    }
  }, [currentId])

  // Follow the stream only while the user is at the bottom: scrolling up to
  // read must not be fought by the stream appending below. Coming back within
  // the threshold resumes following.
  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    if (pinnedRef.current) element.scrollTop = element.scrollHeight
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

  const decide = (requestId: string, answer: PermissionAnswer): void => {
    if (current === undefined) return
    answerPermission(current.id, requestId, answer).catch(fail)
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
          onCreate={form => {
            createSession(form)
              .then(result => {
                setSessions(previous => [
                  result.session,
                  ...previous.filter(session => session.id !== result.session.id),
                ])
                setCurrentId(result.session.id)
              })
              .catch(fail)
          }}
          onDelete={id => {
            if (!window.confirm('删除该会话及全部聊天记录？')) return
            deleteSession(id)
              .then(() => {
                setSessions(previous => previous.filter(session => session.id !== id))
                setCurrentId(previous => (previous === id ? undefined : previous))
              })
              .catch(fail)
          }}
          onRename={(id, name) => {
            renameSession(id, name).catch(fail)
          }}
          onOpenSettings={() => setShowSettings(true)}
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
              context={context}
              usage={usage}
              fallbackCostUsd={current.totalCostUsd}
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
                  <Transcript events={events} />
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
                {/* TaskPanel (后续批次) 会插在此面板之前 */}
                <TodoPin key={current.id} events={events} />
                <Composer
                  busy={current.status === 'busy'}
                  readOnly={current.terminalOwned === true}
                  // Returned, not caught here: the composer restores the
                  // draft it optimistically cleared when a send never lands.
                  onSend={(text, images) => sendMessage(current.id, text, images)}
                  onStop={() => {
                    stopSession(current.id).catch(fail)
                  }}
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
      </div>
    </OverlayContext.Provider>
  )
}
