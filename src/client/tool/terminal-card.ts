/**
 * Terminal-card derivation for the `Bash` tool.
 *
 * The call side supplies the command and the model's own description of it; the
 * result side supplies the captured output. Unlike the host's shell tools,
 * Claude Code reports no exit status as structured data — a failing command
 * arrives as `isError` with the shell's own text — so the exit code is read out
 * of that text when the CLI stated it and is otherwise reported as a plain
 * failure through a replaced label.
 *
 * @module dsh-cc/client/tool/terminal-card
 */

import type { TerminalBlockLabels, TerminalBlockProps } from '@deepseek-ai/dsh-client-ui-primitives'
import { stringField, unwrapToolErrorText, type ToolResult } from './wire.ts'

/**
 * Stand-in exit code for a failure the CLI reported without a number. It is
 * never displayed: {@link TerminalCard.labels} replaces the exit-code label
 * whenever the code is this value, and any negative code renders the status
 * pill the same way a real non-zero one does.
 */
const UNKNOWN_EXIT_CODE = -1

/**
 * A stated exit code at the very end of the result text. Anchored to the tail
 * so a command that merely printed the words mid-output is not mistaken for the
 * CLI's own status line.
 */
const TRAILING_EXIT_CODE = /(?:^|\n)\s*(?:exit code|exit status|退出码)\s*[:：]?\s*(\d+)\s*$/i

/** Label override used when a failure carries no numeric status. */
const UNKNOWN_EXIT_LABEL: Partial<TerminalBlockLabels> = { exitCode: () => '执行失败' }

/** The `TerminalBlock` material one `Bash` call yields. */
export interface TerminalCard {
  /**
   * The props `TerminalBlock` draws. Nested so a render site spreads exactly
   * the primitive's own surface; `maxLines`/`className` belong to that site.
   */
  card: Pick<TerminalBlockProps, 'command' | 'cwd' | 'output' | 'exitCode' | 'running'>
  /** Display copy overrides; absent keeps the primitive's own labels. */
  labels: Partial<TerminalBlockLabels> | undefined
  /** The model's one-line description of the command, which the row shows collapsed. */
  description: string | undefined
}

/**
 * Derive the terminal-card material for a `Bash` call, or null when the call
 * carries no command and belongs on the generic card.
 *
 * A call with no result yet renders as running: the prompt line alone, with the
 * row's own state carrying the in-flight signal.
 * @param input - the `tool_use.input` for the call.
 * @param result - the settled result, or undefined while the call is running.
 * @param cwd - the session workspace, drawn as the prompt's directory.
 * @returns the terminal-card material, or null for the generic path.
 */
export function terminalCard(input: unknown, result: ToolResult | undefined, cwd: string | undefined): TerminalCard | null {
  const command = stringField(input, 'command')
  if (command === undefined) return null
  const description = stringField(input, 'description')
  if (result === undefined) {
    return {
      description,
      labels: undefined,
      card: { command, cwd, output: undefined, exitCode: undefined, running: true },
    }
  }
  const stated = TRAILING_EXIT_CODE.exec(result.text)?.[1]
  const exitCode = stated !== undefined ? Number(stated) : result.isError ? UNKNOWN_EXIT_CODE : 0
  return {
    description,
    labels: exitCode === UNKNOWN_EXIT_CODE ? UNKNOWN_EXIT_LABEL : undefined,
    card: { command, cwd, output: unwrapToolErrorText(result.text), exitCode, running: false },
  }
}
