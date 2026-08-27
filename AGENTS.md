# AGENTS.md

本文件是本仓库给编码智能体（Claude Code、Codex 等）的唯一指导文件；根目录的 `CLAUDE.md` 是指向本文件的软链接，Claude Code 通过它读到同样的内容。不要在 `CLAUDE.md` 里另写内容。

## 项目是什么

dsh-cc 是一个 DSH 双面外挂插件：在 DeepSeek Harness Web GUI 右缘加入 Claude Code dock 入口（`shell.overlay` 槽），每个会话由官方 `@anthropic-ai/claude-agent-sdk` 驱动一个真实 claude 进程。功能细节、配置项与 HTTP API 表见 `README.md`（中文，与本文件互补）。

## 常用命令

```sh
pnpm install
pnpm typecheck     # tsc --noEmit，提交前必过
pnpm build         # typecheck + tsdown，产出 lib/index.js 与 lib/client.js
pnpm watch         # tsdown --watch，配合 link: 安装免重新 add

node scripts/client-smoke.mjs                  # 构建后跑：stub 掉 __ModuleLoader__ 驱动 client.js 的 apply()
node scripts/sse-capture.mjs <out> <ms> [port] # 抓 /cc/api/events 的 SSE 帧到 JSONL
node scripts/cli-contract.mjs                  # 对着真 CLI 断言我们依赖的行为；升 SDK 后必跑
```

- 本仓库**没有测试框架，也不要引入**。验证回路 = `pnpm typecheck` + `scripts/cli-contract.mjs` + 下面的实验室实例做活体验证。
- **升 `@anthropic-ai/claude-agent-sdk` 后先跑 `cli-contract.mjs`。** 它读 dsh-cc 自己设置层里生效的预设（走中转，token 不进仓库），起一个真 query，把「回合中途的消息会不会被丢弃 / 整批会不会合并成一个回合 / CLI 会不会回显用户消息 / init 有哪些能力位 / `cancelAsyncMessage` 还在不在」逐条验一遍。这个脚本存在的理由：`engine.ts` 曾有一条注释写着「verified against the 0.3.220 payload」，三条断言全错，整个排队子系统建在上面 —— 注释里的「已验证」不可信，能跑的断言才可信。
- 装进 GUI 用的 profile：`dsh plugin --profile web add <repo>`（按 `files` 字段打包 lib 产物）；开发用 `add link:<repo>` + `pnpm watch`。改完代码要重启 dsh 才生效。

## 实验室验证（改完必须活体验证再算完成）

- 用户自己的 dsh 实例在 **3080** 端口 —— 动它之前先查 `GET /cc/api/sessions` 确认没有 busy 会话。
- 验证实例：从 **Git Bash** 启动（PowerShell 的 Start-Process 跑不了 npm shim）：`dsh --profile web --no-open --port 3090`。`.lab-home/`（已 gitignore）是隔离的 DSH_HOME 实验副本；`scripts/lab-port.patch.yml` 可把 webserver 覆盖到 127.0.0.1:3081。
- SSE 常连接会让 Playwright 的 networkidle 永远不触发 —— 测页面时别拿 networkidle 当等待条件。
- 实施计划归档在 `docs/superpowers/plans/`，其中的全局约束与本文件同样有效。

## 架构

双面插件，两半各自构建：

- **node 半区**（`src/*.ts`）：函数插件（`name` / `inject: ['webServer']` / `Config` / `apply`），把 `/cc/api` 前缀路由（REST + 一条 SSE）注册到宿主 HTTP 服务；tsdown 打成 ESM `lib/index.js`。
- **浏览器半区**（`src/client/`）：靠 package.json 的 `dsh.client` 声明被宿主 client-modules 扫描；tsdown 打成 `window.__ModuleLoader__.load` 闭包格式 CJS `lib/client.js`，react / react-dom / ui-primitives 保持 external 走宿主模块表（见 `tsdown.config.ts`）。

node 半区各模块（读懂 catalog 这一层是理解全局的关键）：

