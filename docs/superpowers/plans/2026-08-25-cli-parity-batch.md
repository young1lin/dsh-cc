# CLI-Parity Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship four approved features in one batch — per-session permission-mode switching, a pinned current-TODO panel, a bottom task panel with stop/background controls, and click-through file viewing with syntax highlighting.

**Architecture:** All four ride existing patterns: permission mode mirrors the model/effort hot-switch lifecycle (sidecar field → spawn resolution → control channel → status-strip menu); the task panel is a server-authoritative snapshot channel (the engine folds the SDK's five task frames into a per-session table, the runtime broadcasts it whole like the `sessions` frame); the TODO pin is pure client derivation from the transcript; the file viewer is one read-only endpoint plus the host's `fileMentions`/`ReadBlock`/`Modal` primitives.

**Tech Stack:** TypeScript (Node + React), `@anthropic-ai/claude-agent-sdk` 0.3.220 (pinned, unchanged), `@deepseek-ai/dsh-client-ui-primitives` 0.1.0-rc.7, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-25-task-panel-design.md` (feature 2 only; features 1/1b/3 are approved in conversation and restated below). Two spec deviations, both verified against the pinned SDK: (a) `SDKBackgroundTasksChangedMessage.tasks` carries only `{task_id, task_type, description}` — no `command` — so `TaskRow.command` stays unset in this batch; (b) the current permission mode is displayed by resolving session-override-else-config (exact, because every spawn passes an explicit mode) rather than patching `system/init`'s report into the sidecar — an account root's transient posture must not freeze into the row.

## Global Constraints

- House style: 2-space indent, single quotes, no default exports, JSDoc with `@param`/`@returns` on every exported function, `@module` comment at each file head. UI copy in Chinese. Match the surrounding files.
- No test framework exists and none may be added. Verification per task is `pnpm typecheck` plus the concrete live checks named in the task.
- Lab instance: `dsh --profile web --no-open --port 3090` from **Git Bash** (PowerShell `Start-Process` cannot run the npm shim). The user's own instance is on **3080** — before touching it, check `GET /cc/api/sessions` shows zero busy sessions. API base `/cc/api`.
- The plugin must be re-installed (`dsh plugin --profile web add C:/PythonProject/dev/dsh-cc`) or link-installed + `pnpm build` before lab verification; restart dsh after install.
- SDK pinned at `@anthropic-ai/claude-agent-sdk@0.3.220`; facts about task frames/controls below were read from its `sdk.d.ts` and hold for that version.
- Task table and TODO pin are display state only — never persisted; the transcript stays the durable record (CLI-owned facts stay in CLI storage).
- Line endings: repo is LF. After edits, `git diff --stat` must show only intended files.
- Commits: straight to `main`, message trailer `Co-Authored-By: Claude <noreply@anthropic.com>`.

## Current State (anchors for the edits)

- `src/engine.ts` — `EngineStart { sessionId, cwd, model, claudeSessionId? }`; `ensureStarted()` builds `Options` with `permissionMode: this.config.permissionMode` plus the bypass companion flag; `onMessage`'s `case 'system'` handles only `subtype === 'init'`; `onStreamEvent` drops `parent_tool_use_id !== null` frames and `message_start` resets `openBlocks`/`turnStopped`; `finish()` is the single termination bookkeeping path.
- `src/runtime.ts` — routes under `parts[0] === 'sessions'`; `configFor(session)` folds effort/env; `startEngine(session, model)` constructs `EngineStart`; `hooks(sessionId)` implements `EngineHooks`; `SILENT_HOOKS` for probe engines; session detail route returns `{ session, events, live }`; effort route (`parts.length === 3 && parts[2] === 'effort'`) is the lifecycle template for permission-mode.
- `src/types.ts` — `SessionMeta` has `model: string` and `effort?: EffortLevel | ''`; `WireMessage` union ends with `dialog-done`.
- `src/client/App.tsx` — layout order inside `<main>`: header, StatusBar, error bar, then `cc-scroll` div, then `<Composer>`; SSE switch in `connectEvents`; state `eventsBySession`/`liveBySession` keyed per session; `sessions` frame handler prunes dead ids from those maps.
- `src/client/Transcript.tsx` — `EventItem` renders `assistant` via `<MarkdownText text={event.text} />`; `Transcript` is memo'd, computes `cwd` via `sessionCwd(events)`.
- `src/client/StatusBar.tsx` renders `ModelMenu`, `ContextMeter`, `UsageReadout` in `.cc-status`.
- `src/client/status/ModelMenu.tsx` — the `Menu`-picker pattern (open state, optimistic select + rollback, `.cc-status-picker` CSS registered under `status-model-menu`).

## File Structure

- Create: `src/client/status/PermissionModeMenu.tsx` — status-strip posture picker.
- Create: `src/client/TaskPanel.tsx` — bottom task table panel.
- Create: `src/client/TodoPin.tsx` — pinned current-TODO panel + `currentTodos` derivation.
- Create: `src/client/FileViewer.tsx` — modal file viewer.
- Create: `src/client/file-mentions.ts` — `fileMentions` resolver for transcript markdown.
- Create: `src/client/api/fs.ts` — `fetchFile`.
- Modify: `src/types.ts`, `src/engine.ts`, `src/runtime.ts`, `src/http-support.ts`, `src/client/App.tsx`, `src/client/StatusBar.tsx`, `src/client/Transcript.tsx`, `src/client/api/sessions.ts`, `src/client/api/telemetry.ts`, `README.md`.

---

### Task 1: Shared types — permission-mode value, SessionMeta field, TaskRow, `tasks` frame

**Files:**
- Modify: `src/types.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `PermissionModeValue`, `PERMISSION_MODE_VALUES`, `SessionMeta.permissionMode`, `TaskRow`, `TERMINAL_TASK_STATUSES`, `WireMessage` member `{ t: 'tasks'; sessionId: string; tasks: TaskRow[] }`. All later tasks import these names.

- [ ] **Step 1: Add the permission-mode type after `EffortLevel` (line ~26)**

```ts
/**
 * The six permission postures the CLI accepts, in wire spelling — the same
 * union the SDK's `PermissionMode` uses, mirrored so the browser half can
 * validate and label it without importing the Node-only SDK.
 */
export type PermissionModeValue = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions' | 'auto'

/** Every {@link PermissionModeValue}, for validating page-supplied input. */
export const PERMISSION_MODE_VALUES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions', 'auto'] as const
```

- [ ] **Step 2: Add the session override after the `effort` field in `SessionMeta` (line ~111)**

```ts
  /**
   * Permission-posture override for this session; unset or empty = the
   * resolved config default. Same lifecycle as `model`: persisted here,
   * spawn-time for a cold engine, hot-switched on a busy one.
   */
  permissionMode?: PermissionModeValue | ''
```

- [ ] **Step 3: Add the task-table types before `WireMessage` (near `LiveTurnSnapshot`)**

```ts
/** One row of a session's live task table, folded from the CLI's task frames. */
export interface TaskRow {
  /** The CLI's task id; joins control calls back to the process. */
  id: string
  /** Task discriminant: `subagent`, `shell`, `monitor`, `workflow`, … */
  type: string
  status: 'running' | 'paused' | 'completed' | 'failed' | 'killed' | 'stopped'
  /** The model's own statement of what the task is for. */
  description: string
  /** The tool_use block that started the task, when the CLI reported one. */
  toolUseId?: string
  /** Subagent preset name, for `subagent` tasks. */
  subagentType?: string
  /** Joins the transcript Task/Bash card. */
  prompt?: string
  tokens: number
  toolUses: number
  durationMs: number
  lastToolName?: string
  summary?: string
  isBackgrounded?: boolean
  error?: string
}

/** The task statuses that end a task's life. */
export const TERMINAL_TASK_STATUSES = ['completed', 'failed', 'killed', 'stopped'] as const
```

- [ ] **Step 4: Add the wire frame to `WireMessage` (last union member)**

```ts
  | { t: 'tasks'; sessionId: string; tasks: TaskRow[] }
```

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck` — Expected: pass.
Run: `git add src/types.ts && git commit -m "feat: shared types for permission-mode switching and the task table"`

---

### Task 2: Engine — spawn with the session's permission mode, live switch, shared resolver

**Files:**
- Modify: `src/engine.ts`

**Interfaces:**
- Consumes: `PermissionModeValue` from `./types.ts`.
- Produces: `EngineStart.permissionMode: string`; exported `resolveSessionPermissionMode(sessionMode: string, configMode: ResolvedConfig['permissionMode']): PermissionModeValue`; `SessionEngine.setPermissionMode(mode: PermissionModeValue | undefined): Promise<boolean>`; init transcript event `data.permissionMode`.

- [ ] **Step 1: Extend `EngineStart`**

```ts
export interface EngineStart {
  sessionId: string
  cwd: string
  /** Session-level model override; empty string = plugin default. */
  model: string
  /** Session-level permission-posture override; empty string = plugin default. */
  permissionMode: string
  claudeSessionId?: string
}
```

- [ ] **Step 2: Add the import and the resolver next to `resolveSessionModel` (bottom of file)**

Add `type PermissionModeValue` to the `./types.ts` import list, then:

```ts
/**
 * The permission posture a session's engine runs with: the session's own
 * override when it names one, else the resolved config default. Shared by the
 * spawn path here and the page readout in the runtime so the two cannot drift.
 * @param sessionMode - the session's override; empty = no opinion.
 * @param configMode - the resolved config default.
 * @returns the posture to spawn with.
 */
export function resolveSessionPermissionMode(
  sessionMode: string,
  configMode: ResolvedConfig['permissionMode'],
): PermissionModeValue {
  if (sessionMode !== '') return sessionMode as PermissionModeValue
  return configMode
}
```

- [ ] **Step 3: In `ensureStarted()`, resolve and use it**

Replace the two lines `permissionMode: this.config.permissionMode,` and the companion-flag spread below it with:

```ts
    const permissionMode = resolveSessionPermissionMode(this.startSpec.permissionMode, this.config.permissionMode)
    const options: Options = {
      // …unchanged fields…
      permissionMode,
      // The SDK refuses to skip permission checks unless the caller restates
      // the intent through this companion flag.
      ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
```

- [ ] **Step 4: Report the live posture in the init transcript event**

In `onMessage`'s `init` arm, extend `data`:

```ts
            data: {
              model: message.model,
              cwd: message.cwd,
              tools: message.tools,
              permissionMode: message.permissionMode,
            },
```

- [ ] **Step 5: Add the live switch, beside `setModel`**

```ts
  /**
   * Switch the permission posture of the running process; a recycled engine
   * reads the session's persisted override at spawn instead.
   * @param mode - the posture, or undefined to reset to the spawn default.
   * @returns true when a live query accepted the switch.
   */
  async setPermissionMode(mode: PermissionModeValue | undefined): Promise<boolean> {
    this.lastUsed = Date.now()
    const q = this.query
    if (q === undefined) return false
    await q.setPermissionMode(mode ?? resolveSessionPermissionMode(this.startSpec.permissionMode, this.config.permissionMode))
    return true
  }
```

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm typecheck` — Expected: FAIL is expected here if `runtime.ts` still constructs `EngineStart` without `permissionMode`; add `permissionMode: ''` to BOTH existing construction sites in `src/runtime.ts` (`startEngine` uses `session.permissionMode ?? ''`; the catalog probe in `probeModels` uses `permissionMode: ''`) in this same commit, then re-run: Expected: pass.
Run: `git add src/engine.ts src/runtime.ts && git commit -m "feat: engine spawns and hot-switches the session permission mode"`

---

### Task 3: Runtime — permission-mode resolution and route

**Files:**
- Modify: `src/runtime.ts`

**Interfaces:**
- Consumes: `resolveSessionPermissionMode`, `PERMISSION_MODE_VALUES`, `PermissionModeValue`, `SessionEngine.setPermissionMode`.
- Produces: `POST /cc/api/sessions/:id/permission-mode` accepting `{ mode: string }` (empty = reset to global default); spawns honour `SessionMeta.permissionMode`.

- [ ] **Step 1: Resolve the posture in `configFor`**

Add to the import from `./engine.ts`: `resolveSessionPermissionMode`. Add to the import from `./types.ts`: `PERMISSION_MODE_VALUES, PermissionModeValue`. Add the resolver method beside `effortFor`:

```ts
  /**
   * The posture a session's next engine spawns with: the session's own
   * override when it names one, else the resolved config default.
   * @param session - the session being resolved.
   * @returns the posture.
   */
  private permissionModeFor(session: SessionMeta): PermissionModeValue {
    return resolveSessionPermissionMode(session.permissionMode ?? '', this.effectiveConfig().permissionMode)
  }
```

In `configFor`, fold it into the returned object:

```ts
    return { ...base, env, permissionMode: this.permissionModeFor(session), ...(effort !== undefined ? { effort } : {}) }
```

- [ ] **Step 2: Register the route** (place it directly after the `effort` route block)

```ts
        if (parts.length === 3 && parts[2] === 'permission-mode' && method === 'POST') {
          const session = this.store.get(id) ?? await this.catalog.adopt(id)
          if (!session) return json(res, { error: '会话不存在' }, 404)
          const body = await readJson(req)
          const mode = typeof body?.mode === 'string' ? body.mode.trim() : ''
          if (mode !== '' && !(PERMISSION_MODE_VALUES as readonly string[]).includes(mode)) {
            return json(res, { error: '无效的权限模式' }, 400)
          }
          // Same lifecycle as the model override: persisted as this session's
          // default, hot-switched on a busy process, and spawn-time for a cold
          // one — an idle engine is recycled so the next message respawns.
          const permissionMode = mode === '' ? undefined : mode as PermissionModeValue
          await this.patchMeta(session.id, { permissionMode })
          const engine = this.liveEngine(session.id)
          if (engine !== undefined && engine.busy) {
            // Detached but caught, exactly like the live model switch: a
            // refusing CLI must not fault the host process.
            engine.setPermissionMode(permissionMode).catch((error: unknown) => {
              this.ctx.logger?.warn?.(`dsh-cc: live permission-mode switch failed for ${session.id}: ${String(error)}`)
            })
          } else if (engine !== undefined) {
            await this.closeEngine(session.id)
          }
          return json(res, { ok: true, mode })
        }
```

- [ ] **Step 3: Typecheck, verify live, commit**

Run: `pnpm typecheck && pnpm build` — Expected: pass.
Reinstall + restart the lab instance, then verify with curl (substitute a real session id from `GET /cc/api/sessions`):

```sh
SID=$(curl -s localhost:3090/cc/api/sessions | python -c "import sys,json;print(json.load(sys.stdin)['sessions'][0]['id'])")
curl -s -X POST localhost:3090/cc/api/sessions/$SID/permission-mode -H 'content-type: application/json' -d '{"mode":"default"}'
curl -s -X POST localhost:3090/cc/api/sessions/$SID/permission-mode -H 'content-type: application/json' -d '{"mode":"bogus"}'   # expect 400
curl -s localhost:3090/cc/api/sessions | python -c "import sys,json;print([s.get('permissionMode') for s in json.load(sys.stdin)['sessions'] if s['id']=='$SID'])"
```

Expected: `{"ok":true,"mode":"default"}`, then the 400, then `['default']`.
Run: `git add src/runtime.ts && git commit -m "feat: POST /sessions/:id/permission-mode with spawn resolution"`

---

### Task 4: Client — PermissionModeMenu in the status strip

**Files:**
- Create: `src/client/status/PermissionModeMenu.tsx`
- Modify: `src/client/api/telemetry.ts`, `src/client/StatusBar.tsx`, `src/client/App.tsx`

**Interfaces:**
- Consumes: `POST /sessions/:id/permission-mode`, `PERMISSION_MODE_VALUES`, `PermissionModeValue`.
- Produces: `setPermissionMode(id, mode)` API fn; `PermissionModeMenu(props: { sessionId: string; sessionMode: string; configMode: string })`.

- [ ] **Step 1: API function in `telemetry.ts` (after `setEffort`)**

```ts
/**
 * POST /sessions/:id/permission-mode — set this session's permission posture.
 * @param id - session id.
 * @param mode - posture value; empty resets to the global default.
 * @returns the acknowledgement.
 */
export function setPermissionMode(id: string, mode: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/sessions/${id}/permission-mode`, { method: 'POST', body: JSON.stringify({ mode }) })
}
```

- [ ] **Step 2: Create `PermissionModeMenu.tsx`**

```tsx
/**
 * Permission-posture picker for the status strip: the six CLI modes plus a
 * reset-to-global entry, hot-switched on a busy process and persisted as the
 * session's own default — the same lifecycle the model picker follows.
 *
 * @module dsh-cc/client/status/PermissionModeMenu
 */

