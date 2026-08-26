# Slash Commands & @-Mentions Design Spec

> **Status**: approved design, 2026-08-26 (conversation approval plus the blue
> recognition-token requirement). Two CLI-parity input features shipped as one batch.

## Goal

Give the composer the CLI's two input affordances the page still lacks:

1. **Slash commands** — typing `/` opens a command menu (built-ins, user skills, project
   commands); the sent text is executed by the CLI payload itself (SDK: "Slash commands
   are processed" in user turns), and the output of local commands (`/compact`,
   `/usage`, …) lands in the transcript instead of being silently dropped.
2. **@-mentions** — `@path` tokens (project-relative, absolute, files and folders) pull
   the referenced content into the turn's context, with a picker menu as typing sugar.

Both features share one recognition rule for `@` (user decision, CLI-parity): **a token
triggers only when the `@` is at text start or preceded by whitespace** — `user@host`
mid-word never triggers.

## Verified facts (SDK 0.3.220, `sdk.d.ts`)

- Slash commands in user messages are executed by the CLI payload; local commands can
  bypass the model loop entirely (`result` reason: "the loop was bypassed (local slash
  command)").
- `SDKLocalCommandOutputMessage` (`system`/`local_command_output`): `content: string` —
  "Displayed as assistant-style text in the transcript". **Currently unhandled →
  dropped.**
- `SDKInformationalMessage` (`system`/`informational`): `content`, `level:
  'info'|'notice'|'suggestion'|'warning'` — banners (hook feedback, slash-command
  output). **Currently unhandled → dropped.**
- `SlashCommand { name, description, argumentHint, aliases? }`; `supportedCommands()`
  exists. Our stack already wires listing end-to-end: `engine.supportedCommands()` →
  `GET /sessions/:id/commands` → client `fetchCommands` (returns `available:false`
  without a live engine).
- `system`/`commands_changed` push exists — **out of scope**: the menu refetches on
  every open, which is fresh enough for v1.
- `engine.send()` already builds the user message as a content-block array (image blocks
  lead, one text block follows) — mention expansion appends text blocks, no protocol
  change.
- Node half already owns the needed file primitives: `readTextFile` (≤2MB truncation,
  binary refusal) and `fs/list` directory listing.

## Feature A — slash commands

### Composer menu

- Trigger: the draft's first word starts with `/` and is still being composed (no space
  yet). IME composition is guarded exactly like the Enter-to-send path
  (`isComposing` / keyCode 229).
- Source: `fetchCommands(sessionId)` on every menu open (refresh-in-place). With
  `available:false` (no live engine yet) the menu does not open — a fresh session gains
  it after its first message, matching when the CLI's list stabilizes anyway.
- Rows: `name`, `description`, `argumentHint` as grey suffix. Filter: prefix match on
  name **and** aliases, case-insensitive; empty filter lists all.
- Keys: `↑`/`↓` move, `Enter`/`Tab` complete to `/name ` (trailing space, cursor after
  it — args are then typed freely), `Esc` closes, clicking a row completes. While open,
  Enter does NOT submit.
- Sending: the raw text goes out as an ordinary user message.

### Blue recognition token (user requirement)

When the draft's first word `/name` **exactly matches** a known command name or alias
(from the session's command cache), the token renders in recognition blue — the CLI's
"this will invoke that command/skill" feedback.

- Implementation: a metrics-matched **mirror layer** behind the textarea (same font,
  padding, line-height, width, `white-space: pre-wrap`; scrolls in sync). While a match
  exists, the textarea's own text turns `color: transparent` (caret stays visible via
  `caret-color`) and the mirror draws the text with the token in blue, the rest in the
  normal label color.
- **IME guard**: during native composition events the mirror hides and the textarea
  text returns to normal color — a composing buffer must never be invisible. The mirror
  mounts only while a match exists, so ordinary drafts are untouched.
- Transcript: the user row's leading command token gets the same blue span when it
  matches the session's command cache. The cache loads on session switch (when the
  engine is available) and on menu open; highlight is best-effort — no cache, no blue.
- Blue = the host's link/mention token color (`--dsw-alias-label-brand`-family token,
  same one the file-mention rendering uses), never a hardcoded hex.

### Engine gaps (the real backend work)

