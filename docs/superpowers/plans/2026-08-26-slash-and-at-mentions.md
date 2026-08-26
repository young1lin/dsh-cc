# Slash Commands & @-Mentions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the two approved CLI-parity input features — a slash-command menu with blue recognition tokens and command-output transcript rows, and node-side `@path` mention expansion (files and folder trees) with a typing-sugar file picker.

**Architecture:** Slash commands need no new transport: the command list is already wired end-to-end (`engine.supportedCommands()` → `GET /sessions/:id/commands` → `fetchCommands`), sending is an ordinary user message (the CLI payload executes it), and the two system subtypes whose output we currently drop become two new `CcEvent` kinds riding the existing event pipeline. `@`-mentions expand entirely in the node half inside `engine.send()` — the client sends plain text, so menu picking and hand typing are indistinguishable downstream.

**Tech Stack:** TypeScript (Node + React), `@anthropic-ai/claude-agent-sdk` 0.3.220 (pinned, unchanged), `@deepseek-ai/dsh-client-ui-primitives` 0.1.0-rc.7, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-26-slash-and-at-mentions-design.md` — the plan argues from it; executors read both.

## Global Constraints

- House style: 2-space indent, single quotes, no default exports, JSDoc with `@param`/`@returns` on every exported function, `@module` comment at each file head. UI copy in Chinese. Match the surrounding files.
- No test framework exists and none may be added. Verification per task is `pnpm typecheck` plus the concrete live checks named in the task.
- Lab instance: `dsh --profile web --no-open --port 3090` from **Git Bash** (PowerShell `Start-Process` cannot run the npm shim). The user's own instance is on **3080** — before touching it, check `GET /cc/api/sessions` shows zero busy sessions. API base `/cc/api`.
- The lab uses a `link:` install: `pnpm build` + dsh restart ships changes (no re-add). `pnpm watch` is NOT running — build explicitly.
- HTTP payloads with Chinese go through UTF-8 script files (Python urllib or Write-tool JSON files), never inline `curl -d` (GBK console mojibake).
- Playwright never waits for `networkidle` (the SSE connection defeats it).
- SDK pinned at `@anthropic-ai/claude-agent-sdk@0.3.220`; facts below were read from its `sdk.d.ts` and hold for that version.
- The transcript stays the durable record; new event kinds persist through the existing sidecar JSONL — no new storage.
- Line endings: repo is LF. After edits, `git diff --stat` must show only intended files.
- Parallel execution override: this batch runs as waves of parallel agents split by file ownership; agents leave changes **uncommitted** — the coordinator reviews, splits, and commits each task's files itself.

## Current State (anchors for the edits)

- `src/types.ts:246-271` — the `CcEvent` union (`user`/`assistant`/`thinking`/`tool_use`/`tool_result`/`system`/`result`/`error`), each member carrying `seq`/`ts`; `SlashCommand` at line 383.
- `src/engine.ts:270-292` — `send(text, images)` builds `content` as `[...imageBlocks, ...(text ? [{type:'text', text}] : [])]` and pushes an `SDKUserMessage`; `EngineStart` has `cwd`; `publish(input: CcEventInput)` at line 600.
- `src/engine.ts:683-707` — `onMessage`'s `case 'system'` handles `init` early-return then delegates everything else to `onTaskMessage` (which ignores unknown subtypes — `local_command_output` and `informational` are silently dropped today).
- `src/http-support.ts` — `readTextFile(pathname): Promise<FileContent>` (≤2MB truncation, throws on binary/missing), `readDirListing` (dirs-first entries).
- `src/client/api/settings.ts:66` — `listDir(path?): Promise<DirListing>` with `DirListing { path, parent, entries: {name, directory}[] }`.
- `src/client/api/interaction.ts:58` — `fetchCommands(id): Promise<{available: boolean; commands: SlashCommand[]}>`.
- `src/client/Composer.tsx` — props `{busy, readOnly?, onSend, onStop}`; IME guard pattern (`isComposing || keyCode === 229`) at the top of `onKeyDown`; auto-grow effect keyed on `value`; `.cc-input` metrics: `padding: 0`, `font: var(--dsw-font-s-14)`, `max-height: 200px`.
- `src/client/App.tsx:653-662` — the Composer mount (inside `{current !== undefined && (…)}`); SSE `case 'event'` at line 369 appends to `eventsBySession` and calls `refreshTelemetry` on `result`.
- `src/client/Transcript.tsx:272-331` — `EventItem`'s kind switch (`user` renders images + text; `default: return null` at line 328); `Transcript` is memo'd on `props.events`.
- The brand color token proven in this codebase: `var(--dsw-alias-brand-primary)` (`.cc-input-shell[data-drop]` border).

## File Structure

- Create: `src/mentions.ts` — node half: `@`-token scanner, folder-tree builder, mention-block expander.
- Create: `src/client/command-mentions.ts` — pure helpers: leading `/name` extraction, name/alias matching.
- Create: `src/client/CommandMenu.tsx` — the slash-command popup.
- Create: `src/client/MentionPicker.tsx` — the `@` file/folder popup (owns its directory browsing).
- Modify: `src/types.ts`, `src/engine.ts`, `src/client/Composer.tsx`, `src/client/App.tsx`, `src/client/Transcript.tsx`, `README.md`, `AGENTS.md` (module table row).

---

### Task 1: Shared types — `commandOutput` and `notice` events

**Files:**
- Modify: `src/types.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: two `CcEvent` union members. Every later task imports these shapes.