import { useState, type ReactElement } from 'react'
import { IconChevronDownOutline14, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { setPermissionMode } from '../api/telemetry.ts'
import { PERMISSION_MODE_VALUES, type PermissionModeValue } from '../../types.ts'
import { registerCss } from '../css.ts'

registerCss('status-permission-menu', `
/* Rows stack a bold label over the one-line hint, like the model menu's rows. */
.cc-mode-row { display: flex; flex-direction: column; gap: 1px; min-width: 0; padding: 2px 0; }
.cc-mode-label { font: var(--dsw-font-xs-13); }
.cc-mode-hint { font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-tertiary); }
`)

/** Chinese label and one-line explanation for each posture. */
const MODE_META: Record<PermissionModeValue, { label: string; hint: string }> = {
  default: { label: '默认', hint: '危险操作每次询问' },
  acceptEdits: { label: '接受编辑', hint: '自动允许文件编辑' },
  plan: { label: '计划模式', hint: '先规划，不实际执行工具' },
  dontAsk: { label: '免打扰', hint: '不询问，未预先批准则拒绝' },
  bypassPermissions: { label: '跳过全部确认', hint: '自动允许一切，仅在可信目录使用' },
  auto: { label: '自动', hint: '由模型分类器决定允许与否' },
}

/** One mode's stacked menu-row label. */
function modeLabel(value: PermissionModeValue): ReactElement {
  return (
    <span className="cc-mode-row">
      <span className="cc-mode-label">{MODE_META[value].label}</span>
      <span className="cc-mode-hint">{MODE_META[value].hint}</span>
    </span>
  )
}

/**
 * Render the permission-posture picker.
 * @param props.sessionId - the session whose posture to mutate.
 * @param props.sessionMode - the session's own override; '' follows the global default.
 * @param props.configMode - the global default posture, shown when the session has no override.
 * @returns the picker control.
 */
export function PermissionModeMenu(props: { sessionId: string; sessionMode: string; configMode: string }): ReactElement {
  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | undefined>()
  const [mode, setMode] = useState(props.sessionMode)
  // Switching sessions must not leave the previous session's override on screen.
  const [lastSession, setLastSession] = useState(props.sessionId)
  if (lastSession !== props.sessionId) {
    setLastSession(props.sessionId)
    setMode(props.sessionMode)
  }
  const current = mode !== '' ? mode : props.configMode
  const labelText = `权限：${MODE_META[current as PermissionModeValue]?.label ?? current}`
  const items: MenuEntry[] = [
    { id: '', label: '跟随全局默认' },
    ...PERMISSION_MODE_VALUES.map(value => ({ id: value, label: modeLabel(value) })),
  ]
  return (
    <>
      <Menu
        open={open}
        anchor={
          <button
            type="button"
            className="cc-status-picker"
            title="权限模式（忙碌回合就地切换）"
            onClick={() => { setOpen(previous => !previous) }}
          >
            <span className="cc-status-picker-label">{labelText}</span>
            <IconChevronDownOutline14 />
          </button>
        }
        items={items}
        selectedId={mode}
        onSelect={id => {
          setOpen(false)
          const previousMode = mode
          setMode(id)
          setFailure(undefined)
          void setPermissionMode(props.sessionId, id).catch((cause: unknown) => {
            setMode(previousMode)
            setFailure(cause instanceof Error ? cause.message : String(cause))
          })
        }}
        onClose={() => { setOpen(false) }}
      />
      {failure !== undefined && <span className="cc-status-failure" role="status" title={failure}>切换失败</span>}
    </>
  )
}
```

Note: `.cc-status-picker` / `.cc-status-failure` are registered by `status-model-menu`; `ModelMenu` always co-mounts in the same strip, so the classes exist. Note this coupling in a comment above `registerCss`.

- [ ] **Step 3: Mount in `StatusBar.tsx`**

Props gain `sessionMode: string` and `configMode: string`; render `<PermissionModeMenu sessionId={props.sessionId} sessionMode={props.sessionMode} configMode={props.configMode} />` before `<ModelMenu …/>`; extend the JSDoc `@param` lines.

- [ ] **Step 4: Thread values in `App.tsx`**

```tsx
            <StatusBar
              sessionId={current.id}
              busy={current.status === 'busy'}
              sessionMode={current.permissionMode ?? ''}
              configMode={config?.permissionMode ?? 'auto'}
              context={context}
              usage={usage}
              fallbackCostUsd={current.totalCostUsd}
            />
```

- [ ] **Step 5: Typecheck, verify in the lab, commit**

Run: `pnpm typecheck && pnpm build` — Expected: pass. Reinstall/restart, open the page, then: picker shows `权限：自动`; open a session, pick `默认`; send a message that reads a file — a permission card appears; pick `自动` mid-turn — subsequent calls stop prompting. **The design's open verification point:** pick `跳过全部确认` on a BUSY turn — if the CLI refuses the hot switch (the spawn-time companion flag is absent), the picker rolls back; in that case record it in this plan's task note and keep the behavior (persisted value still applies at next spawn), escalating only if the refusal is silent. `GET /cc/api/sessions` shows the persisted `permissionMode`.
Run: `git add src/client && git commit -m "feat: permission-mode picker in the status strip"`

---

### Task 5: Engine — the task table

**Files:**
- Modify: `src/engine.ts`

**Interfaces:**
- Consumes: `TaskRow`, `TERMINAL_TASK_STATUSES` from `./types.ts`; the SDK's task system messages (narrowed by `subtype` in the `system` arm).
- Produces: `EngineHooks.tasks(rows: TaskRow[]): void`; `SessionEngine.taskRows(): TaskRow[]`; `SessionEngine.stopTask(taskId: string): Promise<void>`; `SessionEngine.backgroundTask(toolUseId: string): Promise<boolean>`.

- [ ] **Step 1: Hook + table + imports**

Add to the `./types.ts` import: `TaskRow, TERMINAL_TASK_STATUSES`. Add to `EngineHooks`:

```ts
  /** Publish the session's whole task table; display state, never persisted. */
  tasks(rows: TaskRow[]): void
```

Add the field and the two private methods to `SessionEngine`:

```ts
  /** The session's live task table in start order; display state only. */
  private readonly taskTable = new Map<string, TaskRow>()

  /** Broadcast the task-table snapshot through the host hook. */
  private publishTasks(): void {
    this.hooks.tasks([...this.taskTable.values()])
  }

  /** Drop terminal task rows; called when the next main turn starts. */
  private pruneSettledTasks(): void {
    let changed = false
    for (const [id, row] of [...this.taskTable]) {
      if ((TERMINAL_TASK_STATUSES as readonly string[]).includes(row.status)) {
        this.taskTable.delete(id)
        changed = true
      }
    }
    if (changed) this.publishTasks()
  }
```

- [ ] **Step 2: Fold the five frames — replace the `system` arm of `onMessage`**

```ts
      case 'system': {
        if (message.subtype === 'init') {
          // …existing init body unchanged…
          return
        }
        this.onTaskMessage(message)
        return
      }
```

```ts
  /**
   * Fold one task-lifecycle system message into the task table and publish
   * the whole table. Level semantics throughout: the table IS the state, and
   * the page replaces its copy with each snapshot — so a missed frame heals
   * on the next one and a mid-join page is repaired by the session detail.
   * @param message - the system message carrying a task subtype.
   */
  private onTaskMessage(message: Extract<SDKMessage, { type: 'system' }>): void {
    switch (message.subtype) {
      case 'task_started': {
        const previous = this.taskTable.get(message.task_id)
        this.taskTable.set(message.task_id, {
          id: message.task_id,
          type: message.task_type ?? (message.subagent_type !== undefined ? 'subagent' : 'task'),
          status: 'running',
          description: message.description,
          ...(message.tool_use_id !== undefined ? { toolUseId: message.tool_use_id } : {}),
          ...(message.subagent_type !== undefined ? { subagentType: message.subagent_type } : {}),
          ...(message.prompt !== undefined ? { prompt: message.prompt } : {}),
          tokens: previous?.tokens ?? 0,
          toolUses: previous?.toolUses ?? 0,
          durationMs: previous?.durationMs ?? 0,
          ...(previous?.summary !== undefined ? { summary: previous.summary } : {}),
          ...(previous?.isBackgrounded !== undefined ? { isBackgrounded: previous.isBackgrounded } : {}),
        })
        break
      }
      case 'task_progress': {
        const row = this.taskTable.get(message.task_id)
        if (row === undefined) break
        this.taskTable.set(message.task_id, {
          ...row,
          description: message.description,
          tokens: message.usage.total_tokens,
          toolUses: message.usage.tool_uses,
          durationMs: message.usage.duration_ms,
          ...(message.last_tool_name !== undefined ? { lastToolName: message.last_tool_name } : {}),
          ...(message.subagent_type !== undefined ? { subagentType: message.subagent_type } : {}),
          ...(message.summary !== undefined ? { summary: message.summary } : {}),
        })
        break
      }
      case 'task_updated': {
        const row = this.taskTable.get(message.task_id)
        if (row === undefined) break
        const patch = message.patch
        this.taskTable.set(message.task_id, {
          ...row,
          ...(patch.status !== undefined ? { status: patch.status === 'pending' ? 'running' : patch.status } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.error !== undefined ? { error: patch.error } : {}),
          ...(patch.is_backgrounded !== undefined ? { isBackgrounded: patch.is_backgrounded } : {}),
        })
        break
      }
      case 'task_notification': {
        const row = this.taskTable.get(message.task_id)
        this.taskTable.set(message.task_id, {
          id: message.task_id,
          type: row?.type ?? 'task',
          status: message.status,
          description: row?.description ?? message.summary,
          ...(row?.toolUseId !== undefined || message.tool_use_id !== undefined
            ? { toolUseId: row?.toolUseId ?? message.tool_use_id }
            : {}),
          ...(row?.subagentType !== undefined ? { subagentType: row.subagentType } : {}),
          ...(row?.prompt !== undefined ? { prompt: row.prompt } : {}),
          tokens: message.usage?.total_tokens ?? row?.tokens ?? 0,
          toolUses: message.usage?.tool_uses ?? row?.toolUses ?? 0,
          durationMs: message.usage?.duration_ms ?? row?.durationMs ?? 0,
          ...(row?.lastToolName !== undefined ? { lastToolName: row.lastToolName } : {}),
          summary: message.summary,
          ...(row?.isBackgrounded !== undefined ? { isBackgrounded: row.isBackgrounded } : {}),
        })
        break
      }
      case 'background_tasks_changed': {
        // Level signal: reconcile membership only. Rows are never created
        // here — a level for a task whose start frame was missed would
        // otherwise render a nameless ghost.
        for (const task of message.tasks) {
          const row = this.taskTable.get(task.task_id)
          if (row === undefined) continue
          this.taskTable.set(task.task_id, {
            ...row,
            isBackgrounded: true,
            ...(row.description === '' && task.description !== undefined ? { description: task.description } : {}),
          })
        }
        break
      }
      default:
        return
    }
    this.publishTasks()
  }
```

- [ ] **Step 3: Clear on turn start and on engine death**

In `onStreamEvent`'s `message_start` arm (the main-stream one — the parent-guard above it already returned subagent frames), add before the `delta` publish:

```ts
        // The next main turn clears the settled rows the previous turn left
        // for review; running rows (a backgrounded task) survive.
        this.pruneSettledTasks()
```

In `finish()`, first two lines become:

```ts
    this.busy = false
    this.queryEnded = true
    // Tasks are bound to the CLI process; the transcript cards survive it.
    this.taskTable.clear()
    this.publishTasks()
```

(`close()` needs no addition of its own: aborting ends the consume loop, which lands in `finish()`.)

- [ ] **Step 4: The read and control surface, beside `setModel`**

```ts
  /** The task table in start order; empty once the engine has ended. */
  taskRows(): TaskRow[] {
    return [...this.taskTable.values()]
  }

  /**
   * Stop one running task; the CLI settles it with a `task_notification`
   * whose status is `stopped`.
   * @param taskId - the task id from the table.
   */
  async stopTask(taskId: string): Promise<void> {
    this.lastUsed = Date.now()
    await this.query?.stopTask(taskId)
  }

  /**
   * Background the foreground task one tool call started — the control-call
   * equivalent of the CLI's Ctrl+B.
   * @param toolUseId - the tool_use id that started the task.
   * @returns whether anything was backgrounded.
   */
  async backgroundTask(toolUseId: string): Promise<boolean> {
    this.lastUsed = Date.now()
    const q = this.query
    if (q === undefined) return false
    return await q.backgroundTasks(toolUseId)
  }
```

- [ ] **Step 5: Typecheck and commit**

`SILENT_HOOKS` in `src/runtime.ts` must gain `tasks: () => {},` for the typecheck to pass — include it in this commit. Run `pnpm typecheck` — Expected: pass.
Run: `git add src/engine.ts src/runtime.ts && git commit -m "feat: engine folds the CLI task protocol into a live task table"`

---

### Task 6: Runtime — `tasks` frame, session detail, control routes

**Files:**
- Modify: `src/runtime.ts`

**Interfaces:**
- Consumes: `EngineHooks.tasks`, `taskRows()`, `stopTask()`, `backgroundTask()`, `TERMINAL_TASK_STATUSES`, `TaskRow`.
- Produces: SSE frame `{ t: 'tasks', sessionId, tasks }`; `GET /sessions/:id` response gains `tasks: TaskRow[]`; `POST /cc/api/sessions/:id/tasks/:taskId/stop`; `POST /cc/api/sessions/:id/tasks/:taskId/background`.

- [ ] **Step 1: Broadcast in `hooks()` and the snapshot helper**

Add `TaskRow, TERMINAL_TASK_STATUSES` to the types import. In `hooks(sessionId)`:

```ts
      tasks: rows => {
        this.broadcast({ t: 'tasks', sessionId, tasks: rows })
      },
```

Add the helper beside `liveSnapshot`:

```ts
  /**
   * One session's live task table, read off its engine. No engine — cold,
   * evicted, or terminal-owned — means an empty table, which is also the
   * truth: those tasks died with their process.
   * @param sessionId - the session to read.
   * @returns the rows in start order.
   */
  private taskSnapshot(sessionId: string): TaskRow[] {
    return this.liveEngine(sessionId)?.taskRows() ?? []
  }
```

- [ ] **Step 2: Session detail carries the table**

In the `parts.length === 2 && method === 'GET'` session route:

```ts
          return json(res, {
            session,
            events: await this.catalog.transcript(session),
            live: this.liveSnapshot(session.id),
            tasks: this.taskSnapshot(session.id),
          })
```

- [ ] **Step 3: The control routes**

Register inside the sessions block (after the `stop` route):

```ts
        if (parts.length === 5 && parts[2] === 'tasks' && method === 'POST') {
          return await this.controlTask(id, parts[3] ?? '', parts[4] ?? '', res)
        }
```

And the handler (beside `answerPermission`):

```ts
  /**
   * Stop or background one task of one session's live engine.
   * @param id - the session id.
   * @param taskId - the task id from the table.
   * @param action - `stop` or `background`.
   * @param res - the response to write.
   */
  private async controlTask(id: string, taskId: string, action: string, res: ServerResponse): Promise<void> {
    const engine = this.liveEngine(id)
    if (engine === undefined) return json(res, { error: '会话没有正在运行的进程' }, 409)
    const row = engine.taskRows().find(task => task.id === taskId)
    if (row === undefined) return json(res, { error: '任务不存在' }, 404)
    if (action === 'stop') {
      if ((TERMINAL_TASK_STATUSES as readonly string[]).includes(row.status)) {
        return json(res, { error: '任务已结束' }, 409)
      }
      await engine.stopTask(taskId)
      return json(res, { ok: true })
    }
    if (action === 'background') {
      if (row.toolUseId === undefined) return json(res, { error: '该任务没有对应的工具调用' }, 409)
      const backgrounded = await engine.backgroundTask(row.toolUseId)
      if (!backgrounded) return json(res, { error: '该任务不在前台运行' }, 409)
      return json(res, { ok: true })
    }
    return json(res, { error: '未知操作' }, 400)
  }
```

- [ ] **Step 4: Typecheck, verify live, commit**

Run: `pnpm typecheck && pnpm build` — Expected: pass. Reinstall/restart the lab; in the page, run a prompt that spawns a subagent (e.g. 「用 Task 派一个 Explore 子代理数一下 src 下有多少个 ts 文件」). While it runs:

```sh
node scripts/sse-capture.mjs /tmp/tasks.jsonl 15000 3090
grep '"t":"tasks"' /tmp/tasks.jsonl | tail -3
curl -s localhost:3090/cc/api/sessions/$SID | python -c "import sys,json;d=json.load(sys.stdin);print(d['tasks'])"
```

Expected: `tasks` frames arrive with a `subagent` row whose tokens/duration advance; session detail shows the same rows. Then `curl -X POST .../tasks/<taskId>/stop` → the row settles `stopped`; a second POST returns 409.
Run: `git add src/runtime.ts && git commit -m "feat: tasks SSE frame, session-detail snapshot, stop/background routes"`

---

### Task 7: Client — TaskPanel and SSE wiring

**Files:**
- Create: `src/client/TaskPanel.tsx`
- Modify: `src/client/api/sessions.ts`, `src/client/App.tsx`

**Interfaces:**
- Consumes: `TaskRow`, the `tasks` SSE frame, the two control routes, `fetchSession().tasks`.
- Produces: `stopTask(id, taskId)` / `backgroundTask(id, taskId)` API fns; `TaskPanel(props: { tasks: TaskRow[]; onStop(id: string): void; onBackground(id: string): void })`.

- [ ] **Step 1: API functions and fetch type in `sessions.ts`**

Extend `fetchSession`'s return to include `tasks: TaskRow[]` (add `TaskRow` to the types import), and append:

```ts
/**
 * POST /sessions/:id/tasks/:taskId/stop — stop one running task.
 * @param id - session id.
 * @param taskId - the task id from the panel's row.
 * @returns the acknowledgement.
 */
export function stopTask(id: string, taskId: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/sessions/${id}/tasks/${taskId}/stop`, { method: 'POST' })
}

/**
 * POST /sessions/:id/tasks/:taskId/background — background one foreground task.
 * @param id - session id.
 * @param taskId - the task id from the panel's row.
 * @returns the acknowledgement.
 */
export function backgroundTask(id: string, taskId: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/sessions/${id}/tasks/${taskId}/background`, { method: 'POST' })
}
```

- [ ] **Step 2: Create `TaskPanel.tsx`**

```tsx
/**
 * The bottom task panel: every task the session's CLI process is running —
 * subagents, backgrounded commands, monitors, workflows — as snapshot rows
 * off the `tasks` SSE frame, with stop and background controls.
 *
 * @module dsh-cc/client/TaskPanel
 */

