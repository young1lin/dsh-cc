/**
 * The message composer. Typing while a turn runs is allowed — the message is
 * submitted and the CLI queues it — so the textarea is never disabled; only
 * the send control swaps to an interrupt. Two CLI-parity affordances hang off
 * the draft: a slash-command menu and an @-mention file picker (the composer
 * owns both selections and all the keyboard routing), plus the blue
 * recognition mirror that underlays the textarea while the leading `/name`
 * names a known command.
 *
 * @module dsh-cc/client/Composer
 */

import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type ReactElement } from 'react'
import { Button, IconSendOutline16, IconStopFill16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { uploadImage } from './api/sessions.ts'
import { listDir } from './api/settings.ts'
import { registerCss } from './css.ts'
import { useOverlay } from './overlay.ts'
import { CommandMenu, filterCommands } from './CommandMenu.tsx'
import { MentionPicker, dirForSegment, tokenFor } from './MentionPicker.tsx'
import { commandToken, matchCommand } from './command-mentions.ts'
import { MEDIA_TYPE_EXTENSIONS, type DirListing, type ImageRef, type SlashCommand } from '../types.ts'

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
const MENU_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Escape', 'Enter', 'Tab'])

/**
 * Render the composer.
 * @param props - `busy` state plus send and interrupt callbacks. `readOnly`
 *   marks a session a live CLI process holds open: the box turns read-only
 *   with a reason, because that process is a concurrent writer and no stop
 *   signal of ours can reach its turn. `sessionId` anchors the composer to
 *   one session (the caller closes it over for the command refresh); `cwd`
 *   gates and roots the mention picker; `commands` drives both the menu and
 *   the recognition token; `onRefreshCommands` refetches on menu open.
 * @returns the composer node.
 */
export function Composer(props: {
  sessionId: string
  /** Session working directory — the mention browser's root and the trigger gate. */
  cwd?: string
  /** The session's cached slash commands; empty when none were loadable. */
  commands: readonly SlashCommand[]
  /** Refetch the command list (menu just opened). */
  onRefreshCommands(): void
  busy: boolean
  readOnly?: boolean
  /**
   * Submit one message. Whatever the send resolves to is ignored; only a
   * rejection matters here, and it restores the cleared draft.
   */
  onSend(text: string, images: ImageRef[]): void | Promise<unknown>
  onStop(): void
}): ReactElement {
  const [value, setValue] = useState('')
  const [images, setImages] = useState<ImageRef[]>([])
  const [uploading, setUploading] = useState(0)
  const [dropping, setDropping] = useState(false)
  const [failure, setFailure] = useState<string | undefined>()
  const [focused, setFocused] = useState(false)
  /** The open popup, with the text that drives it. */
  const [menu, setMenu] = useState<{ kind: 'command'; filter: string } | { kind: 'mention'; segment: string } | undefined>()
  /** The popup's selected row, owned here because the keyboard lives here. */
  const [menuIndex, setMenuIndex] = useState(0)
  /** Native IME composition in flight — the mirror hides and menus go inert. */
  const [composing, setComposing] = useState(false)
  const [mentionDir, setMentionDir] = useState<string | undefined>()
  const [mentionListing, setMentionListing] = useState<DirListing | undefined>()
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

  // The mention picker's directory follows the typed segment; picking `..`
  // (handled in activateMentionRow) retargets it directly.
  useEffect(() => {
    if (menu?.kind !== 'mention' || props.cwd === undefined) {
      setMentionListing(undefined)
      return
    }
    const wanted = dirForSegment(props.cwd, menu.segment)
    setMentionDir(previous => previous === wanted ? previous : wanted)
  }, [menu, props.cwd])
  useEffect(() => {
    if (menu?.kind !== 'mention' || mentionDir === undefined) return
    let stale = false
    setMentionListing(undefined)
    listDir(mentionDir)
      .then(result => {
        if (!stale) setMentionListing(result)
      })
      .catch(() => {
        if (!stale) setMentionListing(undefined)
      })
    return () => {
      stale = true
    }
  }, [menu?.kind, mentionDir])

  /** The command rows for the open filter; empty unless the menu is that kind. */
  const filteredCommands = useMemo(
    () => menu?.kind === 'command' ? filterCommands(props.commands, menu.filter) : [],
    [menu, props.commands],
  )
  const mentionFilter = menu?.kind === 'mention'
    ? menu.segment.slice(menu.segment.lastIndexOf('/') + 1).toLowerCase()
    : ''
  const mentionRows = useMemo(() => {
    if (menu?.kind !== 'mention' || mentionListing === undefined) return []
    const entries = mentionListing.entries
      .filter(entry => entry.name.toLowerCase().includes(mentionFilter))
      .map(entry => ({ name: entry.name, directory: entry.directory, climb: false }))
    return [
      ...(mentionListing.parent !== null ? [{ name: '..', directory: true, climb: true }] : []),
      ...entries,
    ]
  }, [menu?.kind, mentionListing, mentionFilter])

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
    void Promise.resolve(props.onSend(text, attachments)).catch((error: unknown) => {
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
    const openToken = /(?:^|\s)@([^@\s]*)$/.exec(before)
    if (openToken !== null && props.cwd !== undefined) {
      const segment = openToken[1]
      if (menu?.kind !== 'mention' || menu.segment !== segment) {
        setMenu({ kind: 'mention', segment })
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
    requestAnimationFrame(() => element?.setSelectionRange(name.length + 2, name.length + 2))
  }

  /** Insert one picked mention token over the open `@segment` before the caret. */
  const insertMention = (name: string): void => {
    const element = inputRef.current
    if (element === null || menu?.kind !== 'mention') return
    const caret = element.selectionStart ?? element.value.length
    const start = caret - menu.segment.length - 1
    if (start < 0 || element.value[start] !== '@') return
    const token = mentionDir !== undefined && props.cwd !== undefined
      ? tokenFor(props.cwd, `${mentionDir.replace(/\/+$/, '')}/${name}`)
      : name
    const next = `${element.value.slice(0, start)}@${token} ${element.value.slice(caret)}`
    setValue(next)
    setMenu(undefined)
    const at = start + token.length + 2
    requestAnimationFrame(() => element.setSelectionRange(at, at))
  }

  /**
   * Activate one mention row: the `..` row climbs the browser one level up,
   * any other inserts itself as the mention.
   * @param index - the row index into `mentionRows`.
   */
  const activateMentionRow = (index: number): void => {
    const row = mentionRows[index]
    if (row === undefined) return
    if (row.climb) {
      if (mentionListing?.parent != null) setMentionDir(mentionListing.parent)
      return
    }
    insertMention(row.name)
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
            onBlur={() => setFocused(false)}
            onKeyDown={event => {
              // The Enter that confirms an IME candidate is not a submit; some
              // browsers report it only through keyCode 229. A whole-Chinese
              // product hits this on every message, so guard before anything
              // else consumes the key.
              if (event.nativeEvent.isComposing || event.keyCode === 229) return
              // An open popup owns the navigation keys first: arrows move the
              // selection, Escape closes the menu (not the input), and
              // Enter/Tab complete the row instead of submitting.
              if (!composing && menu !== undefined) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  const count = menu.kind === 'command' ? filteredCommands.length : mentionRows.length
                  if (count > 0) {
                    setMenuIndex(previous => (previous + (event.key === 'ArrowDown' ? 1 : count - 1)) % count)
                  }
                  return
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setMenu(undefined)
                  return
                }
                if (event.key === 'Enter' || event.key === 'Tab') {
                  event.preventDefault()
                  if (menu.kind === 'command') {
                    const command = filteredCommands[menuIndex]
                    if (command !== undefined) insertCommand(command.name)
                  } else {
                    activateMentionRow(menuIndex)
                  }
                  return
                }
              }
              // Escape only leaves the input; the surface closes on the next
              // Escape, once focus is no longer holding a draft.
              if (event.key === 'Escape') {
                event.currentTarget.blur()
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
            selected={menuIndex}
            onSelectedChange={setMenuIndex}
            onPick={command => insertCommand(command.name)}
          />
        )}
        {!composing && menu?.kind === 'mention' && (
          <MentionPicker
            rows={mentionRows}
            loading={mentionListing === undefined}
            selected={menuIndex}
            onSelectedChange={setMenuIndex}
            onActivate={activateMentionRow}
          />
        )}
        {props.busy && props.readOnly === true
          ? <Button size="sm" icon={<IconStopFill16 />} disabled title="回合属于另一个客户端（终端），网页无法中断它">停止</Button>
          : props.busy
            ? <Button size="sm" icon={<IconStopFill16 />} onClick={props.onStop}>停止</Button>
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
}
