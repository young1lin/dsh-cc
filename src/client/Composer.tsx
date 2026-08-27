/**
 * The message composer. Typing while a turn runs is allowed — the message is
 * submitted and the CLI queues it — so the textarea is never disabled; only
 * the send control swaps to an interrupt. Two CLI-parity affordances hang off
 * the draft: a slash-command menu and an @-mention file picker (the composer
 * owns both selections and all the keyboard routing), plus the blue
 * recognition mirror that underlays the textarea while the leading `/name`
 * names a known command. The draft itself is persisted per session (text
 * plus uploaded images, debounced into localStorage and restored on switch
 * and reload), sent messages are recalled shell-style from a per-project
 * history, and Escape interrupts a running turn of ours before it leaves
 * the input.
 *
 * @module dsh-cc/client/Composer
 */

import { useEffect, useMemo, useRef, useState, memo, type ClipboardEvent, type DragEvent, type ReactElement } from 'react'
import { Button, IconSendOutline16, IconStopFill16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { uploadImage } from './api/sessions.ts'
import { fetchFileIndex, listDir } from './api/settings.ts'
import { registerCss } from './css.ts'
import { useOverlay } from './overlay.ts'
import { CommandMenu, filterCommands } from './CommandMenu.tsx'
import { MentionPicker, type MentionState } from './MentionPicker.tsx'
import {
  MAX_MENU_ROWS, PAGE_ROWS, absoluteDirTarget, absoluteReferenceRow, filterRows, insertionFor,
  isAbsoluteQuery, rankDirChildren, tokenAtCaret, type MenuRow,
} from './mention-core.ts'
import { commandToken, matchCommand } from './command-mentions.ts'
import { MEDIA_TYPE_EXTENSIONS, SKIPPED_DIR, type DirListing, type FileIndex, type ImageRef, type SlashCommand } from '../types.ts'

registerCss('composer', `
.cc-input-shell {
  position: relative;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-1);
  transition: border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}

.cc-input-shell:focus-within { border-color: var(--dsw-alias-border-l3); }

/* The textarea's own box: it holds the flex slot so the recognition mirror
   can overlay the input exactly — same origin, same width, same wrapping.
   The popups anchor to the shell instead (their left/right 12px assumes it). */
.cc-input-box { position: relative; flex: 1; min-width: 0; }

.cc-input {
  display: block;
  width: 100%;
  min-height: 24px;
  max-height: 200px;
  padding: 0;
  border: none;
  outline: none;
  resize: none;
  overflow-y: auto;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-s-14);
  font-family: var(--dsw-font-family);
}

.cc-input::placeholder { color: var(--dsw-alias-markdown-placeholder); }

.cc-input-shell[data-drop='true'] { border-color: var(--dsw-alias-brand-primary); }

/* The recognition mirror: metrics-matched to .cc-input (padding 0, the same
   font shorthand, pre-wrap) so its text lands exactly under the ghosted
   textarea text. It clips rather than scrolls; the textarea's onScroll keeps
   the two line-aligned past the growth cap. */
.cc-input-mirror {
  position: absolute;
  inset: 0;
  padding: 0;
  pointer-events: none;
  overflow: hidden;
  font: var(--dsw-font-s-14);
  font-family: var(--dsw-font-family);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-primary);
}

/* The recognized leading token: the CLI's "this will invoke that command"
 * cue, in the host's brand blue. */
.cc-cmd-token { color: var(--dsw-alias-brand-primary); }

/* Shared popup chrome for the two composer menus (slash commands and @
   mentions). Declared here on purpose: the composer is the component that
   always loads with either popup, and registerCss replaces a whole sheet by
   id — a second module re-registering these rules under its own id would
   silently drop whatever the first registered (exactly the bug that shipped
   both menus unstyled). */
.cc-menu-pop {
  position: absolute; bottom: 100%; left: 12px; right: 12px; z-index: 10;
  max-height: 240px; overflow-y: auto;
  margin-bottom: 4px; padding: 4px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-shadow-lv2);
  font: var(--dsw-font-xs-13);
}
.cc-menu-row { display: flex; align-items: baseline; gap: 8px; padding: 4px 8px; border-radius: 6px; cursor: pointer; }
/* The rail's selected-row token: bg-layer-3 reads white-on-white in light
   themes, which made keyboard selection invisible. */
.cc-menu-row[data-selected='true'] { background: var(--dsw-alias-interactive-bg-active); }
.cc-menu-row-name { flex: none; color: var(--dsw-alias-label-primary); }
.cc-menu-row-args { flex: none; color: var(--dsw-alias-label-tertiary); }
.cc-menu-row-desc { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); }
.cc-menu-empty { padding: 8px; color: var(--dsw-alias-label-tertiary); }

/* While the mirror is up the textarea's own text goes invisible; the caret
   stays put and the placeholder keeps its own color. */
.cc-input[data-ghost='true'] { color: transparent; caret-color: var(--dsw-alias-label-primary); }
.cc-input[data-ghost='true']::placeholder { color: var(--dsw-alias-markdown-placeholder); }

.cc-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 4px 8px;
}

.cc-attachment {
  position: relative;
  width: 56px;
  height: 56px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-1);
}

.cc-attachment img { width: 100%; height: 100%; object-fit: cover; display: block; }

.cc-attachment[data-pending='true'] { opacity: 0.5; }

.cc-attachment-drop {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 9px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12);
  line-height: 18px;
  cursor: pointer;
  box-shadow: var(--dsw-shadow-lv1);
}

.cc-attachment-drop:hover { color: var(--dsw-alias-state-error-primary); }
`)

/** URL extension per image type, from the shared blob-store table. */
const EXTENSIONS = MEDIA_TYPE_EXTENSIONS

/**
 * Keys an open popup consumes in keydown. Their keyup is skipped by the
 * menu recomputation: Escape closed the menu without moving the caret, and
 * an insert's caret move lands one rAF later — recomputing off a not-yet-
 * moved caret would reopen what the keydown just resolved.
 */
const MENU_KEYS = new Set(['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', 'Escape', 'Enter', 'Tab'])

/** localStorage key prefix for one session's persisted draft; the session id follows it. */
const DRAFT_KEY = 'dsh-cc:draft:'

/** How long a draft edit coasts before it is persisted, in milliseconds. */
const DRAFT_DEBOUNCE_MS = 400

/** localStorage key prefix for the input history; the environment stamp follows it. */
const HISTORY_KEY = 'dsh-cc:history-v1:'

/** History entries kept per environment stamp. */
const HISTORY_CAP = 200

/** One persisted draft: the text plus the images already uploaded for it. */
interface DraftSnapshot {
  text: string
  images: ImageRef[]
}

/**
 * Read one session's persisted draft; anything absent, unreadable, or
 * wrong-shaped reads as absent (a fresh composer starts empty).
 * @param sessionId - the session whose draft slot to read.
 * @returns the stored draft, or undefined.
 */
function readDraft(sessionId: string): DraftSnapshot | undefined {
  try {
    const raw = localStorage.getItem(DRAFT_KEY + sessionId)
    if (raw === null) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const { text, images } = parsed as { text?: unknown; images?: unknown }
    if (typeof text !== 'string' || !Array.isArray(images)) return undefined
    const clean = images.filter((item): item is ImageRef =>
      typeof item === 'object' && item !== null
      && typeof (item as ImageRef).id === 'string'
      && typeof (item as ImageRef).mediaType === 'string'
      && (item as ImageRef).mediaType in MEDIA_TYPE_EXTENSIONS)
    return { text, images: clean }
  } catch {
    return undefined
  }
}

/**
 * Persist one session's draft, or clear its slot when the draft is empty.
 * The image ids are content-addressed server-side, so a restored attachment
 * keeps rendering after a reload.
 * @param sessionId - the session whose draft slot to write.
 * @param text - the draft text.
 * @param images - the draft's uploaded images.
 */
function writeDraft(sessionId: string, text: string, images: ImageRef[]): void {
  try {
    if (text === '' && images.length === 0) localStorage.removeItem(DRAFT_KEY + sessionId)
    else localStorage.setItem(DRAFT_KEY + sessionId, JSON.stringify({ text, images }))
  } catch {
    // Private mode or quota: the draft just does not survive this page.
  }
}

/**
 * The environment stamp of one input history, replicating the rule the
 * command cache in App.tsx stamps itself with: `cwd` (which project) plus
 * `configDir` (which account root). Sent messages are recalled across the
 * sessions of one project and account, and never leak into another's.
 * @param cwd - the session's working directory.
 * @param configDir - the session's account root.
 * @returns the stamp suffix of the history key.
 */
function historyStamp(cwd: string | undefined, configDir: string | undefined): string {
  return `${encodeURIComponent(cwd ?? '')}@${encodeURIComponent(configDir ?? '')}`
}

/**
 * Read the input history for one stamp; anything unreadable or wrong-shaped
 * reads as empty.
 * @param stamp - the environment stamp (see {@link historyStamp}).
 * @returns the entries, newest first.
 */
function readHistory(stamp: string): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY + stamp)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

