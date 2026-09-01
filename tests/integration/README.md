# 集成回归（真实中转 + 隔离实例）

对着真实链路的活体回归：每个用例都在 127.0.0.1:3081 起一个隔离的 dsh web 实例
（DSH_HOME 指向已 gitignore 的 `.lab-home/`），spawn 真实 claude 进程走中转模型，
再用 Playwright 驱动真实页面断言。**没有任何 mock。**

## 准备（一次性）

1. `pnpm build`（测试对着 lib/ 产物，改完源码必须先构建）
2. Git for Windows（bash 用于启动实例；自动探测常见安装位置，特殊位置可在
   `credentials.local.json` 加 `"gitBash"` 字段指定）
3. `pip install playwright` + `playwright install chromium`
4. 复制 `credentials.example.json` 为 `credentials.local.json` 填入真实中转配置。
   **该文件已 gitignore，密钥只留在本机。** 缺它时用例整体 SKIP，不会误报失败。

## 运行

```sh
python -m unittest discover -s tests/integration -v          # 全部
python -m unittest discover -s tests/integration -v -k Subagent  # 只跑子代理链路
python -m unittest discover -s tests/integration -v -k Rewind    # 只跑回退链路
```

实例的启动/停止/3081 端口孤儿清理都是自动的；产物（截图等）落在
`.lab-home/it-artifacts/`（已 gitignore）。

## 回归矩阵

### SubagentE2E（对应：两级展示 / 进入输入 / 非阻塞 / 完成即移除）

| 用例 | 断言 |
|---|---|
| test_010 | 任务栏只出现深度 1 子代理一行，且已自动转后台 |
| test_020 | 点行打开两级详情弹窗；输入框发送后清空（转发给子代理） |
| test_031 | 子代理 30s 命令未结束时主线程已回复 MAIN_CONTINUES（不阻塞） |
| test_032 | 运行中子代理工具实时流进弹窗；嵌套 Bash 不泄漏进主任务栏 |
| test_040 | 子代理完成 → 任务栏立即消失 |
| test_050 | Agent 卡内持久嵌套转录含 Glob/Read/Bash；无无名占位行；无 task-notification 泄漏 |
| test_060 | 首轮用户行带 复制/复制回合/回退 三个操作 |
| test_070 | API 终态：任务清空、嵌套工具齐全、回退锚点存在、无浏览器报错 |

### RewindE2E（对应：新会话可用回退）

| 用例 | 断言 |
|---|---|
| test_010 | 末行回退按钮打开弹窗并引用锚消息 |
| test_020 | 确认后锚文本填回输入框（编辑重发语义） |
| test_030 | 原会话删除、fork 新行唯一且 id 不同；第一轮保留、被回退轮次消失 |

## 已知测试环境坑（都在 helpers 里兜住了）

- 3081 被上次实例的 node 孤儿占用（EADDRINUSE）：启动前 `taskkill` 清端口，停止后确认释放。
- 宿主 GUI「添加 API Key」遮罩：新 profile 每次出现，`dismiss_onboarding_mask` 兜底。
- SSE 长连接让 networkidle 永不触发：只用显式 selector/轮询等待。
- 会话首条消息触发 CLI 自动改名：定位 rail 行用实时 name，清理残留按 summary 匹配。