| 模块 | 职责 |
|---|---|
| `runtime.ts` | `/cc/api` HTTP 面：REST 变更 + SSE 推送；catalog 变化由 `store-watch.ts` 的文件监听驱动（30s 定时器只兜底），只推动了的那一行 |
| `engine.ts` | 每会话一个 SDK query：流式多轮、`canUseTool` 权限桥；消息一律**立即推流**，排队由 CLI 自己做（见下方「排队的不变量」），`queued` 计数随 sessions 帧下发；每个成功完成的主线模型响应后探测一次遥测（context/usage）并经 SSE `telemetry` 帧推送 —— 按响应计频，探测在途时丢弃新触发而不排队；关掉的引擎下次发消息按原生 id resume；`maxLiveSessions` LRU 挤出 |
| `catalog.ts` | **统一会话目录**：CLI 自己的磁盘存储 + dsh-cc sidecar 合并成一张列表 |
| `native-sessions.ts` / `native-transcript.ts` | 适配 CLI 原生存储（`~/.claude/projects/<encoded-cwd>/<id>.jsonl`）到 `SessionMeta` |
| `peer-sessions.ts` | 只读观察 `~/.claude/sessions/<pid>.json` 活进程注册表，得出 `terminalOwned` |
| `accounts.ts` | **账号根目录的唯一所有者**：解析生效的 `CLAUDE_CONFIG_DIR` 并写到 dsh 进程自己的 env 上 |
| `store.ts` | sidecar 持久化：index.json + 每会话 JSONL |
| `live-turn.ts` | 流式帧折叠 reducer，**两半共用同一份**，页面中途加入/切回拿到的进行中回合才一致 |
| `mentions.ts` | 发消息时的 @ 提及展开：文件内容 / 文件夹目录树作为文本块追加（触发规则：行首或空白后的 `@`；总量 1MB 上限） |
| `file-index.ts` | @ 提及菜单的项目索引：会话 cwd 下的一次有界 BFS 遍历（5000 行 / 层 2000 / 深 16），TTL 缓存；与发送侧共用 `types.ts` 里的 `SKIPPED_DIR` 单一忽略权威 —— 菜单绝不提供注入会跳过的东西 |
| `blobs.ts` | 图片字节按 SHA-256 内容寻址存储（页面粘贴与转录回读同源同 id）；`sweep()` 回收无引用且超过宽限期的文件 |
| `config.ts` | schemastery schema；结构化 provider 字段解析成 env 叠加，显式 `env` 永远赢 |
| `store-watch.ts` | 递归监听 CLI 主目录，报出「哪几个项目目录变了」；带速率上限，作用域不确定时如实说 full |

**核心不变量**：CLI 的存储是会话身份 / 标题 / 转录的唯一权威；sidecar 只存 CLI 表达不了的字段（模型覆盖、env 层、live 状态、计量成本、草稿转录、标题来源标记）。两边按原生 id（sidecar 的 `claudeSessionId`）对齐；native 记录上的字段不得泄漏进合并后的 sidecar 行。标题规则对齐 CLI：页面建的草稿在首次发消息时以消息首行自动命名（`titleSource: 'auto'`），手动命名（`titleSource: 'user'`）永不被自动覆盖；收养的 CLI 会话本来就带着 CLI 自己的派生标题，不参与自动命名。

**账号根目录的不变量**：任一时刻只有一个 `CLAUDE_CONFIG_DIR` 生效，由 `accounts.ts` 独家拥有 —— SDK 的 `listSessions` 之流和 `peer-sessions` 都只认 `process.env.CLAUDE_CONFIG_DIR`（无 per-call 选项），所以切账号 = 改写 dsh 进程自己的这个变量。因此 `CLAUDE_CONFIG_DIR` 在两个 env 编辑器里都被拒（写进 env 只会搬动被 spawn 的进程、搬不动插件自己的读，正是要防的分叉），cordis 配置里的则在 `resolveConfig` 提升成 `configDir`。切换时必须把一切从旧根目录读来的缓存一起作废：`account`、`modelCatalog`、catalog signature、所有引擎；有 busy 引擎则拒绝切换（409）。sidecar 行创建时盖 `configDir` 章，`catalog.list()` 按此过滤。

**排队的不变量**：**队列归 CLI 所有，宿主只做镜像。** CLI 自己有一条命令队列（能力位 `msg_lifecycle_v1`，2.1.220 载荷实测）：任何时候推进流的用户消息都会回一条 `command_lifecycle` 帧 —— `queued`（在跑的回合后面等）→ `started`（被取进某个回合）→ 终态。所以 `send()` **一律立即推流**，绝不宿主侧扣着；`engine.ts` 的 `outbox` 只是这些 uuid 的正文/时间/附件镜像，供页面列出「谁在等」。三条硬约束：

- **转录行在 `started` 时才发**，不在 send 时发 —— 排队中的消息写进转录就等于谎称已发出（这正是宿主队列时代的 bug）。唯一例外是 outbox 为空的那一条：它不可能在等谁，立即回显，省掉冷会话起进程的 1~2 秒空白。
- **不要自己复刻投递语义**：CLI 会把堆在一个回合后面的**整批**消息合并成**一个**回合（一条 user 记录、N 个 text block、一个 result；批次代表 uuid 是最后一条）。逐条投递会变成 N 个回合、N 份计费，且模型永远看不到用户的连续意图。
- **撤回走 `query.cancelAsyncMessage(uuid)`**（该方法在 SDK 运行时里有、`sdk.d.ts` 里被抹掉了，要窄化类型去拿）；`interrupt()` 的回执带 `still_queued`，用它对账，别自己猜。CLI 进程死掉时它的队列跟着没，所以未 `started` 的条目仍由宿主 `takeQueued` / `restoreQueue` 搬进下一个引擎 —— 只搬没开跑的，开跑的那条归 `lastSend` 重放。

