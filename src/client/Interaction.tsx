/**
 * Blocking interactions: the tool-permission card and the AskUserQuestion card.
 *
 * The permission card prefers the CLI's own copy (`title`, `displayName`,
 * `description`) over anything reconstructed here, because the CLI already
 * knows what a given tool call will actually do. "Always allow" is offered only
 * when the CLI supplied rules to persist; a decision also carries an optional
 * note, which reaches the model either as denial reason or as context after the
 * result.
 *
 * @module dsh-cc/client/Interaction
 */

import { useEffect, useState, type ReactElement } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { registerCss } from './css.ts'
import { toolSummary } from './Transcript.tsx'
import type { DialogQuestion } from './api/interaction.ts'
import type { PermissionAnswer, PermissionRequest } from '../types.ts'

registerCss('interaction', `
.cc-ask {
  align-self: stretch;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-state-warn-primary);
  border-radius: 12px;
  background: var(--dsw-alias-state-warn-tertiary);
}

.cc-ask-head { display: flex; align-items: baseline; gap: 8px; font: var(--dsw-font-s-strong-14); color: var(--dsw-alias-label-primary); }

.cc-ask-sub {
  margin-top: 2px;
  font: var(--dsw-font-xs-13);
  color: var(--dsw-alias-label-secondary);
}

.cc-ask-target {
  margin: 8px 0;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--dsw-alias-markdown-code-block);
  font: var(--dsw-font-markdown-code-block-small);
  font-family: var(--ds-font-family-code);
  color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 180px;
  overflow: auto;
}

.cc-ask-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; align-items: center; }

.cc-q-header {
  font: var(--dsw-font-xxs-12);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--dsw-alias-brand-primary);
}

.cc-q-text { margin: 2px 0 8px; font: var(--dsw-font-s-strong-14); color: var(--dsw-alias-label-primary); }

.cc-q-option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  margin-bottom: 6px;
  padding: 8px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-base);
  text-align: left;
  cursor: pointer;
}

.cc-q-option:hover { border-color: var(--dsw-alias-border-l3); }

.cc-q-option[data-active='true'] {
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-interactive-bg-hover-accent);
}

.cc-q-label { font: var(--dsw-font-xs-strong-13); color: var(--dsw-alias-label-primary); }
.cc-q-desc { font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-secondary); }

/* How long this answer has been parked; lives in the head's far end. */
.cc-ask-wait {
  margin-left: auto;
  flex: none;
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
`)

/**
 * Whether a tool's approval should persist beyond this session by default.
 * Command and network approvals are about a repeatable action, so they belong
 * in the project's local settings; a file edit is about one moment in one
 * conversation, so it stays in the session.
 *
 * @param toolName - the wire tool name.
 * @returns the destination "always allow" writes to.
 */
export function rememberDestination(toolName: string): PermissionAnswer['remember'] {
  return toolName === 'Bash' || toolName === 'WebFetch' || toolName === 'WebSearch'
    ? 'localSettings'
    : 'session'
}

/**
 * The tool-permission card.
 * @param props - the pending request and the answer callback.
 * @returns the card node.
 */
export function PermissionCard(props: {
  request: PermissionRequest
  onAnswer(answer: PermissionAnswer): void
}): ReactElement {
  const [note, setNote] = useState('')
  const [waited, setWaited] = useState(0)
  const { request } = props
  // The CLI parks the whole turn on this answer, and over a slow gateway the
  // card can sit much longer than the UI suggests — make the wait visible.
  useEffect(() => {
    const timer = setInterval(() => setWaited(value => value + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  const target = toolSummary(request.toolName, request.input)
  const canRemember = (request.suggestions?.length ?? 0) > 0
  const destination = rememberDestination(request.toolName)
  const answer = (behavior: 'allow' | 'deny', remember?: PermissionAnswer['remember']): void => {
    props.onAnswer({
      behavior,
      ...(note.trim() !== '' ? { message: note.trim() } : {}),
      ...(remember !== undefined ? { remember } : {}),
    })
  }

  return (
    <div className="cc-ask">
      <div className="cc-ask-head">
        {request.title ?? `Claude 请求使用 ${request.displayName ?? request.toolName}`}
        <span className="cc-ask-wait" title="回合正停在这个答案上">已等待 {Math.floor(waited / 60)}:{String(waited % 60).padStart(2, '0')}</span>
      </div>
      {request.description !== undefined && <div className="cc-ask-sub">{request.description}</div>}
      {request.blockedPath !== undefined && (
        <div className="cc-ask-sub">被规则拦截的路径：{request.blockedPath}</div>
      )}
      <div className="cc-ask-target">{target !== '' ? target : JSON.stringify(request.input, null, 2)}</div>
      <Input
        value={note}
        placeholder="补充说明（可选，会转达给模型）"
        onChange={event => setNote(event.target.value)}
      />
      <div className="cc-ask-actions">
        <Button variant="primary" size="sm" onClick={() => answer('allow')}>允许一次</Button>
        {canRemember && (
          <Button size="sm" onClick={() => answer('allow', destination)}>
            {destination === 'localSettings' ? '总是允许（写入项目设置）' : '本会话总是允许'}
          </Button>
        )}
        <Button size="sm" onClick={() => answer('deny')}>拒绝</Button>
      </div>
    </div>
  )
}

/**
 * The AskUserQuestion card.
 * @param props - the pending dialog payload plus answer and cancel callbacks.
 * @returns the card node.
 */
export function QuestionCard(props: {
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
      if (!multi) return { ...previous, [index]: [label] }
      return {
        ...previous,
        [index]: current.includes(label) ? current.filter(item => item !== label) : [...current, label],
      }
    })
  }

  const answered = (index: number): boolean =>
    (picks[index] ?? []).length > 0 || (texts[index] ?? '').trim().length > 0
  const complete = questions.length === 0 || questions.every((_, index) => answered(index))

  return (
    <div className="cc-ask">
      <div className="cc-ask-head">Claude 想确认几个问题</div>
      {questions.map((question, index) => (
        <div key={`${index}:${question.question ?? ''}`} style={{ marginTop: 10 }}>
          {question.header !== undefined && question.header !== '' && (
            <div className="cc-q-header">{question.header}</div>
          )}
          <div className="cc-q-text">{question.question}</div>
          {(question.options ?? []).map(option => {
            const label = option.label ?? ''
            return (
              <button
                key={`${index}:${label}`}
                type="button"
                className="cc-q-option"
                data-active={(picks[index] ?? []).includes(label)}
                onClick={() => toggle(index, label, question.multiSelect === true)}
              >
                <span className="cc-q-label">{label}</span>
                {option.description !== undefined && option.description !== '' && (
                  <span className="cc-q-desc">{option.description}</span>
                )}
              </button>
            )
          })}
          <Input
            value={texts[index] ?? ''}
            placeholder="其他（自行输入回答）…"
            onChange={event => setTexts(previous => ({ ...previous, [index]: event.target.value }))}
          />
        </div>
      ))}
      <div className="cc-ask-actions">
        <Button
          variant="primary"
          size="sm"
          disabled={!complete}
          onClick={() => props.onAnswer({
            answers: questions.map((question, index) => {
              const custom = (texts[index] ?? '').trim()
              return {
                questionId: question.question ?? '',
                optionLabels: picks[index] ?? [],
                ...(custom !== '' ? { text: custom } : {}),
              }
            }),
          })}
        >
          提交回答
        </Button>
        <Button size="sm" onClick={props.onCancel}>取消</Button>
      </div>
    </div>
  )
}
