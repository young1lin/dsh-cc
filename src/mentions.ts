/**
 * @-mention expansion for outgoing messages: `@path` tokens name files or
 * folders (project-relative or absolute) whose content joins the turn as text
 * blocks appended after the sentence. A token triggers only when its `@` sits
 * at text start or after whitespace — `user@host` mid-word never triggers.
 * Everything here is best-effort per token: a stale, binary, or unreadable
 * path stays plain text and never blocks the send.
 *
 * @module dsh-cc/mentions
 */

import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { readTextFile } from './http-support.ts'

/** Total bytes one message's mentions may inject; later ones are elided. */
const MAX_TOTAL_BYTES = 1024 * 1024
/** Entry cap for one folder's tree listing. */
const MAX_TREE_ENTRIES = 500
/** Depth cap for one folder's tree listing. */
const MAX_TREE_DEPTH = 8

/** Directory names the folder tree never descends into. */
export const SKIPPED_DIR_NAMES = ['node_modules', '.git', 'dist', 'build', 'lib', 'out'] as const

/**
 * Every @-mention path token in the text, first occurrence only, in order.
 * @param text - the outgoing message body.
 * @returns the unique path tokens, without their `@`.
 */
export function scanMentionPaths(text: string): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const match of text.matchAll(/(?:^|\s)@(\S+)/g)) {
    const token = match[1]
    if (!seen.has(token)) {
      seen.add(token)
      paths.push(token)
    }
  }
  return paths
}

/**
 * The display form of one mention path: cwd-relative with forward slashes
 * when it sits under the cwd, else absolute with forward slashes.
 * @param path - the resolved absolute path.
 * @param cwd - the session working directory.
 * @returns the display path.
 */
function displayPath(path: string, cwd: string): string {
  const rel = relative(cwd, path)
  if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split('\\').join('/')
  return path.split('\\').join('/')
}

/**
 * Build the text blocks one message's @-mentions contribute, appended after
 * the user's own text block. Files deliver their (possibly truncated) content;
 * folders deliver a bounded tree listing, never contents — the model reads
 * what it needs itself, CLI-style. A 1MB total budget elides later mentions.
 * @param text - the outgoing message body.
 * @param cwd - the session working directory, for resolving relative tokens.
 * @returns the additional content blocks; empty when nothing resolves.
 */
export async function mentionBlocks(
  text: string,
  cwd: string,
): Promise<{ type: 'text'; text: string }[]> {
  const blocks: { type: 'text'; text: string }[] = []
  let budget = MAX_TOTAL_BYTES
  for (const token of scanMentionPaths(text)) {
    const path = isAbsolute(token) ? resolve(token) : resolve(cwd, token)
    const info = await stat(path).catch(() => undefined)
    if (info === undefined) continue
    if (info.isFile()) {
      // Binary or unreadable files throw inside readTextFile; they stay plain text.
      const file = await readTextFile(path).catch(() => undefined)
      if (file === undefined) continue
      if (budget <= 0) {
        blocks.push({ type: 'text', text: `<file path="${displayPath(path, cwd)}">（已省略：附件总量超限）</file>` })
        continue
      }
      const body = file.content.slice(0, budget)
      const cut = body.length < file.content.length
      budget -= body.length
      const notes = [
        ...(file.truncated ? ['文件超过 2MB，仅开头部分'] : []),
        ...(cut ? ['附件总量超限，仅开头部分'] : []),
      ]
      blocks.push({
        type: 'text',
        text: `<file path="${displayPath(path, cwd)}">\n${body}${notes.length > 0 ? `\n（${notes.join('；')}）` : ''}\n</file>`,
      })
    } else if (info.isDirectory()) {
      const tree = await folderTree(path)
      const body = tree.slice(0, Math.max(budget, 0))
      const cut = body.length < tree.length
      budget -= body.length
      blocks.push({
        type: 'text',
        text: `<folder path="${displayPath(path, cwd)}">\n${body}${cut ? '\n（已省略：附件总量超限）' : ''}\n</folder>`,
      })
    }
  }
  return blocks
}

/**
 * List one folder as an indented tree, breadth-capped and depth-capped, with
 * heavy directories (node_modules, .git, …) and dot-directories skipped.
 * @param root - the folder to list.
 * @returns the tree as newline-joined lines.
 */
async function folderTree(root: string): Promise<string> {
  const lines: string[] = []
  let entries = 0
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth >= MAX_TREE_DEPTH || entries >= MAX_TREE_ENTRIES) return
    const dirents = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const visible = dirents
      .filter(dirent => dirent.isDirectory() || dirent.isFile())
      .filter(dirent => !(dirent.isDirectory() && (dirent.name.startsWith('.') || (SKIPPED_DIR_NAMES as readonly string[]).includes(dirent.name))))
      .sort((left, right) =>
        left.isDirectory() === right.isDirectory()
          ? left.name.localeCompare(right.name)
          : left.isDirectory() ? -1 : 1)
    for (const dirent of visible) {
      if (entries >= MAX_TREE_ENTRIES) {
        lines.push(`${'  '.repeat(depth)}…（超过条目上限，已省略）`)
        return
      }
      lines.push(`${'  '.repeat(depth)}${dirent.name}${dirent.isDirectory() ? '/' : ''}`)
      entries++
      if (dirent.isDirectory()) await walk(join(dir, dirent.name), depth + 1)
    }
  }
  await walk(root, 0)
  return lines.join('\n')
}