- [ ] **Step 1: Extend the `CcEvent` union (after the `system` member, line ~251)**

```ts
  /** Output of a local slash command (`/compact`, `/usage`, …) — no model turn ran. */
  | { kind: 'commandOutput'; seq: number; ts: string; text: string }
  /** A loop banner: hook feedback, slash-command notices; level picks the styling. */
  | { kind: 'notice'; seq: number; ts: string; text: string; level: 'notice' | 'suggestion' | 'warning' }
```

(`CcEventInput` — whatever the engine's publish input type is called — picks the same two shapes up automatically if it derives from `CcEvent`; if it is a separate union, add the members there too. Typecheck will say.)

- [ ] **Step 2: Typecheck and commit**

Run: `pnpm typecheck` — Expected: pass (the client's `default: return null` and the engine's narrow `publish` inputs tolerate new members).
Run: `git add src/types.ts && git commit -m "feat: commandOutput and notice transcript events"`

---

### Task 2: Node — the mentions module

**Files:**
- Create: `src/mentions.ts`

**Interfaces:**
- Consumes: `readTextFile` from `./http-support.ts`.
- Produces: `scanMentionPaths(text): string[]`; `mentionBlocks(text, cwd): Promise<{type:'text'; text:string}[]>`; `SKIPPED_DIR_NAMES: readonly string[]`.

- [ ] **Step 1: Create `src/mentions.ts`**

```ts
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
```

- [ ] **Step 2: Typecheck and commit**

Run: `pnpm typecheck` — Expected: pass.
Run: `git add src/mentions.ts && git commit -m "feat: node-side @-mention scanner and expander"`

---

### Task 3: Engine — the two system subtypes and send-time expansion

**Files:**
- Modify: `src/engine.ts`

**Interfaces:**
- Consumes: `mentionBlocks` from `./mentions.ts`; the two new `CcEvent` kinds.
- Produces: `send()` appends mention blocks; `local_command_output` and `informational` system messages become transcript events.

- [ ] **Step 1: Handle the two subtypes in `onMessage`'s `case 'system'` (after the `init` early-return, before `this.onTaskMessage(message)`)**

```ts
        if (message.subtype === 'local_command_output') {
          // A local slash command answered without a model turn; its output is
          // the transcript row the turn produced.
          this.publish({ kind: 'commandOutput', text: message.content })
          return
        }
        if (message.subtype === 'informational') {
          this.publish({
            kind: 'notice',
            text: message.content,
            // 'info' is transcript-mode-only in the CLI; the page folds it
            // into the quietest level it does render.
            level: message.level === 'info' ? 'notice' : message.level,
          })
          return
        }
```

- [ ] **Step 2: Expand mentions in `send()`**

Replace the `content` construction (lines ~276-284) with:

```ts
    // Images lead the content list: the model reads the attachment before the
    // sentence about it, which is the order the CLI's own client uses.
    // @-mentions follow the text: the sentence names the reference first, the
    // payload sits behind it.
    const content = [
      ...images.map(image => ({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.data },
      })),
      ...(text.length > 0 ? [{ type: 'text', text }] : []),
      ...await mentionBlocks(text, this.startSpec.cwd),
    ]
```

Add `mentionBlocks` to the `./mentions.ts` import.

- [ ] **Step 3: Typecheck, verify live, commit**

Run: `pnpm typecheck && pnpm build` — Expected: pass.
Lab (Git Bash restart after build): with a UTF-8 payload script, send `「引用 @src/types.ts 并告诉我它第一行的注释说了什么；再提一下 user@host 不应该被当成文件」` to a session whose cwd is the repo → the model answers from the injected content (it did not run Read — confirm in the transcript: no Read tool card). Send a second message mentioning `@src/client` → the answer reflects the folder listing (e.g. counts files) with no Read/Glob cards. `GET /cc/api/sessions/:id` shows the `commandOutput`-free transcript as before for normal turns.
Run: `git add src/engine.ts && git commit -m "feat: engine expands @-mentions and surfaces local command output"`

---

### Task 4: Client — command-token helpers

**Files:**
- Create: `src/client/command-mentions.ts`

**Interfaces:**
- Consumes: nothing new (the `SlashCommand` shape is structurally matched).
- Produces: `CommandLike`; `commandToken(text): string | undefined`; `matchCommand(token, commands): CommandLike | undefined`. Composer (Task 6) and Transcript (Task 7) both import these.

- [ ] **Step 1: Create `src/client/command-mentions.ts`**

```ts
/**
 * Slash-command token helpers shared by the composer (menu trigger and the
 * blue recognition token) and the transcript (blue leading token on user
 * rows). Pure string work over the session's cached command list.
 *
 * @module dsh-cc/client/command-mentions
 */

/** The structural slice of a command entry the matching needs. */
export interface CommandLike {
  name: string
  aliases?: string[]
}

/**
 * The draft's leading `/name` token, when the very first word is one.
 * @param text - the draft or message text.
 * @returns the token including its slash, or undefined when the text does not
 *   start with a slash word.
 */
export function commandToken(text: string): string | undefined {
  const match = /^(\S+)/.exec(text)
  if (match === null || !match[1].startsWith('/')) return undefined
  return match[1]
}

/**
 * Whether a leading token names a known command, by name or alias — the
 * recognition test behind the blue token.
 * @param token - the leading token including its slash.
 * @param commands - the session's cached command list.
 * @returns the matched command, or undefined.
 */
export function matchCommand(token: string, commands: readonly CommandLike[]): CommandLike | undefined {
  const bare = token.slice(1).toLowerCase()
  if (bare === '') return undefined
  return commands.find(command =>
    command.name.toLowerCase() === bare
    || command.aliases?.some(alias => alias.toLowerCase() === bare))
}
```

- [ ] **Step 2: Typecheck and commit**

Run: `pnpm typecheck` — Expected: pass.
Run: `git add src/client/command-mentions.ts && git commit -m "feat: command-token helpers for composer and transcript"`

---

### Task 5: Client — the two popups

**Files:**
- Create: `src/client/CommandMenu.tsx`, `src/client/MentionPicker.tsx`

**Interfaces:**
- Consumes: `SlashCommand` from `../../types.ts`; `listDir` + `DirListing` from `./api/settings.ts`.
- Produces: `CommandMenu(props: { commands: SlashCommand[]; filter: string; selected: number; onSelectedChange(index: number): void; onPick(command: SlashCommand): void })`; `MentionPicker(props: { cwd: string; segment: string; selected: number; onSelectedChange(index: number): void; onPick(path: string): void })`. Composer (Task 6) renders both and owns the selection index and keyboard.

- [ ] **Step 1: Create `CommandMenu.tsx`**

```tsx
/**
 * The slash-command popup: the session's command list filtered by the draft's
 * first word. Presentational — the composer owns the selection index, the
 * keyboard, and the insert.
 *
 * @module dsh-cc/client/CommandMenu
 */

import type { ReactElement } from 'react'
import type { SlashCommand } from '../types.ts'
import { registerCss } from './css.ts'

// Shares .cc-menu-pop with the mention picker: one registration, two users
// (MentionPicker re-registers the same id harmlessly).
registerCss('composer-menus', `
.cc-menu-pop {
  position: absolute; bottom: 100%; left: 12px; right: 12px; z-index: 10;
  max-height: 240px; overflow-y: auto;
  margin-bottom: 4px; padding: 4px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-shadow-lv2);
  font: var(--dsw-font-xs-13);
}
.cc-menu-row { display: flex; align-items: baseline; gap: 8px; padding: 4px 8px; border-radius: 6px; cursor: pointer; }
.cc-menu-row[data-selected='true'] { background: var(--dsw-alias-bg-layer-3); }
.cc-menu-row-name { flex: none; color: var(--dsw-alias-label-primary); }
.cc-menu-row-args { flex: none; color: var(--dsw-alias-label-tertiary); }
.cc-menu-row-desc { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); }
.cc-menu-empty { padding: 8px; color: var(--dsw-alias-label-tertiary); }
`)

/**
 * Filter a command list by the draft's first word: prefix match on name or
 * alias, case-insensitive; an empty filter lists everything.
 * @param commands - the session's command list.
 * @param filter - the typed text after the slash.
 * @returns the matching commands, original order.
 */
export function filterCommands(commands: readonly SlashCommand[], filter: string): SlashCommand[] {
  const needle = filter.trim().toLowerCase()
  if (needle === '') return [...commands]
  return commands.filter(command =>
    command.name.toLowerCase().startsWith(needle)
    || command.aliases?.some(alias => alias.toLowerCase().startsWith(needle)))
}

/**
 * Render the command popup; the composer only mounts it while open.
 * @param props.commands - the full cached list (already filtered by the caller).
 * @param props.filter - the typed text after the slash (unused for filtering;
 *   kept for a future empty-state message).
 * @param props.selected - the selected row index into `commands`.
 * @param props.onSelectedChange - hover/pointer moves the selection.
 * @param props.onPick - a row was activated.
 * @returns the popup node.
 */
export function CommandMenu(props: {
  commands: SlashCommand[]
  filter: string
  selected: number
  onSelectedChange(index: number): void
  onPick(command: SlashCommand): void
}): ReactElement {
  if (props.commands.length === 0) {
    return (
      <div className="cc-menu-pop">
        <div className="cc-menu-empty">没有匹配的命令</div>
      </div>
    )
  }
  return (
    <div className="cc-menu-pop" role="listbox">
      {props.commands.map((command, index) => (
        <div
          key={command.name}
          className="cc-menu-row"
          role="option"
          aria-selected={index === props.selected}
          data-selected={index === props.selected}
          onPointerEnter={() => props.onSelectedChange(index)}
          onClick={() => props.onPick(command)}
        >
          <span className="cc-menu-row-name">/{command.name}</span>
          {command.argumentHint !== '' && <span className="cc-menu-row-args">{command.argumentHint}</span>}
          {command.description !== '' && <span className="cc-menu-row-desc" title={command.description}>{command.description}</span>}
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Create `MentionPicker.tsx`**

Presentational, exactly like `CommandMenu`: the composer owns the listing state, the selection index, and the keyboard. This file also exports the two pure path helpers the composer needs.

```tsx
/**
 * The @-mention file popup: one directory page of the session cwd over GET
 * /fs/list, filtered by the typed segment. Presentational — the composer owns
 * the browsing directory, the fetch, the selection, and the insert. Row
 * semantics: Enter/Tab (or click) picks the row as the mention — folders are
 * mentionable, they inject a tree; the `..` row climbs one level up.
 *
 * @module dsh-cc/client/MentionPicker
 */

