/**
 * MCP server readout for the status strip — the page's answer to the CLI's
 * `/mcp`.
 *
 * Which servers a session actually has is not readable from any one config
 * file: project scope depends on the session's cwd, user scope on the account
 * root, and enterprise policy can override both. The CLI is the only thing
 * that has resolved all three, so this panel is a view onto a live process and
 * says so plainly when there is not one.
 *
 * @module dsh-cc/client/status/McpMenu
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { controlMcpServer, fetchMcpServers, type McpServerRow } from '../api/telemetry.ts'
import { registerCss } from '../css.ts'
import { useOverlay } from '../overlay.ts'

registerCss('status-mcp-menu', `
.cc-mcp-wrap { position: relative; display: inline-flex; }
.cc-mcp-panel {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 40;
  min-width: 320px; max-width: 460px; max-height: 340px; overflow-y: auto;
  padding: 6px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 8px 28px rgb(0 0 0 / 18%);
}
.cc-mcp-empty { padding: 10px 8px; color: var(--dsw-alias-label-tertiary); }
.cc-mcp-row { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 7px; }
.cc-mcp-row:hover { background: var(--dsw-alias-bg-layer-3); }
.cc-mcp-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-label-caption); }
.cc-mcp-dot[data-status='connected'] { background: var(--dsw-alias-status-success, #3fae5a); }
.cc-mcp-dot[data-status='failed'] { background: var(--dsw-alias-status-error, #d9534f); }
.cc-mcp-dot[data-status='needs-auth'] { background: var(--dsw-alias-status-warning, #e0a33e); }
.cc-mcp-dot[data-status='pending'] { background: var(--dsw-alias-status-warning, #e0a33e); }
.cc-mcp-name { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.cc-mcp-title { font: var(--dsw-font-xs-13); color: var(--dsw-alias-label-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cc-mcp-sub { font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-tertiary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cc-mcp-act { flex: none; display: flex; gap: 5px; }
.cc-mcp-act button {
  padding: 1px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12); cursor: pointer;
}
.cc-mcp-act button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.cc-mcp-act button:disabled { color: var(--dsw-alias-label-caption); cursor: default; }
`)

/** Chinese label per connection status. */
const STATUS_LABEL: Record<McpServerRow['status'], string> = {
  connected: '已连接',
  failed: '连接失败',
  'needs-auth': '待授权',
  pending: '连接中',
  disabled: '已停用',
}

/**
 * The one-line subtitle under a server's name: what it is, and what is wrong
 * with it when something is.
 * @param row - the server row.
 * @returns the subtitle text.
 */
function subtitleFor(row: McpServerRow): string {
  const parts = [STATUS_LABEL[row.status] ?? row.status]
  if (row.scope !== undefined && row.scope !== '') parts.push(row.scope)
  if (row.tools !== undefined && row.tools.length > 0) parts.push(`${row.tools.length} 个工具`)
  if (row.serverInfo !== undefined) parts.push(`v${row.serverInfo.version}`)
  if (row.error !== undefined && row.error !== '') parts.push(row.error)
  return parts.join(' · ')
}

/**
 * Render the MCP readout, or nothing at all when this session has no servers.
 *
 * Absent rather than empty on purpose: a user with no MCP configured should
 * not carry a permanently-empty control in a strip that is already dense.
 * @param props.sessionId - the session whose process to ask.
 * @param props.busy - whether a turn is running; a turn both means a live
 *   process exists and is the moment server state can change under the user.
 * @returns the control, or null when there is nothing to show.
 */
export function McpMenu(props: { sessionId: string; busy: boolean }): ReactElement | null {
  const [open, setOpen] = useState(false)
  const [servers, setServers] = useState<McpServerRow[]>([])
  const [pending, setPending] = useState<string | undefined>()
  const wrap = useRef<HTMLDivElement>(null)
  useOverlay(open)

  const load = useCallback((id: string) => {
    fetchMcpServers(id)
      .then(result => setServers(result.servers))
      .catch(() => {
        // Cold session or a refusing process; the next trigger retries.
      })
  }, [])

  // Re-read when the session changes and when a turn boundary passes: a server
  // can connect, drop, or start needing auth while the process works.
  useEffect(() => {
    setServers([])
    setOpen(false)
    load(props.sessionId)
  }, [props.sessionId, load])
  useEffect(() => {
    if (!props.busy) load(props.sessionId)
  }, [props.busy, props.sessionId, load])

  // Click-outside closes, matching every other floating layer on the surface.
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (wrap.current?.contains(event.target as Node) === false) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  if (servers.length === 0) return null

  const connected = servers.filter(row => row.status === 'connected').length
  const broken = servers.some(row => row.status === 'failed' || row.status === 'needs-auth')

  const act = (row: McpServerRow, action: 'reconnect' | 'enable' | 'disable'): void => {
    setPending(row.name)
    controlMcpServer(props.sessionId, row.name, action)
      .then(result => setServers(result.servers))
      .catch(() => {
        // The CLI refused; re-read so the row shows whatever is true now.
        load(props.sessionId)
      })
      .finally(() => setPending(undefined))
  }

  return (
    <div className="cc-mcp-wrap" ref={wrap}>
      <button
        type="button"
        className="cc-status-picker"
        title="MCP 服务器（读自当前进程）"
        onClick={() => setOpen(previous => !previous)}
      >
        <span className="cc-status-picker-label">
          {`MCP ${connected}/${servers.length}${broken ? ' ⚠' : ''}`}
        </span>
        <IconChevronDownOutline14 />
      </button>
      {open && (
        <div className="cc-mcp-panel" role="dialog" aria-label="MCP 服务器">
          {servers.map(row => (
            <div className="cc-mcp-row" key={row.name}>
              <span className="cc-mcp-dot" data-status={row.status} aria-hidden />
              <span className="cc-mcp-name">
                <span className="cc-mcp-title">{row.name}</span>
                <span className="cc-mcp-sub" title={subtitleFor(row)}>{subtitleFor(row)}</span>
              </span>
              <span className="cc-mcp-act">
                {row.status === 'disabled'
                  ? (
                    <button type="button" disabled={pending === row.name} onClick={() => act(row, 'enable')}>启用</button>
                  )
                  : (
                    <>
                      <button type="button" disabled={pending === row.name} onClick={() => act(row, 'reconnect')}>重连</button>
                      <button type="button" disabled={pending === row.name} onClick={() => act(row, 'disable')}>停用</button>
                    </>
                  )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
