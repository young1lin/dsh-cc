/**
 * Static knowledge about built-in slash commands whose shape the streaming
 * channel cannot faithfully carry: commands that open an interactive terminal
 * UI inside the CLI, and commands this page already renders a native control
 * for. The live catalog (supportedCommands()) says what exists; this module
 * says what the web surface should advise about the ones with special shapes.
 *
 * Sourced from the official commands reference (code.claude.com/docs/en/
 * commands); curated by hand because the CLI does not expose this dimension.
 *
 * @module dsh-cc/client/term-commands
 */

/**
 * Commands the page has a native control for, mapped to where that control
 * lives. The menu chip points the user at the control instead of sending the
 * bare command into the stream (where its argument-less form usually opens a
 * terminal picker the stream cannot show).
 */
const PAGE_EQUIVALENTS: Readonly<Record<string, string>> = {
  model: '状态栏「模型」菜单',
  effort: '状态栏「模型」菜单里的思考档位',
  permissions: '状态栏「权限模式」菜单',
  context: '状态栏的上下文占用读数',
  usage: '状态栏的用量读数',
  cost: '状态栏的用量读数',
  stats: '状态栏的用量读数',
  status: '设置面板',
  config: '设置面板',
  rename: '会话栏的重命名',
  clear: '会话栏「新建会话」',
}

/**
 * Built-in commands whose CLI implementation opens an interactive terminal UI
 * (pickers, viewers, $EDITOR, OAuth flows) with no page equivalent. Sending
 * them through the streaming channel may produce no visible output — the menu
 * marks them so the user knows before pressing Enter.
 */
const TERMINAL_TUI: ReadonlySet<string> = new Set([
  'theme', 'tui', 'diff', 'resume', 'mcp', 'hooks', 'keybindings', 'tasks',
  'agents', 'list-agents', 'schedule', 'sandbox', 'plugin', 'release-notes',
  'goal', 'radio', 'mobile', 'desktop', 'chrome', 'teleport', 'remote-control',
  'remote-env', 'insights', 'artifacts', 'upgrade', 'usage-credits',
  'privacy-settings', 'passes', 'stickers', 'terminal-setup', 'powerup',
  'autocompact', 'voice', 'fast', 'advisor', 'btw', 'memory', 'login',
  'logout', 'feedback', 'bug', 'import',
])

/**
 * Look up the page-native control a command duplicates, if any.
 * @param name - the command's canonical name (without the leading slash).
 * @returns where the control lives, or undefined when there is none.
 */
export function pageEquivalentFor(name: string): string | undefined {
  return PAGE_EQUIVALENTS[name]
}

/**
 * Whether a command's CLI implementation is an interactive terminal UI.
 * @param name - the command's canonical name (without the leading slash).
 * @returns true when the command opens a terminal-only interface.
 */
export function isTerminalCommand(name: string): boolean {
  return TERMINAL_TUI.has(name)
}
