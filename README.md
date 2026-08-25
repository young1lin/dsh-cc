# dsh-cc — 在 DeepSeek Harness 网页里使用 Claude Code

dsh-cc 是一个 DSH 外挂双面插件：在 DSH Web GUI 右缘加入一个 **Claude Code** dock 按钮（`cc-dock`，注册在宿主的 `shell.overlay` 槽），点开一个全屏会话 overlay。每个会话由官方 **Claude Agent SDK** 驱动一个真实的 Claude Code 进程，支持多轮对话、工具权限审批、会话恢复（resume），并且模型 / 代理 / API Key / Base URL 全部通过环境变量与 cordis.yml 配置。

## 功能

- 右缘「Claude Code」dock 按钮，打开全屏会话 overlay（Escape 关闭）
- 多会话管理：新建（可指定名称 / 工作目录 / 模型）、切换、重命名、删除；CLI 原生创建的会话也在列表里，终端正在使用的只读展示
- 实时流式输出（SSE）：文本、思考过程、工具调用与结果、回合统计（耗时 / 步数 / 花费）；中途加入 / 切回会话也能拿到进行中的回合
- **工具权限审批**：把 `permissionMode` 设为 `default` 后，Claude Code 的每次工具授权请求会弹到页面上，点「允许 / 拒绝」（可选记住为规则）即可
- **AskUserQuestion 对话桥**：模型向用户提问（选项 / 输入框）时直接在页面上作答
- **模型与思考档位热切换**：会话进行中切换模型 / effort，忙碌回合就地切换，选择持久化为该会话的默认
- **图片输入**：粘贴或拖入图片（每张 ≤ 5MB）随消息发送，转录回读同一份内容寻址存储
- **用量与上下文读数**：状态栏显示模型 / 档位选择、上下文窗口占用与账户用量
- 会话持久化：JSONL 转录存放在数据目录，重启 DSH 后会话列表与记录仍在；继续对话自动通过 Claude 原生 session resume
- 环境变量可配置：`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`HTTPS_PROXY` 等任意变量，通过 profile 的 cordis.patch.yml、结构化 provider 字段或页内设置面板注入

## 安装

前置：本机已安装 Node 22+、pnpm；DSH 已安装（`dsh` 命令可用）。

```sh
cd C:/PythonProject/dev/dsh-cc
pnpm install
pnpm run build

# 装进 web profile（GUI 使用的 profile）
dsh plugin --profile web add C:/PythonProject/dev/dsh-cc

# 重启 dsh（web profile）后刷新页面
```

> 开发迭代：改完代码 `pnpm run build` 后重新执行上面的 `dsh plugin ... add` 并重启即可（file: 安装按 files 打包）。也可以用 `dsh plugin --profile web add link:C:/PythonProject/dev/dsh-cc` 做链接安装，配合 `pnpm run watch` 免重新 add（仅改 lib 产物时）。

## 配置（模型 / 代理 / 密钥）

默认零配置即可用（使用本机 Claude Code 登录态）。要切换模型或走代理，编辑 profile 的补丁层 `~/.dsh/profiles/web/cordis.patch.yml`（或 $DSH_HOME 下），加入或修改 dsh-cc 行：

```yaml
- id: dsh-cc
  config:
    model: claude-sonnet-4-5        # 默认模型；会话里也可单独选
    permissionMode: auto            # default / acceptEdits / plan / dontAsk / bypassPermissions / auto（默认 auto）
    effort: high                    # 新会话默认思考档位：low / medium / high / xhigh / max；不填 = CLI 默认
    cwd: D:/work                    # 新会话的默认工作目录
    dataDir: C:/Users/me/.dsh/claude-code
    maxLiveSessions: 4              # 同时存活的 claude 进程上限，超出关闭最久未用的
    maxTurns: 0                     # 单回合工具调用上限；0 = 不限
    executablePath: ''              # 覆盖 claude 可执行文件路径；空 = 用 SDK 自带载荷
    provider:                       # 结构化网关配置，逐字段解析成环境变量
      baseUrl: https://api.example.com   # → ANTHROPIC_BASE_URL；空 = 官方 API
      authToken: sk-xxx                  # → ANTHROPIC_AUTH_TOKEN
      apiKey: ''                         # → ANTHROPIC_API_KEY（仅在未设 authToken 时生效）
      model: ''                          # → ANTHROPIC_MODEL（网关目录里的 id / 别名）
      opusModel: ''                      # → ANTHROPIC_DEFAULT_OPUS_MODEL
      sonnetModel: ''                    # → ANTHROPIC_DEFAULT_SONNET_MODEL
      haikuModel: ''                     # → ANTHROPIC_DEFAULT_HAIKU_MODEL
      smallFastModel: ''                 # → ANTHROPIC_SMALL_FAST_MODEL
      httpsProxy: http://127.0.0.1:7890  # → HTTPS_PROXY
      httpProxy: ''                      # → HTTP_PROXY
      noProxy: localhost,127.0.0.1       # → NO_PROXY
      apiTimeoutMs: 300000               # → API_TIMEOUT_MS
    env:                            # 直接注入 claude 进程的环境变量；同名键永远赢过 provider 结构化字段
      HTTPS_PROXY: http://127.0.0.1:7890
      NO_PROXY: localhost,127.0.0.1
