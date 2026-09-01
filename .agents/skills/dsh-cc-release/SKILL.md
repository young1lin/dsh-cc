---
description: dsh-cc 仓库专用的发布流程——当用户要求发布新版本、发 tag、bump 版本、准备更新、发 patch 时自动使用。版本号按语义升级，发布提交 + annotated tag + 推送 + 盯 npm 发布完成。
---

# dsh-cc 发布流程

仅适用于 dsh-cc 仓库。发布 = 版本号 patch 升级（用户说 minor/major 按语义）+ 发布提交 + annotated tag + 推送 + 确认 npm 自动发布成功。

## 0. 前置（任一不满足即停下）

- 工作区干净（`git status --short` 为空）
- `pnpm typecheck` + `pnpm build` + `node scripts/client-smoke.mjs` 全绿
- 集成回归全量 16 用例通过：`python -m unittest discover -s tests/integration -v`

## 1. 版本与发布提交

- 读 `package.json` 当前 version，默认 patch +1（如 0.1.4 → 0.1.5）。
- 只改 `package.json` 的 version 字段，提交信息：

```
chore: 发布 vX.Y.Z —— <本版核心要点，一行>

- 要点 1
- 要点 2
```

## 2. tag 与推送

```sh
git tag -a vX.Y.Z -m "<与发布提交同样的要点>"
git push origin main --follow-tags
```

## 3. 盯自动发布

推送即触发 GitHub Actions 的 `Publish npm package`（tag 触发）：

```
GET https://api.github.com/repos/young1lin/dsh-cc/actions/runs?per_page=2
GET https://registry.npmjs.org/@young1lin/dsh-cc   # dist-tags.latest 应变为新版本
```

轮询到 workflow success 且 npm latest = 新版本才算发布完成，向用户报告。

## 4. 发布后提示用户

- 其他环境更新：`dsh plugin --profile web add @young1lin/dsh-cc@X.Y.Z`
- 本机 link 安装（3080）：node 半区有改动时需重启 dsh + 刷新页面

## 5. 失败回滚

- workflow 失败：`git tag -d vX.Y.Z` + `git revert` 发布提交，修复后重新走流程；不 force push。
- npm 上已发布成功则不可撤回，只能发 patch 修复版。