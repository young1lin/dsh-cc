# Terminal Session Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mtime-recency guess for "a CLI terminal is driving this session" with the CLI's own live-process registry, so the web page knows exactly which sessions another live `claude` process holds open — and stays read-only for them.

**Architecture:** The CLI writes one JSON file per live top-level process under `~/.claude/sessions/<pid>.json` (this is what `claude ps` reads; it is stable surface). dsh-cc reads that directory on its existing 2-second native-store rescan, derives a `terminalOwned` flag per session in the catalog merge, and broadcasts it on the existing `sessions` SSE frame. Busy detection stays mtime-based but is suppressed when the file is fresh yet no live writer exists (crashed process). The browser gates the composer read-only on `terminalOwned`.

**Tech Stack:** TypeScript (Node + React), `@anthropic-ai/claude-agent-sdk` 0.3.220 (unchanged), no new dependencies.

**Spec:** This document is the spec. Background investigation lives in the conversation of 2026-08-24; facts referenced here were verified live on this machine (Windows 11, claude 2.1.241, dsh 0.1.1-rc.2).

## Global Constraints

- **Read-only consumption of `~/.claude/sessions/`.** Never write, never delete, never connect to the `messagingSocketPath` named pipe advertised in those files — that is a private, PAKE-authenticated peer protocol (no docs, no stability promise, per-version churn). We read the JSON files only.
- **No cross-process interrupt.** Do not attempt to stop a turn owned by another process: Windows cannot deliver Ctrl+C to another console's process, and `TerminateProcess` is a kill, not a graceful stop. The page is read-only for terminal-owned sessions; that is the entire control model.
- **Do not touch** the CLI's `*.key` files in that directory (peer-auth secrets).
- House style: 2-space indent, JSDoc on every exported function with `@param`/`@returns`, single quotes, no default exports. Match the surrounding files.
- No test framework exists in this repo (`package.json` scripts: `clean`, `typecheck`, `build`, `watch`). The verification loop per task is `pnpm typecheck` + the concrete live checks given in each task. Do not add a test framework for this.
- One instance of dsh web for verification runs on port **3090** (`dsh --profile web --no-open --port 3090`, started from Git Bash — PowerShell `Start-Process` cannot run the npm shim). The user's own instance on **3080** must not be killed without checking `GET /cc/api/sessions` shows zero busy sessions first. API base is `/cc/api`.
- Sessions in `~/.claude/sessions` may be owned by processes on this machine only. `CLAUDE_CONFIG_DIR` overrides the registry location (same env the CLI honors).

## Current State (what exists today)

- `src/native-sessions.ts` — `toSessionMeta()` sets `status: Date.now() - info.lastModified < RECENT_WRITE_MS ? 'busy' : 'idle'` with `RECENT_WRITE_MS = 15_000`. This is the guess being replaced.
- `src/catalog.ts` — `SessionCatalog.refresh(): Promise<boolean>` re-reads the native store every call, fingerprints `id/updatedAt/status`, returns whether anything changed; `src/runtime.ts` rescans every 2 s and broadcasts the `sessions` SSE frame on change.
- `src/client/App.tsx` — composer currently gated by `foreignBusy={current.status === 'busy' && current.origin === 'cli'}`; `src/client/Composer.tsx` accepts `foreignBusy?: boolean` and renders the read-only state.
- `src/types.ts` — `SessionMeta` carries `origin: 'dsh-cc' | 'cli'` (web-created vs discovered-native). Web-created sessions that ran turns are merged with sidecar operational fields winning (`mergeNativeInto` copies only `summary`, `gitBranch`, `updatedAt` from the native record — important: fields set on the native record do NOT leak into the merged sidecar row).

## File Structure

- Create: `src/peer-sessions.ts` — reads the CLI PID registry; one responsibility, no React, no SDK imports.
- Modify: `src/types.ts` — add the `terminalOwned?: boolean` field to `SessionMeta`.
- Modify: `src/catalog.ts` — merge step sets `terminalOwned` and suppresses stale busy.
- Modify: `src/client/App.tsx` + `src/client/Composer.tsx` — gate on the new flag (rename `foreignBusy` → `readOnly`).
- Modify: `src/client/SessionRail.tsx` — row tooltip for terminal-owned sessions.

