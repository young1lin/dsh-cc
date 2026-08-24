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
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type UserDialogResult,
} from '@anthropic-ai/claude-agent-sdk'
import type { ResolvedConfig } from './config.ts'
import type {
  AccountSummary,
  CcEventInput,
  ImageRef,
  PermissionAnswer,
  PermissionRequest,
  SessionMeta,
  SlashCommand,
  StreamDelta,
  TurnUsage,
} from './types.ts'

/**
 * Characters of CLI stderr retained for failure diagnostics. The tail is
 * quoted into the `error` transcript event, so it stays small enough to read
 * in the page.
 */
const STDERR_TAIL_LIMIT = 8_000

/** Host callbacks the engine uses to publish facts. */
export interface EngineHooks {
  /** Persist and broadcast one transcript event (seq/ts assigned by the host). */
  emit(input: CcEventInput): Promise<void>
  /** Patch session metadata and broadcast the new snapshot. */
  updateMeta(patch: Partial<SessionMeta>): Promise<void>
  /** Publish one incremental piece of the running turn; never persisted. */
  delta(delta: StreamDelta): void
  /** Publish a pending tool-permission request to the page. */
  permissionRequest(request: PermissionRequest): void
  /** Publish a pending blocking dialog (e.g. AskUserQuestion) to the page. */
  dialogRequest(request: DialogRequest): void
  /** Optional failure hook: the runtime may auto-recover with a fallback model. */
  onEngineFailure?(error: Error): Promise<void> | void
}