import type { ReactElement } from 'react'
import { registerCss } from './css.ts'

// Same sheet as CommandMenu (see the note there).
registerCss('composer-menus', `
.cc-menu-row-folder::after { content: '/'; color: var(--dsw-alias-label-tertiary); }
`)

/** Normalize separators to forward slashes. */
const posix = (path: string): string => path.split('\\').join('/')

/**
 * The token a picked entry inserts: cwd-relative when it sits under the cwd,
 * else absolute; forward slashes throughout.
 * @param cwd - the session working directory.
 * @param absolute - the picked entry's absolute path.
 * @returns the token text (no `@`).
 */
export function tokenFor(cwd: string, absolute: string): string {
  const base = posix(cwd).replace(/\/+$/, '') + '/'
  const target = posix(absolute)
  return target.toLowerCase().startsWith(base.toLowerCase())
    ? target.slice(base.length)
    : target
}

/**
 * Derive the browsing directory from the typed segment: everything up to its
 * last slash, resolved against the cwd (`..` segments walk); a bare segment
 * browses the cwd itself.
 * @param cwd - the session working directory.
 * @param segment - the typed text after the `@` (may contain slashes).
 * @returns the absolute directory to list.
 */
export function dirForSegment(cwd: string, segment: string): string {
  const cut = segment.lastIndexOf('/')
  const walked = cut === -1 ? '' : segment.slice(0, cut + 1)
  const base = posix(cwd).replace(/\/+$/, '').split('/')
  for (const part of walked.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') base.pop()
    else base.push(part)
  }
  return base.join('/') || '/'
}