---

### Task 1: The peer registry reader

**Files:**
- Create: `src/peer-sessions.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `readPeerSessions(): Promise<Map<string, PeerSession>>` keyed by native session id, and `interface PeerSession { pid: number; sessionId: string; cwd: string; kind: string }`.

- [ ] **Step 1: Write the module**

```ts
/**
 * Read-only view of the CLI's live-process registry: the
 * `~/.claude/sessions/<pid>.json` file every top-level claude process
 * writes at startup and unlinks on clean exit, so `claude ps` can enumerate
 * everything the user is running. Treat this directory as an observation
 * deck only — the `messagingSocketPath` advertised inside each file is a
 * private, PAKE-authenticated peer protocol with no stability promise, and
 * the sibling `*.key` files are its secrets; neither is ours to touch.
 *
 * @module dsh-cc/peer-sessions
 */

import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** One live CLI process currently holding a session open. */
export interface PeerSession {
  pid: number
  sessionId: string
  cwd: string
  kind: string
}

/** The registry directory, honoring the same env override the CLI does. */
function sessionsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'sessions')
}

/**
 * Liveness probe: signal zero throws exactly when the pid is gone. EPERM
 * means the process exists but belongs to another user — still alive.
 * @param pid - the process id from a registry file.
 * @returns whether the process is running right now.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Every live CLI peer, keyed by the native session id it holds open.
 *
 * A dead process's stale file (crash, `kill -9`) contributes nothing, which
 * is what lets the catalog tell "a writer is still attached" from "the
 * transcript just happens to be fresh". When several processes hold the
 * same session (a resumed terminal plus a headless run), the last live
 * one read wins — callers only ask whether ANY live writer exists.
 * @returns the live peers; an empty map when the registry is absent or
 *   unreadable, which means nothing is terminal-owned.
 */