/**
 * Record one sent message into its stamp's history: newest first, a
 * consecutive repeat deduplicated, the list capped at {@link HISTORY_CAP}.
 * @param stamp - the environment stamp (see {@link historyStamp}).
 * @param text - the message text that was sent.
 */
function recordHistory(stamp: string, text: string): void {
  if (text === '') return
  try {
    const entries = readHistory(stamp)
    if (entries[0] === text) return
    localStorage.setItem(HISTORY_KEY + stamp, JSON.stringify([text, ...entries].slice(0, HISTORY_CAP)))
  } catch {
    // Best effort: a full or locked store simply skips this entry.
  }
}

/**
 * Render the composer.
 * @param props - `busy` state plus send and interrupt callbacks. `readOnly`
 *   marks a session a live CLI process holds open: the box turns read-only
 *   with a reason, because that process is a concurrent writer and no stop
 *   signal of ours can reach its turn. `sessionId` anchors the composer to
 *   one session (the caller closes it over for the command refresh, and it
 *   keys the persisted draft); `cwd` gates and roots the mention picker;
 *   `configDir` joins `cwd` in stamping the shared input history;
 *   `commands` drives both the menu and the recognition token;
 *   `onRefreshCommands` refetches on menu open, `onReloadCommands` re-discovers
 *   them from disk first.
 * @returns the composer node.
 */
