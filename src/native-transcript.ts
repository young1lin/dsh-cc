/**
 * Maps the Claude Agent SDK's historical session-message read
 * (`getSessionMessages`) onto dsh-cc's own `CcEvent` transcript shape.
 *
 * `SessionMessage.message` is typed `unknown` in the SDK — it is the raw
 * Anthropic `BetaMessage` (assistant) or `MessageParam` (user) written by
 * another process (the `claude` CLI, or a concurrent SDK query), so every
 * field this module reads is validated before use; a block this module does
 * not recognize is skipped rather than thrown on.
 *
 * Compaction boundaries are the one thing `getSessionMessages` cannot
 * deliver: it sanitizes every record down to the declared `SessionMessage`
 * fields (verified against SDK 0.3.220), so a system record's `subtype` and
 * `compactMetadata` never survive the SDK boundary. Those are read straight
 * from the CLI's own transcript JSONL instead — same store the SDK reads,
 * validated with the same lenient pattern, and every failure degrades to
 * "no boundaries" rather than to a failed transcript read.
 *
 * @module dsh-cc/native-transcript
 */

import { createReadStream } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { getSessionMessages, type SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import type { CcEvent, CcEventInput, ImageRef } from './types.ts'

/** Options for reading one session's historical transcript from native storage. */
export interface ReadNativeTranscriptOptions {
  /** Project directory the session belongs to; omit to search every project. */
  cwd?: string
  /**
   * The Claude Code home the session lives under (the account root), used to
   * locate the raw transcript file for compaction boundaries. Falls back to
   * `CLAUDE_CONFIG_DIR`, then the CLI's default `~/.claude`.
   */
  configDir?: string
  /**
   * Maximum number of underlying SDK messages to map, counted from the END of
   * the transcript.
   *
   * The SDK's own `limit`/`offset` page from the START of the session, which
   * is the opposite of what a transcript view wants: a long conversation would
   * render its opening and never its recent turns. The tail is therefore taken
   * here rather than pushed down to `getSessionMessages`.
   */
  limit?: number
  /**
   * Persist one inline image from the transcript and return the reference to
   * record on the event. Native transcripts carry image bytes inline as
   * base64, while `CcEvent` refers to them by blob id, so rehydrating them
   * needs somewhere to put the bytes. Omit to drop images instead.
   */
  storeImage?: (mediaType: ImageRef['mediaType'], base64: string) => Promise<ImageRef>
}

/**
 * Read one session's transcript from the Claude Code CLI's own on-disk
 * store and map it onto dsh-cc's `CcEvent` union in chronological order.
 *
 * One `SessionMessage` can expand into zero or more `CcEvent`s: an assistant
 * turn's text/thinking/tool_use content blocks each become one event, and a
 * user turn's text/tool_result content blocks likewise. `seq` is assigned
 * sequentially over the flattened event list, not over the source messages.
 *
 * @param sessionId - native session UUID.
 * @param options - project directory and the tail cap; see {@link ReadNativeTranscriptOptions.limit}.
 * @returns the mapped events, oldest kept first; empty when the session has no messages.
 */
export async function readNativeTranscript(
  sessionId: string,
  options: ReadNativeTranscriptOptions = {},
): Promise<CcEvent[]> {
  let all: SessionMessage[]
  try {
    all = await getSessionMessages(sessionId, { dir: options.cwd })
  } catch (error) {
    throw new Error(`dsh-cc: failed to read native transcript for session ${sessionId}`, { cause: error })
  }
  // Reading unpaged costs one JSONL parse the SDK performs for any page
  // anyway; only the kept messages are mapped, so a capped read still does the
  // bounded work — image rehydration included.
  const limit = options.limit
  const messages = limit !== undefined && limit > 0 && all.length > limit
    ? all.slice(all.length - limit)
    : all

  // Rows carry their timestamp ahead of seq assignment because compaction
  // boundaries (read separately, from the raw file) splice in by time before
  // the flattened sequence is numbered.
  const rows: { ts: string; input: CcEventInput }[] = []
  let lastTs = new Date(0).toISOString()
  for (const message of messages) {
    const ts = resolveTimestamp(message, lastTs)
    lastTs = ts
    const inputs = mapSessionMessage(message)
    const images = options.storeImage === undefined
      ? []
      : await storeMessageImages(message, options.storeImage)
    for (const input of attachImages(inputs, images)) rows.push({ ts, input })
  }
  const boundaries = await readCompactBoundaries(sessionId, options)
  if (boundaries.length > 0) {
    // Boundaries older than the kept window belong to turns the tail cap has
    // already dropped; rendering one would hang a divider over nothing.
    const windowStart = rows.length > 0 ? rows[0].ts : new Date().toISOString()
    for (const row of boundaries) {
      if (row.ts.localeCompare(windowStart) >= 0) rows.push(row)
    }
    rows.sort((left, right) => left.ts.localeCompare(right.ts))
  }
  const events: CcEvent[] = []
  let seq = 0
  for (const row of rows) {
    seq += 1
    events.push({ ...row.input, seq, ts: row.ts } as CcEvent)
  }
  return events
}

/**
 * Attach a user message's images to the event that represents it.
 *
 * One native record holds every content block of a turn, so its images belong
 * to that turn's single user event rather than to events of their own. A
 * message that is nothing but images still produces one event, with empty
 * text, so the attachment is not silently lost.
 * @param inputs - the events mapped from the record.
 * @param images - the record's stored images.
 * @returns the events with images attached.
 */
function attachImages(inputs: CcEventInput[], images: ImageRef[]): CcEventInput[] {
  if (images.length === 0) return inputs
  const index = inputs.findIndex(input => input.kind === 'user')
  if (index < 0) return [{ kind: 'user', text: '', images }, ...inputs]
  return inputs.map((input, at) => (at === index ? { ...input, images } : input))
}

/**
 * Store every inline image of one native record.
 * @param message - the record to scan.
 * @param store - the sink that persists one image.
 * @returns the references, in content order; empty for a record with no images.
 */
async function storeMessageImages(
  message: SessionMessage,
  store: NonNullable<ReadNativeTranscriptOptions['storeImage']>,
): Promise<ImageRef[]> {
  if (message.type !== 'user') return []
  const content = readMessageContent(message.message)
  if (content === undefined || typeof content === 'string') return []
  const refs: ImageRef[] = []
  for (const block of content) {
    if (block.type !== 'image') continue
    const source = block.source
    if (typeof source !== 'object' || source === null) continue
    const { type, media_type: mediaType, data } = source as Record<string, unknown>
    if (type !== 'base64' || typeof mediaType !== 'string' || typeof data !== 'string') continue
    if (!IMAGE_MEDIA_TYPES.includes(mediaType as ImageRef['mediaType'])) continue
    refs.push(await store(mediaType as ImageRef['mediaType'], data))
  }
  return refs
}

/** Image types `CcEvent` can carry; any other inline type is dropped. */
const IMAGE_MEDIA_TYPES: readonly ImageRef['mediaType'][] = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
]

