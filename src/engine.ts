/**
 * One interactive Claude Code session engine: a long-lived official Agent SDK
 * query fed by a pushable user-message stream, mapped to dsh-cc transcript
 * events. Tool-permission prompts bridge to the page through hooks; a closed
 * engine restarts on the next send via the native session resume id.
 *
 * @module dsh-cc/engine
 */

import { randomUUID } from 'node:crypto'
import {
  query,
  type CanUseTool,
  type OnUserDialog,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type UserDialogResult,
} from '@anthropic-ai/claude-agent-sdk'
import type { ResolvedConfig } from './config.ts'
import type { CcEventInput, PermissionRequest, SessionMeta } from './types.ts'

/** Host callbacks the engine uses to publish facts. */
export interface EngineHooks {
  /** Persist and broadcast one transcript event (seq/ts assigned by the host). */
  emit(input: CcEventInput): Promise<void>
  /** Patch session metadata and broadcast the new snapshot. */
  updateMeta(patch: Partial<SessionMeta>): Promise<void>
  /** Publish a pending tool-permission request to the page. */
  permissionRequest(request: PermissionRequest): void
  /** Publish a pending blocking dialog (e.g. AskUserQuestion) to the page. */
  dialogRequest(request: DialogRequest): void
  /** Optional failure hook: the runtime may auto-recover with a fallback model. */
  onEngineFailure?(error: Error): Promise<void> | void
}

/** One blocking dialog awaiting a page answer. */
export interface DialogRequest {
  id: string
  kind: string
  payload: Record<string, unknown>
}

/** Static inputs one engine instance runs with. */
export interface EngineStart {
  sessionId: string
  cwd: string
  /** Session-level model override; empty string = plugin default. */
  model: string
  claudeSessionId?: string
}

/**
 * Minimal pushable async iterable: send() pushes user messages, close()
 * ends the stream so the SDK query drains and the CLI process exits.
 */
class Pushable<T> {
  private queue: T[] = []
  private wake: (() => void) | undefined
  private closed = false

  /**
   * Queue one value for the consumer.
   * @param value - the value to yield.
   */
  push(value: T): void {
    if (this.closed) return
    this.queue.push(value)
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  /** End the stream after the queued values drain. */
  close(): void {
    this.closed = true
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  /** @returns the async iterator over pushed values. */
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        for (;;) {
          const value = this.queue.shift()
          if (value !== undefined) return { value, done: false }
          if (this.closed) return { value: undefined, done: true }
          await new Promise<void>(resolve => {
            this.wake = resolve
          })
        }
      },
    }
  }
}

/** One live Claude Code conversation: at most one CLI query at a time. */
export class SessionEngine {
  private readonly input = new Pushable<SDKUserMessage>()
  private readonly abort = new AbortController()
  private readonly pending = new Map<string, (result: PermissionResult) => void>()
  private readonly permissionInputs = new Map<string, Record<string, unknown>>()
  private readonly dialogs = new Map<string, (result: UserDialogResult) => void>()
  private readonly canUseTool: CanUseTool
  private readonly onUserDialog: OnUserDialog
  private started = false
  private closed = false
  private query: Query | undefined

  /** Native Claude Code session id; learned from init, then the resume anchor. */
  claudeSessionId: string | undefined
  /** Model id reported by the live process init; the lastGoodModel candidate. */
  liveModel: string | undefined
  /** True while a submitted message has not reached its result message yet. */
  busy = false
  /** Last activity timestamp; the live-cap eviction order. */
  lastUsed = Date.now()

  /** Whether close() already ran; a closed engine restarts through a new instance. */
  get isClosed(): boolean {
    return this.closed
  }

