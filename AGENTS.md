# AGENTS.md

Guidance for AI agents (and humans) working in this repository.

## What This Is

`@botmux-ai/plugin-agent-chrome` — the Agent Chrome Stack plugin for
[botmux](https://github.com/deepcoldy/botmux). It provides one shared headful
Chrome instance, per-session CDP isolation, and per-session noVNC views
(Follow / Free Browsing) for botmux CLI sessions.

- npm: https://www.npmjs.com/package/@botmux-ai/plugin-agent-chrome
- 插件运行时状态（profile、日志、密码等）不进仓库，生成在安装目录 / `ACS_DATA_ROOT` 下。

## Layout

| Path | Purpose |
| --- | --- |
| `bin/broker.js` | L3 broker 源码（CDP 隔离、窗口映射、per-session VNC）。esbuild 打包进 `dist/`，**直接改这个文件** |
| `bin/*.sh` | L1 显示层 / L2 Chrome / 启停脚本 |
| `lib/cdp.js` | CDP 连接辅助 |
| `src/mcp/` | MCP server（对 agent 暴露的工具） |
| `service/` | botmux 插件 service runner（拉起 broker、健康检查） |
| `dashboard/` | 插件面板（React，esbuild 打包） |
| `skills/` | 交付给 botmux 的 skill 文档 |
| `test/` | 测试（见下） |
| `scripts/build.mjs` | 构建：esbuild bundle → `dist/` |

## Build & Test

```bash
npm install        # devDependencies（esbuild / chrome-devtools-mcp / novnc / ws / react）
npm run build      # 产物在 dist/
npm run validate   # dist 结构校验
npm test           # build + validate + 全部 hermetic 检查（不需要真实 X/Chrome）
```

`test/` 下两类测试：

- **hermetic**（`npm test` 跑）：假 Chrome + 临时目录，CI 可跑。如
  `check-broker-binding.js`、`check-vnc-password.js`。
- **live**（需真实 Xvfb/Chrome/x11vnc 环境，手动跑）：`check-vnc.js`、
  `check-window-map.js`、`check-3session.js` 等。

改完 `bin/broker.js` 等源码后**必须 `npm run build`**，`dist/` 才是发布物。

## 发版流程（tag 触发 CI 自动发）

**只在 main 打 `v*` tag 才会发版**，workflow 见
`.github/workflows/publish.yml`：校验 tag 在 main 上 → 校验版本号一致 →
`npm ci && npm test` → `npm publish`。

步骤：

```bash
# 1. 改版本号（走 PR，不能直推 main）
git checkout -b release/x.y.z
npm version x.y.z --no-git-tag-version   # 同步改 package.json + package-lock.json
git commit -am "chore: release x.y.z"
git push -u origin release/x.y.z
# 2. 开 PR，等 CODEOWNERS approve 后合并
# 3. 拉最新 main，打 tag 推送
git checkout main && git pull
git tag vx.y.z
git push origin vx.y.z
# 4. Actions 自动发版：https://github.com/botmux-ai/botmux-plugin-agent-chrome/actions
```

注意：

- tag 名必须是 `v` + 完整版本号（`v0.3.0` ↔ `package.json` 的 `0.3.0`），不一致 CI 会失败。
- 认证走 npm trusted publishing (OIDC)，无需长期 token；npmjs.com 包设置里
  Trusted Publishers 需指向本仓库 + `.github/workflows/publish.yml`。
- 发版后 bnpm 等内网镜像同步可能有延迟；验证安装可用
  `npm_config_registry=https://registry.npmjs.org botmux plugin install @botmux-ai/plugin-agent-chrome`。

## 约定

- 提交信息用 conventional commits（`feat:` / `fix:` / `chore:` / `ci:`）。
- main 是保护分支，一切改动走 PR，CODEOWNERS（@deepcoldy @TGGgbone）review。
- 运行时密钥/密码不进仓库；VNC 密码由 broker 首次启动随机生成，存
  `ACS_DATA_ROOT/private/`（0600），详见 README "VNC Access Control"。