/** One image to attach to a user message, already base64-encoded for the SDK. */
export interface SendImage {
  mediaType: ImageRef['mediaType']
  /** Base64 body without a data: URL prefix. */
  data: string
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
  private readonly permissionSuggestions = new Map<string, PermissionUpdate[]>()
  private readonly dialogs = new Map<string, (result: UserDialogResult) => void>()
  private readonly canUseTool: CanUseTool
  private readonly onUserDialog: OnUserDialog
  /** Block indices of the running turn whose block-start reached the page. */
  private readonly openBlocks = new Set<number>()
  /** Whether the running turn already published its turn-stop. */
  private turnStopped = false
  /** Trailing CLI stderr, capped at STDERR_TAIL_LIMIT characters. */
  private stderrTail = ''
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
    this.canUseTool = async (toolName, input, options) => {
      // AskUserQuestion rides the permission channel: the CLI parks the tool
      // and the deny-message becomes the user's answer verbatim.
      if (toolName === 'AskUserQuestion') {
        return await this.bridgeQuestion(input, options.signal)
      }
      const requestId = randomUUID()
      this.permissionInputs.set(requestId, input)
      if (options.suggestions !== undefined) this.permissionSuggestions.set(requestId, options.suggestions)
      const decided = new Promise<PermissionResult>(resolve => {
        this.pending.set(requestId, resolve)
        options.signal.addEventListener('abort', () => {
          if (this.pending.delete(requestId)) resolve({ behavior: 'deny', message: '请求已取消' })
        }, { once: true })
      })
      this.hooks.permissionRequest({
        id: requestId,
        toolName,
        input,
        ...(options.title !== undefined ? { title: options.title } : {}),
        ...(options.displayName !== undefined ? { displayName: options.displayName } : {}),
        ...(options.description !== undefined ? { description: options.description } : {}),
        ...(options.suggestions !== undefined ? { suggestions: options.suggestions } : {}),
        ...(options.blockedPath !== undefined ? { blockedPath: options.blockedPath } : {}),
        ...(options.decisionReason !== undefined ? { decisionReason: options.decisionReason } : {}),
      })
      try {
        return await decided
      } finally {
        this.permissionInputs.delete(requestId)
        this.permissionSuggestions.delete(requestId)
      }
    }
  }

  /**
   * Submit one user text message, starting the CLI query on first use.
   * @param text - the message body.
   */
  async send(text: string, images: SendImage[] = []): Promise<void> {
    if (this.closed) throw new Error('dsh-cc: engine is closed')
    this.lastUsed = Date.now()
    this.ensureStarted()
    this.busy = true
    // Images lead the content list: the model reads the attachment before the
    // sentence about it, which is the order the CLI's own client uses.
    const content = [
      ...images.map(image => ({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.data },
      })),
      ...(text.length > 0 ? [{ type: 'text', text }] : []),
    ]
    const message = {
      type: 'user',
      message: { role: 'user', content },
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

  /**
   * The slash-command catalog of the live CLI, including the user's own
   * skills. The CLI discovers commands lazily, so the list can grow between
   * calls within one session.
   * @returns the command list, or undefined without a live query.
   */
  async supportedCommands(): Promise<SlashCommand[] | undefined> {
    this.lastUsed = Date.now()
    try {
      return await this.query?.supportedCommands()
    } catch {
      return undefined
    }
  }

  /**
   * The authenticated account behind the live CLI: subscription tier for a
   * claude.ai login, or the credential source for API-key and gateway auth.
   * The CLI resolves this from whichever credential actually won, so it is the
   * only reliable answer to "which account is this session spending".
   * @returns the account info, or undefined without a live query or when the
   * CLI cannot resolve one.
   */
  async accountInfo(): Promise<AccountSummary | undefined> {
    this.lastUsed = Date.now()
    try {
      const info = await this.query?.accountInfo()
      if (info === undefined) return undefined
      return {
        ...(info.email !== undefined ? { email: info.email } : {}),
        ...(info.organization !== undefined ? { organization: info.organization } : {}),
        ...(info.subscriptionType !== undefined ? { subscriptionType: info.subscriptionType } : {}),
        ...(info.tokenSource !== undefined ? { tokenSource: info.tokenSource } : {}),
        ...(info.apiProvider !== undefined ? { apiProvider: info.apiProvider } : {}),
      }
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
   * Deliver the page's permission decision. A deny relays the message to the
   * model as the refusal reason; an allow carrying a destination writes the
   * request's suggested rules there, so the CLI stops asking. Passing a
   * destination for a request that carried no suggestions decides that one
   * call only.
   * @param requestId - the pending request id.
   * @param answer - the page's decision, optional note, and optional rule destination.
   * @returns the applied behavior when a pending request matched, else undefined.
   */
  answerPermission(requestId: string, answer: PermissionAnswer): 'allow' | 'deny' | undefined {
    const resolve = this.pending.get(requestId)
    if (!resolve) return undefined
    this.pending.delete(requestId)
    this.lastUsed = Date.now()
    if (answer.behavior === 'deny') {
      resolve({ behavior: 'deny', message: answer.message || '用户在 DSH 页面上拒绝了该操作' })
      return 'deny'
    }
    const remember = answer.remember
    const suggestions = this.permissionSuggestions.get(requestId)
    const updatedPermissions = remember !== undefined && suggestions !== undefined
      ? suggestions.map(update => ({ ...update, destination: remember }))
      : undefined
    resolve({
      behavior: 'allow',
      updatedInput: this.permissionInputs.get(requestId),
      ...(updatedPermissions !== undefined ? { updatedPermissions } : {}),
    })
    const note = answer.message?.trim()
    if (note !== undefined && note !== '') void this.noteToModel(note)
    return 'allow'
  }

  /**
   * Queue one page note as a user message that starts no turn: the CLI appends
   * it to the transcript and merges it into the next querying message, so an
   * allow-with-note reaches the model after the tool result.
   * @param text - the note body.
   */
  private async noteToModel(text: string): Promise<void> {
    const message = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      session_id: this.claudeSessionId ?? '',
      parent_tool_use_id: null,
      shouldQuery: false,
    } as SDKUserMessage
    this.input.push(message)
    await this.hooks.emit({ kind: 'user', text })
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
      // The SDK refuses to skip permission checks unless the caller restates
      // the intent through this companion flag.
      ...(this.config.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      canUseTool: this.canUseTool,
      onUserDialog: this.onUserDialog,
      supportedDialogKinds: ['ask_user_question'],
      includePartialMessages: true,
      stderr: chunk => this.appendStderr(chunk),
      ...(this.startSpec.model ? { model: this.startSpec.model } : this.config.model ? { model: this.config.model } : {}),
      ...(this.config.maxTurns > 0 ? { maxTurns: this.config.maxTurns } : {}),
      ...(this.config.effort !== undefined ? { effort: this.config.effort } : {}),
      ...(this.config.executablePath ? { pathToClaudeCodeExecutable: this.config.executablePath } : {}),
      ...(this.claudeSessionId ? { resume: this.claudeSessionId } : {}),
    }
    this.query = query({ prompt: this.input, options })
    void this.consume(this.query)
  }

  /**
   * Retain the trailing CLI stderr for failure diagnostics.
   * @param chunk - one stderr chunk from the SDK transport.
   */
  private appendStderr(chunk: string): void {
    const merged = this.stderrTail + chunk
    this.stderrTail = merged.length > STDERR_TAIL_LIMIT ? merged.slice(merged.length - STDERR_TAIL_LIMIT) : merged
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
      case 'stream_event': {
        this.onStreamEvent(message)
        return
      }
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
        const outcome = {
          ...(message.error !== undefined ? { error: message.error } : {}),
          ...(message.aborted === true ? { aborted: true } : {}),
        }
        let emittedText = false
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text.trim().length > 0) {
            emittedText = true
            void this.hooks.emit({ kind: 'assistant', text: block.text, ...outcome })
          } else if (block.type === 'thinking' && block.thinking.trim().length > 0) {
            void this.hooks.emit({ kind: 'thinking', text: block.thinking })
          } else if (block.type === 'tool_use') {
            void this.hooks.emit({ kind: 'tool_use', toolUseId: block.id, name: block.name, input: block.input })
          }
        }
        // A turn that failed before producing text carries the reason only on
        // the envelope; without this the failure never reaches the transcript.
        if (!emittedText && message.error !== undefined) {
          void this.hooks.emit({ kind: 'assistant', text: '', ...outcome })
        }
        return
      }
      case 'user': {
        // A resumed CLI replays its stored transcript ahead of the new turn.
        // Engine recycling (live-cap eviction, model/effort/env changes) makes
        // that routine, and re-emitting would duplicate every earlier result.
        if ('isReplay' in message) return
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
          usage: turnUsage(message.usage),
          ...(message.duration_api_ms !== undefined ? { apiDurationMs: message.duration_api_ms } : {}),
          ...(message.subtype === 'success' ? {} : { errors: message.errors }),
          ...(message.terminal_reason !== undefined ? { terminalReason: message.terminal_reason } : {}),
        })
        void this.hooks.updateMeta({
          status: 'idle',
          ...(this.liveModel !== undefined ? { lastGoodModel: this.liveModel } : {}),
          ...(message.total_cost_usd !== undefined ? { totalCostUsd: message.total_cost_usd } : {}),
        })
        return
      }
      default:
        // SDKMessage grows with every CLI release; the kinds not handled here
        // carry no transcript content this page renders.
        return
    }
  }

  /**
   * Publish one partial-message event as a StreamDelta. A subagent's turn
   * (parent_tool_use_id is set) is dropped: the page renders one stream, and
   * the subagent's output arrives with its Task tool result.
   * @param message - the partial-message envelope from the SDK.
   */
  private onStreamEvent(message: SDKPartialAssistantMessage): void {
    if (message.parent_tool_use_id !== null) return
    const event = message.event
    switch (event.type) {
      case 'message_start': {
        this.openBlocks.clear()
        this.turnStopped = false
        this.hooks.delta({
          d: 'turn-start',
          messageId: event.message.id,
          ...(message.ttft_ms !== undefined ? { ttftMs: message.ttft_ms } : {}),
        })
        return
      }
      case 'content_block_start': {
        const start = describeBlock(event.content_block)
        if (start === undefined) return
        this.openBlocks.add(event.index)
        this.hooks.delta({ d: 'block-start', index: event.index, ...start })
        return
      }
      case 'content_block_delta': {
        if (!this.openBlocks.has(event.index)) return
        const delta = event.delta
        switch (delta.type) {
          case 'text_delta':
            this.hooks.delta({ d: 'text', index: event.index, text: delta.text })
            return
          case 'thinking_delta':
            this.hooks.delta({ d: 'thinking', index: event.index, text: delta.thinking })
            return
          case 'input_json_delta':
            this.hooks.delta({ d: 'tool-input', index: event.index, partialJson: delta.partial_json })
            return
          default:
            // Signature, citation, and compaction deltas amend a block the
            // page renders from its final event instead.
            return
        }
      }
      case 'content_block_stop': {
        if (!this.openBlocks.delete(event.index)) return
        this.hooks.delta({ d: 'block-stop', index: event.index })
        return
      }
      case 'message_delta': {
        this.stopTurn(event.delta.stop_reason ?? undefined)
        return
      }
      case 'message_stop': {
        this.stopTurn(undefined)
        return
      }
      default:
        // The Messages API adds stream events without a major version bump.
        return
    }
  }

  /**
   * Publish turn-stop once per assistant message. The API sends message_delta,
   * which carries the stop reason, immediately before the reasonless
   * message_stop, so the first of the pair wins.
   * @param stopReason - the model's stop reason, when the event carried one.
   */
  private stopTurn(stopReason: string | undefined): void {
    if (this.turnStopped) return
    this.turnStopped = true
    this.hooks.delta({ d: 'turn-stop', ...(stopReason !== undefined ? { stopReason } : {}) })
  }

  private async finish(error: Error | undefined): Promise<void> {
    this.busy = false
    if (this.closed) return
    if (error !== undefined) {
      await this.hooks.emit({ kind: 'error', message: this.describeFailure(error) })
      await this.hooks.updateMeta({ status: 'error', lastError: error.message })
      await this.hooks.onEngineFailure?.(error)
      return
    }
    await this.hooks.updateMeta({ status: 'idle' })
  }

  /**
   * Quote the CLI stderr tail into a failure message. A process-exit error
   * already carries the SDK's own shorter tail, which this must not repeat.
   * @param error - the failure that ended the query.
   * @returns the message shown in the transcript.
   */
  private describeFailure(error: Error): string {
    const tail = this.stderrTail.trim()
    if (tail === '' || error.message.includes('stderr:')) return error.message
    return `${error.message}\nstderr: ${tail}`
  }
}