  constructor(
    private readonly startSpec: EngineStart,
    private readonly config: ResolvedConfig,
    private readonly hooks: EngineHooks,
  ) {
    this.claudeSessionId = startSpec.claudeSessionId
    this.onUserDialog = async (request, { signal }) => {
      const requestId = randomUUID()
      const decided = new Promise<UserDialogResult>(resolve => {
        this.dialogs.set(requestId, resolve)
        signal.addEventListener('abort', () => {
          if (this.dialogs.delete(requestId)) resolve({ behavior: 'cancelled' })
        }, { once: true })
      })
      this.hooks.dialogRequest({ id: requestId, kind: request.dialogKind, payload: request.payload })
      return await decided
    }
    this.canUseTool = async (toolName, input, { signal }) => {
      // AskUserQuestion rides the permission channel: the CLI parks the tool
      // and the deny-message becomes the user's answer verbatim.
      if (toolName === 'AskUserQuestion') {
        return await this.bridgeQuestion(input, signal)
      }
      const requestId = randomUUID()
      this.permissionInputs.set(requestId, input)
      const decided = new Promise<PermissionResult>(resolve => {
        this.pending.set(requestId, resolve)
        signal.addEventListener('abort', () => {
          if (this.pending.delete(requestId)) resolve({ behavior: 'deny', message: '请求已取消' })
        }, { once: true })
      })
      this.hooks.permissionRequest({ id: requestId, toolName, input })
      try {
        return await decided
      } finally {
        this.permissionInputs.delete(requestId)
      }
    }
  }

