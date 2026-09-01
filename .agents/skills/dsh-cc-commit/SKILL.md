---
description: dsh-cc 仓库专用的提交前流程——当用户要求 commit、提交改动、入库时自动使用。执行本仓库提交前检查链（typecheck/build/client-smoke/集成用例/隐私闸门）后再生成符合仓库风格的提交。
---

# dsh-cc 提交前流程

仅适用于 dsh-cc 仓库。用户说「commit / 提交 / 入库」时按顺序执行以下步骤，任何一步失败即停下报告，不得跳过。

## 1. 检查链（按序，全绿才继续）

```sh
pnpm typecheck                 # 必过
pnpm build                     # lib/ 必须与源码一致
node scripts/client-smoke.mjs  # client 包烟雾
```

## 2. 集成用例（按改动范围选择）

```sh
python -m unittest discover -s tests/integration -v -k ResultModel  # 结果/模型/上下文条
python -m unittest discover -s tests/integration -v -k Subagent     # 子代理链路
python -m unittest discover -s tests/integration -v -k Rewind       # 回退链路
```

- 改了任务栏/子代理/回退/转录渲染/进度条 → 至少跑对应类；拿不准就全量（约 4 分钟）。
- 集成测试需要 `tests/integration/.env`（已 gitignore）；缺失时用例会 SKIP，不视为通过。

## 3. 升级过 @anthropic-ai/claude-agent-sdk 时

先 `node scripts/cli-contract.mjs`，断言全过才能继续。

## 4. 隐私闸门（staged 内容逐项扫描，全部零命中才提交）

```
git add -A 之后：
- git diff --cached 中不得出现：用户名、真实 token 片段（运行时从 tests/integration/.env 取值比对，不把前缀写进本文件）、C:\Users 与盘符根等本机绝对路径
- 不得 stage：tests/integration/.env、__pycache__/、*.pyc、.lab-home/ 内部产物、*.log
- tests/integration/.env.example 只允许占位符（AUTH_TOKEN=<你的中转 token>）
```

## 5. 提交

- 信息风格：`feat|chore|fix|test: 中文标题 —— 破折号后接要点详情`（参考 git log）。
- 换行由 .gitattributes 强制 LF，不要用会改写整文件换行的手段。
- 用户明确说 push 才 push：`git push origin main --follow-tags`。

## 例外说明

- `C:/Program Files/Git/...`（标准安装位置）、`https://open.bigmodel.cn`、glm 模型 id 属可接受项。
- CI 里的防泄漏闸门（.github/workflows/publish.yml）会在发布前再拦一次。