/** One streamed content block as the Messages API opens it. */
type StreamedContentBlock = Extract<
  SDKPartialAssistantMessage['event'],
  { type: 'content_block_start' }
>['content_block']

/** The block-start fields that describe an opened block's identity. */
type BlockStartFields = Omit<Extract<StreamDelta, { d: 'block-start' }>, 'd' | 'index'>

/**
 * Map one streamed content block onto its block-start fields.
 * @param block - the content block the API opened.
 * @returns the fields, or undefined for a block that streams no page content.
 */
function describeBlock(block: StreamedContentBlock): BlockStartFields | undefined {
  switch (block.type) {
    case 'text':
      return { type: 'text' }
    case 'thinking':
      return { type: 'thinking' }
    case 'tool_use':
    case 'server_tool_use':
    case 'mcp_tool_use':
      return { type: 'tool_use', toolName: block.name, toolUseId: block.id }
    default:
      // Redacted thinking, server-tool results, uploads, and compaction blocks
      // reach the page only through their final assistant event.
      return undefined
  }
}

/**
 * Reduce the SDK's usage record to the counters the page shows.
 * @param usage - the result message's usage block.
 * @returns the per-turn token counts.
 */
function turnUsage(usage: SDKResultMessage['usage']): TurnUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens,
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