/** One picker row: a directory entry, or the climb-up affordance. */
export interface MentionRow {
  name: string
  directory: boolean
  /** The `..` row: activation climbs instead of inserting. */
  climb: boolean
}

/**
 * Render the mention popup; the composer only mounts it while open.
 * @param props.rows - the rows to show (`..` first when climbing is possible).
 * @param props.loading - the directory page is still being fetched.
 * @param props.selected - the selected row index.
 * @param props.onSelectedChange - hover/pointer moves the selection.
 * @param props.onActivate - a row was activated (Enter/Tab/click).
 * @returns the popup node.
 */
export function MentionPicker(props: {
  rows: readonly MentionRow[]
  loading: boolean
  selected: number
  onSelectedChange(index: number): void
  onActivate(index: number): void
}): ReactElement {
  return (
    <div className="cc-menu-pop" role="listbox">
      {props.loading && <div className="cc-menu-empty">读取目录中…</div>}
      {!props.loading && props.rows.length === 0 && <div className="cc-menu-empty">没有匹配的文件</div>}
      {props.rows.map((row, index) => (
        <div
          key={`${row.name}-${index}`}
          className="cc-menu-row"
          role="option"
          aria-selected={index === props.selected}
          data-selected={index === props.selected}
          title={row.climb ? '上一级' : row.directory ? '提及整个文件夹（注入目录树）' : '提及此文件'}
          onPointerEnter={() => props.onSelectedChange(index)}
          onClick={() => props.onActivate(index)}
        >
          <span className={row.directory ? 'cc-menu-row-name cc-menu-row-folder' : 'cc-menu-row-name'}>{row.name}</span>
        </div>
      ))}
    </div>
  )
}
```

The composer builds `rows` from its `listDir` result: the filtered entries (case-insensitive substring on the segment's last path component), with a `{name: '..', directory: true, climb: true}` row first whenever `listing.parent !== null`.

- [ ] **Step 3: Typecheck and commit**

Run: `pnpm typecheck` — Expected: pass.
Run: `git add src/client/CommandMenu.tsx src/client/MentionPicker.tsx && git commit -m "feat: slash-command and file-mention popups"`

---

### Task 6: Client — Composer integration (menus, keyboard, blue mirror)

**Files:**
- Modify: `src/client/Composer.tsx`

**Interfaces:**
- Consumes: `CommandMenu`/`filterCommands`, `MentionPicker` (+ its exported `dirForSegment`/`tokenFor`/`MentionRow`), `commandToken`/`matchCommand` from `./command-mentions.ts`, `SlashCommand` from `../types.ts`, `listDir` + `DirListing` from `./api/settings.ts`.
- Produces: `Composer(props: { sessionId; cwd?: string; commands: readonly SlashCommand[]; onRefreshCommands(): void; busy; readOnly?; onSend; onStop })`.

- [ ] **Step 1: Extend the props and add the menu state**

```tsx
export function Composer(props: {
  sessionId: string
  /** Session working directory — the mention browser's root and the trigger gate. */
  cwd?: string
  /** The session's cached slash commands; empty when none were loadable. */
  commands: readonly SlashCommand[]
  /** Refetch the command list (menu just opened). */
  onRefreshCommands(): void
  busy: boolean
  readOnly?: boolean
  onSend(text: string, images: ImageRef[]): void | Promise<unknown>
  onStop(): void
}): ReactElement {
```

State additions:

```tsx
  /** The open popup, with the text that drives it. */
  const [menu, setMenu] = useState<{ kind: 'command'; filter: string } | { kind: 'mention'; segment: string } | undefined>()
  /** The popup's selected row, owned here because the keyboard lives here. */
  const [menuIndex, setMenuIndex] = useState(0)
  /** Native IME composition in flight — the mirror hides and menus go inert. */
  const [composing, setComposing] = useState(false)
  const [mentionDir, setMentionDir] = useState<string | undefined>()
  const [mentionListing, setMentionListing] = useState<DirListing | undefined>()
```

- [ ] **Step 2: The trigger computation (shared by change, keyup, click, select)**

```tsx
  /**
   * Recompute the open popup from the draft and the caret. The slash menu
   * lives only while the caret is inside the draft's first word and that word
   * starts with `/`; the mention picker only while the caret is inside an
   * open `@token` whose `@` sits at start or after whitespace.
   * @param element - the textarea.
   */
  const updateMenu = (element: HTMLTextAreaElement): void => {
    if (props.readOnly === true) {
      setMenu(undefined)
      return
    }
    const caret = element.selectionStart ?? element.value.length
    const before = element.value.slice(0, caret)
    if (!/\s/.test(before) && element.value.startsWith('/')) {
      const filter = element.value.slice(1)
      if (menu?.kind !== 'command' || menu.filter !== filter) {
        // The refetch fires only on the transition into an open command menu,
        // never on every keystroke inside one.
        if (menu === undefined) props.onRefreshCommands()
        setMenu({ kind: 'command', filter })
        setMenuIndex(0)
      }
      return
    }
    const openToken = /(?:^|\s)@([^@\s]*)$/.exec(before)
    if (openToken !== null && props.cwd !== undefined) {
      const segment = openToken[1]
      if (menu?.kind !== 'mention' || menu.segment !== segment) {
        setMenu({ kind: 'mention', segment })
        setMenuIndex(0)
      }
      return
    }
    setMenu(undefined)
  }
```

Call `updateMenu(event.currentTarget)` from `onChange` (after `setValue`), `onKeyUp`, `onClick`, and `onSelect`. Attach `onCompositionStart={() => setComposing(true)}` / `onCompositionEnd={() => setComposing(false)}` to the textarea. Gate all menu behavior on `!composing`. (`updateMenu` reads `menu` from the enclosing render, which is fresh on every keystroke — no updater-function side effects.)

- [ ] **Step 3: The mention browser effect**

```tsx
  // The mention picker's directory follows the typed segment; picking `..`
  // (handled in onActivate) retargets it directly.
  useEffect(() => {
    if (menu?.kind !== 'mention' || props.cwd === undefined) {
      setMentionListing(undefined)
      return
    }
    const wanted = dirForSegment(props.cwd, menu.segment)
    setMentionDir(previous => previous === wanted ? previous : wanted)
  }, [menu, props.cwd])
  useEffect(() => {
    if (menu?.kind !== 'mention' || mentionDir === undefined) return
    let stale = false
    setMentionListing(undefined)
    listDir(mentionDir)
      .then(result => {
        if (!stale) setMentionListing(result)
      })
      .catch(() => {
        if (!stale) setMentionListing(undefined)
      })
    return () => {
      stale = true
    }
  }, [menu?.kind, mentionDir])
```

Row building and activation (in the render body or a `useMemo`):

```tsx
  const mentionFilter = menu?.kind === 'mention' ? menu.segment.slice(menu.segment.lastIndexOf('/') + 1).toLowerCase() : ''
  const mentionRows = useMemo(() => {
    if (menu?.kind !== 'mention' || mentionListing === undefined) return []
    const entries = mentionListing.entries
      .filter(entry => entry.name.toLowerCase().includes(mentionFilter))
      .map(entry => ({ name: entry.name, directory: entry.directory, climb: false }))
    return [
      ...(mentionListing.parent !== null ? [{ name: '..', directory: true, climb: true }] : []),
      ...entries,
    ]
  }, [menu?.kind, mentionListing, mentionFilter])
```

- [ ] **Step 4: Keyboard routing in `onKeyDown` (after the IME guard, before the Escape/Enter handling)**

```tsx
            if (!composing && menu !== undefined) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const count = menu.kind === 'command' ? filteredCommands.length : mentionRows.length
                if (count > 0) {
                  setMenuIndex(previous => (previous + (event.key === 'ArrowDown' ? 1 : count - 1)) % count)
                }
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setMenu(undefined)
                return
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault()
                if (menu.kind === 'command') {
                  const command = filteredCommands[menuIndex]
                  if (command !== undefined) insertCommand(command.name)
                } else {
                  const row = mentionRows[menuIndex]
                  if (row !== undefined) {
                    if (row.climb) {
                      if (mentionListing?.parent != null) setMentionDir(mentionListing.parent)
                    } else {
                      insertMention(row.name)
                    }
                  }
                }
                return
              }
            }
