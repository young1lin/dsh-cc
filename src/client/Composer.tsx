/**
 * The message composer. Typing while a turn runs is allowed — the message is
 * submitted and the CLI queues it — so the textarea is never disabled; only
 * the send control swaps to an interrupt.
 *
 * @module dsh-cc/client/Composer
 */

import { useState, type ReactElement } from 'react'
import { Button, IconSendOutline16, IconStopFill16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { registerCss } from './css.ts'

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
`)

/**
 * Render the composer.
 * @param props - busy state plus send and interrupt callbacks.
 * @returns the composer node.
 */
export function Composer(props: {
  busy: boolean
  onSend(text: string): void
  onStop(): void
}): ReactElement {
  const [value, setValue] = useState('')

  const submit = (): void => {
    const text = value.trim()
    if (text.length === 0) return
    setValue('')
    props.onSend(text)
  }

  return (
    <div className="cc-composer">
      <div className="cc-input-shell">
        <textarea
          className="cc-input"
          rows={1}
          value={value}
          placeholder={props.busy ? '正在工作中，消息会排队发出…' : '向 Claude Code 发送消息，Enter 发送，Shift+Enter 换行'}
          onChange={event => setValue(event.target.value)}
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
                disabled={value.trim().length === 0}
                onClick={submit}
              >
                发送
              </Button>
            )}
      </div>
    </div>
  )
}
