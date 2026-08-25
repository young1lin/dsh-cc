/**
 * The fileMentions resolver behind clickable file paths in transcript
 * markdown: an inline-code token that plausibly names a text file becomes a
 * link that opens the viewer on the file's latest disk content.
 *
 * The test is a shape test, not an existence probe — the resolver must be
 * synchronous — so a deleted file degrades to the viewer's error state rather
 * than suppressing the link. The host applies mentions to settled renders
 * only; streaming text stays inert code until its turn completes.
 *
 * @module dsh-cc/client/file-mentions
 */

import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'

/** Extensions the viewer offers to open; anything else stays inert code. */
const TEXT_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc',
  'py', 'pyi', 'java', 'rs', 'go', 'c', 'h', 'cpp', 'hpp', 'cc', 'hh', 'cs',
  'rb', 'php', 'swift', 'kt', 'kts', 'scala', 'groovy', 'gradle',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env',
  'md', 'mdx', 'txt', 'log', 'csv', 'tsv',
  'html', 'htm', 'css', 'scss', 'less', 'xml', 'svg', 'sql',
  'lua', 'pl', 'pm', 'r', 'm', 'vue', 'svelte', 'astro',
])

/** Windows drive, UNC, or POSIX-absolute beginnings. */
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/

/**
 * Whether a token plausibly names a text file: no spaces, sane length, and
 * either an absolute path or a relative one with a separator, with a known
 * text extension (a bare `foo.ts` relative to the cwd is ambiguous enough to
 * skip; `src/foo.ts` is not).
 * @param value - the inline-code token, exactly as authored.
 * @returns the shape verdict.
 */
function isFileLike(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 2 || trimmed.length > 260) return false
  if (/\s/.test(trimmed)) return false
  const hasSeparator = trimmed.includes('/') || trimmed.includes('\\')
  if (!ABSOLUTE_PATH.test(trimmed) && !hasSeparator) return false
  const name = trimmed.split(/[/\\]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return false
  return TEXT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

/**
 * Build the mentions resolver for one transcript render.
 * @param cwd - the session working directory, for resolving relative paths.
 * @param open - the viewer opener.
 * @returns the `fileMentions` prop value.
 */
export function fileMentionsFor(cwd: string | undefined, open: (path: string) => void): MarkdownFileMentions {
  return {
    resolve: value => {
      if (!isFileLike(value)) return undefined
      const trimmed = value.trim().replace(/\\/g, '/')
      const absolute = ABSOLUTE_PATH.test(trimmed) || cwd === undefined
        ? trimmed
        : `${cwd.replace(/[\\/]+$/, '')}/${trimmed}`
      return { open: () => open(absolute), label: trimmed, title: absolute }
    },
  }
}