export async function readPeerSessions(): Promise<Map<string, PeerSession>> {
  const peers = new Map<string, PeerSession>()
  let names: string[]
  try {
    names = await readdir(sessionsDir())
  } catch {
    return peers
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue // Skip the *.key peer-auth secrets.
    try {
      const raw = JSON.parse(await readFile(join(sessionsDir(), name), 'utf8')) as Partial<PeerSession>
      if (typeof raw.pid !== 'number' || typeof raw.sessionId !== 'string') continue
      if (!isAlive(raw.pid)) continue
      peers.set(raw.sessionId, {
        pid: raw.pid,
        sessionId: raw.sessionId,
        cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
        kind: typeof raw.kind === 'string' ? raw.kind : '',
      })
    } catch {
      // Malformed or mid-rewrite entry: not a peer we can act on.
    }
  }
  return peers
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 3: Smoke-test against the live registry**

Nothing imports the module yet after this task, so test it directly (from the repo root, Git Bash; a `claude` REPL is open somewhere — at minimum, the session implementing this plan has registered):

```bash
npx tsx -e "import { readPeerSessions } from './src/peer-sessions.ts'; readPeerSessions().then(m => { console.log('peers:', m.size); for (const [id, p] of m) console.log(id, p.pid, p.kind, p.cwd) })"
```

Expected: at least one peer — including the pid of any open terminal REPL (cross-check: `ls ~/.claude/sessions/*.json` and compare). Note: the session implementing this plan has its own process registered; do not disturb it.

- [ ] **Step 4: Commit**

```bash
git add src/peer-sessions.ts
git commit -m "feat: read the CLI live-process registry for session ownership"
```

---

### Task 2: Ownership in the catalog merge

**Files:**
- Modify: `src/types.ts` (inside `interface SessionMeta`, after `gitBranch?: string`)
- Modify: `src/catalog.ts` (`refresh()`, and the import block)

**Interfaces:**
- Consumes: `readPeerSessions` / `PeerSession` from Task 1.
- Produces: `SessionMeta.terminalOwned?: boolean` on the wire (rides the existing `sessions` SSE frame and `GET /cc/api/sessions` unchanged — `SessionMeta` is the shared contract type).

- [ ] **Step 1: Add the field to the contract**

In `src/types.ts`, inside `interface SessionMeta` after the `gitBranch` field:

```ts
  /**
   * A live CLI process (terminal REPL, `claude -p`, another SDK client)
   * currently holds this session open, per the `~/.claude/sessions`
   * registry. The page is read-only for such a session: the other process
   * is a concurrent writer, and no signal of ours can reach its turn.
   */
  terminalOwned?: boolean
```

- [ ] **Step 2: Derive it in refresh()**

In `src/catalog.ts`: add `import { readPeerSessions } from './peer-sessions.ts'`, then rewrite `refresh()` as:

```ts
  /**
   * Re-read the CLI's session store across every project directory and the
   * live-process registry alongside it.
   *
   * A failure here is not fatal: the CLI store may be absent on a machine
   * that has only ever run Claude Code through this page, and the sidecar
   * alone still serves a working list.
   * @returns whether anything native changed — a moved `updatedAt`, a
   *   flipped status, or a changed ownership — so a poller can skip
   *   broadcasting a quiet store.
   */
  async refresh(): Promise<boolean> {
    let fresh: SessionMeta[]
    let peers: Map<string, PeerSession>
    try {
      ;[fresh, peers] = await Promise.all([listNativeSessions(), readPeerSessions()])
    } catch {
      // No readable CLI store: the sidecar list stands on its own.
      return false
    }
    // Sessions the sidecar adopted are driven by this page's own engines;
    // their engine process registers in the CLI registry too, and they must
    // not read as terminal-owned. (The merge in list() already keeps the
    // sidecar row for them, so setting the flag only on the rest is enough.)
    const adopted = new Set<string>()
    for (const meta of this.store.list()) {
      if (meta.claudeSessionId !== undefined) adopted.add(meta.claudeSessionId)
    }
    for (const meta of fresh) {
      if (adopted.has(meta.id)) continue
      meta.terminalOwned = peers.has(meta.id)
      // A fresh transcript with no live writer is a crashed or finished
      // turn, not a running one — the mtime heuristic alone would call it
      // busy for the full recency window after a `kill -9`.
      if (meta.status === 'busy' && meta.terminalOwned !== true) meta.status = 'idle'
    }
    this.native = fresh
    const signature = JSON.stringify(fresh.map(meta => `${meta.id}\n${meta.updatedAt}\n${meta.status}\n${meta.terminalOwned === true}`))
    if (signature === this.signature) return false
    this.signature = signature
    return true
  }
```

Add `PeerSession` to the type import from `./peer-sessions.ts`.

- [ ] **Step 3: Typecheck and build**

Run: `pnpm build`
Expected: clean (this runs `tsc --noEmit` first).

- [ ] **Step 4: Verify against a live headless turn**

Restart the verification instance (kill the 3090 listener via `netstat -ano | grep :3090`, then `dsh --profile web --no-open --port 3090 &` from Git Bash, wait for `dsh web: http://127.0.0.1:3090` in the log), then:

```bash
mkdir -p /tmp/peer-test && cd /tmp/peer-test
ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic \
ANTHROPIC_AUTH_TOKEN="$GLM_TOKEN" ANTHROPIC_MODEL=glm-5.3 \
claude -p '从 1 慢慢数到 30，每个数字一行' &
# $GLM_TOKEN: the Zhipu key from the user's environment — deliberately not
# written into this committed file; export it in the shell before running.
sleep 4
curl -sS http://127.0.0.1:3090/cc/api/sessions | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const m=JSON.parse(d).sessions.filter(s=>s.cwd.includes('peer-test'));console.log(JSON.stringify(m.map(s=>({name:s.name.slice(0,20),status:s.status,owned:s.terminalOwned})),null,1))})"
```

Expected: `status: "busy"`, `owned: true` while the turn runs; after exit `status` returns to `idle` (within ~15 s) and `owned: false` (the CLI unlinks its registry file on exit).

- [ ] **Step 5: Verify the crashed-writer suppression**

Start another headless turn as above, capture its pid (`pgrep -f "claude -p"` or read the newest `~/.claude/sessions/*.json`), then `kill -9 <pid>` mid-turn. Poll the same endpoint.

Expected: within ~2 rescan ticks the session reads `status: "idle"`, `owned: false` — NOT busy for the remaining recency window (this is the regression the peer check exists to fix).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/catalog.ts
git commit -m "feat: derive terminal ownership from the CLI process registry"
```

---

### Task 3: Read-only gating on the new flag

**Files:**
- Modify: `src/client/App.tsx` (the `<Composer …>` props)
- Modify: `src/client/Composer.tsx` (rename `foreignBusy` → `readOnly`)
- Modify: `src/client/SessionRail.tsx` (`SessionRow`'s outer `<div>`)

**Interfaces:**
- Consumes: `SessionMeta.terminalOwned` from Task 2.
- Produces: `Composer` prop `readOnly?: boolean` (replaces `foreignBusy`).

- [ ] **Step 1: Rename the Composer prop**

In `src/client/Composer.tsx`, rename every `foreignBusy` (props type, `submit` guard, textarea `readOnly`, both stop-button branches, JSDoc) to `readOnly`. The JSDoc sentence becomes:

```
 * @param props - busy state plus send and interrupt callbacks. `readOnly`
 *   marks a session a live CLI process holds open: the box turns read-only
 *   with a reason, because that process is a concurrent writer and no stop
 *   signal of ours can reach its turn.
```

and the textarea placeholder for that state becomes:

```tsx
          readOnly={props.readOnly === true}
          placeholder={props.readOnly === true
            ? '这个会话正被一个终端进程使用（claude ps 可见），此处只读镜像'
            : props.busy
              ? '正在工作中，消息会排队发出…'
              : '向 Claude Code 发送消息，Enter 发送，Shift+Enter 换行，可粘贴或拖入图片'}
```

- [ ] **Step 2: Gate on ownership, not busy-guessing**

In `src/client/App.tsx`, replace the `foreignBusy` prop with:

```tsx
                  readOnly={current.terminalOwned === true}
```

- [ ] **Step 3: Rail row affordance**

In `src/client/SessionRail.tsx`, `SessionRow`'s outer `<div>`, add:

```tsx
      title={props.session.terminalOwned === true ? '正由终端进程使用，网页端只读' : undefined}
```

- [ ] **Step 4: Typecheck, build, restart, verify in the browser**

Run: `pnpm build`, restart the 3090 instance, then repeat the headless-turn recipe from Task 2 Step 4 and drive the page (Python + Playwright, headless Chromium; the page holds an SSE stream so `networkidle` never fires — wait on selectors instead):

```python
page.goto('http://127.0.0.1:3090')
page.wait_for_selector('.cc-dock, .cc-rail', timeout=20000)
# open the surface if only the dock is present: page.locator('.cc-dock').first.click()
page.locator('.cc-session', has_text='<the headless session name>').first.click()
page.wait_for_timeout(1500)
box = page.locator('.cc-input')
print('readonly:', box.get_attribute('readonly') is not None)
print('placeholder:', box.get_attribute('placeholder'))
```

Expected: `readonly: True`, placeholder mentions 只读; after the turn finishes and the registry entry disappears, the box becomes editable again on the next `sessions` frame.

- [ ] **Step 5: Commit**

```bash
git add src/client/App.tsx src/client/Composer.tsx src/client/SessionRail.tsx
git commit -m "feat: read-only composer for terminal-owned sessions"
```

---

### Task 4: Cleanup and rollout

- [ ] **Step 1: Delete the throwaway verification session**

`DELETE /cc/api/sessions/<id>` for the `/tmp/peer-test` session (find it via `GET /cc/api/sessions` filtering `cwd` containing `peer-test`); confirm `200`. Remove `/tmp/peer-test`.

- [ ] **Step 2: Roll out to the user's instance**

Check `GET http://127.0.0.1:3080/cc/api/sessions` on the user's instance shows zero busy sessions, then restart it (`dsh web --no-open --port 3080 &` from Git Bash). Tell the user to refresh the 3080 tab.

## Self-Review Checklist (for the executor)

- `terminalOwned` never appears on sidecar-adopted (web-created) sessions — verify by creating a session in the page, sending one turn, and checking `GET /cc/api/sessions` shows `terminalOwned` absent/false for it while its engine is live.
- The `sessions` SSE broadcast still fires when ONLY ownership flips (fingerprint includes it) — verify by opening a terminal REPL on an old session and watching the page update within ~2 s without any transcript write.
- No writes anywhere under `~/.claude/` — `git status` clean, and the only new file in the repo is `src/peer-sessions.ts`.