```

The two insertions (replace the open token, keep the rest of the draft; the caret lands after the inserted space):

```tsx
  /** Insert a completed slash command over the draft's first word. */
  const insertCommand = (name: string): void => {
    const element = inputRef.current
    const rest = value.includes(' ') ? value.slice(value.indexOf(' ')) : ''
    setValue(`/${name} ${rest.trimStart()}`)
    setMenu(undefined)
    requestAnimationFrame(() => element?.setSelectionRange(name.length + 2, name.length + 2))
  }
  /** Insert one picked mention token over the open `@segment` before the caret. */
  const insertMention = (name: string): void => {
    const element = inputRef.current
    if (element === null || menu?.kind !== 'mention') return
    const caret = element.selectionStart ?? element.value.length
    const start = caret - menu.segment.length - 1
    if (start < 0 || element.value[start] !== '@') return
    const token = mentionDir !== undefined && props.cwd !== undefined
      ? tokenFor(props.cwd, `${mentionDir.replace(/\/+$/, '')}/${name}`)
      : name
    const next = `${element.value.slice(0, start)}@${token} ${element.value.slice(caret)}`
    setValue(next)
    setMenu(undefined)
    const at = start + token.length + 2
    requestAnimationFrame(() => element.setSelectionRange(at, at))
  }
