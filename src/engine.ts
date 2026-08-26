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
import { mentionBlocks } from './mentions.ts'
import type {
  AccountSummary,
  CcEventInput,
  ImageRef,
  PermissionAnswer,
  PermissionModeValue,
  PermissionRequest,
  SessionMeta,
  SlashCommand,
  StreamDelta,
  TaskRow,
  TurnUsage,
} from './types.ts'
import { TERMINAL_TASK_STATUSES } from './types.ts'

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
  /** Publish the session's whole task table; display state, never persisted. */
  tasks(rows: TaskRow[]): void
  /**
   * Publish a telemetry snapshot (context accounting, plan usage) probed
   * after each completed model response — the statusline cadence.
   */
  telemetry(payload: TelemetrySnapshot): void
  /** Optional failure hook: the runtime may auto-recover with a fallback model. */
  onEngineFailure?(error: Error): Promise<void> | void
}

/** One image to attach to a user message, already base64-encoded for the SDK. */
export interface SendImage {
  mediaType: ImageRef['mediaType']
  /** Base64 body without a data: URL prefix. */
  data: string
}

/**
 * One telemetry push: the control channel's context-accounting and usage
 * answers, passed through as the CLI shaped them. Either half may be absent
 * when its probe failed; presence is the signal the page renders on.
 */
export interface TelemetrySnapshot {
  /** Context-window breakdown (getContextUsage's answer). */
  context?: unknown
  /** Session cost plus plan rate-limit windows (the usage probe's answer). */
  usage?: unknown
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
  /** Session-level permission-posture override; empty string = plugin default. */
  permissionMode: string
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
  /**
   * Whether the main stream has opened at least one block this turn. A turn
   * that ends without any is one the model never ran — a local slash command
   * answering straight from the CLI — and its final text is command output.
   * Reset only at CLI-reported turn boundaries (non-replay user echo, result),
   * never in send(): a message queued mid-turn must not flip it under the
   * envelope still in flight.
   */
  private streamedThisTurn = false
  /**
   * Whether the turn in progress was started by a `/` command — the only
   * input that can produce local-command output. Guarding the
   * command-output classification on it keeps a zero-stream envelope that is
   * NOT command output (an interrupt acknowledgement) out of the bucket.
   */
  private turnWasCommand = false
  /** The session's live task table in start order; display state only. */
  private readonly taskTable = new Map<string, TaskRow>()
  /** Trailing CLI stderr, capped at STDERR_TAIL_LIMIT characters. */
  private stderrTail = ''
  private started = false
  private closed = false
  private queryEnded = false
  private query: Query | undefined

  /** Native Claude Code session id; learned from init, then the resume anchor. */
  claudeSessionId: string | undefined
  /** Model id reported by the live process init; the lastGoodModel candidate. */
  liveModel: string | undefined
  /** True while a submitted message has not reached its result message yet. */
  busy = false
  /** Last activity timestamp; the live-cap eviction order. */
  lastUsed = Date.now()
  /**
   * Host callback fired once this engine's query has terminated. A terminated
   * engine can never serve another message — its input stream has no consumer
   * — so the host uses this to drop it from its live table immediately. Set
   * by the host after construction; never called on an engine the host
   * already removed.
   */
  onEnd: (() => void) | undefined
  /**
   * The most recent submission, kept verbatim so the host can replay it when
   * the process dies mid-turn.
   *
   * The transcript cannot answer "what was just sent" for a session the CLI
   * owns: that store is read as a bounded tail and its own copy of the message
   * is written by the process that then failed. Keeping the submission here is
   * what makes a model fallback replay the message that failed rather than
   * some earlier one — attachments included.
   */
  lastSend: { text: string; images: SendImage[] } | undefined

  /** Whether close() already ran; a closed engine restarts through a new instance. */
  get isClosed(): boolean {
    return this.closed
  }

  /**
   * Whether the SDK query has terminated — the CLI exited or failed, however
   * cleanly. Such an engine is spent: pushing into it feeds a stream nobody
   * consumes, so the host must spawn a replacement instead of reusing it.
   * Set synchronously the moment the termination is noticed, so a send racing
   * the end-of-query bookkeeping still sees it.
   */
  get isDead(): boolean {
    return this.queryEnded
  }