/**
 * Map one `SessionMessage` to zero or more transcript events, without
 * `seq`/`ts` (the caller assigns those over the full flattened sequence).
 * @param message - one record from `getSessionMessages`.
 * @returns the mapped events in the order their source content blocks appeared;
 *   empty for a record kind this module does not render (e.g. `system`).
 */
export function mapSessionMessage(message: SessionMessage): CcEventInput[] {
  // System records carry their facts at the top level rather than in a
  // `message` payload, so they are mapped before the content read below
  // (which nothing system-shaped would survive).
  if (message.type === 'system') return mapSystemRecord(message)
  const content = readMessageContent(message.message)
  if (content === undefined) return []
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content
  if (message.type === 'assistant') return blocks.flatMap(mapAssistantBlock)
  // The record's own UUID rides along on user rows: it is the anchor the
  // fork and file-rewind endpoints address.
  if (message.type === 'user') return blocks.flatMap(block => mapUserBlock(block, message.uuid))
  return []
}

/**
 * Map one `system` record. The compaction boundary is the only system kind
 * with a visual row; `subtype` and `compactMetadata` are validated
 * top-level reads in the resolveTimestamp pattern — the SDK declares
 * neither on `SessionMessage`. (SDK 0.3.220 additionally strips both
 * before records reach this module, which is why boundaries are also read
 * from the raw file; this branch lights up on its own the moment the SDK
 * passes the fields through.)
 * @param message - the system record.
 * @returns the boundary event, or empty for every other system kind.
 */
function mapSystemRecord(message: SessionMessage): CcEventInput[] {
  const record = message as unknown as { subtype?: unknown; compactMetadata?: unknown }
  if (record.subtype !== 'compact_boundary') return []
  return [compactBoundaryInput(record.compactMetadata)]
}

/** One Anthropic content block as it appears in a native transcript record. */
interface RawBlock {
  type: string
  [key: string]: unknown
}

/**
 * Read and validate the `message.content` field of a raw SDK record.
 * @param message - the `SessionMessage.message` value (`unknown` in the SDK).
 * @returns the content as a string or a block array, or undefined when the
 *   record does not carry the shape this module expects.
 */