```

Folder-row picks insert the folder token itself (folders are mentionable); pointer clicks route through the same `insertMention`/climb logic as Enter.

- [ ] **Step 5: The blue recognition mirror**

Recognition state and render (inside the input shell, before the textarea):

```tsx
  const token = commandToken(value)
  const recognized = !composing && token !== undefined ? matchCommand(token, props.commands) : undefined
```

```tsx
      <div className="cc-input-shell" data-drop={dropping} …>
        {recognized !== undefined && (
          <div className="cc-input-mirror" aria-hidden>{token}<span className="cc-mirror-rest">{value.slice(token.length)}</span></div>
        )}
        <textarea … data-ghost={recognized !== undefined ? 'true' : undefined} />
```

Wait — the mirror must render the token blue and the rest normal; the token is plain text in the mirror, so:

```tsx
          <div className="cc-input-mirror" aria-hidden>
            <span className="cc-cmd-token">{token}</span>
            {value.slice(token.length)}
          </div>
```

CSS (extend the `composer` sheet):

```css
.cc-input-shell { position: relative; }
.cc-input-mirror {
  position: absolute; inset: 0; padding: 0; pointer-events: none; overflow: hidden;
  font: var(--dsw-font-s-14); font-family: var(--dsw-font-family);
  white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere;
  color: var(--dsw-alias-label-primary);
}
.cc-cmd-token { color: var(--dsw-alias-brand-primary); }
.cc-input[data-ghost='true'] { color: transparent; caret-color: var(--dsw-alias-label-primary); }
.cc-input[data-ghost='true']::placeholder { color: var(--dsw-alias-markdown-placeholder); }
```

(`.cc-input-shell { position: relative; }` merges into the existing rule; the mirror's metrics must match `.cc-input` exactly — both are `padding: 0`, same font stack, and the textarea keeps its own `overflow-y: auto` while the mirror clips, which is correct while heights agree. On textarea scroll, sync with `onScroll={() => { if (mirrorRef.current !== null && inputRef.current !== null) mirrorRef.current.scrollTop = inputRef.current.scrollTop }}` and give the mirror `overflow: hidden`.)

- [ ] **Step 6: Render the popups (inside the input shell, after the mirror)**

```tsx
        {!composing && menu?.kind === 'command' && (
          <CommandMenu
            commands={filteredCommands}
            filter={menu.filter}
            selected={menuIndex}
            onSelectedChange={setMenuIndex}
            onPick={command => insertCommand(command.name)}
          />
        )}
        {!composing && menu?.kind === 'mention' && (
          <MentionPicker
            rows={mentionRows}
            loading={mentionListing === undefined}
            selected={menuIndex}
            onSelectedChange={setMenuIndex}
            onActivate={index => {
              const row = mentionRows[index]
              if (row === undefined) return
              if (row.climb) {
                if (mentionListing?.parent != null) setMentionDir(mentionListing.parent)
                return
              }
              insertMention(row.name)
            }}
          />
        )}