```

注意：**id 定位的补丁会整行替换 config** —— 改哪项就把整块写全。保存后 profile 补丁层会热重载（watchUserPatches），但已存活的 claude 进程要新会话/重发消息后才会带上新环境。

`provider.model`（→ `ANTHROPIC_MODEL`，由 CLI 在网关目录里解析）与顶层 `model`（SDK 查询参数）是两条独立的解析通道，可只设其一或都设。

### 页面内设置

聊天页面内建的设置面板（SettingsModal）读写 `GET/PUT /cc/api/settings`，持久化到 `dataDir/settings.json`，可改默认模型、`permissionMode` 与环境变量。保存即时生效：空闲引擎被回收、下一条消息用新配置起进程，无需重启 dsh（忙碌回合先跑完）。非空字段覆盖 cordis 配置的同名字段，留空则回落到 cordis 层；`env` 按键合并而非整块替换。

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
C:/PythonProject/dev/dsh-cc
├─ package.json          dsh.bundle + dsh.client 声明（双面插件）
├─ cordis.patch.yml      bundle 层：挂载 dsh-cc 插件行
└─ src/
   ├─ index.ts           node 半区（函数插件）：inject webServer，挂 /cc/api 路由
   ├─ config.ts          schemastery 配置 schema + 显式默认值 + provider → env 解析
   ├─ types.ts           两半共享的契约类型（SessionMeta / 事件 / 设置 / 线路消息）
   ├─ store.ts           sidecar 持久化：index.json + 每会话 JSONL 转录
   ├─ catalog.ts         统一会话目录：CLI 原生存储 + sidecar 合并成一张列表
   ├─ native-sessions.ts     适配 CLI 原生存储（~/.claude/projects/...）到 SessionMeta
   ├─ native-transcript.ts   读 CLI 原生 JSONL 转录（尾部截断）
   ├─ peer-sessions.ts   只读观察 ~/.claude/sessions/<pid>.json 活进程注册表 → terminalOwned
   ├─ engine.ts          每会话一个 SDK query：流式多轮、canUseTool 权限桥、resume
   ├─ live-turn.ts       流式帧折叠 reducer（两半共用，中途加入拿到一致的进行中回合）
   ├─ blobs.ts           图片字节 SHA-256 内容寻址存储
   ├─ runtime.ts         REST + SSE 路由（/cc/api/*）
   └─ client/            浏览器半区：右缘 dock + 全屏聊天 overlay
        index.tsx          apply(): ctx.slots 注入 shell.overlay 槽（cc-dock 按钮）
        App.tsx            会话列表 / 聊天 / 权限与提问卡片 / 设置入口
        SessionRail.tsx    会话侧栏    Transcript.tsx  消息流
        Composer.tsx       输入框      LiveTurnView.tsx  进行中回合
        StatusBar.tsx      模型 / 档位 / 上下文 / 用量状态条
        Interaction.tsx    权限审批卡片 + AskUserQuestion 卡片
        api/               fetch + EventSource 封装（http / sessions / settings / telemetry / interaction）
        tool/              各类工具卡片（terminal / read / diff / search / web / TodoList…）
        settings/          SettingsModal / ProviderForm / EnvEditor / SessionEnvModal / AccountPanel
        status/            用量与上下文读数（UsageReadout / ContextMeter / ModelMenu）
```

- **node 半区**是函数插件（具名导出 `name`/`inject`/`Config`/`apply`），等待 `webServer` 服务后把 `/cc/api` 前缀路由注册到宿主 HTTP 服务上；不与宿主 cordis 发生类继承耦合。
- **浏览器半区**通过 package.json 的 `dsh.client` 声明被 client-modules 自动扫描，bundle 以 `window.__ModuleLoader__` 闭包格式构建，react / react-dom 走宿主模块表。

