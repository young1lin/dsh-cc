# Task Panel Design Spec

> **Status**: approved design, 2026-08-25. Companion bounded features shipped in the same
> implementation batch (permission-mode switcher, TODO pin, file viewer) are approved in
> conversation and are NOT spec'd here — only the task panel needed an architectural spec.

## Goal

Give the page a CLI-parity view of live work: a bottom panel listing every task the CLI
process is running — subagents, backgrounded shell commands, MCP monitors, workflows —
with live progress, a **Stop** action (`stopTask`) and a **Background** action (the Ctrl+B
equivalent, `backgroundTasks`). Today all five task lifecycle messages fall into
`engine.ts`'s unhandled `system` subtypes and are discarded, and the page renders nothing
about in-flight subagents until the `Task` tool result commits.

## Verified facts (SDK 0.3.220, `sdk.d.ts`)

- `SDKTaskStartedMessage` (`system`/`task_started`): `task_id`, `tool_use_id?`,
  `description`, `subagent_type?`, `task_type?`, `workflow_name?`, `prompt?`,
  `skip_transcript?`.
- `SDKTaskProgressMessage` (`system`/`task_progress`): `task_id`, `tool_use_id?`,
  `description`, `subagent_type?`, `usage { total_tokens, tool_uses, duration_ms }`,
  `last_tool_name?`, `summary?`.
- `SDKTaskUpdatedMessage` (`system`/`task_updated`): `task_id` + wire-safe `patch`
  `{ status?: 'pending'|'running'|'completed'|'failed'|'killed'|'paused', description?,
  end_time?, total_paused_ms?, error?, is_backgrounded? }`.
- `SDKTaskNotificationMessage` (`system`/`task_notification`): `task_id`, `tool_use_id?`,
  `status: 'completed'|'failed'|'stopped'`, `summary`, `usage?` — the settle frame.
- `SDKBackgroundTasksChangedMessage`: a **level** signal (`BackgroundTaskSummary[]`,
  ids only + type/description fields) emitted on background-set membership change; the
  doc explicitly recommends replacing state from levels, not pairing edges.
- Controls on `Query`: `stopTask(taskId)` (a `task_notification` with status `stopped`
  follows), `backgroundTasks(toolUseId?)` (backgrounds in-flight foreground tasks; the
  blocking tool call returns immediately and the turn continues).
- `forwardSubagentText` option exists for nested subagent transcripts — **out of scope**
  (explicitly declined; the progress row is the CLI-density view).

## Architecture (chosen: server-authoritative snapshot channel)

The engine folds all five task frames into a per-session **task table** and the runtime
broadcasts the whole table as one new SSE frame kind. The page renders snapshots and
never folds task edges.

- `tasks` is a **level** frame like the existing `sessions` frame: full-table payload,
  so a missed frame self-heals on the next broadcast and a mid-join page is repaired by
  the snapshot inside `GET /sessions/:id`.
- `task_updated` patch semantics are folded exactly once, server-side (the codebase's
  one-reducer philosophy: state the two halves could disagree about lives on one side).
- Rejected alternative — forwarding edges and folding client-side (like `live-turn`
  deltas): needs a snapshot repair path anyway (a page joining after `task_started` sees
  orphan rows), duplicates patch logic in the client.
- Rejected alternative — folding tasks into `live-turn`: wrong model; background tasks
  outlive the turn, live turns are discarded at turn end.

## Data model (`src/types.ts`, shared)

```ts
/** One row of the live task table, folded by the engine from SDK task frames. */
export interface TaskRow {
  id: string                // task_id
  type: string              // 'subagent' | 'shell' | 'monitor' | 'workflow' | …
  status: 'running' | 'paused' | 'completed' | 'failed' | 'killed' | 'stopped'
  description: string
  toolUseId?: string        // joins the transcript Task/Bash card
  subagentType?: string
  command?: string          // shell tasks
  prompt?: string
  tokens: number
  toolUses: number
  durationMs: number
  lastToolName?: string
  summary?: string
  isBackgrounded?: boolean
  error?: string
}
```

Terminal statuses: `completed | failed | killed | stopped`. The CLI's `pending` and the
notification's `stopped` normalize into this set. Nothing here is persisted — the
transcript's `Task` card remains the durable record; the table is live read-state only
(sidecar invariant: CLI-expressible facts stay in CLI storage).

## Engine folding (`src/engine.ts`)

- The task table is private engine state (`Map<string, TaskRow>` in insertion order).
  Every mutation emits one **full-table snapshot** through a new
  `EngineHooks.tasks(rows: TaskRow[]): void` — the host broadcasts, never persists.