```

with `const filteredCommands = useMemo(() => menu?.kind === 'command' ? filterCommands(props.commands, menu.filter) : [], [menu, props.commands])`; clamp `menuIndex` against the current row count in the render body (`if (menuIndex >= count) setMenuIndex(0)` guarded to avoid loops).

- [ ] **Step 7: Typecheck, verify in the lab, commit**

Run: `pnpm typecheck && pnpm build` — Expected: pass. Lab Playwright (UTF-8 script): open a used session; type `/` → menu lists commands with descriptions; type `comp` → filtered to `/compact`; ↓ + Tab → draft becomes `/compact `; with the full name typed the token renders blue (`.cc-cmd-token` present, textarea `data-ghost`); backspacing to `/xyz` removes the blue; typing Chinese after the command keeps composition visible (mirror hides during composition); `@` mid-word after text without space does not open the picker, ` @src/` does; the picker lists `src`, drilling works, `..` climbs, Enter inserts `@src/types.ts ` relative — climbing above the cwd inserts an absolute token.
Run: `git add src/client/Composer.tsx && git commit -m "feat: composer slash menu, mention picker, blue recognition token"`

---

### Task 7: Client — Transcript rows and App wiring

**Files:**
- Modify: `src/client/Transcript.tsx`, `src/client/App.tsx`

**Interfaces:**
- Consumes: the two new `CcEvent` kinds; `commandToken`/`matchCommand` from `./command-mentions.ts`; `fetchCommands` from `./api/interaction.ts`; the new Composer props.
- Produces: `Transcript(props: { events: CcEvent[]; commands: readonly SlashCommand[] })`; App's `commandsBySession` cache with load-on-switch, refresh-on-menu-open, refresh-on-turn-end.

- [ ] **Step 1: Transcript — the two new kinds (`EventItem`'s switch, before `default`)**

```tsx
    case 'commandOutput':
      return (
        <div className="cc-command-output">
          <div className="cc-command-output-title">命令输出</div>
          <MarkdownText text={event.text} fileMentions={props.mentions} />
        </div>
      )
    case 'notice':
      return <div className={`cc-note cc-note-${event.level}`}>{event.text}</div>
```

`EventItem` gains `commands: readonly SlashCommand[]`; the `user` case renders its leading token blue when recognized — keep whatever today renders the text, but split off the token:

```tsx
    case 'user': {
      const lead = commandToken(event.text)
      const hit = lead !== undefined ? matchCommand(lead, props.commands) : undefined
      const body = hit !== undefined && lead !== undefined
        ? (
          <>
            <span className="cc-cmd-token">{lead}</span>
            {event.text.slice(lead.length)}
          </>
        )
        : event.text
      // …existing images markup, then {body} where the raw text renders today
```

`Transcript`'s memo stays keyed on props; it now takes `commands` and threads it into every `EventItem`. CSS (into the transcript's registered sheet or a new one):

```css
.cc-command-output { border-left: 2px solid var(--dsw-alias-border-l3); padding-left: 10px; }
.cc-command-output-title { font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-tertiary); margin-bottom: 2px; }
.cc-note-warning { color: var(--dsw-alias-state-error-primary); }
.cc-note-suggestion { color: var(--dsw-alias-label-secondary); }
```

(`.cc-cmd-token` comes from the composer's sheet, which always co-mounts; note the coupling in a comment.)

- [ ] **Step 2: App — the command cache**

```tsx
  /** Per-session cached slash commands; empty until first load. */
  const [commandsBySession, setCommandsBySession] = useState<Record<string, SlashCommand[]>>({})
