# CLI-Parity Batch 2 Implementation Plan

**Goal:** Close the remaining interaction-parity gaps between the web surface and the Claude Code CLI, identified by a three-agent audit against the official interactive-mode / commands / checkpointing references. Nine work packages in three parallel waves by file surface.

**Baseline finding:** the page already matches or beats the CLI on information display (context meter, usage readout, task panel, permission cards with free-form note). The gap is the "muscle-memory layer": Esc interrupt, input history, queue visibility, time travel (fork/rewind), hotkeys, shell mode, and streaming-render continuity.

## Verified SDK facts (pinned @anthropic-ai/claude-agent-sdk@0.3.220)

- `forkSession(sessionId, { dir?, upToMessageId?, title? })` → new native session id; branching point is the user message's uuid.
- `enableFileCheckpointing: true` (query option) + `Query.rewindFiles(userMessageId, { dryRun? })` → `{ canRewind, error?, filesChanged?, insertions?, deletions?, skippedLinks? }`. dryRun previews with ± line counts.
- Native transcript rows: user rows carry `uuid`; compaction boundary is a `type:"system" subtype:"compact_boundary"` row with `compactMetadata { trigger, preTokens, postTokens, cumulativeDroppedTokens, durationMs }`, immediately followed by a synthetic user "This session is being continued…" summary message; `file-history-snapshot` rows hold checkpoint data (CLI-side).
- `query.supportedCommands()` is the live command catalog; commands are transparently forwarded as message text today (no page-local execution by design).
- `SessionMessage` (sdk.d.ts:4727) declares `type: 'user'|'assistant'|'system'`, `uuid: string`, `message: unknown` — the native message uuid is a declared field, so mapping it onto user events needs no smuggling. System rows' `subtype`/`compactMetadata` arrive as undeclared runtime extras, read through the same validated-unknown pattern the module already uses for `timestamp` (native-transcript.ts:249-261).

## Waves and packages

**Wave 1 (parallel, disjoint surfaces):**
- A (WP1/2/9c, `Composer.tsx` + `NewSessionCard.tsx`, minimal `App.tsx` props): Esc interrupt while busy (before blur, after menus), per-session draft persistence (`dsh-cc:draft:<id>`), input history ↑/↓ (`dsh-cc:history-v1:<configDir>|<cwd>`, cap 200, dedupe consecutive), optional session name in the new-session card.
- B (WP3, `engine.ts` queue area + `runtime.ts` new routes + new `QueuedList.tsx`): queue snapshot `GET /sessions/:id/queue`, take-back `DELETE /sessions/:id/queue/:uuid`, queued entries survive engine death (never-delivered entries re-queue after resume), expandable queued list above composer with per-entry recall.
- D (WP7/9, `live-turn.ts` + `LiveTurnView.tsx` + `tool/card-model.ts` + `MentionPicker.tsx`): streaming Markdown via host MarkdownText with caret as trailing element, per-turn elapsed timer (+ per-thinking-block when clean), `Agent` tool → task card dispatch, fuzzy-match character highlight from computed positions.

**Wave 2 (after Wave-1 integration):**
- C (WP5, `engine.ts` + `runtime.ts` + `native-transcript.ts` + transcript UI): `enableFileCheckpointing` on spawn; `POST /sessions/:id/fork` wiring the existing `forkNativeSession`; rewind preview/apply endpoints over `rewindFiles`; user events carry `nativeMessageId`; compact boundary rendered as a divider row with token stats; hover actions on user bubbles (fork / rewind files), double-Esc rewind menu as the umbrella entry.
- G (WP4, `App.tsx` window keydown): Shift+Tab cycles permission modes, Alt+P opens model menu, Alt+T toggles effort; guarded by overlay state and IME. WIRING DESIGN (verified against current code): App already holds sessionMode/configMode (it passes both to StatusBar) and renders the error bar — Shift+Tab computes next from PERMISSION_MODE_VALUES starting at (sessionMode || configMode), calls setPermissionMode directly, failure lands in the existing error bar (no new state). Alt+P: ModelMenu owns its open state; add an optional `openSignal?: number` prop whose change setOpen(true) — one prop, no lifting. Alt+T: App keeps `lastEffortRef`; effective effort set → setEffort(''), else setEffort(lastEffortRef ?? 'high'); the ref updates whenever a session's effort field is seen non-empty.