import { useState, type ReactElement } from 'react'
import { Button, DisclosureRow, IconCheckOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { registerCss } from './css.ts'
import { compact } from './status/format.ts'
import type { TaskRow } from '../types.ts'

registerCss('task-panel', `
.cc-tasks { border-top: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); font: var(--dsw-font-xxs-12); }
.cc-tasks-body { padding: 2px 20px 8px; }
.cc-task-row { display: flex; align-items: center; gap: 10px; padding: 3px 0; color: var(--dsw-alias-label-secondary); }
.cc-task-row[data-terminal='true'] { color: var(--dsw-alias-label-caption); }
.cc-task-badge {
  flex: none; padding: 1px 7px; border-radius: 999px;
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-secondary);
}
.cc-task-desc { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cc-task-meta { flex: none; color: var(--dsw-alias-label-caption); }
.cc-task-actions { flex: none; display: flex; gap: 6px; }
.cc-task-row { cursor: pointer; }
.cc-task-detail { padding: 0 0 4px 22px; display: flex; flex-direction: column; gap: 1px; }
.cc-task-detail-line {
  color: var(--dsw-alias-label-caption);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cc-task-spin {
  flex: none; width: 12px; height: 12px; border-radius: 50%;
  border: 1.5px solid var(--dsw-alias-label-caption); border-top-color: transparent;
  animation: cc-task-rotate 0.8s linear infinite;
}
@keyframes cc-task-rotate { to { transform: rotate(360deg); } }
`)

/** Chinese badge per task discriminant; unknown types fall back to the raw tag. */
const TYPE_BADGES: Record<string, string> = {
  subagent: '子代理', shell: '命令', bash: '命令', monitor: '监视', workflow: '工作流', task: '任务',
}

/**
 * The row's badge: the subagent preset outranks the raw discriminant.
 * @param row - the task row.
 * @returns the badge text.
 */
function badgeFor(row: TaskRow): string {
  if (row.subagentType !== undefined) return `子代理 ${row.subagentType}`
  return TYPE_BADGES[row.type] ?? row.type
}

/**
 * One task row's glyph.
 * @param status - the row status.
 * @returns the glyph element, or null for terminal-but-unremarkable states.
 */
function glyphFor(status: TaskRow['status']): ReactElement | null {
  if (status === 'completed') return <IconCheckOutline14 />
  if (status === 'running' || status === 'paused') return <span className="cc-task-spin" aria-hidden />
  return null
}

/**
 * Format a running duration.
 * @param ms - the duration in milliseconds.
 * @returns e.g. `1:07`.
 */
function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * Render the task panel; nothing at all when the table is empty.
 * @param props.tasks - the session's task snapshot.
 * @param props.onStop - stop one task by id.
 * @param props.onBackground - background one task by id.
 * @returns the panel, or null.
 */
export function TaskPanel(props: { tasks: TaskRow[]; onStop(id: string): void; onBackground(id: string): void }): ReactElement | null {
  const [open, setOpen] = useState(true)
  const [expanded, setExpanded] = useState<string | undefined>()
  if (props.tasks.length === 0) return null
  const running = props.tasks.filter(task => task.status === 'running' || task.status === 'paused').length
  return (
    <div className="cc-tasks">
      <DisclosureRow
        titleClassName="cc-tasks"
        title={`任务（${running} 运行中 / ${props.tasks.length}）`}
        open={open}
        expandable
        expandOnRowClick
        onToggle={() => setOpen(value => !value)}
      >
        <div className="cc-tasks-body">
          {props.tasks.map(task => {
            const terminal = task.status !== 'running' && task.status !== 'paused'
            const detail = expanded === task.id
            return (
              <div key={task.id}>
                <div
                  className="cc-task-row"
                  data-terminal={terminal}
                  title="点击展开详情"
                  onClick={() => { setExpanded(previous => previous === task.id ? undefined : task.id) }}
                >
                  <span aria-hidden>{glyphFor(task.status)}</span>
                  <span className="cc-task-badge">{badgeFor(task)}</span>
                  <span className="cc-task-desc">{task.description}</span>
                  <span className="cc-task-meta">
                    {compact(task.tokens)} · {duration(task.durationMs)}
                    {task.lastToolName !== undefined ? ` · ${task.lastToolName}` : ''}
                  </span>
                  {!terminal && (
                    <span className="cc-task-actions">
                      <Button size="sm" onClick={() => props.onBackground(task.id)}>转后台</Button>
                      <Button size="sm" onClick={() => props.onStop(task.id)}>结束</Button>
                    </span>
                  )}
                </div>
                {detail && (
                  <div className="cc-task-detail">
                    {task.prompt !== undefined && task.prompt !== '' && (
                      <div className="cc-task-detail-line" title={task.prompt}>任务：{task.prompt}</div>
                    )}
                    {task.summary !== undefined && task.summary !== '' && (
                      <div className="cc-task-detail-line">摘要：{task.summary}</div>
                    )}
                    {task.error !== undefined && task.error !== '' && (
                      <div className="cc-task-detail-line">错误：{task.error}</div>
                    )}
                    <div className="cc-task-detail-line">
                      工具调用 {task.toolUses} 次 · 状态 {task.status}
                      {task.isBackgrounded === true ? ' · 已转后台' : ''}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </DisclosureRow>
    </div>
  )
}
```

(`compact` is already exported by `src/client/status/format.ts` — verify the import path with typecheck; if the export is absent, inline `tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'K' : String(tokens)`.)

- [ ] **Step 3: Wire into `App.tsx`**

State: `const [tasksBySession, setTasksBySession] = useState<Record<string, TaskRow[]>>({})` (import `TaskRow`).

In the SSE switch, a new case before `default`:

```ts
        case 'tasks':
          setTasksBySession(previous => ({ ...previous, [message.sessionId]: message.tasks }))
          break
```

In the `sessions` frame's cleanup (beside the `eventsBySession` prune), drop dead sessions' tables:

```ts
          setTasksBySession(previous => {
            const alive = new Set(message.sessions.map(session => session.id))
            let changed = false
            const next = { ...previous }
            for (const id of Object.keys(next)) {
              if (!alive.has(id)) {
                delete next[id]
                changed = true
              }
            }
            return changed ? next : previous
          })
```

In the `currentId` effect and in `scheduleLiveCatchUp`'s fetch handler, seed from the snapshot: `setTasksBySession(previous => ({ ...previous, [id]: result.tasks }))`.

Render, between the `cc-scroll` div and the Composer:

```tsx
                <TaskPanel
                  tasks={tasksBySession[current.id] ?? []}
                  onStop={taskId => { stopTask(current.id, taskId).catch(fail) }}
                  onBackground={taskId => { backgroundTask(current.id, taskId).catch(fail) }}
                />
```

(extend the `api/sessions.ts` import with `stopTask, backgroundTask`).

- [ ] **Step 4: Typecheck, verify in the lab, commit**

Run: `pnpm typecheck && pnpm build` — Expected: pass. Lab: run the subagent prompt; the panel appears under the transcript with ticking meta; 「结束」settles the row; 「转后台」on a long Bash resumes the turn immediately; the settled rows clear when the next turn starts; a mid-run page refresh rebuilds the panel.
Run: `git add src/client && git commit -m "feat: bottom task panel with stop and background controls"`

---

### Task 8: Client — the TODO pin

**Files:**
- Create: `src/client/TodoPin.tsx`
- Modify: `src/client/App.tsx`

**Interfaces:**
- Consumes: `CcEvent[]`, `todoCard`/`TodoList` from `./tool/TodoList.tsx`.
- Produces: `currentTodos(events): TodoItem[] | undefined`; `TodoPin(props: { events: CcEvent[] })`.

- [ ] **Step 1: Create `TodoPin.tsx`**

```tsx
/**
 * The pinned current-TODO panel above the composer: the session's live
 * checklist, derived from the last committed TodoWrite in the transcript, so
 * the plan stays visible while typing instead of scrolling away in history.
 * The transcript keeps its own TodoWrite cards; this is the current-state
 * readout, so nothing here is persisted beyond the transcript itself.
 *
 * @module dsh-cc/client/TodoPin
 */

import { useMemo, useState, type ReactElement } from 'react'
import { DisclosureRow } from '@deepseek-ai/dsh-client-ui-primitives'
import { registerCss } from './css.ts'
import { TodoList, todoCard, type TodoItem } from './tool/TodoList.tsx'
import type { CcEvent } from '../types.ts'

registerCss('todo-pin', `
.cc-todopin { padding: 4px 20px 0; border-top: 1px solid var(--dsw-alias-border-l2); font: var(--dsw-font-xxs-12); }
.cc-todopin-title { color: var(--dsw-alias-label-secondary); }
`)

/**
 * Derive the session's current checklist from its transcript tail: the last
 * committed TodoWrite wins, and an unparsable or emptied list clears the pin.
 * @param events - the transcript, in order.
 * @returns the items, or undefined when no usable list exists.
 */
export function currentTodos(events: readonly CcEvent[]): TodoItem[] | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event.kind !== 'tool_use' || event.name !== 'TodoWrite') continue
    return todoCard(event.input)?.items
  }
  return undefined
}

/**
 * Render the pinned checklist; nothing when the session has no live list.
 * @param props.events - the session's transcript.
 * @returns the pin, or null.
 */
export function TodoPin(props: { events: CcEvent[] }): ReactElement | null {
  const items = useMemo(() => currentTodos(props.events), [props.events])
  const [open, setOpen] = useState(true)
  if (items === undefined) return null
  const done = items.filter(item => item.status === 'completed').length
  return (
    <div className="cc-todopin">
      <DisclosureRow
        titleClassName="cc-todopin-title"
        title={`任务清单 ${done}/${items.length}`}
        open={open}
        expandable
        expandOnRowClick
        onToggle={() => setOpen(value => !value)}
      >
        <TodoList items={items} />
      </DisclosureRow>
    </div>
  )
}
```

- [ ] **Step 2: Mount in `App.tsx`** — after `<TaskPanel …/>`, before `<Composer …/>`:

```tsx
                <TodoPin key={current.id} events={events} />
```

- [ ] **Step 3: Typecheck, verify in the lab, commit**

Run: `pnpm typecheck && pnpm build` — Expected: pass. Lab: ask the model to「用 TodoWrite 建一个三步清单，逐步完成」— the pin appears above the composer and its checkmarks advance as TodoWrites commit; switching sessions swaps pins; a cleared list hides it; reload restores it from the transcript.
Run: `git add src/client && git commit -m "feat: pinned current-TODO panel above the composer"`

---

### Task 9: Node — the file-content endpoint

**Files:**
- Modify: `src/http-support.ts`, `src/runtime.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `readTextFile(pathname: string): Promise<FileContent>` where `FileContent = { path: string; content: string; truncated: boolean }`; `GET /cc/api/fs/file?path=` responding `{ file: FileContent }`.

- [ ] **Step 1: The reader in `http-support.ts`**

Extend the imports: `import { open, stat } from 'node:fs/promises'` (merging with the existing `readdir` import) and add `type FileContent` — no, `FileContent` is defined here; just add the code after `readDirListing`:

```ts
/** Largest file the viewer reads; bigger files deliver their head only. */
const MAX_FILE_BYTES = 2 * 1024 * 1024

/** One text file as the page viewer renders it. */
export interface FileContent {
  path: string
  content: string
  /** True when only the head of an oversized file was read. */
  truncated: boolean
}

/**
 * Read one text file for the viewer. A NUL byte in the head marks a binary
 * file and is refused rather than rendered; an oversized file is cut to its
 * head with the flag set so the viewer can say so.
 * @param pathname - the file to read.
 * @returns the content descriptor.
 * @throws when the path is empty, missing, unreadable, or not a text file.
 */
export async function readTextFile(pathname: string): Promise<FileContent> {
  const file = resolve(pathname.trim())
  if (file === '') throw new Error('未指定文件')
  const info = await stat(file).catch(() => {
    throw new Error('文件不存在或不可访问')
  })
  if (!info.isFile()) throw new Error('不是文件')
  const truncated = info.size > MAX_FILE_BYTES
  const size = truncated ? MAX_FILE_BYTES : info.size
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(size)
    await handle.read(buffer, 0, size, 0)
    if (buffer.includes(0)) throw new Error('不是文本文件')
    return { path: file, content: buffer.toString('utf8'), truncated }
  } finally {
    await handle.close()
  }
}
```

- [ ] **Step 2: The route in `runtime.ts`** (beside the `fs/list` route; import `readTextFile`):

```ts
      if (parts[0] === 'fs' && parts[1] === 'file' && parts.length === 2 && method === 'GET') {
        const path = url.searchParams.get('path')
        if (path === null || path.trim() === '') return json(res, { error: '缺少 path 参数' }, 400)
        try {
          return json(res, { file: await readTextFile(path) })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return json(res, { error: `无法读取文件：${message}` }, 404)
        }
      }
```

- [ ] **Step 3: Typecheck, verify with curl, commit**

Run: `pnpm typecheck && pnpm build` — Expected: pass. Lab:

```sh
curl -s "localhost:3090/cc/api/fs/file?path=C:/PythonProject/dev/dsh-cc/src/types.ts" | head -c 200
curl -s "localhost:3090/cc/api/fs/file?path=C:/PythonProject/dev/dsh-cc/missing.ts"     # 404
curl -s "localhost:3090/cc/api/fs/file?path=C:/PythonProject/dev/dsh-cc/lib/client.js" | python -c "import sys,json;print(len(json.load(sys.stdin)['file']['content']))"
```

Expected: the file head; the 404; a length ≤ 2097152.
Run: `git add src/http-support.ts src/runtime.ts && git commit -m "feat: GET /fs/file for the page file viewer"`

---

### Task 10: Client — file mentions and the viewer

**Files:**
- Create: `src/client/file-mentions.ts`, `src/client/api/fs.ts`, `src/client/FileViewer.tsx`
- Modify: `src/client/Transcript.tsx`

**Interfaces:**
- Consumes: `GET /fs/file`, `MarkdownText`'s `fileMentions` prop, `ReadBlock`, `Modal`, `langFromPath`, `useOverlay`.
- Produces: `fetchFile(path)`; `fileMentionsFor(cwd, open): MarkdownFileMentions`; `FileViewer(props: { path: string; onClose(): void })`.

- [ ] **Step 1: `api/fs.ts`**

```ts
/**
 * Filesystem read endpoints for the page: the file viewer's content read.
 *
 * @module dsh-cc/client/api/fs
 */

import { api } from './http.ts'

/** One text file as the viewer renders it. */
export interface FileContentDto {
  path: string
  content: string
  /** True when only the head of an oversized file was read. */
  truncated: boolean
}

/**
 * GET /fs/file?path= — the file's latest content, read from disk at request
 * time rather than from the transcript, so the view shows what is there now.
 * @param path - absolute file path.
 * @returns the content descriptor.
 */
export function fetchFile(path: string): Promise<{ file: FileContentDto }> {
  return api<{ file: FileContentDto }>(`/fs/file?path=${encodeURIComponent(path)}`)
}
```

- [ ] **Step 2: `file-mentions.ts`**

```ts
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
```

- [ ] **Step 3: `FileViewer.tsx`**

```tsx
/**
 * The click-through file viewer: a modal that fetches the file's latest
 * content from disk and renders it as a line-numbered, syntax-highlighted
 * ReadBlock — the same surface the Read card draws.
 *
 * @module dsh-cc/client/FileViewer
 */

import { useEffect, useState, type ReactElement } from 'react'
import { Modal, ReadBlock, type ReadBlockLine } from '@deepseek-ai/dsh-client-ui-primitives'
import { fetchFile } from './api/fs.ts'
import { useOverlay } from './overlay.ts'
import { registerCss } from './css.ts'
import { langFromPath } from './tool/wire.ts'

registerCss('file-viewer', `
.cc-fileviewer { display: flex; flex-direction: column; min-height: 120px; max-height: 70vh; }
.cc-fileviewer-note { padding: 16px 0; font: var(--dsw-font-xs-13); color: var(--dsw-alias-label-secondary); text-align: center; }
`)

/** The viewer's fetch states. */
type ViewState =
  | { phase: 'loading' }
  | { phase: 'ready'; lines: ReadBlockLine[]; totalLines: number; truncated: boolean; lang: string | undefined }
  | { phase: 'failed'; message: string }

/**
 * Render the file viewer modal.
 * @param props.path - the absolute path to display.
 * @param props.onClose - the close callback.
 * @returns the modal node.
 */
export function FileViewer(props: { path: string; onClose(): void }): ReactElement {
  const [state, setState] = useState<ViewState>({ phase: 'loading' })
  // Register with the surface's overlay signal so Escape closes the modal,
  // not the whole Claude Code surface under it.
  useOverlay(true)
  useEffect(() => {
    let stale = false
    setState({ phase: 'loading' })
    fetchFile(props.path)
      .then(result => {
        if (stale) return
        const body = result.file.content.endsWith('\n')
          ? result.file.content.slice(0, -1)
          : result.file.content
        const rows = body === '' ? [] : body.split('\n')
        setState({
          phase: 'ready',
          lines: rows.map((text, index) => ({ number: index + 1, text })),
          totalLines: rows.length,
          truncated: result.file.truncated,
          lang: langFromPath(result.file.path),
        })
      })
      .catch(cause => {
        if (!stale) setState({ phase: 'failed', message: cause instanceof Error ? cause.message : String(cause) })
      })
    return () => {
      stale = true
    }
  }, [props.path])
  return (
    <Modal
      open
      onClose={props.onClose}
      title={props.path}
      closeLabel="关闭文件"
      contentClassName="cc-fileviewer"
      description={state.phase === 'ready' && state.truncated ? '文件超过 2MB，仅显示开头部分' : undefined}
    >
      {state.phase === 'loading' && <div className="cc-fileviewer-note">读取中…</div>}
      {state.phase === 'failed' && <div className="cc-fileviewer-note">{state.message}</div>}
      {state.phase === 'ready' && (
        <ReadBlock lines={state.lines} totalLines={state.totalLines} lang={state.lang} maxLines={400} />
      )}
    </Modal>
  )
}
```

- [ ] **Step 4: Wire into `Transcript.tsx`**

`EventItem` gains `cwd: string | undefined` and `mentions: MarkdownFileMentions` props (type imported from the primitives); the assistant case becomes `<MarkdownText text={event.text} fileMentions={props.mentions} />`. `Transcript` holds the viewer:

```tsx
  const [viewPath, setViewPath] = useState<string | undefined>()
  const mentions = useMemo(() => fileMentionsFor(cwd, setViewPath), [cwd])
```

pass both into every `EventItem`, and after the items list:

```tsx
      {viewPath !== undefined && <FileViewer path={viewPath} onClose={() => setViewPath(undefined)} />}
```

- [ ] **Step 5: Typecheck, verify in the lab, commit**

Run: `pnpm typecheck && pnpm build` — Expected: pass. Lab: ask the model to「在回复里用反引号提到 src/types.ts 和一个不存在的路径」; after the turn settles, `src/types.ts` renders as a link — click opens the modal with highlighted content; the missing path opens the error state; Escape/「关闭」closes it without closing the surface; editing the file on disk and reopening shows the new content.
Run: `git add src/client && git commit -m "feat: click-through file viewer with syntax highlighting"`

---

### Task 11: README and docs

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: documentation.

- [ ] **Step 1: Update the feature list** — add bullets: 权限模式会话级热切换（状态栏菜单，持久化为会话默认）；底部任务面板（子代理/命令/监视/工作流的实时进度、「结束」「转后台」控制）；输入框上方固定当前任务清单（TODO 面板）；对话文本中的文件路径可点击查看最新内容（行号 + 语法高亮）。
- [ ] **Step 2: Extend the HTTP API table** — the count line becomes 28 method-path pairs; add:

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /cc/api/sessions/:id/permission-mode | 切换权限模式；持久化为该会话默认，忙碌引擎就地热切换 |
| POST | /cc/api/sessions/:id/tasks/:taskId/stop | 结束一个运行中的任务（子代理/命令等） |
| POST | /cc/api/sessions/:id/tasks/:taskId/background | 把前台任务转后台继续跑（CLI 的 Ctrl+B 等价物） |
| GET | /cc/api/fs/file?path= | 读取文本文件最新内容（≤2MB，超出截断；二进制拒绝） |

Also: `GET /sessions/:id` row gains 「+ 任务表快照」; `/cc/api/events` row's frame list gains `tasks`; 已知限制 section — note that file mentions apply to settled text only.

- [ ] **Step 3: Commit**

Run: `git add README.md && git commit -m "docs: permission-mode switch, task panel, TODO pin, file viewer"`
