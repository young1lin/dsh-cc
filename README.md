# dsh-cc — 在 DeepSeek Harness 网页里使用 Claude Code

dsh-cc 是一个 DSH 外挂双面插件：在 DSH Web GUI 的侧边栏加入一个 **Claude Code** 入口，打开一个独立的聊天页面。每个会话由官方 **Claude Agent SDK** 驱动一个真实的 Claude Code 进程，支持多轮对话、工具权限审批、会话恢复（resume），并且模型 / 代理 / API Key / Base URL 全部通过环境变量与 cordis.yml 配置。

## 功能

- 侧边栏底部「Claude Code」按钮，打开全屏会话页面
- 多会话管理：新建（可指定名称 / 工作目录 / 模型）、切换、删除
- 实时流式输出（SSE）：文本、思考过程、工具调用与结果、回合统计（耗时 / 步数 / 花费）
- **工具权限审批**：`permissionMode: default` 时，Claude Code 的每次工具授权请求会弹到页面上，点「允许 / 拒绝」即可
- 会话持久化：JSONL 转录存放在数据目录，重启 DSH 后会话列表与记录仍在；继续对话自动通过 Claude 原生 session resume
- 环境变量可配置：`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`HTTPS_PROXY` 等任意变量，通过 profile 的 cordis.patch.yml 注入

## 安装

前置：本机已安装 Node 22+、pnpm；DSH 已安装（`dsh` 命令可用）。

```sh
cd D:/dev/dsh-cc
pnpm install
pnpm run build

# 装进 web profile（GUI 使用的 profile）
dsh plugin --profile web add D:/dev/dsh-cc

# 重启 dsh（web profile）后刷新页面
```

> 开发迭代：改完代码 `pnpm run build` 后重新执行上面的 `dsh plugin ... add` 并重启即可（file: 安装按 files 打包）。也可以用 `dsh plugin --profile web add link:D:/dev/dsh-cc` 做链接安装，配合 `pnpm run watch` 免重新 add（仅改 lib 产物时）。

## 配置（模型 / 代理 / 密钥）

默认零配置即可用（使用本机 Claude Code 登录态）。要切换模型或走代理，编辑 profile 的补丁层 `~/.dsh/profiles/web/cordis.patch.yml`（或 $DSH_HOME 下），加入或修改 dsh-cc 行：

```yaml
- id: dsh-cc
  config:
    model: claude-sonnet-4-5        # 默认模型；会话里也可单独选
    permissionMode: acceptEdits     # default / acceptEdits / plan / bypassPermissions
    cwd: D:/work                    # 新会话的默认工作目录
    dataDir: C:/Users/me/.dsh/claude-code
    maxLiveSessions: 4              # 同时存活的 claude 进程上限，超出关闭最久未用的
    env:                            # 注入 claude 进程的环境变量（覆盖继承值）
      HTTPS_PROXY: http://127.0.0.1:7890
      HTTP_PROXY: http://127.0.0.1:7890
      NO_PROXY: localhost,127.0.0.1
      ANTHROPIC_BASE_URL: https://api.example.com   # 网关 / 中转
      ANTHROPIC_AUTH_TOKEN: sk-xxx                   # Token（或 ANTHROPIC_API_KEY）
      ANTHROPIC_MODEL: claude-opus-4-5
```

注意：**id 定位的补丁会整行替换 config** —— 改哪项就把整块写全。保存后 profile 补丁层会热重载（watchUserPatches），但已存活的 claude 进程要新会话/重发消息后才会带上新环境。

常用环境变量参考：

| 变量 | 作用 |
|---|---|
| `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` | API 密钥 |
| `ANTHROPIC_BASE_URL` | 自定义 API 地址（中转/网关） |
| `ANTHROPIC_MODEL` | 默认模型 |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | HTTP 代理 |
| `ANTHROPIC_SMALL_FAST_MODEL` | 后台小模型 |

## 架构

```
D:/dev/dsh-cc
├─ package.json          dsh.bundle + dsh.client 声明（双面插件）
├─ cordis.patch.yml      bundle 层：挂载 dsh-cc 插件行
└─ src/
   ├─ index.ts           node 半区（函数插件）：inject webServer，挂 /cc/api 路由
   ├─ config.ts          schemastery 配置 schema + 显式默认值
   ├─ store.ts           会话存储（index.json + 每会话 JSONL 转录）
   ├─ engine.ts          Claude Agent SDK 引擎：流式多轮 query、canUseTool 权限桥、resume
   ├─ runtime.ts         REST + SSE 路由（/cc/api/*）
   └─ client/            浏览器半区：侧边栏入口 + 全屏聊天 overlay
        index.tsx          apply(): ctx.slots 注册 sidebar.footer.action
        App.tsx            会话列表 / 聊天 / 权限卡片 / 配置面板
        Message.tsx        消息渲染（代码块 / 工具卡片 / 思考折叠）
        api.ts             fetch + EventSource 封装
        styles.ts          cc- 前缀样式注入
```

- **node 半区**是函数插件（具名导出 `name`/`inject`/`Config`/`apply`），等待 `webServer` 服务后把 `/cc/api` 前缀路由注册到宿主 HTTP 服务上；不与宿主 cordis 发生类继承耦合。
- **浏览器半区**通过 package.json 的 `dsh.client` 声明被 client-modules 自动扫描，bundle 以 `window.__ModuleLoader__` 闭包格式构建，react / react-dom 走宿主模块表。

### HTTP API（本机调试用）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /cc/api/config | 生效配置摘要（不含环境变量值） |
| GET/POST | /cc/api/sessions | 列表 / 新建 |
| GET/DELETE | /cc/api/sessions/:id | 详情（含转录）/ 删除 |
| POST | /cc/api/sessions/:id/messages | 发送消息 |
| POST | /cc/api/sessions/:id/stop | 中断当前回合 |
| POST | /cc/api/sessions/:id/permissions/:requestId | 权限审批 |
| GET | /cc/api/events | SSE 实时推送 |

## 已知限制

- **原生权限设置的优先级**：若本机 `~/.claude/settings.json` 设了 `permissions.defaultMode: "auto"`，Claude Code 原生分类器会自行允许/拒绝工具请求，页面收不到审批卡片。想在页面里审批，把原生 defaultMode 改回 `default`（或删除该字段）。
- 权限模式为 `default` 时依赖页面在线答复授权请求；关着页面时请求会一直挂起（关会话则自动拒绝）。
- `bypassPermissions` 会跳过 Claude Code 全部确认，请仅在可信目录使用。
- 每个活跃会话是一个真实 claude 进程，受 `maxLiveSessions`（默认 4）约束；被挤出的进程下次发消息时自动 resume。
- 转录读取对页面按尾部 800 条截断；完整记录在数据目录的 JSONL 里。
- SDK 固定为 `@anthropic-ai/claude-agent-sdk@0.3.220`（自带对应版本 CLI 载荷，与本机安装的 claude 版本无关）。
