/**
 * The message composer. Typing while a turn runs is allowed — the message is
 * submitted and the CLI queues it — so the textarea is never disabled; only
 * the send control swaps to an interrupt.
 *
 * @module dsh-cc/client/Composer
 */

import { useState, type ClipboardEvent, type DragEvent, type ReactElement } from 'react'
import { Button, IconSendOutline16, IconStopFill16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { uploadImage } from './api/sessions.ts'
import { registerCss } from './css.ts'
import type { ImageRef } from '../types.ts'

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

/** URL extension per image type, mirroring the host's blob route. */
const EXTENSIONS: Record<ImageRef['mediaType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/**
 * Render the composer.
 * @param props - busy state plus send and interrupt callbacks.
 * @returns the composer node.
 */
export function Composer(props: {
  busy: boolean
  onSend(text: string, images: ImageRef[]): void
  onStop(): void
}): ReactElement {
  const [value, setValue] = useState('')
  const [images, setImages] = useState<ImageRef[]>([])
  const [uploading, setUploading] = useState(0)
  const [dropping, setDropping] = useState(false)
  const [failure, setFailure] = useState<string | undefined>()

  const empty = value.trim().length === 0 && images.length === 0

  const submit = (): void => {
    if (empty || uploading > 0) return
    setValue('')
    setImages([])
    props.onSend(value.trim(), images)
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
          value={value}
          placeholder={props.busy ? '正在工作中，消息会排队发出…' : '向 Claude Code 发送消息，Enter 发送，Shift+Enter 换行，可粘贴或拖入图片'}
          onChange={event => setValue(event.target.value)}
          onPaste={onPaste}
          onKeyDown={event => {
            if (event.key === 'Escape') event.stopPropagation()
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
        />
        {props.busy
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