function readMessageContent(message: unknown): string | RawBlock[] | undefined {
  if (typeof message !== 'object' || message === null || !('content' in message)) return undefined
  const content = (message as { content: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const blocks: RawBlock[] = []
  for (const block of content) {
    if (typeof block === 'object' && block !== null && typeof (block as { type?: unknown }).type === 'string') {
      blocks.push(block as RawBlock)
    }
    // A block without a string `type` cannot be dispatched below; skipped.
  }
  return blocks
}

/**
 * Map one assistant content block to its transcript event.
 * @param block - a validated content block from an assistant message.
 * @returns a single-element array for a recognized, non-empty block; empty
 *   for an empty text/thinking block or a block type this module skips
 *   (e.g. `redacted_thinking`, `server_tool_use`).
 */
function mapAssistantBlock(block: RawBlock): CcEventInput[] {
  if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
    return [{ kind: 'assistant', text: block.text }]
  }
  if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim().length > 0) {
    return [{ kind: 'thinking', text: block.thinking }]
  }
  if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
    return [{ kind: 'tool_use', toolUseId: block.id, name: block.name, input: block.input }]
  }
  return []
}

/**
 * Map one user content block to its transcript event.
 * @param block - a validated content block from a user message.
 * @param nativeMessageId - the record's own UUID, threaded down from
 *   {@link mapSessionMessage}; rides on text rows as the fork/rewind anchor.
 * @returns a single-element array for a recognized, non-empty block; empty
 *   for an empty text block or a block type this module does not render.
 *   Native `image` blocks are dropped: dsh-cc's `ImageRef` addresses bytes
 *   in its own session-store `blobs/` directory, which a native transcript
 *   was never written through, so there is no blob to reference.
 */
function mapUserBlock(block: RawBlock, nativeMessageId: string): CcEventInput[] {
  if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
    // Background-task completion is harness control context for the parent,
    // not a human message — but its <result> body IS the subagent's final
    // report, and the Agent card it belongs to shows it as the call's result
    // (replacing the internal "launched" acknowledgement). A notification
    // without a usable tool-use id stays dropped. The same drop applies to
    // the plugin's own system-reminder forward instructions.
    const trimmed = block.text.trimStart()
    if (trimmed.startsWith('<task-notification>')) {
      const note = parseTaskNotification(block.text)
      if (note?.toolUseId === undefined) return []
      return [{
        kind: 'tool_result',
        toolUseId: note.toolUseId,
        text: note.result ?? note.summary ?? '',
        isError: note.status !== undefined && note.status !== 'completed',
      }]
    }
    if (trimmed.startsWith('<system-reminder>')) return []
    return [{ kind: 'user', text: block.text, nativeMessageId }]
  }
  if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
    return [{
      kind: 'tool_result',
      toolUseId: block.tool_use_id,
      text: flattenToolResultContent(block.content),
      isError: block.is_error === true,
    }]
  }
  return []
}

/** One parsed `<task-notification>` control message. */
export interface TaskNotification {
  /** The background task id, when the message carried one. */
  taskId: string | undefined
  /** The main-thread Agent/Task tool-use the notification answers. */
  toolUseId: string | undefined
  /** Terminal status: `completed`, `failed`, `stopped`. */
  status: string | undefined
  /** The CLI's one-line completion summary. */
  summary: string | undefined
  /** The subagent's final report — the payload the page renders. */
  result: string | undefined
}

/**
 * Parse a `<task-notification>` control message the CLI injects as a
 * main-thread user text when background work settles. Both the live stream
 * (engine) and the replayed transcript (this module) must surface the same
 * result, so the extraction lives here once.
 * @param text - the raw text block.
 * @returns the parsed fields, or undefined when the text is not a notification.
 */
export function parseTaskNotification(text: string): TaskNotification | undefined {
  if (!text.includes('<task-notification>')) return undefined
  const field = (tag: string): string | undefined => {
    const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
    if (match === null) return undefined
    const value = match[1]?.trim()
    return value === '' ? undefined : value
  }
  return {
    taskId: field('task-id'),
    toolUseId: field('tool-use-id'),
    status: field('status'),
    summary: field('summary'),
    result: field('result'),
  }
}

/**
 * Flatten a tool_result block's `content` field to display text.
 * @param content - string, content-block array, or absent.
 * @returns the flattened text; empty string when `content` is absent.
 */
function flattenToolResultContent(content: unknown): string {
  if (content === undefined || content === null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content)
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string') {
      parts.push((block as { text: string }).text)
    } else {
      parts.push(JSON.stringify(block))
    }
  }
  return parts.join('\n')
}