- **Local-command output delivery — verified against the live CLI (0.3.220 payload):
  `/usage`-style commands answer as a plain `assistant` message with *no stream events
  at all* in the turn** (`local_command_output` exists in the d.ts but this payload
  does not use it for these commands; the subtype handler stays as forward
  compatibility). The engine therefore tracks `streamedThisTurn` (set on the main
  stream's `message_start`, reset at send/finish): a non-replayed main-thread
  assistant message in a turn that never streamed is local-command output, published
  as the new `commandOutput` kind instead of `assistant`.
- **Persistence — the CLI displays local-command output but never writes it to its own
  transcript**, so `SessionCatalog.sidecarOnly` must admit `commandOutput` (and
  `notice`) or the row lives exactly one SSE broadcast and vanishes on reload.
- `system`/`informational` → new transcript event carrying `level`, rendered as a
  banner row (notice/suggestion gray or warning tint; `info` folded into notice).
- New event kinds join `CcEvent` in `src/types.ts` and ride the existing event
  pipeline untouched — engine `publish` → SSE `event` frame → client events map →
  sidecar JSONL. `live-turn.ts` folds stream deltas only and never sees transcript
  events, so it needs no change.
- Replay guard: resumed engines replay stored history as assistant/user messages
  carrying `isReplay`; the local-command reclassification must exclude them (it does).

## Feature B — @-mentions

### Node-side expansion (single implementation, zero client state)

All expansion happens in `engine.send()`; the client sends plain text exactly as typed.
Menu picking and hand typing are therefore indistinguishable downstream.

- Scan the text for `(^|\s)@(\S+)`; for each unique token:
  - Resolve the path: absolute when it matches the drive/UNC/leading-slash shape,
    else joined onto the session cwd.
  - **File** → `readTextFile` (≤2MB truncated; binary refusal → skip silently, token
    stays plain text).
  - **Folder** → bounded tree listing (NOT contents — user decision, CLI-parity): skip
    `node_modules`, `.git`, `dist`, `build`, `lib`, `out`, and dot-directories; cap 500
    entries / depth 8; dirs-first alphabetical; over-cap entries elided with a count
    line.
  - **Missing path** → plain text, no error (a pasted stale path never blocks a send).
- Block order: images → user text → mention blocks, appended after the text so the
  sentence reads first. Formats (each its own text block):
  `<file path="…">\n…\n</file>` and `<folder path="…">\n<tree>\n</folder>`.
- **Total budget**: 1MB of injected content per message; beyond it, later mentions are
  replaced by a 「（已省略：附件总量超限）」 marker inside their block.
- `lastSend` retry semantics: expansion re-runs at send time (a retried send re-reads
  the disk — latest content wins, same as the CLI's re-attached mention).

### Composer picker (sugar)

- Trigger: `@` at text start or after whitespace, while the token is being composed
  (no whitespace inside it yet).
- Browser rooted at the session cwd via `fs/list`; a `..` row at the top climbs (above
  the cwd root, `fs/list` with no path lists drive roots) — picks outside the cwd insert
  **absolute** tokens, picks inside insert cwd-relative ones, forward slashes,
  backslash-free.
- Filter: case-insensitive substring on the current segment. Keys: `↑`/`↓`, `Enter`/
  `Tab` pick (inserts `@path` + trailing space), `Esc` closes. Enter does not submit
  while open.
- Transcript: the user row keeps the text as typed (the token is literally what the
  model saw); no v1 decoration.

## Out of scope (v1)

- `commands_changed` SSE push (menu refetches on open).
- Slash-command **argument** autocomplete (`argumentHint` is display-only).
- @-token decoration in settled transcript text.
- Folder contents inlining (tree only), gitignore-aware filtering.

## Files touched

- `src/types.ts` — new CcEvent kinds (`commandOutput`, `notice`).
- `src/mentions.ts` — new node module: the `@` token scanner, folder-tree builder,
  and mention-block expander (the single place expansion lives).
- `src/engine.ts` — the two system subtypes; mention expansion in `send()`.
- `src/client/command-mentions.ts` — new pure helpers: leading command-token
  extraction and name/alias matching (shared by Composer and Transcript).
- `src/client/CommandMenu.tsx`, `src/client/MentionPicker.tsx` — the two popups.
- `src/client/Composer.tsx` — both menus, mirror layer, IME guards.
- `src/client/App.tsx` — owns the session-scoped command cache (loads on switch,
  refreshes on menu open and at turn end) and hands it to Composer and Transcript.
- `src/client/Transcript.tsx` — 「命令输出」 block, level banners, blue command token.
- `src/client/api/interaction.ts`, `fs.ts`, `settings.ts` — nothing new required
  (`fetchCommands`, `fetchFile`, `listDir` all exist).
- `README.md` — feature bullets; API table unchanged (no new routes).

## Verification (lab 3090; no test framework in this repo)

`pnpm typecheck`, then Python scripts (UTF-8 payload files, never inline `curl -d`) +
Playwright (never `networkidle`):

1. Send `/usage`-style local command → transcript gains a 「命令输出」 row; `sse-capture`
   shows the event; no phantom assistant turn.
2. Send a message with hand-typed `@src/types.ts` plus a menu-picked folder → ask the
   model to quote the file's first line and name the folder's file count (proves both
   injections); `user@host` in the same text stays inert.
3. Playwright: `/` menu opens/filters/completes; recognized `/name` shows the blue token
   (mirror), unrecognized stays plain; typing Chinese mid-draft keeps composition
   visible; `@` picker drills, climbs via `..`, inserts relative vs absolute correctly.
4. Boundary: a >2MB file mention truncates; a binary mention stays plain text; the 1MB
   total budget elides with the marker.
