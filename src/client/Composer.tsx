/**
 * The message composer. Typing while a turn runs is allowed — the message is
 * submitted and the CLI queues it — so the textarea is never disabled; only
 * the send control swaps to an interrupt.
 *
 * @module dsh-cc/client/Composer
 */

import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactElement } from 'react'
import { Button, IconSendOutline16, IconStopFill16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { uploadImage } from './api/sessions.ts'
import { registerCss } from './css.ts'
import { useOverlay } from './overlay.ts'
import { MEDIA_TYPE_EXTENSIONS, type ImageRef } from '../types.ts'

registerCss('composer', `
.cc-input-shell {
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

.cc-input {
  flex: 1;
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
 * Render the composer.
 * @param props - busy state plus send and interrupt callbacks. `readOnly`
 *   marks a session a live CLI process holds open: the box turns read-only
 *   with a reason, because that process is a concurrent writer and no stop
 *   signal of ours can reach its turn.
 * @returns the composer node.
 */
export function Composer(props: {
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
  const inputRef = useRef<HTMLTextAreaElement>(null)
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
    void Promise.resolve(props.onSend(text, attachments)).catch((error: unknown) => {
      setFailure(error instanceof Error ? error.message : String(error))
      setValue(previous => (previous === '' ? text : previous))
      setImages(previous => (previous.length === 0 ? attachments : previous))
    })
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
        <textarea
          className="cc-input"
          rows={1}
          ref={inputRef}
          value={value}
          readOnly={props.readOnly === true}
          placeholder={props.readOnly === true
            ? '这个会话正被一个终端进程使用（claude ps 可见），此处只读镜像'
            : props.busy
              ? '正在工作中，消息会排队发出…'
              : '向 Claude Code 发送消息，Enter 发送，Shift+Enter 换行，可粘贴或拖入图片'}
          onChange={event => setValue(event.target.value)}
          onPaste={onPaste}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={event => {
            // The Enter that confirms an IME candidate is not a submit; some
            // browsers report it only through keyCode 229. A whole-Chinese
            // product hits this on every message, so guard before anything
            // else consumes the key.
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
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
