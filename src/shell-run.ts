/**
 * Mechanism-only shell runner for the `!` prefix (shell mode): executes one
 * command line in the session's working directory and streams its output back
 * in bounded chunks. This module deliberately enforces NO policy — permission
 * gating, queueing, and transcript wrapping belong to the engine layer that
 * calls it; here there is only execution, a timeout, and an output budget.
 *
 * Output is capped to the LAST maxBytes of the combined stream (the engine's
 * own stderr tail-8000 philosophy: what fits at the end is usually what
 * matters), and a timed-out process is killed with its partial output kept.
 *
 * @module dsh-cc/shell-run
 */

import { spawn } from 'node:child_process'

/** Options for one shell-mode execution. */
export interface ShellRunOptions {
  /** Working directory for the command. */
  cwd: string
  /** Kill the process after this many milliseconds; default 120_000. */
  timeoutMs?: number
  /** Combined output budget in bytes (tail kept); default 262_144 (256 KiB). */
  maxBytes?: number
  /** Called with each combined output chunk as it arrives, already counted against the budget. */
  onChunk?(chunk: string): void
}

/** The settled result of one shell-mode execution. */
export interface ShellRunResult {
  /** The process's exit code; non-zero on failure. */
  exitCode: number
  /** Combined stdout+stderr, capped to the last maxBytes. */
  output: string
  /** True when the run was killed by the timeout. */
  timedOut: boolean
}

/**
 * Run one command line through the platform shell and collect bounded output.
 * stdout and stderr are merged in arrival order — shell mode feeds the merged
 * stream into the conversation, and interleaving is exactly what the user saw.
 * @param command - the command line after the `!` prefix.
 * @param options - cwd, timeout, output budget, and the streaming sink.
 * @returns the exit code, the capped output, and the timeout flag.
 */
export function runShell(command: string, options: ShellRunOptions): Promise<ShellRunResult> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const maxBytes = options.maxBytes ?? 262_144
  return new Promise(resolve => {
    // shell: true routes through cmd.exe / sh so pipes, redirects, and env
    // expansions behave the way the user's terminal would.
    const child = spawn(command, { cwd: options.cwd, shell: true, windowsHide: true })
    let buffered = ''
    let bytes = 0
    let settled = false
    const absorb = (data: Buffer): void => {
      const text = data.toString('utf8')
      buffered += text
      bytes += Buffer.byteLength(text, 'utf8')
      if (bytes > maxBytes) {
        const cut = buffered.length - Math.floor(maxBytes * (buffered.length / Math.max(bytes, 1)))
        buffered = buffered.slice(cut)
        bytes = Buffer.byteLength(buffered, 'utf8')
      }
      options.onChunk?.(text)
    }
    child.stdout.on('data', absorb)
    child.stderr.on('data', absorb)
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve({ exitCode: child.exitCode ?? 1, output: buffered, timedOut: true })
    }, timeoutMs)
    const finish = (exitCode: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode, output: buffered, timedOut: false })
    }
    child.on('error', error => {
      buffered += String(error)
      finish(1)
    })
    child.on('close', code => finish(code ?? 0))
  })
}