/**
 * Resolve one record's display timestamp. `SessionMessage` does not declare
 * a `timestamp` field, but the CLI's on-disk records carry one at runtime
 * (mirroring the sibling `SDKAssistantMessage`/`SDKUserMessage` field); a
 * record without a usable value reuses the previous event's timestamp so
 * ordering stays monotonic.
 * @param message - the source record.
 * @param previous - the previous event's resolved timestamp.
 * @returns an ISO 8601 timestamp.
 */
function resolveTimestamp(message: SessionMessage, previous: string): string {
  const raw = (message as unknown as { timestamp?: unknown }).timestamp
  if (typeof raw === 'string' && !Number.isNaN(Date.parse(raw))) return raw
  return previous
}

/**
 * Build one compactBoundary event from a boundary record's metadata.
 *
 * Every field is validated separately: the CLI owns this object and older
 * records carry fewer fields (early auto compactions recorded `preTokens`
 * only), so the divider renders whatever the record can prove.
 * @param metadata - the raw `compactMetadata` value, already unknown-typed.
 * @returns the event input; a record without usable metadata still yields a
 *   bare divider, because the boundary itself is the fact being rendered.
 */
function compactBoundaryInput(metadata: unknown): Extract<CcEventInput, { kind: 'compactBoundary' }> {
  const meta = typeof metadata === 'object' && metadata !== null
    ? metadata as Record<string, unknown>
    : {}
  const tokens = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
  const preTokens = tokens(meta.preTokens)
  const postTokens = tokens(meta.postTokens)
  const cumulativeDroppedTokens = tokens(meta.cumulativeDroppedTokens)
  return {
    kind: 'compactBoundary',
    trigger: typeof meta.trigger === 'string' ? meta.trigger : '',
    ...(preTokens !== undefined ? { preTokens } : {}),
    ...(postTokens !== undefined ? { postTokens } : {}),
    ...(cumulativeDroppedTokens !== undefined ? { cumulativeDroppedTokens } : {}),
  }
}

/**
 * The CLI's project-directory name for a working directory: every
 * non-alphanumeric character collapsed to `-`, and slugs longer than 200
 * characters truncated with a base-36 hash of the full path appended. This
 * mirrors the CLI's own encoding so the raw transcript file can be located
 * at all.
 * @param cwd - the session's working directory.
 * @returns the directory name under `<configDir>/projects/`.
 */
export function encodeProjectDir(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (slug.length <= 200) return slug
  let hash = 0
  for (let at = 0; at < cwd.length; at += 1) hash = ((hash << 5) - hash + cwd.charCodeAt(at)) | 0
  return `${slug.slice(0, 200)}-${Math.abs(hash).toString(36)}`
}

/**
 * Read the session's compaction boundaries from the CLI's own transcript
 * file.
 *
 * `getSessionMessages` sanitizes records to the declared fields, so the
 * boundary metadata never arrives through it (see the module comment); the
 * raw JSONL lines are the only place the CLI's facts exist. The walk is a
 * streaming scan of the same file the SDK parses anyway; subagent and
 * meta lines are skipped exactly as the SDK's own filter skips them. Every
 * failure — no cwd to locate the file, missing file, unreadable or
 * malformed content — degrades to an empty list: the transcript loses its
 * dividers, never its messages.
 * @param sessionId - native session UUID.
 * @param options - the caller's cwd/configDir; cwd is required to locate
 *   the project directory.
 * @returns boundary rows (`ts` + event input) in file order, oldest first.
 */
async function readCompactBoundaries(
  sessionId: string,
  options: ReadNativeTranscriptOptions,
): Promise<{ ts: string; input: CcEventInput }[]> {
  if (options.cwd === undefined) return []
  const root = options.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const file = join(root, 'projects', encodeProjectDir(options.cwd), `${sessionId}.jsonl`)
  const rows: { ts: string; input: CcEventInput }[] = []
  try {
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    for await (const line of lines) {
      // Cheap prefilter before the parse: boundary lines are rare, and a
      // full JSON.parse per line of a multi-megabyte transcript is exactly
      // the cost this avoids.
      if (!line.includes('"compact_boundary"')) continue
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof record !== 'object' || record === null) continue
      const raw = record as Record<string, unknown>
      if (raw.type !== 'system' || raw.subtype !== 'compact_boundary') continue
      // Same exclusions the SDK's transcript filter applies: subagent
      // sidechains and meta rows are not this conversation.
      if (raw.isSidechain === true || raw.isMeta === true || raw.teamName !== undefined) continue
      const ts = raw.timestamp
      if (typeof ts !== 'string' || Number.isNaN(Date.parse(ts))) continue
      rows.push({ ts, input: compactBoundaryInput(raw.compactMetadata) })
    }
  } catch {
    return []
  }
  return rows
}