  /**
   * The environment layer this engine's process was spawned with. Environment
   * is spawn-time only, so the host compares this against the session's
   * current layer on send and recycles a stale idle engine instead of reusing
   * it — the case the save-time recycler misses when the turn was running.
   */
  get spawnEnv(): Readonly<Record<string, string>> {
    return this.config.env
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
    this.lastSend = { text, images }
    this.ensureStarted()
    // A locally-dispatched command turn NEVER echoes a user message (verified
    // against the payload: init → synthetic assistant → result, no echo), so
    // the turn's command-ness is seeded here and only refined by a later
    // echo. The stream flag resets only when no turn is in flight: a message
    // QUEUED under a streaming turn must not flip the flag under the envelope
    // still in flight — that envelope's own message_start already armed it.
    if (!this.busy) this.streamedThisTurn = false
    this.turnWasCommand = text.trimStart().startsWith('/')
    this.busy = true
    // Images lead the content list: the model reads the attachment before the
    // sentence about it, which is the order the CLI's own client uses.
    // @-mentions follow the text: the sentence names the reference first, the
    // payload sits behind it.
    const content = [
      ...images.map(image => ({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.data },
      })),
      ...(text.length > 0 ? [{ type: 'text', text }] : []),
      ...await mentionBlocks(text, this.startSpec.cwd),
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
   * Start the CLI process without submitting anything.
   *
   * The control channel — the model catalog, the account, the context
   * accounting — is answered by a live process out of its own resolved
   * configuration and costs no API call, so a caller that needs only those can
   * start a query and never send a turn.
   */
  warmUp(): void {
    if (this.closed) throw new Error('dsh-cc: engine is closed')
    this.lastUsed = Date.now()
    this.ensureStarted()
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

  /** Whether a telemetry probe is running; a second trigger is dropped, not queued. */
  private telemetryInFlight = false

  /**
   * Probe both telemetry readouts and hand the answers to the host for
   * broadcast. Fired once per completed model response — the low frequency
   * is the point (the page's status bar follows the turn, not the stream).
   * A probe already in flight swallows the trigger: queueing would replay a
   * stale moment's answer after the next response already completed, and the
   * next completed response fires a fresh one anyway.
   */
  private async pushTelemetry(): Promise<void> {
    if (this.telemetryInFlight || this.closed) return
    this.telemetryInFlight = true
    try {
      const [context, usage] = await Promise.all([
        this.getContextUsage(),
        this.getUsage(),
      ])
      if (context !== undefined || usage !== undefined) {
        this.hooks.telemetry({
          ...(context !== undefined ? { context } : {}),
          ...(usage !== undefined ? { usage } : {}),
        })
      }
    } finally {
      this.telemetryInFlight = false
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

  /** The task table in start order; empty once the engine has ended. */
  taskRows(): TaskRow[] {
    return [...this.taskTable.values()]
  }

  /**
   * Stop one running task; the CLI settles it with a `task_notification`
   * whose status is `stopped`.
   * @param taskId - the task id from the table.
   */
  async stopTask(taskId: string): Promise<void> {
    this.lastUsed = Date.now()
    await this.query?.stopTask(taskId)
  }

  /**
   * Background the foreground task one tool call started — the control-call
   * equivalent of the CLI's Ctrl+B.
   * @param toolUseId - the tool_use id that started the task.
   * @returns whether anything was backgrounded.
   */
  async backgroundTask(toolUseId: string): Promise<boolean> {
    this.lastUsed = Date.now()
    const q = this.query
    if (q === undefined) return false
    return await q.backgroundTasks(toolUseId)
  }

  /**
   * Switch the permission posture of the running process; a recycled engine
   * reads the session's persisted override at spawn instead.
   * @param mode - the posture, or undefined to reset to the spawn default.
   * @returns true when a live query accepted the switch.
   */
  async setPermissionMode(mode: PermissionModeValue | undefined): Promise<boolean> {
    this.lastUsed = Date.now()
    const q = this.query
    if (q === undefined) return false
    await q.setPermissionMode(mode ?? resolveSessionPermissionMode(this.startSpec.permissionMode, this.config.permissionMode))
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
    if (note !== undefined && note !== '') {
      void this.noteToModel(note).catch(error => {
        console.warn('dsh-cc: 备注转发失败', error)
      })
    }
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

  /**
   * Fire-and-forget transcript publish that can never surface an unhandled
   * rejection: these run off the message loop, where nobody is left to catch.
   * @param input - the event to publish.
   */
  private publish(input: CcEventInput): void {
    void this.hooks.emit(input).catch(error => {
      console.warn('dsh-cc: 事件发布失败', error)
    })
  }

  /**
   * Fire-and-forget metadata patch with the same never-rejects guarantee.
   * @param patch - the fields to patch.
   */
  private patch(patch: Partial<SessionMeta>): void {
    void this.hooks.updateMeta(patch).catch(error => {
      console.warn('dsh-cc: 会话状态更新失败', error)
    })
  }

  /** Broadcast the task-table snapshot through the host hook. */
  private publishTasks(): void {
    this.hooks.tasks([...this.taskTable.values()])
  }

  /** Drop terminal task rows; called when the next main turn starts. */
  private pruneSettledTasks(): void {
    let changed = false
    for (const [id, row] of [...this.taskTable]) {
      if ((TERMINAL_TASK_STATUSES as readonly string[]).includes(row.status)) {
        this.taskTable.delete(id)
        changed = true
      }
    }
    if (changed) this.publishTasks()
  }

  /**
   * The child's whole environment: everything this process carries, the
   * config layer applied over it, and — while a preset owns the provider
   * scope — that scope's omitted keys stripped, so they cannot leak in from
   * the shell that launched dsh. Windows env vars are case-insensitive, so
   * the common case variants of each deleted key go too.
   */
  private spawnEnvironment(): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value
    }
    Object.assign(env, this.config.env)
    for (const key of this.config.envDeletes ?? []) {
      delete env[key]
      delete env[key.toLowerCase()]
      delete env[key.toUpperCase()]
    }
    return env
  }

  private ensureStarted(): void {
    if (this.started) return
    this.started = true
    const model = resolveSessionModel(this.startSpec.model, this.config.model)
    const permissionMode = resolveSessionPermissionMode(this.startSpec.permissionMode, this.config.permissionMode)
    const options: Options = {
      cwd: this.startSpec.cwd,
      abortController: this.abort,
      env: this.spawnEnvironment(),
      permissionMode,
      // The SDK refuses to skip permission checks unless the caller restates
      // the intent through this companion flag.
      ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      canUseTool: this.canUseTool,
      onUserDialog: this.onUserDialog,
      supportedDialogKinds: ['ask_user_question'],
      includePartialMessages: true,
      stderr: chunk => this.appendStderr(chunk),
      ...(model !== undefined ? { model } : {}),
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
      // finish's own finally still retires the engine if the host hooks fail
      // again inside it; this catch only stops the rejection from escaping a
      // promise nobody awaits.
      await this.finish(error instanceof Error ? error : new Error(String(error)))
        .catch(() => {})
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
          this.patch({ claudeSessionId: message.session_id })
          this.publish({
            kind: 'system',
            subtype: 'init',
            data: {
              model: message.model,
              cwd: message.cwd,
              tools: message.tools,
              permissionMode: message.permissionMode,
            },
          })
          return
        }
        if (message.subtype === 'local_command_output') {
          // A local slash command answered without a model turn; its output is
          // the transcript row the turn produced.
          this.publish({ kind: 'commandOutput', text: message.content })
          return
        }
        if (message.subtype === 'informational') {
          this.publish({
            kind: 'notice',
            text: message.content,
            // 'info' is transcript-mode-only in the CLI; the page folds it
            // into the quietest level it does render.
            level: message.level === 'info' ? 'notice' : message.level,
          })
          return
        }
        this.onTaskMessage(message)
        return
      }
      case 'assistant': {
        const outcome = {
          ...(message.error !== undefined ? { error: message.error } : {}),
          ...(message.aborted === true ? { aborted: true } : {}),
        }
        // A main-thread turn whose stream never opened a block is a local
        // slash command answering without the model (replayed history carries
        // isReplay and stays out). The CLI displays such output but never
        // records it, so it publishes under the sidecar-owned kind — the
        // transcript row survives reloads instead of living one SSE broadcast.
        const localCommand = !('isReplay' in message)
          && message.parent_tool_use_id === null
          && this.turnWasCommand
          && !this.streamedThisTurn
        let emittedText = false
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text.trim().length > 0) {
            emittedText = true
            this.publish(localCommand
              ? { kind: 'commandOutput', text: block.text }
              : { kind: 'assistant', text: block.text, ...outcome })
          } else if (block.type === 'thinking' && block.thinking.trim().length > 0) {
            this.publish({ kind: 'thinking', text: block.thinking })
          } else if (block.type === 'tool_use') {
            this.publish({ kind: 'tool_use', toolUseId: block.id, name: block.name, input: block.input })
          }
        }
        // A turn that failed before producing text carries the reason only on
        // the envelope; without this the failure never reaches the transcript.
        if (!emittedText && message.error !== undefined) {
          this.publish({ kind: 'assistant', text: '', ...outcome })
        }
        // A successful main-thread response has just completed — exactly the
        // moment the CLI's statusline refreshes. Probe the telemetry readouts
        // now (per response, never per delta); subagent envelopes carry their
        // own little contexts and say nothing about the main thread.
        if (message.error === undefined && message.parent_tool_use_id === null) {
          void this.pushTelemetry()
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
        // The non-replay user echo refines the turn state seeded at send: a
        // command turn announces itself either way the CLI echoes it — the
        // raw `/cmd` text or the expanded `<command-name>` marker XML. A
        // tool_result echo mid-loop also lands here; it clears the stream
        // flag, which the next envelope's own message_start re-arms before
        // that envelope completes.
        this.streamedThisTurn = false
        this.turnWasCommand = blocks.some(block => block.type === 'text'
          && (block.text.trimStart().startsWith('/') || block.text.includes('<command-name>')))
        for (const block of blocks) {
          if (block.type === 'tool_result') {
            const text = toolResultText(block.content)
            // The AskUserQuestion answer rides the permission-deny channel,
            // so the CLI marks it as an error; it is a normal answer.
            const isAnswer = text.startsWith('用户回答：') || text.startsWith('用户没有回答')
            this.publish({
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
        this.streamedThisTurn = false
        this.turnWasCommand = false
        const isError = message.subtype !== 'success' || message.is_error === true
        this.publish({
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
        this.patch({
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
   * Fold one task-lifecycle system message into the task table and publish
   * the whole table. Level semantics throughout: the table IS the state, and
   * the page replaces its copy with each snapshot — so a missed frame heals
   * on the next one and a mid-join page is repaired by the session detail.
   * @param message - the system message carrying a task subtype.
   */
  private onTaskMessage(message: Extract<SDKMessage, { type: 'system' }>): void {
    switch (message.subtype) {
      case 'task_started': {
        const previous = this.taskTable.get(message.task_id)
        this.taskTable.set(message.task_id, {
          id: message.task_id,
          type: message.task_type ?? (message.subagent_type !== undefined ? 'subagent' : 'task'),
          status: 'running',
          description: message.description,
          ...(message.tool_use_id !== undefined ? { toolUseId: message.tool_use_id } : {}),
          ...(message.subagent_type !== undefined ? { subagentType: message.subagent_type } : {}),
          ...(message.prompt !== undefined ? { prompt: message.prompt } : {}),
          tokens: previous?.tokens ?? 0,
          toolUses: previous?.toolUses ?? 0,
          durationMs: previous?.durationMs ?? 0,
          ...(previous?.summary !== undefined ? { summary: previous.summary } : {}),
          ...(previous?.isBackgrounded !== undefined ? { isBackgrounded: previous.isBackgrounded } : {}),
        })
        break
      }
      case 'task_progress': {
        const row = this.taskTable.get(message.task_id)
        if (row === undefined) break
        this.taskTable.set(message.task_id, {
          ...row,
          description: message.description,
          tokens: message.usage.total_tokens,
          toolUses: message.usage.tool_uses,
          durationMs: message.usage.duration_ms,
          ...(message.last_tool_name !== undefined ? { lastToolName: message.last_tool_name } : {}),
          ...(message.subagent_type !== undefined ? { subagentType: message.subagent_type } : {}),
          ...(message.summary !== undefined ? { summary: message.summary } : {}),
        })
        break
      }
      case 'task_updated': {
        const row = this.taskTable.get(message.task_id)
        if (row === undefined) break
        const patch = message.patch
        this.taskTable.set(message.task_id, {
          ...row,
          ...(patch.status !== undefined ? { status: patch.status === 'pending' ? 'running' : patch.status } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.error !== undefined ? { error: patch.error } : {}),
          ...(patch.is_backgrounded !== undefined ? { isBackgrounded: patch.is_backgrounded } : {}),
        })
        break
      }
      case 'task_notification': {
        const row = this.taskTable.get(message.task_id)
        this.taskTable.set(message.task_id, {
          id: message.task_id,
          type: row?.type ?? 'task',
          status: message.status,
          description: row?.description ?? message.summary,
          ...(row?.toolUseId !== undefined || message.tool_use_id !== undefined
            ? { toolUseId: row?.toolUseId ?? message.tool_use_id }
            : {}),
          ...(row?.subagentType !== undefined ? { subagentType: row.subagentType } : {}),
          ...(row?.prompt !== undefined ? { prompt: row.prompt } : {}),
          tokens: message.usage?.total_tokens ?? row?.tokens ?? 0,
          toolUses: message.usage?.tool_uses ?? row?.toolUses ?? 0,
          durationMs: message.usage?.duration_ms ?? row?.durationMs ?? 0,
          ...(row?.lastToolName !== undefined ? { lastToolName: row.lastToolName } : {}),
          summary: message.summary,
          ...(row?.isBackgrounded !== undefined ? { isBackgrounded: row.isBackgrounded } : {}),
        })
        break
      }
      case 'background_tasks_changed': {
        // Level signal: reconcile membership only. Rows are never created
        // here — a level for a task whose start frame was missed would
        // otherwise render a nameless ghost.
        for (const task of message.tasks) {
          const row = this.taskTable.get(task.task_id)
          if (row === undefined) continue
          this.taskTable.set(task.task_id, {
            ...row,
            isBackgrounded: true,
            ...(row.description === '' && task.description !== undefined ? { description: task.description } : {}),
          })
        }
        break
      }
      default:
        return
    }
    this.publishTasks()
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
        this.streamedThisTurn = true
        // The next main turn clears the settled rows the previous turn left
        // for review; running rows (a backgrounded task) survive.
        this.pruneSettledTasks()
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

  /**
   * Query-termination bookkeeping. `queryEnded` flips first and synchronously,
   * so a send racing this function already sees a dead engine; the `finally`
   * then guarantees the host's end-of-life callback runs on every path, even
   * one where a host hook itself throws.
   * @param error - the failure that ended the query, or undefined on a clean
   *   end of stream (which can still be a CLI that exited mid-turn).
   */
  private async finish(error: Error | undefined): Promise<void> {
    this.busy = false
    this.queryEnded = true
    this.streamedThisTurn = false
    // Tasks are bound to the CLI process; the transcript cards survive it.
    this.taskTable.clear()
    this.publishTasks()
    if (this.closed) return
    try {
      if (error !== undefined) {
        await this.hooks.emit({ kind: 'error', message: this.describeFailure(error) })
        await this.hooks.updateMeta({ status: 'error', lastError: error.message })
        await this.hooks.onEngineFailure?.(error)
        return
      }
      await this.hooks.updateMeta({ status: 'idle' })
    } finally {
      this.onEnd?.()
    }
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

/**
 * The model a session's engine runs with: the session's own override when it
 * names one, else the resolved config default, else none (the CLI picks).
 *
 * One rule, shared by the spawn path here and the catalog readout in the
 * runtime — two copies of "session.model falls back to the config model"
 * would drift, and the page's current-model marker must agree with what the
 * process actually runs.
 * @param sessionModel - the session's model override; empty = no opinion.
 * @param configModel - the resolved config's default model; empty = none.
 * @returns the model id to spawn with, or undefined to let the CLI choose.
 */
export function resolveSessionModel(sessionModel: string, configModel: string): string | undefined {
  if (sessionModel !== '') return sessionModel
  if (configModel !== '') return configModel
  return undefined
}

/**
 * The permission posture a session's engine runs with: the session's own
 * override when it names one, else the resolved config default. Shared by the
 * spawn path here and the page readout in the runtime so the two cannot drift.
 * @param sessionMode - the session's override; empty = no opinion.
 * @param configMode - the resolved config default.
 * @returns the posture to spawn with.
 */
export function resolveSessionPermissionMode(
  sessionMode: string,
  configMode: ResolvedConfig['permissionMode'],
): PermissionModeValue {
  if (sessionMode !== '') return sessionMode as PermissionModeValue
  return configMode
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
