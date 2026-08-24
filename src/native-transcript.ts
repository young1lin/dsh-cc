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
 * @module dsh-cc/native-transcript
 */

import { getSessionMessages, type SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import type { CcEvent, CcEventInput, ImageRef } from './types.ts'

/** Options for reading one session's historical transcript from native storage. */
export interface ReadNativeTranscriptOptions {
  /** Project directory the session belongs to; omit to search every project. */
  cwd?: string
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

  const events: CcEvent[] = []
  let seq = 0
  let lastTs = new Date(0).toISOString()
  for (const message of messages) {
    const ts = resolveTimestamp(message, lastTs)
    lastTs = ts
    const inputs = mapSessionMessage(message)
    const images = options.storeImage === undefined
      ? []
      : await storeMessageImages(message, options.storeImage)
    for (const input of attachImages(inputs, images)) {
      seq += 1
      events.push({ ...input, seq, ts } as CcEvent)
    }
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
  const content = readMessageContent(message.message)
  if (content === undefined) return []
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content
  if (message.type === 'assistant') return blocks.flatMap(mapAssistantBlock)
  if (message.type === 'user') return blocks.flatMap(mapUserBlock)
  // 'system' SessionMessage records (compaction boundaries, etc.) carry no
  // `message` payload through getSessionMessages — nothing to render.
  return []
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
 * @returns a single-element array for a recognized, non-empty block; empty
 *   for an empty text block or a block type this module does not render.
 *   Native `image` blocks are dropped: dsh-cc's `ImageRef` addresses bytes
 *   in its own session-store `blobs/` directory, which a native transcript
 *   was never written through, so there is no blob to reference.
 */
function mapUserBlock(block: RawBlock): CcEventInput[] {
  if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
    return [{ kind: 'user', text: block.text }]
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
