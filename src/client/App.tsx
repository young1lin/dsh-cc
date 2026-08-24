/**
 * The Claude Code surface: session rail, status strip, transcript, pending
 * interactions, and the composer.
 *
 * This module owns cross-cutting state only — the live SSE subscription, the
 * selected session, and which dialog is open. Each region is its own module so
 * they can evolve independently.
 *
 * Escape is handled here rather than at the layer entry so an open dialog
 * consumes the key first: closing the whole surface out from under a dialog was
 * the previous behavior, and it made the settings dialog impossible to dismiss.
 *
 * @module dsh-cc/client/App
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { Composer } from './Composer.tsx'
import { PermissionCard, QuestionCard } from './Interaction.tsx'
import { SessionRail } from './SessionRail.tsx'
import { StatusBar } from './StatusBar.tsx'
import { LiveTurnView } from './LiveTurnView.tsx'
import { reduceDelta, type LiveTurn } from '../live-turn.ts'
import { Transcript } from './Transcript.tsx'
import { SettingsModal } from './settings/SettingsModal.tsx'
import { SessionEnvModal } from './settings/SessionEnvModal.tsx'
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

/**
 * The Claude Code surface.
 * @param props - the close callback, invoked by Escape or the close control.
 * @returns the surface node.
 */
export function CcApp(props: { onClose(): void }): ReactElement {
  const [config, setConfig] = useState<ConfigSummary | undefined>()
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [currentId, setCurrentId] = useState<string | undefined>()
  const [events, setEvents] = useState<CcEvent[]>([])
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

  const current = sessions.find(session => session.id === currentId)
  const dialogOpen = showSettings || envSessionId !== undefined
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
   * local fold has holes the reducer will not fill on its own. Debounced so
   * one reconnect costs one request, not one per missed frame.
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
          .then(result => applyLiveSnapshot(id, result.live))
          .catch(() => {
            // Best effort; the next gap (or the next selection) retries.
          })
      }
    }, 250)
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
                  if (currentIdRef.current === id) setEvents(result.events)
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
          if (message.sessionId !== currentIdRef.current) break
          setEvents(previous => [...previous, message.event])
          if (message.event.kind === 'result') {
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
    }, setConnected)

    return () => {
      disposed = true
      clearTimeout(foreignSyncTimer.current)
      clearTimeout(liveGapTimer.current)
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
        if (stale) return
        setEvents(result.events)
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

  useEffect(() => {
    const element = scrollRef.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [events.length, live, currentId])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // An open dialog owns the key; the surface closes only from the bare
      // surface, so Escape never dismisses two layers at once.
      if (dialogOpen) return
      props.onClose()
    }
    // Capture phase, deliberately: a dialog closes itself from a `document`
    // bubble listener, and React flushes that state update at the microtask
    // checkpoint BETWEEN the two listeners — re-registering this one with
    // `dialogOpen` already false, which then closed the surface too. Capture
    // runs before any of that, while the dialog is still open.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [dialogOpen, props.onClose])

  const decide = (requestId: string, answer: PermissionAnswer): void => {
    if (current === undefined) return
    answerPermission(current.id, requestId, answer).catch(fail)
  }

  return (
    <div className="cc-overlay">
      <SessionRail
        sessions={sessions}
        currentId={currentId}
        config={config}
        connected={connected}
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
                <div className="cc-scroll" ref={scrollRef}>
                  <Transcript events={events} />
                  <LiveTurnView turn={live} />
                  {events.length === 0 && live === undefined
                    && <div className="cc-empty">发送第一条消息，开始与 Claude Code 对话</div>}
                  {permissions
                    .filter(item => item.sessionId === current.id)
                    .map(item => (
                      <PermissionCard
                        key={item.request.id}
                        request={item.request}
                        onAnswer={answer => decide(item.request.id, answer)}
                      />
                    ))}
                  {dialogs
                    .filter(item => item.sessionId === current.id)
                    .map(item => (
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
                </div>
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

      {showSettings && <SettingsModal config={config} onClose={() => setShowSettings(false)} />}
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
  )
}
