/**
 * Fold the live {@link StreamDelta} frames of one in-flight assistant turn
 * into renderable blocks, so the page shows text as the model writes it
 * instead of waiting for the whole message.
 *
 * Live blocks are display state only: nothing here is persisted, and every
 * block is superseded by the committed transcript event that follows it. The
 * surface drops the whole live turn the moment a committed event arrives,
 * which is what keeps a streamed block from rendering twice.
 *
 * @module dsh-cc/client/stream
 */

import type { StreamDelta } from '../types.ts'

/** One content block of the in-flight turn, accumulated from its deltas. */
export interface LiveBlock {
  index: number
  type: 'text' | 'thinking' | 'tool_use'
  /** Accumulated text; empty for a tool block, whose arguments stay unparsed. */
  text: string
  toolName?: string
  toolUseId?: string
  /** True once the block's `block-stop` arrived. */
  closed: boolean
}

/** The assistant turn currently being written. */
export interface LiveTurn {
  messageId: string
  /** Milliseconds from request to first token, when the CLI reported it. */
  ttftMs?: number
  blocks: LiveBlock[]
  /** True once `turn-stop` arrived; the turn stays visible until it commits. */
  stopped: boolean
}

/**
 * Apply one delta frame to the live turn.
 *
 * Frames for a block that never opened are ignored rather than synthesising a
 * block: the SSE stream can be joined mid-turn by a page that connects late,
 * and a half-block rendered without its type reads as corruption.
 *
 * @param turn - the current live turn, or undefined before one starts.
 * @param delta - the incoming frame.
 * @returns the next live turn, or undefined when no turn is in flight.
 */
export function reduceDelta(turn: LiveTurn | undefined, delta: StreamDelta): LiveTurn | undefined {
  switch (delta.d) {
    case 'turn-start':
      return {
        messageId: delta.messageId,
        ...(delta.ttftMs !== undefined ? { ttftMs: delta.ttftMs } : {}),
        blocks: [],
        stopped: false,
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