### HTTP API（本机调试用）

全部 24 个方法-路径对，与 `src/runtime.ts` 的路由注册一一对应：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /cc/api/config | 生效配置摘要：数据目录、默认 cwd、模型、权限模式、SDK 版本；环境变量逐键列出并标注来源层（进程 / 插件 / 页面设置），以 TOKEN / KEY / SECRET / PASSWORD / COOKIE 结尾的键打码，其余原样返回 |
| GET | /cc/api/models | 当前全局配置下的模型目录（由 CLI / 网关解析；`available: false` 表示无 CLI 应答，回落静态别名） |
| GET | /cc/api/settings | 读取页面可编辑设置层（模型 / permissionMode / env） |
| PUT | /cc/api/settings | 替换页面可编辑设置层；持久化到 dataDir/settings.json 并即时生效 |
| POST | /cc/api/images | 上传一张图片（原始字节 + content-type，≤ 5MB），返回内容寻址引用 |
| GET | /cc/api/blobs/:id.:ext | 回读已存图片（immutable 长缓存） |
| GET | /cc/api/fs/list?path= | 工作目录选择器的目录列表（无 path 列盘符根） |
| GET | /cc/api/sessions | 会话列表（含 CLI 原生会话；`terminalOwned` 标注终端持有） |
| POST | /cc/api/sessions | 新建会话（可带名称 / cwd / 模型） |
| GET | /cc/api/sessions/:id | 会话详情 + 转录（尾部 800 条）+ 进行中回合快照 |
| DELETE | /cc/api/sessions/:id | 删除会话（连同 CLI 原生转录）；原生存储删除失败（如 Windows 下文件被终端进程占用）时返回 409 + error，会话保留 |
| PUT | /cc/api/sessions/:id/name | 重命名（同步改 CLI 记录，`claude --resume` 列表同名） |
| PUT | /cc/api/sessions/:id/env | 会话级环境层；空闲引擎即时回收，下一条消息用新环境起进程 |
| POST | /cc/api/sessions/:id/messages | 发送消息（可带图片引用）；终端持有（terminalOwned）的会话返回 409 |
| GET | /cc/api/sessions/:id/context | 当前回合上下文占用（需活跃引擎） |
| GET | /cc/api/sessions/:id/models | 会话视角的模型目录、当前选择与 effort 档位 |
| POST | /cc/api/sessions/:id/model | 切换模型；持久化为该会话默认，忙碌引擎就地热切换 |
| POST | /cc/api/sessions/:id/effort | 切换思考档位；per-session：持久化到该会话，只影响该会话 |
| GET | /cc/api/sessions/:id/usage | 账户用量（需活跃引擎） |
| GET | /cc/api/sessions/:id/commands | CLI 支持的斜杠命令（需活跃引擎） |
| POST | /cc/api/sessions/:id/stop | 中断当前回合 |
| POST | /cc/api/sessions/:id/dialogs/:requestId | 应答 AskUserQuestion（`cancel: true` 取消） |
| POST | /cc/api/sessions/:id/permissions/:requestId | 权限审批（allow / deny，可选 message 与 remember 目标） |
| GET | /cc/api/events | SSE 实时推送（hello / sessions / event / delta / permission / dialog …） |

## 已知限制

- **审批卡片的来源**：插件自身的 `permissionMode` 默认就是 `auto`（config.ts），零配置时 Claude Code 自行允许/拒绝工具请求，页面收不到审批卡片。想在页面里审批，把它显式设为 `default`（cordis 配置或页内设置均可）；本机 `~/.claude/settings.json` 的 `permissions.defaultMode` 是另一条同效果的来源，若设为 `"auto"` 页面同样收不到卡片。
- 权限模式为 `default` 时依赖页面在线答复授权请求；关着页面时请求会一直挂起（关会话则自动拒绝）。
- `bypassPermissions` 会跳过 Claude Code 全部确认，请仅在可信目录使用。
- 终端正在使用的会话（terminalOwned）在页面上只读：发消息返回 409，也无法中断它的回合 —— Windows 无法向其他控制台进程发信号。
- 每个活跃会话是一个真实 claude 进程，受 `maxLiveSessions`（默认 4）约束；被挤出的进程下次发消息时自动 resume。
- 转录读取对页面按尾部 800 条截断；完整记录在数据目录的 JSONL 里。
- SDK 固定为 `@anthropic-ai/claude-agent-sdk@0.3.220`（自带对应版本 CLI 载荷，与本机安装的 claude 版本无关）。
