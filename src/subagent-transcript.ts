/**
 * Incremental reader for Claude Code's native depth-1 subagent transcript.
 *
 * Backgrounding detaches child assistant envelopes from the SDK query stream,
 * but the CLI keeps writing the authoritative sidechain JSONL under the parent
 * session. This adapter maps only conversation content (not attachments or the
 * duplicated initial prompt) into the nested browser event shape.
 *
 * @module dsh-cc/subagent-transcript
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { encodeProjectDir } from './native-transcript.ts'
import type { SubagentEvent } from './types.ts'

/** Result of reading all complete records after one zero-based line cursor. */
export interface SubagentTranscriptChunk {
  nextLine: number
  events: SubagentEvent[]
  /**
   * The wire model id the child's own responses were written with (the first
   * assistant record's `message.model`) — what the CLI actually resolved the
   * delegating call's model alias (or inherited default) to. Captured on the
   * first read, which always starts at line zero; undefined until the child
   * has produced at least one assistant record.
   */
  model?: string
}

/**
 * Resolve the CLI-owned sidechain transcript path.
 * @param configDir - account root (usually ~/.claude).
 * @param cwd - parent session workspace.
 * @param sessionId - native parent session id.
 * @param agentId - task/agent id from task_started.
 * @returns the absolute JSONL path.
 */
export function subagentTranscriptPath(
  configDir: string,
  cwd: string,
  sessionId: string,
  agentId: string,
): string {
  return join(configDir, 'projects', encodeProjectDir(cwd), sessionId, 'subagents', `agent-${agentId}.jsonl`)
}

/**
 * Read newly appended complete records from one native subagent JSONL file.
 * Missing files are normal immediately after task_started and yield no events.
 * @param path - path returned by {@link subagentTranscriptPath}.
 * @param fromLine - zero-based count of records already consumed.
 * @returns the next cursor and mapped nested events.
 */
export async function readSubagentTranscript(path: string, fromLine: number): Promise<SubagentTranscriptChunk> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { nextLine: fromLine, events: [] }
    throw error
  }
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  const start = fromLine <= lines.length ? fromLine : 0
  const events: SubagentEvent[] = []
  let model: string | undefined
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined || line.trim() === '') continue
    try {
      const record = JSON.parse(line) as unknown
      if (model === undefined && isAssistantModel(record)) model = assistantModel(record)
      events.push(...mapRecord(record))
    } catch {
      // A malformed complete record is not actionable. The CLI writes each
      // line atomically; advancing past it avoids wedging every later update.
    }
  }
  return model === undefined ? { nextLine: lines.length, events } : { nextLine: lines.length, events, model }
}

/**
 * Whether one raw sidechain record is an assistant entry carrying a usable
 * wire model id.
 * @param value - the parsed JSONL record.
 * @returns true when `message.model` is a non-empty string.
 */
function isAssistantModel(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.type !== 'assistant') return false
  return assistantModel(record) !== undefined
}

/**
 * Read one raw record's wire model id.
 * @param value - the parsed JSONL record.
 * @returns the `message.model` string, or undefined when absent.
 */
function assistantModel(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.message !== 'object' || record.message === null) return undefined
  const message = record.message as Record<string, unknown>
  if (typeof message.model !== 'string' || message.model === '') return undefined
  return message.model
}

/** Map one raw sidechain record onto nested display events. */
function mapRecord(value: unknown): SubagentEvent[] {
  if (typeof value !== 'object' || value === null) return []
  const record = value as Record<string, unknown>
  if (record.type !== 'assistant' && record.type !== 'user') return []
  if (typeof record.message !== 'object' || record.message === null) return []
  const message = record.message as Record<string, unknown>
  const content = message.content
  if (!Array.isArray(content)) return []
  const events: SubagentEvent[] = []
  for (const value of content) {
    if (typeof value !== 'object' || value === null) continue
    const block = value as Record<string, unknown>
    if (record.type === 'assistant') {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        events.push({ kind: 'assistant', text: block.text })
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim() !== '') {
        events.push({ kind: 'thinking', text: block.thinking })
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        events.push({ kind: 'tool_use', toolUseId: block.id, name: block.name, input: block.input })
      }
    } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      events.push({
        kind: 'tool_result',
        toolUseId: block.tool_use_id,
        text: resultText(block.content),
        isError: block.is_error === true,
      })
    }
  }
  return events
}

/** Flatten one native tool_result payload into browser text. */
function resultText(content: unknown): string {
  if (content === undefined || content === null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content)
  return content.map(block => {
    if (typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string') {
      return (block as { text: string }).text
    }
    return JSON.stringify(block)
  }).join('\n')
}
