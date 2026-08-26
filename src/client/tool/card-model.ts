/**
 * Tool-to-card dispatch: which host block primitive draws a given Claude Code
 * tool call, and the material that block needs.
 *
 * Every derivation is result-tolerant by design — a payload that does not parse
 * into its block's model returns null and lands on `generic`, the IN/OUT card
 * that shows the tool's own text unchanged. A card is therefore never drawn
 * from a guess.
 *
 * @module dsh-cc/client/tool/card-model
 */

import type { WebBlockProps } from '@deepseek-ai/dsh-client-ui-primitives'
import { diffCard, type DiffCard } from './diff-card.ts'
import { readCard, type ReadCard } from './read-card.ts'
import { searchCard, type SearchCard } from './search-card.ts'
import { terminalCard, type TerminalCard } from './terminal-card.ts'
import { todoCard, type TodoCard } from './TodoList.tsx'
import { webCard } from './web-card.ts'
import { firstLine, stringField, stripReminders, type ToolResult } from './wire.ts'

/** The subagent delegation a `Task` call describes. */
export interface TaskCard {
  /** The model's one-line statement of what the subagent is for. */
  description: string | undefined
  /** The preset the subagent runs under, e.g. `Explore`. */
  subagentType: string | undefined
  /** The subagent's final report, rendered as markdown; absent while it runs. */
  report: string | undefined
}

/** The card one tool call renders as, discriminated by the block that draws it. */
export type ToolCard =
  | { kind: 'terminal'; terminal: TerminalCard }
  | { kind: 'read'; read: ReadCard }
  | { kind: 'diff'; diff: DiffCard }
  | { kind: 'search'; search: SearchCard }
  | { kind: 'web'; web: WebBlockProps }
  | { kind: 'todo'; todo: TodoCard }
  | { kind: 'task'; task: TaskCard }
  | { kind: 'generic' }

/** The generic IN/OUT card, shared by every derivation that declines a call. */
const GENERIC: ToolCard = { kind: 'generic' }

/**
 * Derive the `Task` card. Unlike the block-backed cards this one cannot fail to
 * parse: both halves are plain text, and an absent one simply renders nothing.
 * @param input - the `tool_use.input` for the call.
 * @param result - the settled result, or undefined while the subagent runs.
 * @returns the delegation material.
 */
function taskCard(input: unknown, result: ToolResult | undefined): TaskCard {
  const report = result === undefined || result.isError ? undefined : stripReminders(result.text)
  return {
    description: stringField(input, 'description'),
    subagentType: stringField(input, 'subagent_type'),
    report: report === undefined || report === '' ? undefined : report,
  }
}

/**
 * Choose the card for one tool call.
 * @param name - wire tool name.
 * @param input - the `tool_use.input` for the call.
 * @param result - the settled result, or undefined while the call is running.
 * @param cwd - the session workspace, which shortens paths and labels the prompt.
 * @returns the card, `generic` when no block's model fits this call.
 */
export function toolCard(
  name: string,
  input: unknown,
  result: ToolResult | undefined,
  cwd: string | undefined,
): ToolCard {
  switch (name) {
    case 'Bash': {
      const terminal = terminalCard(input, result, cwd)
      return terminal === null ? GENERIC : { kind: 'terminal', terminal }
    }
    case 'Read': {
      const read = readCard(input, result, cwd)
      return read === null ? GENERIC : { kind: 'read', read }
    }
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      const diff = diffCard(name, input, result, cwd)
      return diff === null ? GENERIC : { kind: 'diff', diff }
    }
    case 'Grep':
    case 'Glob': {
      const search = searchCard(result)
      return search === null ? GENERIC : { kind: 'search', search }
    }
    case 'WebSearch':
    case 'WebFetch': {
      const web = webCard(name, input, result)
      return web === null ? GENERIC : { kind: 'web', web }
    }
    case 'TodoWrite': {
      const todo = todoCard(input)
      return todo === null ? GENERIC : { kind: 'todo', todo }
    }
    // `Agent` is the same delegation tool under its newer wire name; both
    // spellings draw the task card.
    case 'Task':
    case 'Agent':
      return { kind: 'task', task: taskCard(input, result) }
    default:
      return GENERIC
  }
}

/** A card's contribution to the collapsed row, when it knows better than the arguments. */
export interface CardSummary {
  text: string
  /** Fragment kept out of the ellipsized text; null when the card has none. */
  suffix: string | null
}

/**
 * The summary a card supplies for its collapsed row, or null to keep the
 * argument-derived one.
 * @param card - the derived card.
 * @returns the summary override, or null.
 */
export function cardSummary(card: ToolCard): CardSummary | null {
  switch (card.kind) {
    case 'terminal':
      // The model's own description of the command; the command itself is one
      // click away in the card, so the row says what the command is FOR.
      return card.terminal.description === undefined
        ? null
        : { text: firstLine(card.terminal.description), suffix: null }
    case 'diff':
      return { text: card.diff.card.diffs[0]?.path ?? '', suffix: `+${card.diff.added} -${card.diff.removed}` }
    case 'todo':
      return { text: card.todo.summary, suffix: card.todo.suffix }
    case 'task': {
      const { description, subagentType } = card.task
      if (description === undefined && subagentType === undefined) return null
      return { text: firstLine(description ?? ''), suffix: subagentType ?? null }
    }
    default:
      return null
  }
}