```

Load once per session switch (in the `currentId` effect):

```tsx
      fetchCommands(id)
        .then(result => {
          if (currentIdRef.current === id && result.available) {
            setCommandsBySession(previous => ({ ...previous, [id]: result.commands }))
          }
        })
        .catch(() => {})
```

A refresh callback for the composer's menu-open:

```tsx
  const refreshCommands = (id: string): void => {
    fetchCommands(id)
      .then(result => {
        if (result.available) setCommandsBySession(previous => ({ ...previous, [id]: result.commands }))
      })
      .catch(() => {})
  }
```

Warm the cache when a turn ends (in the SSE `case 'event'`, beside the existing `refreshTelemetry` call on `result`): `refreshCommands(message.sessionId)`. Prune dead sessions in the `sessions` frame cleanup beside the `tasksBySession` prune.

- [ ] **Step 3: Thread the new props**

```tsx
                <Composer
                  sessionId={current.id}
                  cwd={current.cwd}
                  commands={commandsBySession[current.id] ?? []}
                  onRefreshCommands={() => refreshCommands(current.id)}
                  busy={current.status === 'busy'}
                  …
                />
```

```tsx
                <Transcript events={events} commands={commandsBySession[current.id] ?? []} />
```

(Check how `Transcript` is invoked today and keep its memo working — the `commands` array identity changes only when the cache entry changes.)

- [ ] **Step 4: Typecheck, verify live, commit**

Run: `pnpm typecheck && pnpm build` — Expected: pass. Lab: send `/usage`-style local command via the composer → a 「命令输出」 row appears and persists across reload (sidecar JSONL); the user row's `/usage` token is blue; an `informational` banner (if one arises) renders as a gray note.
Run: `git add src/client/Transcript.tsx src/client/App.tsx && git commit -m "feat: command-output rows, notices, and the blue command token in the transcript"`

---

### Task 8: README and AGENTS docs

**Files:**
- Modify: `README.md`, `AGENTS.md`

**Interfaces:**
- Consumes: everything above.
- Produces: documentation.

- [ ] **Step 1: README feature bullets** — add: 斜杠命令菜单（输入 `/` 弹出，含技能与项目命令；命中的命令在输入框与转录里显示为蓝色识别态；本地命令的输出以「命令输出」行进转录）; `@` 文件/文件夹提及（输入 `@` 弹出目录选择器；手打的 `@路径` 同样生效 —— 仅行首或空白后的 `@` 触发；文件内容与文件夹目录树随消息注入，总量上限 1MB）。
- [ ] **Step 2: README 已知限制** — add: 斜杠命令菜单需要活跃引擎（新会话发过第一条消息后可用）; `@` 触发要求 `@` 位于行首或空白之后（`user@host` 不触发）; 文件夹提及注入目录树而非文件内容; 二进制或不可读路径静默保持普通文本。
- [ ] **Step 3: README 架构树 + AGENTS.md 模块表** — add `mentions.ts`（node 半区）与 `CommandMenu.tsx`/`MentionPicker.tsx`/`command-mentions.ts`（浏览器半区）行。API 表不变（28 对，无新路由）。
- [ ] **Step 4: Commit**

Run: `git add README.md AGENTS.md && git commit -m "docs: slash-command menu and @-mention injection"`

---

## Verification (whole batch, lab 3090)

1. **Local command round-trip** (UTF-8 payload script): send `/usage` → transcript gains 「命令输出」; `scripts/sse-capture.mjs` shows the `event` frame; no phantom assistant text; reload keeps the row.
2. **Mention injection proof**: message 「引用 @src/types.ts，告诉我它第一行的模块注释说了什么；顺带提 user@host 应保持普通文本」→ the answer quotes the module comment; the transcript shows **no Read tool card** (content came from the injected block); `user@host` inert. Second message with `@src/client` → tree-based answer, no Glob/Read cards.
3. **Playwright UI**: slash menu open/filter/complete; blue token on recognized draft and plain on `/xyz`; IME composition stays visible; mention picker drill/climb/insert relative + absolute.
4. **Boundaries**: >2MB file → truncated marker; binary path → plain text; >1MB total → elision markers.