  /**
   * Submit one user text message, starting the CLI query on first use.
   * @param text - the message body.
   */
  async send(text: string): Promise<void> {
    if (this.closed) throw new Error('dsh-cc: engine is closed')
    this.lastUsed = Date.now()
    this.ensureStarted()
    this.busy = true
    const message = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      session_id: this.claudeSessionId ?? '',
      parent_tool_use_id: null,
    } as SDKUserMessage
    this.input.push(message)
  }

  /**
   * Bridge one AskUserQuestion tool call to the page and await the answer.
   * The page answers through the dialog channel; the deny-message carries
   * the user's choices back to the model verbatim.
   * @param input - the tool input (questions array).
   * @param signal - cancellation signal from the SDK.
   * @returns the permission result whose message is the user's answer.
   */
  private async bridgeQuestion(input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    const requestId = randomUUID()
    const decided = new Promise<PermissionResult>(resolve => {
      this.dialogs.set(requestId, result => {
        if (result.behavior === 'cancelled') {
          resolve({ behavior: 'deny', message: '用户没有回答（取消了问题）' })
          return
        }
        resolve({ behavior: 'deny', message: formatQuestionAnswer(result.result) })
      })
      signal.addEventListener('abort', () => {
        if (this.dialogs.delete(requestId)) {
          resolve({ behavior: 'deny', message: '请求已取消' })
        }
      }, { once: true })
    })
    this.hooks.dialogRequest({ id: requestId, kind: 'ask_user_question', payload: input })
    return await decided
  }

  /**
   * Fetch the structured /usage data (session cost plus claude.ai plan
   * rate-limit windows) through the SDK control channel. Experimental SDK
   * API; returns undefined without a live query or on failure.
   * @returns the raw usage response, or undefined.
   */
  async getUsage(): Promise<unknown> {
    this.lastUsed = Date.now()
    const q = this.query
    if (q === undefined) return undefined
    try {
      return await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
    } catch {
      return undefined
    }
  }

  /**
   * Context window breakdown (system prompt, tools, messages) via the SDK
   * control channel.
   * @returns the usage response, or undefined without a live query.
   */
  async getContextUsage(): Promise<unknown> {
    this.lastUsed = Date.now()
    try {
      return await this.query?.getContextUsage()
    } catch {
      return undefined
    }
  }

  /**
   * Switch the model for subsequent turns.
   * @param model - model id or alias; undefined resets to the session default.
   * @returns true when a live query accepted the switch.
   */
  async setModel(model: string | undefined): Promise<boolean> {
    this.lastUsed = Date.now()
    const q = this.query
    if (q === undefined) return false
    await q.setModel(model)
    return true
  }

  /**
   * Switch the reasoning effort level for subsequent turns (live processes
   * only; a cold session spawns with the runtime's current effort).
   * @param level - effort level, or undefined to reset to the default.
   * @returns true when a live query accepted the change.
   */
  async setEffort(level: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined): Promise<boolean> {
    this.lastUsed = Date.now()
    const q = this.query
    if (q === undefined) return false
    await q.applyFlagSettings(level === undefined ? { effortLevel: null } : { effortLevel: level })
    return true
  }

  /**
   * The selectable model catalog from the live CLI (display names, effort
   * support).
   * @returns the model list, or undefined without a live query.
   */
  async supportedModels(): Promise<readonly unknown[] | undefined> {
    this.lastUsed = Date.now()
    try {
      return await this.query?.supportedModels()
    } catch {
      return undefined
    }
  }

  /** Request cancellation of the current turn; the query and process stay alive. */
  async interrupt(): Promise<void> {
    this.lastUsed = Date.now()
    try {
      await this.query?.interrupt()
    } catch (error) {
      await this.hooks.emit({
        kind: 'error',
        message: `中断失败: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  /**
   * Deliver the page's permission decision.
   * @param requestId - the pending request id.
   * @param behavior - allow or deny.
   * @param message - optional deny message shown to the model.
   * @returns the behavior when a pending request matched, else undefined.
   */
  answerPermission(requestId: string, behavior: 'allow' | 'deny', message?: string): 'allow' | 'deny' | undefined {
    const resolve = this.pending.get(requestId)
    if (!resolve) return undefined
    this.pending.delete(requestId)
    this.lastUsed = Date.now()
    if (behavior === 'allow') {
      resolve({ behavior: 'allow', updatedInput: this.permissionInputs.get(requestId) })
    } else {
      resolve({ behavior: 'deny', message: message || '用户在 DSH 页面上拒绝了该操作' })
    }
    return behavior
  }

  /**
   * Deliver the page's dialog answer.
   * @param requestId - the pending dialog id.
   * @param answers - the completed result payload; undefined cancels.
   * @returns true when a pending dialog matched.
   */
  answerDialog(requestId: string, answers: unknown): boolean {
    const resolve = this.dialogs.get(requestId)
    if (!resolve) return false
    this.dialogs.delete(requestId)
    this.lastUsed = Date.now()
    resolve(answers === undefined ? { behavior: 'cancelled' } : { behavior: 'completed', result: answers })
    return true
  }

  /** Close the input stream, deny every pending request, and terminate the CLI process tree. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const [requestId, resolve] of [...this.pending]) {
      this.pending.delete(requestId)
      resolve({ behavior: 'deny', message: '会话已关闭' })
    }
    for (const [requestId, resolve] of [...this.dialogs]) {
      this.dialogs.delete(requestId)
      resolve({ behavior: 'cancelled' })
    }
    this.input.close()
    this.abort.abort()
    try {
      this.query?.close()
    } catch {
      // close() on an already-exited query throws; the process tree is gone anyway.
    }
  }

  private ensureStarted(): void {
    if (this.started) return
    this.started = true
    const options: Options = {
      cwd: this.startSpec.cwd,
      abortController: this.abort,
      env: { ...process.env, ...this.config.env },
      permissionMode: this.config.permissionMode,
      canUseTool: this.canUseTool,
      onUserDialog: this.onUserDialog,
      supportedDialogKinds: ['ask_user_question'],
      ...(this.startSpec.model ? { model: this.startSpec.model } : this.config.model ? { model: this.config.model } : {}),
      ...(this.config.maxTurns > 0 ? { maxTurns: this.config.maxTurns } : {}),
      ...(this.config.effort !== undefined ? { effort: this.config.effort } : {}),
      ...(this.config.executablePath ? { pathToClaudeCodeExecutable: this.config.executablePath } : {}),
      ...(this.claudeSessionId ? { resume: this.claudeSessionId } : {}),
    }
    this.query = query({ prompt: this.input, options })
    void this.consume(this.query)
  }

  private async consume(q: Query): Promise<void> {
    try {
      for await (const message of q) this.onMessage(message)
      await this.finish(undefined)
    } catch (error) {
      await this.finish(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private onMessage(message: SDKMessage): void {
    switch (message.type) {
      case 'system': {
        if (message.subtype === 'init') {
          this.claudeSessionId = message.session_id
          this.liveModel = message.model
          void this.hooks.updateMeta({ claudeSessionId: message.session_id })
          void this.hooks.emit({
            kind: 'system',
            subtype: 'init',
            data: {
              model: message.model,
              cwd: message.cwd,
              tools: message.tools,
            },
          })
        }
        return
      }
      case 'assistant': {
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text.trim().length > 0) {
            void this.hooks.emit({ kind: 'assistant', text: block.text })
          } else if (block.type === 'thinking' && block.thinking.trim().length > 0) {
            void this.hooks.emit({ kind: 'thinking', text: block.thinking })
          } else if (block.type === 'tool_use') {
            void this.hooks.emit({ kind: 'tool_use', toolUseId: block.id, name: block.name, input: block.input })
          }
        }
        return
      }
      case 'user': {
        const content = message.message.content
        const blocks = typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content
        for (const block of blocks) {
          if (block.type === 'tool_result') {
            const text = toolResultText(block.content)
            // The AskUserQuestion answer rides the permission-deny channel,
            // so the CLI marks it as an error; it is a normal answer.
            const isAnswer = text.startsWith('用户回答：') || text.startsWith('用户没有回答')
            void this.hooks.emit({
              kind: 'tool_result',
              toolUseId: block.tool_use_id,
              text,
              isError: block.is_error === true && !isAnswer,
            })
          }
        }
        return
      }
      case 'result': {
        this.busy = false
        const isError = message.subtype !== 'success' || message.is_error === true
        void this.hooks.emit({
          kind: 'result',
          subtype: message.subtype,
          text: message.subtype === 'success' ? message.result : '',
          isError,
          durationMs: message.duration_ms ?? 0,
          numTurns: message.num_turns ?? 0,
          totalCostUsd: message.total_cost_usd ?? 0,
        })
        void this.hooks.updateMeta({
          status: 'idle',
          ...(this.liveModel !== undefined ? { lastGoodModel: this.liveModel } : {}),
          ...(message.total_cost_usd !== undefined ? { totalCostUsd: message.total_cost_usd } : {}),
        })
        return
      }
      default:
        return
    }
  }

  private async finish(error: Error | undefined): Promise<void> {
    this.busy = false
    if (this.closed) return
    if (error !== undefined) {
      await this.hooks.emit({ kind: 'error', message: error.message })
      await this.hooks.updateMeta({ status: 'error', lastError: error.message })
      await this.hooks.onEngineFailure?.(error)
      return
    }
    await this.hooks.updateMeta({ status: 'idle' })
  }
}

/**
 * Render the page's structured answer into the message the model reads.
 * @param answers - the dialog result payload ({answers:[{questionId, optionLabels}]}).
 * @returns a compact Chinese answer line per question.
 */
function formatQuestionAnswer(answers: unknown): string {
  const record = answers as { answers?: { questionId?: unknown; optionLabels?: unknown; text?: unknown }[] } | undefined
  const list = Array.isArray(record?.answers) ? record?.answers : []
  if (list.length === 0) return '用户没有回答'
  const parts: string[] = []
  for (const item of list) {
    const question = typeof item?.questionId === 'string' ? item.questionId : ''
    const options = Array.isArray(item?.optionLabels)
      ? item.optionLabels.filter((option): option is string => typeof option === 'string')
      : []
    const text = typeof item?.text === 'string' && item.text.trim().length > 0 ? item.text.trim() : ''
    const value = text !== ''
      ? text + (options.length > 0 ? '（同时选择了：' + options.join('、') + '）' : '')
      : (options.length > 0 ? options.join('、') : '（未选择）')
    parts.push((question !== '' ? question + '：' : '') + value)
  }
  return '用户回答：' + parts.join('；')
}

/**
 * Flatten a tool_result content field to page text.
 * @param content - string or content-block array from the SDK.
 * @returns the flattened text.
 */
function toolResultText(content: string | readonly unknown[] | undefined): string {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'object' && block !== null && 'type' in block) {
      const record = block as Record<string, unknown>
      if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
      else parts.push(JSON.stringify(block))
    } else {
      parts.push(String(block))
    }
  }
  return parts.join('\n')
}