export const Composer = memo(function Composer(props: {
  sessionId: string
  /** Session working directory — the mention browser's root and the trigger gate. */
  cwd?: string
  /** The session's account root; with `cwd` it stamps the shared input history. */
  configDir?: string
  /** The session's cached slash commands; empty when none were loadable. */
  commands: readonly SlashCommand[]
  /** Refetch the command list (menu just opened). */
  onRefreshCommands(): void
  /**
   * Reload plugins and skills from disk, then refetch. Undefined for a session
   * with no process to ask — a cold session's catalog is a remembered one, and
   * nothing can reload it in place.
   */
  onReloadCommands?: () => void
  /** Whether such a reload is in flight. */
  reloadingCommands?: boolean
  busy: boolean
  readOnly?: boolean
  /**
   * Submit one message. Whatever the send resolves to is ignored; only a
   * rejection matters here, and it restores the cleared draft.
   */
  onSend(text: string, images: ImageRef[]): void | Promise<unknown>
  /**
   * A recalled queued message to append to the draft's end. The object — not
   * its text — is the change signal: every recall supplies a fresh one, so
   * the same text recalled twice still appends twice.
   */
  restoreRequest?: { text: string; nonce: number }
  onStop(): void
}): ReactElement {
  const [value, setValue] = useState('')
  const [images, setImages] = useState<ImageRef[]>([])
  const [uploading, setUploading] = useState(0)
  const [dropping, setDropping] = useState(false)
  const [failure, setFailure] = useState<string | undefined>()
  const [focused, setFocused] = useState(false)
  /** The open popup, with the text that drives it. */
  const [menu, setMenu] = useState<{ kind: 'command'; filter: string } | { kind: 'mention'; query: string } | undefined>()
  /** The popup's selected row, owned here because the keyboard lives here. */
  const [menuIndex, setMenuIndex] = useState(0)
  /** Native IME composition in flight — the mirror hides and menus go inert. */
  const [composing, setComposing] = useState(false)
  // The mention menu's settled project index (warm: fetched once per cwd,
  // retried by nonce), and the live listing behind an absolute-path query.
  const [mentionIndex, setMentionIndex] = useState<FileIndex | undefined>()
  const [mentionFailed, setMentionFailed] = useState(false)
  const [mentionAttempt, setMentionAttempt] = useState(0)
  const [dirListing, setDirListing] = useState<DirListing | undefined>()
  // Escape dismisses the mention menu for the CURRENT query only; typing on
  // (a different query) reopens it.
  const dismissedQuery = useRef<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  // The composer holds drafts: while it is focused, Escape is not the
  // surface's — it only leaves the input, and a stray press cannot cost the
  // draft. Closing stays one Esc away once focus is elsewhere.
  useOverlay(focused)

  // Grow with the draft and hand the rest to internal scrolling: `auto` first
  // so `scrollHeight` reports the content's own height, not the last one set.
  useEffect(() => {
    const element = inputRef.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [value])

  // Mount sizing: an untouched draft never fires the value effect above, so a
  // fresh session opened at the CSS floor (24px) - shorter than the font's own
  // line box, which cropped the placeholder's lower half (a CJK row read as
  // vertically cut). Size once from the element's real metrics on the way in.
  useEffect(() => {
    const element = inputRef.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [])

  // A session a terminal process just adopted turns the box read-only under
  // whatever was open; a stale popup must not stay keyboard-armed against a
  // draft the UI simultaneously declares a read-only mirror.
  useEffect(() => {
    if (props.readOnly === true) setMenu(undefined)
  }, [props.readOnly])

  // A recalled queued message re-enters the draft at its end, on a newline —
  // never over whatever the user is typing when the recall lands.
  useEffect(() => {
    const request = props.restoreRequest
    if (request === undefined) return
    setValue(previous => (previous === '' ? request.text : previous + '\n' + request.text))
  }, [props.restoreRequest])

  // History recall, live only while navigating: the entry list snapshot,
  // the cursor into it (newest = 0, -1 = the stashed-draft position below
  // the newest), and the draft put aside on the way in. Editing, sending,
  // or switching sessions nulls it.
  const recallRef = useRef<{ entries: string[]; cursor: number; stash: string } | null>(null)
  // Mirrors of the draft states, so the session-switch flush below can read
  // the outgoing session’s last draft without waiting for the next render.
  const valueRef = useRef(value)
  const imagesRef = useRef(images)
  useEffect(() => {
    valueRef.current = value
    imagesRef.current = images
  })

  // The composer instance survives session switches (App does not key it),
  // so without a per-session slot the box’s states would cross sessions — a
  // draft typed in one leaking into the next, everything lost on reload.
  // Each switch flushes the outgoing draft under its own id and adopts the
  // stored one; edits themselves coast DRAFT_DEBOUNCE_MS before writing.
  const draftSessionRef = useRef(props.sessionId)
  useEffect(() => {
    if (draftSessionRef.current !== props.sessionId) {
      writeDraft(draftSessionRef.current, valueRef.current, imagesRef.current)
      draftSessionRef.current = props.sessionId
    }
    const draft = readDraft(props.sessionId)
    setValue(draft?.text ?? '')
    setImages(draft?.images ?? [])
    setFailure(undefined)
    setMenu(undefined)
    recallRef.current = null
  }, [props.sessionId])

  // Closing the surface must not eat the tail of the debounce window: the
  // last <400ms of typing is flushed on unmount too.
  useEffect(() => () => {
    writeDraft(draftSessionRef.current, valueRef.current, imagesRef.current)
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      writeDraft(props.sessionId, value, images)
    }, DRAFT_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [props.sessionId, value, images])

  // The mention query's derived navigation facts: whether it spells an
  // absolute path (the reference is the typed path itself, plus the live
  // children of the directory it names) or rides the project index.
  const mentionQuery = menu?.kind === 'mention' ? menu.query : null
  // The absolute-path derivation returns fresh objects per call, so computing
  // it bare in render would give the mention-rows memo unstable deps and
  // re-filter the roster on every parent re-render (every delta frame while
  // typing a mention during a running turn).
  const nav = useMemo(() => mentionQuery === null
    ? { exactRow: null, dirTarget: null }
    : { exactRow: absoluteReferenceRow(mentionQuery), dirTarget: absoluteDirTarget(mentionQuery) },
  [mentionQuery])
  const exactRow = nav.exactRow
  const dirTarget = nav.dirTarget
  const mentionAbsolute = exactRow !== null

  // Warm fetch: one project index per cwd for the composer's lifetime. The
  // attempt nonce is the retry — a fetch that failed once must not blind
  // the session forever. A failed index still leaves absolute-path queries
  // fully usable (their synthetic row needs no index at all).
  useEffect(() => {
    if (props.cwd === undefined) return
    let stale = false
    setMentionIndex(undefined)
    setMentionFailed(false)
    fetchFileIndex(props.cwd)
      .then(result => {
        if (!stale) setMentionIndex(result.index)
      })
      .catch(() => {
        if (!stale) setMentionFailed(true)
      })
    return () => {
      stale = true
    }
  }, [props.cwd, mentionAttempt])

  // A failed index retries at BOTH gesture edges: when a live gesture ends
  // (query non-null -> null) and when a fresh one starts (null ->
  // non-null). The start edge covers the cold start where the warm fetch
  // raced the HTTP surface and died before the first '@' ever worked.
  // Mount-time null -> null never bumps (that would loop refetches).
  const prevQueryRef = useRef<string | null>(null)
  useEffect(() => {
    const previous = prevQueryRef.current
    if (mentionFailed && ((previous !== null && mentionQuery === null) || (previous === null && mentionQuery !== null))) {
      setMentionAttempt(attempt => attempt + 1)
    }
    prevQueryRef.current = mentionQuery
  }, [mentionQuery, mentionFailed])

  // The listing of the directory an absolute query navigates: one fetch per
  // directory per gesture. Fragment keystrokes share the fetch (same
  // directory); a target change or the gesture's end resets, so the next
  // '@' sees the live filesystem. A failed listing leaves the typed
  // reference row alone in the menu.
  useEffect(() => {
    const dir = menu?.kind === 'mention' ? dirTarget?.dir : undefined
    if (dir === undefined) {
      setDirListing(undefined)
      return
    }
    let stale = false
    setDirListing(undefined)
    listDir(dir)
      .then(result => {
        if (!stale) setDirListing(result)
      })
      .catch(() => {
        if (!stale) setDirListing(undefined)
      })
    return () => {
      stale = true
    }
  }, [menu?.kind, dirTarget?.dir])

  /** The command rows for the open filter; empty unless the menu is that kind. */
  const filteredCommands = useMemo(
    () => menu?.kind === 'command' ? filterCommands(props.commands, menu.filter) : [],
    [menu, props.commands],
  )
  const mentionRows = useMemo(() => {
    if (mentionQuery === null) return []
    // A relative query ranks the whole project index — the '@' gesture is a
    // search, not a one-directory browse.
    if (exactRow === null || dirTarget === null) {
      return filterRows(mentionIndex?.rows ?? [], mentionQuery)
    }
    // An absolute query offers the live children of the directory it names,
    // ranked by the fragment still being typed.
    const prefix = dirTarget.dir.endsWith('/') ? dirTarget.dir : `${dirTarget.dir}/`
    const children = (dirListing?.entries ?? [])
      .filter(entry => !entry.directory || !SKIPPED_DIR.test(entry.name))
      .map(entry => entry.directory
        ? { path: prefix + entry.name, directory: true as const }
        : { path: prefix + entry.name })
    const ranked = rankDirChildren(children, dirTarget.fragment).slice(0, MAX_MENU_ROWS)
    // A completed folder spelling leads with the folder itself — the
    // listing reference is the primary pick. A mid-typing fragment leads
    // with the matching children. An empty roster — failed listing or
    // genuinely empty directory — falls back to the typed reference, so an
    // absolute path stays pickable no matter what.
    if (ranked.length === 0) return [exactRow]
    return dirTarget.fragment === '' ? [exactRow, ...ranked] : ranked
  }, [mentionQuery, exactRow, dirTarget, dirListing, mentionIndex])
  /** The mention menu's settling state, for the roster's loading/failed rows. */
  const mentionState: MentionState = mentionAbsolute ? 'ready'
    : mentionIndex === undefined ? (mentionFailed ? 'failed' : 'loading')
    : 'ready'
  /** A failed index hides the menu for relative queries; absolute ones need no index. */
  const mentionVisible = menu?.kind === 'mention' && (mentionAbsolute || !mentionFailed)

  // Filters shrink the row list under a stationary index; pull the selection
  // back inside it. Render-phase correction, guarded so it settles.
  const menuCount = menu?.kind === 'command' ? filteredCommands.length : mentionRows.length
  if (menu !== undefined && menuIndex > 0 && menuIndex >= menuCount) setMenuIndex(0)

  const empty = value.trim().length === 0 && images.length === 0

  const submit = (): void => {
    if (empty || uploading > 0 || props.readOnly === true) return
    const text = value.trim()
    const attachments = images
    // Cleared optimistically so the box is ready for the next message. A send
    // that never lands — an expired attachment, a closed engine — puts the
    // draft back instead of discarding what was typed.
    setValue('')
    setImages([])
    setFailure(undefined)
    setMenu(undefined)
    // Sending leaves history recall: the box holds a fresh turn now.
    recallRef.current = null
    void Promise.resolve(props.onSend(text, attachments))
      .then(() => {
        // A landed send retires the stored draft immediately (the debounce
        // would write the emptiness anyway, 400ms later) and files the text
        // into this project’s input history.
        writeDraft(props.sessionId, '', [])
        recordHistory(historyStamp(props.cwd, props.configDir), text)
      })
      .catch((error: unknown) => {
        setFailure(error instanceof Error ? error.message : String(error))
        setValue(previous => (previous === '' ? text : previous))
        setImages(previous => (previous.length === 0 ? attachments : previous))
      })
  }

  /**
   * Recompute the open popup from the draft and the caret. The slash menu
   * lives only while the caret is inside the draft's first word and that word
   * starts with `/`; the mention picker only while the caret is inside an
   * open `@token` whose `@` sits at start or after whitespace.
   * @param element - the textarea.
   */
  const updateMenu = (element: HTMLTextAreaElement): void => {
    if (props.readOnly === true) {
      setMenu(undefined)
      return
    }
    const caret = element.selectionStart ?? element.value.length
    const before = element.value.slice(0, caret)
    if (!/\s/.test(before) && element.value.startsWith('/')) {
      const filter = element.value.slice(1)
      if (menu?.kind !== 'command' || menu.filter !== filter) {
        // The refetch fires only on the transition into an open command menu,
        // never on every keystroke inside one.
        if (menu === undefined) props.onRefreshCommands()
        setMenu({ kind: 'command', filter })
        setMenuIndex(0)
      }
      return
    }
    const token = tokenAtCaret(element.value, caret)
    if (token !== null && props.cwd !== undefined && dismissedQuery.current !== token.query) {
      if (menu?.kind !== 'mention' || menu.query !== token.query) {
        setMenu({ kind: 'mention', query: token.query })
        setMenuIndex(0)
      }
      return
    }
    setMenu(undefined)
  }

  /** Insert a completed slash command over the draft's first word. */
  const insertCommand = (name: string): void => {
    const element = inputRef.current
    const rest = value.includes(' ') ? value.slice(value.indexOf(' ')) : ''
    setValue(`/${name} ${rest.trimStart()}`)
    setMenu(undefined)
    // A mouse pick lands with focus on the row's mousedown already prevented,
    // but a programmatic activation must not strand the caret on an unfocused
    // box either — typing continues here right after the insert.
    element?.focus()
    requestAnimationFrame(() => element?.setSelectionRange(name.length + 2, name.length + 2))
  }

  /**
   * Insert one picked mention row over the open token: the whole half-typed
   * run to the next whitespace is replaced (the caret may sit inside it), a
   * closing space terminates the reference, and a folder pick appends its
   * separating slash.
   * @param row - the picked menu row.
   */
  const insertMention = (row: MenuRow): void => {
    const element = inputRef.current
    if (element === null || menu?.kind !== 'mention') return
    const caret = element.selectionStart ?? element.value.length
    const token = tokenAtCaret(element.value, caret)
    if (token === null) return
    const plan = insertionFor(element.value, token, caret, row)
    dismissedQuery.current = null
    setValue(plan.next)
    setMenu(undefined)
    element.focus()
    requestAnimationFrame(() => element.setSelectionRange(plan.caret, plan.caret))
  }

  /**
   * Upload every image among the given items and attach the results.
   * @param files - the candidate files from a paste or a drop.
   * @returns true when at least one file was an image and was taken.
   */
  const attach = (files: File[]): boolean => {
    const picked = files.filter(file => file.type.startsWith('image/'))
    if (picked.length === 0) return false
    setFailure(undefined)
    setUploading(count => count + picked.length)
    for (const file of picked) {
      uploadImage(file)
        .then(result => setImages(previous => [...previous, result.image]))
        .catch((error: unknown) => {
          setFailure(error instanceof Error ? error.message : String(error))
        })
        .finally(() => setUploading(count => count - 1))
    }
    return true
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = [...event.clipboardData.items]
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter((file): file is File => file !== null)
    // Only swallow the paste when an image was actually taken, so pasting
    // text that happens to travel with an image still inserts the text.
    if (attach(files)) event.preventDefault()
  }

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    setDropping(false)
    if (attach([...event.dataTransfer.files])) event.preventDefault()
  }

  // The recognition pair: the draft's leading `/name` when it names a known
  // command. `token` and `recognized` split so the mirror's JSX can narrow
  // the token before slicing the rest of the draft after it.
  const token = commandToken(value)
  const recognized = token !== undefined && !composing
    ? matchCommand(token, props.commands)
    : undefined

  return (
    <div className="cc-composer">
      {(images.length > 0 || uploading > 0) && (
        <div className="cc-attachments">
          {images.map(image => (
            <div className="cc-attachment" key={image.id}>
              <img src={`/cc/api/blobs/${image.id}.${EXTENSIONS[image.mediaType]}`} alt={image.name ?? '附件'} />
              <button
                type="button"
                className="cc-attachment-drop"
                title="移除"
                onClick={() => setImages(previous => previous.filter(item => item.id !== image.id))}
              >
                ×
              </button>
            </div>
          ))}
          {Array.from({ length: uploading }, (_, index) => (
            <div className="cc-attachment" data-pending="true" key={`pending-${index}`} />
          ))}
        </div>
      )}
      {failure !== undefined && <div className="cc-error-bar">{failure}</div>}
      <div
        className="cc-input-shell"
        data-drop={dropping}
        onDragOver={event => {
          event.preventDefault()
          setDropping(true)
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={onDrop}
      >
        <div className="cc-input-box">
          {token !== undefined && recognized !== undefined && (
            <div className="cc-input-mirror" aria-hidden ref={mirrorRef}>
              <span className="cc-cmd-token">{token}</span>
              {value.slice(token.length)}
            </div>
          )}
          <textarea
            className="cc-input"
            rows={1}
            ref={inputRef}
            value={value}
            readOnly={props.readOnly === true}
            data-ghost={recognized !== undefined ? 'true' : undefined}
            placeholder={props.readOnly === true
              ? '这个会话正被一个终端进程使用（claude ps 可见），此处只读镜像'
              : props.busy
                ? '正在工作中，消息会排队发出…'
                : '向 Claude Code 发送消息，Enter 发送，Shift+Enter 换行，可粘贴或拖入图片'}
            onChange={event => {
              setValue(event.target.value)
              // Any real edit leaves history recall; the recalled text is
              // from here on just a draft being shaped.
              recallRef.current = null
              updateMenu(event.target)
            }}
            onKeyUp={event => {
              if (!MENU_KEYS.has(event.key)) updateMenu(event.currentTarget)
            }}
            onClick={event => updateMenu(event.currentTarget)}
            onSelect={event => updateMenu(event.currentTarget)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onScroll={() => {
              // The mirror clips instead of scrolling; track the textarea so
              // ghosted text stays line-aligned past the 200px growth cap.
              if (mirrorRef.current !== null && inputRef.current !== null) {
                mirrorRef.current.scrollTop = inputRef.current.scrollTop
              }
            }}
            onPaste={onPaste}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false)
              // A popup that outlives its textarea breaks the Escape
              // contract: with the composer deregistered, one Escape would
              // close the whole surface under a still-open menu. Row clicks
              // are safe here — their mousedown is prevented, so focus never
              // leaves the textarea on the way to a pick.
              setMenu(undefined)
            }}
            onKeyDown={event => {
              // The Enter that confirms an IME candidate is not a submit; some
              // browsers report it only through keyCode 229. A whole-Chinese
              // product hits this on every message, so guard before anything
              // else consumes the key.
              if (event.nativeEvent.isComposing || event.keyCode === 229) return
              // An open popup owns the navigation keys first: arrows move the
              // selection, Escape closes the menu (not the input), and
              // Enter/Tab complete the row instead of submitting. The readOnly
              // guard keeps a menu that raced the flip inert.
              if (!composing && menu !== undefined && props.readOnly !== true) {
                if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault()
                  const count = menu.kind === 'command' ? filteredCommands.length : mentionRows.length
                  if (count > 0) {
                    setMenuIndex(previous => {
                      const last = count - 1
                      if (event.key === 'ArrowDown') return (previous + 1) % count
                      if (event.key === 'ArrowUp') return (previous - 1 + count) % count
                      if (event.key === 'Home') return 0
                      if (event.key === 'End') return last
                      // Paging clamps at the ends instead of wrapping: a
                      // page is a jump, not a rotation.
                      if (event.key === 'PageDown') return Math.min(last, previous + PAGE_ROWS)
                      return Math.max(0, previous - PAGE_ROWS)
                    })
                  }
                  return
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  if (menu.kind === 'mention') {
                    // Dismissed for the current query only; typing on
                    // (a different query) reopens the menu.
                    dismissedQuery.current = menu.query
                  }
                  setMenu(undefined)
                  return
                }
                if (event.key === 'Enter' || event.key === 'Tab') {
                  event.preventDefault()
                  // The mention menu's loading window is not an answer —
                  // rows may still land, and Enter must not send a half-typed
                  // `@token` past them. (An absolute query is never loading:
                  // its typed-reference row is available immediately.)
                  if (menu.kind === 'mention' && mentionState === 'loading') return
                  const count = menu.kind === 'command' ? filteredCommands.length : mentionRows.length
                  if (count === 0) {
                    // Nothing to complete — the menu is advisory, like the
                    // CLI's: Enter sends the draft exactly as typed (an
                    // unknown /command reaches the CLI, which answers for
                    // itself); Tab only closes.
                    setMenu(undefined)
                    if (event.key === 'Enter') submit()
                    return
                  }
                  if (menu.kind === 'command') {
                    const command = filteredCommands[menuIndex]
                    if (command !== undefined) insertCommand(command.name)
                  } else {
                    const row = mentionRows[menuIndex]
                    if (row !== undefined) insertMention(row)
                  }
                  return
                }
              }
              // Shell-style input history: with no popup open and the caret
              // at the head of the first line, ArrowUp walks sent messages
              // (from an empty draft, or from one already being recalled)
              // and ArrowDown walks back — one step below the newest it
              // restores the draft stashed on the way in. Any edit or send
              // leaves the recall (see onChange/submit); an open menu owns
              // the arrows above, and composition was guarded at the top.
              if (menu === undefined && props.readOnly !== true
                && (event.key === 'ArrowUp' || event.key === 'ArrowDown')
                && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
                && event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0
                && (value === '' || recallRef.current !== null)) {
                const recall = recallRef.current
                if (event.key === 'ArrowUp') {
                  const entries = recall?.entries ?? readHistory(historyStamp(props.cwd, props.configDir))
                  if (entries.length > 0) {
                    event.preventDefault()
                    const cursor = recall === null ? 0 : Math.min(recall.cursor + 1, entries.length - 1)
                    recallRef.current = { entries, cursor, stash: recall?.stash ?? value }
                    setValue(entries[cursor])
                  }
                } else if (recall !== null) {
                  event.preventDefault()
                  if (recall.cursor > 0) {
                    recallRef.current = { ...recall, cursor: recall.cursor - 1 }
                    setValue(recall.entries[recall.cursor - 1])
                  } else {
                    // One step below the newest: back to the stashed draft.
                    recallRef.current = { ...recall, cursor: -1 }
                    setValue(recall.stash)
                  }
                }
              }
              // Escape layers: an open menu took it above; next comes
              // interrupting a running turn of ours (the same stop the
              // button offers — a terminal-owned turn keeps the old
              // behavior, no signal of ours can reach it); only then does
              // it leave the input, leaving the surface’s close one key
              // away.
              if (event.key === 'Escape') {
                if (props.busy && props.readOnly !== true && menu === undefined) {
                  event.preventDefault()
                  props.onStop()
                } else {
                  event.currentTarget.blur()
                }
                return
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            }}
          />
        </div>
        {!composing && menu?.kind === 'command' && (
          <CommandMenu
            commands={filteredCommands}
            filter={menu.filter}
            emptyHint={props.commands.length === 0
              ? '命令列表将在会话首次对话后可用'
              : '没有匹配的命令，Enter 将原样发送'}
            selected={menuIndex}
            onSelectedChange={setMenuIndex}
            onPick={command => insertCommand(command.name)}
            onReload={props.onReloadCommands}
            reloading={props.reloadingCommands}
          />
        )}
        {!composing && mentionVisible && menu?.kind === 'mention' && (
          <MentionPicker
            rows={mentionRows}
            state={mentionState}
            truncated={mentionAbsolute ? dirListing?.truncated === true : mentionIndex?.truncated === true}
            absolutePath={exactRow?.path}
            selected={menuIndex}
            onSelectedChange={setMenuIndex}
            onPick={insertMention}
          />
        )}
        {props.busy && props.readOnly === true
          ? <Button size="sm" icon={<IconStopFill16 />} disabled title="回合属于另一个客户端（终端），网页无法中断它">停止</Button>
          : props.busy
            ? <Button size="sm" icon={<IconStopFill16 />} onClick={props.onStop} title="停止 (Esc)">停止</Button>
            : (
              <Button
                variant="primary"
                size="sm"
                icon={<IconSendOutline16 />}
                disabled={empty || uploading > 0}
                onClick={submit}
              >
                发送
              </Button>
            )}
      </div>
    </div>
  )
})
