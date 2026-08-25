# AGENTS.md

本文件是本仓库给编码智能体（Claude Code、Codex 等）的唯一指导文件；根目录的 `CLAUDE.md` 是指向本文件的软链接，Claude Code 通过它读到同样的内容。不要在 `CLAUDE.md` 里另写内容。

## 项目是什么

dsh-cc 是一个 DSH 双面外挂插件：在 DeepSeek Harness Web GUI 侧边栏加入 Claude Code 入口，每个会话由官方 `@anthropic-ai/claude-agent-sdk` 驱动一个真实 claude 进程。功能细节、配置项与 HTTP API 表见 `README.md`（中文，与本文件互补）。

## 常用命令

```sh
pnpm install
pnpm typecheck     # tsc --noEmit，提交前必过
pnpm build         # typecheck + tsdown，产出 lib/index.js 与 lib/client.js
pnpm watch         # tsdown --watch，配合 link: 安装免重新 add

node scripts/client-smoke.mjs                  # 构建后跑：stub 掉 __ModuleLoader__ 驱动 client.js 的 apply()
node scripts/sse-capture.mjs <out> <ms> [port] # 抓 /cc/api/events 的 SSE 帧到 JSONL
```

- 本仓库**没有测试框架，也不要引入**。验证回路 = `pnpm typecheck` + 下面的实验室实例做活体验证。
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
| `runtime.ts` | `/cc/api` HTTP 面：REST 变更 + SSE 推送；每 2s 重扫 catalog，有变化才广播 `sessions` 帧 |
| `engine.ts` | 每会话一个 SDK query：流式多轮、`canUseTool` 权限桥；关掉的引擎下次发消息按原生 id resume；`maxLiveSessions` LRU 挤出 |
| `catalog.ts` | **统一会话目录**：CLI 自己的磁盘存储 + dsh-cc sidecar 合并成一张列表 |
| `native-sessions.ts` / `native-transcript.ts` | 适配 CLI 原生存储（`~/.claude/projects/<encoded-cwd>/<id>.jsonl`）到 `SessionMeta` |
| `peer-sessions.ts` | 只读观察 `~/.claude/sessions/<pid>.json` 活进程注册表，得出 `terminalOwned` |
| `store.ts` | sidecar 持久化：index.json + 每会话 JSONL |
| `live-turn.ts` | 流式帧折叠 reducer，**两半共用同一份**，页面中途加入/切回拿到的进行中回合才一致 |
| `blobs.ts` | 图片字节按 SHA-256 内容寻址存储（页面粘贴与转录回读同源同 id） |
| `config.ts` | schemastery schema；结构化 provider 字段解析成 env 叠加，显式 `env` 永远赢 |

**核心不变量**：CLI 的存储是会话身份 / 标题 / 转录的唯一权威；sidecar 只存 CLI 表达不了的字段（模型覆盖、env 层、live 状态、计量成本、草稿转录）。两边按原生 id（sidecar 的 `claudeSessionId`）对齐；native 记录上的字段不得泄漏进合并后的 sidecar 行。

浏览器半区：`index.tsx` 的 `apply()` 往 `sidebar.footer.action` 槽注册入口；`App.tsx` 组合 `SessionRail` / `Transcript` / `Composer` / `LiveTurnView`；`tool/*-card.ts` 渲染各类工具卡片；`settings/` 是 provider / 环境配置 UI；`status/` 是用量读数。

## 硬性约束

- `~/.claude/sessions/` 只读观察：不写不删，不连 `messagingSocketPath`，不碰 `*.key`（PAKE 私有协议，无稳定性承诺）。
- 不跨进程打断：终端持有的会话在页面上只读，这就是全部控制模型（Windows 无法向别的控制台进程发 Ctrl+C）。
- SDK 固定 `@anthropic-ai/claude-agent-sdk@0.3.220`（自带 CLI 载荷，与本机 claude 版本无关）。
- profile 补丁层（cordis.patch.yml）里 id 定位的补丁**整行替换 config** —— 改哪项就把整块写全。
- 本机 `~/.claude/settings.json` 若设 `permissions.defaultMode: "auto"`，原生分类器会自行允许/拒绝，页面收不到审批卡片。

## 代码风格

2 空格缩进、单引号、无默认导出；每个导出函数写 JSDoc（含 `@param` / `@returns`）；每个文件开头是解释模块职责的 `@module` 注释。面向用户的文案（日志、UI）用中文。改代码时以周边文件为准。