**活进程才知道的事**：MCP 服务器（`mcpServerStatus` / `reconnectMcpServer` / `toggleMcpServer`）、子代理目录（`supportedAgents`）、斜杠命令（`supportedCommands`）都只能问活进程 —— 哪些生效取决于会话 cwd（项目作用域）、账号根目录（用户作用域）和企业策略，三层只有 CLI 解析全了，读配置文件必然错。冷会话一律回 `available: false`（命令目录另有「上次记档」回退）。技能与插件 CLI 只在启动时解析，所以有 `POST /sessions/:id/commands` 走 `reloadPlugins` + `reloadSkills` 再重读 —— 两个 reload 各自 try，插件树坏了不能连累技能。

浏览器半区：`index.tsx` 的 `apply()` 往 `shell.overlay` 槽注入右缘 dock 入口（`cc-dock` 按钮，点开全屏 overlay）；`App.tsx` 组合 `SessionRail` / `Transcript` / `Composer` / `LiveTurnView` / `StatusBar` / `Interaction`（权限审批卡片与 AskUserQuestion 桥）；`tool/*-card.ts` 渲染各类工具卡片；`settings/` 是 provider / 环境配置 UI（`SettingsModal` / `SessionEnvModal` 等）；`status/` 是用量与上下文读数。

## 硬性约束

- **测试只允许走 GLM 中转**（用户配额保护；GLM env 全量见 memory）。账号直连预设只属于用户本人操作。
- **预设键域语义**：`activePresetId` 激活时 `PROVIDER_ENV_KEYS` 键域由预设独占——预设之内的键替换一切层、之外的键从生效环境**删除**（`ResolvedConfig.envDeletes` → engine spawn 剥离，含大小写变体）。这是逐键覆盖表达不了的删除语义，别绕开它去改 spawn env。
- **`/cc/api` 前缀必须校验 Host 为回环**（`localhost`/`127.0.0.1`/`::1`）：`fs/file`、`fs/list` 能读全盘，宿主 webserver 不校验前缀路由的 Host，没有这道闸 DNS rebinding 就能跨站读文件。动 handle() 入口时保住它。
- `~/.claude/sessions/` 只读观察：不写不删，不连 `messagingSocketPath`，不碰 `*.key`（PAKE 私有协议，无稳定性承诺）。
- 不跨进程打断：终端持有的会话在页面上只读，这就是全部控制模型（Windows 无法向别的控制台进程发 Ctrl+C）。
- SDK 固定 `@anthropic-ai/claude-agent-sdk@0.3.220`（自带 CLI 载荷，与本机 claude 版本无关）。
- profile 补丁层（cordis.patch.yml）里 id 定位的补丁**整行替换 config** —— 改哪项就把整块写全。
- **catalog 是监听驱动的，不是轮询驱动的**（`store-watch.ts`）。全量 `listSessions({})` 实测 205ms（307 个会话 / 52 个目录），按 2 秒轮一次就是一个核的 10.3%，**存储再安静也照付**。现在：`fs.watch` 递归盯 `projects/`（只有 win32/darwin 支持 recursive，其余平台 `watchClaudeHome` 返回 undefined、退回原来的按听众定时），事件带上变了哪个项目目录 → `catalog.refreshProjects()` 只重读那几个目录（同机 67ms，快 3.1 倍），30s 定时器只当兜底。改这里的三条铁律：**① 监听必须带速率上限**（一个回合在终端里跑会持续写转录，纯去抖会比轮询更糟）；**② 作用域读不确定就 return undefined 退回全量**（目录名编码是单向的，猜不出 cwd 就别猜）；**③ 会话集合变了（增/删）必须走全量帧**，单行帧表达不了。
- **SSE 帧要选最小的那个**：全量 `sessions` 帧本机 136KB / 318 行，而绝大多数变化只动一行（queued 计数、状态、计费）。`broadcastSession(id)` 推单行（396 字节），`broadcastSessions()` 只留给会话集合变化和页面接入。实测 40 秒空闲从 812KB 降到 792 字节。`catalog.row(id)` 必须和 `list()` 同形 —— 它要把原生 id 解析回已收养的 sidecar 行，否则页面会多出一行重复会话。
- 插件默认 `permissionMode` 就是 `auto`（`config.ts`），零配置时页面收不到审批卡片；想页面审批需显式设为 `default`。本机 `~/.claude/settings.json` 的 `permissions.defaultMode` 是另一条同效果的来源。

## 代码风格

2 空格缩进、单引号、无默认导出；每个导出函数写 JSDoc（含 `@param` / `@returns`）；每个文件开头是解释模块职责的 `@module` 注释。面向用户的文案（日志、UI）用中文。改代码时以周边文件为准。
