/**
 * Fold the live {@link StreamDelta} frames of one in-flight assistant turn
 * into renderable blocks, so a surface shows text as the model writes it
 * instead of waiting for the whole message.
 *
 * Both halves fold with this one reducer: the node half keeps the folded turn
 * per session so a page that joins mid-turn (or switches away and back) can be
 * handed the in-flight state, and the browser half folds incoming frames into
 * its per-session map. One reducer guarantees the two never disagree about
 * what a frame sequence means.
 *
 * The fold also stamps the turn's `startedAt` from an injected clock
 * reading, so a surface can show elapsed time. Like everything here it is
 * display state only, and a snapshot folded before the stamp existed simply
 * reads as unknown.
 *
 * Live blocks are display state only: nothing here is persisted, and every
 * block is superseded by the committed transcript event that follows it. The
 * surface drops the whole live turn once the turn's result commits, which is
 * what keeps a streamed block from rendering twice.
 *
 * @module dsh-cc/live-turn
 */

import type { LiveBlock, LiveTurn, StreamDelta } from './types.ts'

export type { LiveBlock, LiveTurn }

/**
 * The folded turn with the fold's clock stamps. The extension is optional
 * on purpose: a turn folded by an older half — a snapshot taken before the
 * stamp existed, or a turn already in flight across an upgrade — is still a
 * valid input and a valid prop, and only the elapsed readout degrades.
 */
export interface LiveTurnState extends LiveTurn {
  /** Epoch milliseconds stamped when the turn's `turn-start` frame folded. */
  startedAt?: number
}

/**
 * Apply one delta frame to the live turn.
 *
 * Frames for a block that never opened are ignored rather than synthesising a
 * block: a consumer can join the frame stream mid-block (a page that connects
 * late, or a reconnect that missed the opening), and a half-block rendered
 * without its type reads as corruption. The server-side fold never joins
 * mid-block — it sees every frame from the engine — so its snapshot is the
 * repair path for a consumer with holes.
 *
 * @param turn - the current live turn, or undefined before one starts.
 * @param delta - the incoming frame.
 * @param now - the clock reading the frame folds at; the default reads the
 *   system clock, and an explicit reading keeps the fold a pure function of
 *   (frames, clock) for deterministic use.
 * @returns the next live turn, or undefined when no turn is in flight.
 */
export function reduceDelta(
  turn: LiveTurnState | undefined,
  delta: StreamDelta,
  now: number = Date.now(),
): LiveTurnState | undefined {
  switch (delta.d) {
    case 'turn-start':
      return {
        messageId: delta.messageId,
        ...(delta.ttftMs !== undefined ? { ttftMs: delta.ttftMs } : {}),
        blocks: [],
        stopped: false,
        startedAt: now,
      }
    case 'block-start': {
      if (turn === undefined) return undefined
      const block: LiveBlock = {
        index: delta.index,
        type: delta.type,
        text: '',
        ...(delta.toolName !== undefined ? { toolName: delta.toolName } : {}),
        ...(delta.toolUseId !== undefined ? { toolUseId: delta.toolUseId } : {}),
        closed: false,
      }
      return { ...turn, blocks: [...turn.blocks.filter(item => item.index !== delta.index), block] }
    }
    case 'text':
    case 'thinking':
      return appendText(turn, delta.index, delta.text)
    case 'tool-input':
      // Argument fragments only parse once whole, so they are counted but not
      // shown; the collapsed row reads as the tool name until the call commits.
      return turn
    case 'block-stop':
      return mapBlock(turn, delta.index, block => ({ ...block, closed: true }))
    case 'turn-stop':
      return turn === undefined ? undefined : { ...turn, stopped: true }
    default:
      // A frame kind from a newer node half: ignored, never fatal to the view.
      return turn
  }
}

/**
 * Append streamed text to one open block.
 * @param turn - the current live turn.
 * @param index - the block index the text belongs to.
 * @param text - the fragment.
 * @returns the next live turn.
 */
function appendText(turn: LiveTurn | undefined, index: number, text: string): LiveTurn | undefined {
  return mapBlock(turn, index, block => ({ ...block, text: block.text + text }))
}

/**
 * Replace one block of the live turn.
 * @param turn - the current live turn.
 * @param index - the block index to replace.
 * @param map - the replacement, applied to the existing block only.
 * @returns the next live turn, unchanged when the block never opened.
 */
function mapBlock(
  turn: LiveTurn | undefined,
  index: number,
  map: (block: LiveBlock) => LiveBlock,
): LiveTurn | undefined {
  if (turn === undefined) return undefined
  if (!turn.blocks.some(block => block.index === index)) return turn
  return { ...turn, blocks: turn.blocks.map(block => (block.index === index ? map(block) : block)) }
}