**Wave 3:**
- E (WP8): server-side command catalog cache in dataDir keyed (configDir, cwd) returned with `stale: true` for cold sessions. PRE-STAGED: `src/command-cache.ts` (complete, typechecks; wire = remember on successful supportedCommands(), read on unavailable engine, ~5 lines in runtime.ts). Client-side TUI/page chips shipped: `term-commands.ts` + `CommandMenu.tsx`.
- F (WP6, `engine.ts` send interception + shell runner): `!` prefix executes in session cwd via child_process (timeout, output cap), streams as commandOutput events, wraps command+output as a user message per CLI semantics, queues while busy, permission-gated in approval modes. PRE-STAGED: `src/shell-run.ts` (mechanism-only runner: merged stream, 120s timeout, 256 KiB tail cap, chunk callback; NO policy — gating stays at the engine layer).

**Integration & verification per wave:** `pnpm typecheck` → `pnpm build` → lab instance `dsh --profile web --no-open --port 3090` from Git Bash; check 3080 for zero busy sessions before any contact; SSE keeps connections open so never use networkidle as a wait condition. README updated once at the end.

## C package dispatch brief (anchors verified against HEAD)

- engine.ts:876-894 — the `Options` literal in `ensureStarted()`: add `enableFileCheckpointing: true` beside `includePartialMessages`.
- engine.ts — new methods `rewindFilesPreview(id, dryRun)` thin-wrapping `this.query?.rewindFiles(userMessageId, { dryRun })`; undefined query → { available: false } shape mirroring supportedCommands.
- native-sessions.ts:196 `forkNativeSession` — already wraps SDK forkSession({ dir, upToMessageId, title }); wire `POST /sessions/:id/fork` { upToMessageId?, title? } in runtime.ts near the rename/delete routes; the new native session enters the catalog through the existing adoption path (CLI is identity authority; NO sidecar field writes beyond what adoption already does); busy engine → 409.
- native-transcript.ts:145-154 — `mapSessionMessage` system branch: read `subtype`/`compactMetadata` through the validated-unknown pattern of resolveTimestamp (249-261); `subtype === 'compact_boundary'` → new event kind `compactBoundary` carrying { trigger, preTokens, postTokens, cumulativeDroppedTokens }; user branch: attach `message.uuid` (DECLARED field, sdk.d.ts:4729) as optional `nativeMessageId` on the user event. types.ts: extend the CcEvent user member + add the compactBoundary member (wire-compat: unknown kinds already tolerated by both halves' switches — verify default branches).
- runtime.ts — routes: `POST /sessions/:id/fork`, `POST /sessions/:id/rewind-preview` { userMessageId } (dryRun), `POST /sessions/:id/rewind` { userMessageId } — the latter two require a live engine with checkpointing (409 with reason otherwise). Broadcast sessions frame after fork (new row appears).
- Transcript.tsx:298-336 — user bubble: hover reveals action row (「分叉」「回滚文件」) only when event.nativeMessageId is present; compactBoundary renders a centered divider「对话已压缩 · 前 N tokens → 后 M tokens」. App.tsx: wire the two REST calls + a small confirm popover for rewind preview stats (filesChanged count, +insertions/-deletions, skippedLinks warning); after fork success switch selection to the new session id.
- Double-Esc rewind menu is OPTIONAL polish; ship hover actions first.

## G package implementation design (final, verified against HEAD)

ModelMenu half DONE: `openSignal?: number` prop + effect `if (openSignal !== undefined && openSignal > 0) setOpenMenu('model')` (0 default never fires on mount). App half, to apply after B lands (App.tsx is contested until then):

- imports: `setPermissionMode, setEffort` from './api/telemetry.ts'; `PERMISSION_MODE_VALUES` (+ type) from './types.ts'.
- state: `const [modelMenuSignal, setModelMenuSignal] = useState(0)`; `const lastEffortRef = useRef('')`; effect `if (current?.effort) lastEffortRef.current = current.effort`.
- one window keydown effect beside the Esc one (capture), guards: isComposing/keyCode 229, overlaysRef.size > 0, and currentIdRef.current must be set; read the session through sessionsRef (already exists) so the effect never re-subscribes per frame:
  - Shift+Tab → preventDefault; from = session.permissionMode || config?.permissionMode || 'auto'; next = PERMISSION_MODE_VALUES[(indexOf(from)+1) % len]; setPermissionMode(id, next).catch(fail).
  - Alt+P/p → preventDefault; setModelMenuSignal(v => v + 1).
  - Alt+T/t → preventDefault; effort = session.effort ?? ''; effort !== '' ? setEffort(id, '') : setEffort(id, lastEffortRef.current || 'high'); both .catch(fail).
- StatusBar props + `openSignal?: number` pass-through to ModelMenu (StatusBar.tsx is uncontested).

## F engine wiring design (apply after C lands)

- engine.send(): before building the SDK content, `const m = /^!(.*)$/s.exec(text.trimStart())`; if m && images.length === 0 → shell-mode path:
  1. emit user echo event with the raw `!cmd` text (runtime currently emits the user event; the shell path must publish its own — check sendMessage split: emitEvent stays in runtime, so interception must live in runtime.sendMessage BEFORE engine.send, calling a new engine.runShell(command) method).
  2. engine.runShell(command): policy = shellPolicyFor(effective permissionMode); 'ask' → reuse the permission bridge (surface as canUseTool-style request via the existing pendingPermissions channel with toolName 'Shell'); 'run' → runShell(command, { cwd, onChunk → publish commandOutput deltas or accumulate }); on settle: publish one commandOutput event with merged output, then push the wrapped user message (「!<command> 输出如下：<output>」 as plain text) through the normal deliver() path so the CLI's model responds to it (CLI respondToBashCommands semantics).
  3. busy → queue like a message (entries carry wasCommand; shell entries add wasShell so delivery replays runShell not send).
- Keep it minimal for the final round: single commandOutput event on settle (no streaming chunks) is acceptable if time-boxed.

## Lab verification checklist (final round)

Pre-flight: `GET /cc/api/sessions` on 3080 → zero busy before any contact; lab instance `dsh --profile web --no-open --port 3090` from Git Bash; SSE defeats networkidle — never wait on it.

1. Esc interrupt: start a turn (any prompt), press Esc in the composer → turn stops, transcript shows 已中断, queue survives.
2. Draft: type unsent text, switch session, switch back → text restored; reload page → restored.
3. History: send 2 messages, empty composer, ArrowUp twice → second-to-last, ArrowDown → back to stash/draft.
4. Queue UI: send during a running turn → strip shows 已排队 N; expand → rows; 撤回 → text returns to composer; kill engine (bad model via session env?) → queue survives next send.
5. Hotkeys: Shift+Tab cycles permission label; Alt+P opens model menu; Alt+T toggles effort label.
6. Streamed markdown: ask for a fenced code block → live text renders fenced content as plain text, settle swaps to highlighted; caret never inside the fence; elapsed clock ticks beside 思考中.
7. Agent card + mention highlight: trigger a Task/Agent delegation → task card; @-menu filter shows brand-blue matched chars.
8. Command chips: open / menu → /model shows 页面 chip, /theme shows 终端 chip; cold session (never sent) shows cached catalog (stale) rather than empty.
9. Fork: on a session with native id, POST fork → new session appears in rail, switches selection; transcript of fork matches source up to branch point.
10. Rewind: make Claude edit a file, hover the user bubble → 回滚文件 → preview shows files/±lines → apply → file content reverted on disk.
11. Compact boundary: run /compact → divider「对话已压缩 · 前 N → 后 M tokens」appears after reload (native transcript re-read).
12. Shell mode: permissionMode default → `! echo hi` asks approval card; acceptEdits → runs, commandOutput row appears, model responds to output.

## Constraints carried over

All house rules from AGENTS.md apply (style, sidecar invariants, loopback Host gate, no cross-process interrupts, SDK pin). Queue re-delivery must never double-send an entry the CLI already consumed — the result-boundary delivery flag is the source of truth. Checkpoint restore is file-level only; conversation-level rewind is expressed as fork-and-switch because the SDK exposes no in-place truncate.