- `onMessage`'s `system` arm grows from `init`-only to the five subtypes:
  - `task_started` → upsert `{ status: 'running', tokens: 0, toolUses: 0, durationMs: 0 }`
    carrying type/description/subagentType/prompt/toolUseId/command-when-present.
  - `task_progress` → merge tokens/toolUses/durationMs/lastToolName/summary/description.
  - `task_updated` → merge the patch fields verbatim.
  - `task_notification` → settle: status + summary + usage overwrite.
  - `background_tasks_changed` → reconcile only (missed-edge guard; rows are never
    created from this frame): every id present in the level gets `isBackgrounded: true`,
    and the level's summary fields (`command`, `description`, `agent_type`) fill any row
    slot still empty — the shell command line reaches the table only through this frame.
- **Clear-on-next-turn** (user decision): on main-stream `message_start`
  (`parent_tool_use_id === null`, the only stream the engine forwards), prune terminal
  rows, keep running ones, broadcast. Settled rows therefore stay visible from settle
  until the next turn begins.
- Engine death (`finish`/`close`) → clear the table, broadcast empty: tasks are bound to
  the CLI process; a recycled engine's tasks died with it (the transcript card survives).

## Transport (`src/runtime.ts`)

- SSE: new frame `{ kind: 'tasks', sessionId, tasks: TaskRow[] }` broadcast on every
  snapshot, same channel and listener accounting as `sessions`.
- `GET /cc/api/sessions/:id` response gains `tasks: TaskRow[]` — read off the live
  engine; no engine (cold, evicted, terminal-owned) → `[]`.
- New routes, both requiring a live engine:
  - `POST /cc/api/sessions/:id/tasks/:taskId/stop` → `q.stopTask(taskId)`.
  - `POST /cc/api/sessions/:id/tasks/:taskId/background` → `q.backgroundTasks(toolUseId)`
    (the row's `toolUseId`).
  - Guards: no live engine → 409; taskId not in the table → 404; row already terminal
    (stop) → 409; `backgroundTasks` resolving `false` (not a foreground task) → 409.

## UI (`src/client/`)

- New `TaskPanel.tsx` mounted `Transcript → TaskPanel → TodoPin → Composer` (transient
  per-turn state sits above session-persistent state; both hug the composer like the
  CLI's bottom region).
- Panel header: 「任务（N 运行中）」 with a collapse toggle; the panel hides entirely at
  zero rows.
- Row: type badge (`subagentType` present → 子代理; `type === 'shell'` → 命令;
  `monitor` → 监视; `workflow` → 工作流; anything else falls back to the raw `type`),
  description, `tokens · duration` readout, `last_tool_name`; running rows get
  a spinner and the two action buttons 「结束」「转后台」; terminal rows grey out with a
  status glyph (✓ / ✕ / ■). Expanding a row shows full description, prompt, usage, and
  error when present.
- Client state: a per-session `TaskRow[]` fed by `tasks` frames and seeded from session
  detail; reset on session switch. Styling through `--dsw-*` tokens only.
- README: API table + feature list updated (three new method-path pairs + frame kind).

## Edge cases

- **Missed frames** — next snapshot repairs; there is no client-side fold to corrupt.
- **Background task crossing turns** — survives clear-on-next-turn (running rows are
  pruned only when terminal).
- **Engine recycling (LRU eviction, env/model changes)** — `finish` broadcasts the empty
  table; the panel drains while the transcript keeps the history.
- **Terminal-owned sessions** — no engine, `tasks: []`, no panel; consistent with the
  read-only control model.
- **Old CLI payloads without `task_type`** — badge falls back to the raw discriminant.
- **`skip_transcript` ambient tasks** — they may appear in the panel (real work); they
  never had transcript cards to conflict with.

## Verification (no test framework in this repo)

`pnpm typecheck`, then the lab instance on 3090 (Git Bash launch; the 3080 user instance
is checked for busy sessions before anything touches it):

1. A prompt that spawns two subagents and one long `Bash` → three rows appear with
   ticking tokens/duration/last-tool; `scripts/sse-capture.mjs` shows `tasks` frames.
2. 「结束」 on one subagent → its row settles `stopped`, the model receives the
   truncation; 「转后台」 on the shell → the turn resumes immediately, row marks
   backgrounded, settles later via `task_notification`.
3. Next turn starts → settled rows clear, a still-running background row survives.
4. Mid-turn page refresh → panel rebuilt from `GET /sessions/:id` detail.
5. `maxLiveSessions` eviction mid-task → panel drains to empty.
