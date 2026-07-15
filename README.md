# Agent Chrome Plugin

Botmux plugin packaging for ACS — Agent Chrome Stack. It provides one shared
headful Chrome instance, per-session CDP isolation, and two noVNC viewing modes
for each agent CLI session: Follow Agent and Free Browsing.

GitHub: https://github.com/botmux-ai/botmux-plugin-agent-chrome

The original ACS scripts are kept under `bin/` and `lib/`. Runtime state such as
Chrome profile, logs, screenshots, and manifests is intentionally excluded from
this repository and generated under the installed plugin directory.

## Requirements

- Linux with Node.js 20+, npm, Botmux, and Chrome or Chromium.
- Xvfb, openbox, xcompmgr, wmctrl, x11vnc, websockify/noVNC, xdotool,
  ImageMagick, and curl.

`chrome-devtools-mcp@1.5.0` is a pinned build input vendored into the plugin's
self-contained `dist/`. MCP startup uses that bundled runtime and does not keep
`node_modules`, run `npx`, or access the npm registry on each Codex session. The launcher also selects a Node.js
`>=20.19.0` executable instead of inheriting a potentially stale Node.js from a
long-running Codex daemon. Set `ACS_NODE_BIN` to override that selection.

On Debian or Ubuntu, install the system tools with:

```bash
sudo apt-get update
sudo apt-get install -y xvfb openbox xcompmgr wmctrl x11vnc websockify novnc \
  xdotool imagemagick curl
```

Chrome is detected from the machine-local `/data00/google/chrome/chrome` first,
then from common Chrome/Chromium command names. Override it when needed:

```bash
export ACS_CHROME_BIN=/path/to/chrome
```

## Install From npm

Botmux expands the official short id to `@botmux-ai/plugin-agent-chrome`:

```bash
botmux plugin install agent-chrome
botmux plugin enable agent-chrome
botmux plugin service start agent-chrome
botmux agent-chrome:status
```

## Install From The `.tgz`

Use a `file:` URL so Botmux lets npm unpack the tarball and persist only its
self-contained `dist/` runtime:

```bash
botmux plugin install "file:/absolute/path/botmux-ai-plugin-agent-chrome-0.2.0.tgz"
botmux plugin enable agent-chrome
botmux plugin service start agent-chrome
botmux plugin service status
botmux agent-chrome:status
```

If Chrome was not auto-detected, pass the override when starting or restarting
the service:

```bash
ACS_CHROME_BIN=/path/to/chrome botmux plugin service restart agent-chrome
```

After enable, botmux materializes:

- Skill: `agent-chrome`
- MCP server: `agent-chrome`
- CLI command: `botmux agent-chrome:status`
- Dashboard page under Plugins
- Auto PM2 service that can also be controlled by CLI/Dashboard

The service uses `auto` mode. `botmux start` and the start phase of
`botmux restart` ensure the Xvfb + Chrome + broker stack is running. A normal
`botmux stop` leaves it running; use `botmux stop --with-plugin` when the plugin
service should stop with the core. It remains controllable from Dashboard and
with `botmux plugin service start|stop|restart agent-chrome`.

Profile, session manifests, and logs live under `~/.agent-chrome` by default,
separate from the replaceable plugin runtime. Before reinstalling, updating, or
uninstalling the plugin, stop its service explicitly:

```bash
botmux plugin service stop agent-chrome
```

Botmux rejects the lifecycle operation while the service is still running; it
does not stop the service implicitly.

Start a new Codex/agent session after enabling the plugin so it reloads the
`agent-chrome` MCP configuration and skill.

Open the Agent Chrome page from the Botmux Dashboard after an agent creates its
first browser page. The page joins each browser connection to its Botmux CLI
session and provides:

- A session list, with the Bot name and CLI shown as secondary context.
- **Follow Agent**, which tracks the page currently operated by the agent.
- **Free Browsing**, which keeps one stable noVNC URL while you switch among the
  pages owned by that session.
- View-only mode by default, with an explicit switch for keyboard and mouse
  input.
- Copy-link and independent-window actions for the current noVNC stream.

The independent-window action currently opens the raw noVNC view. A dedicated
standalone viewer with its own page switcher is intentionally deferred.

## Local Development

```bash
npm install
npm test
botmux plugin install . --link
botmux plugin enable agent-chrome
botmux plugin service start agent-chrome
botmux agent-chrome:status
```

Publish from the repository root with `npm publish`. The root `package.json` is
the npm envelope; Botmux discards it after reading the manifest and installs
only `dist/`.

## ACS Architecture

ACS provides:

- Single shared Chrome profile for live login reuse.
- Stable Botmux session binding and per-session target filtering.
- Per-session kiosk windows and noVNC views.
- MCP connection through `bin/mcp-launch.sh`.
- Structured native browser-session tools through the Agent Chrome MCP.

Default ports:

- Xvfb: `:77`
- Chrome DevTools: `127.0.0.1:9223`
- ACS broker: `9300`
- per-session VNC: `5910+`
- per-session noVNC: `6090+`

## Runtime Commands

```bash
bash bin/acs-up.sh
bash bin/acs-down.sh --all
curl http://127.0.0.1:9300/health
curl http://127.0.0.1:9300/sessions
```

The Agent Chrome MCP adds two session-scoped tools alongside the standard Chrome
DevTools tools:

- `browser_session_info`
- `browser_session_set_writable`

Four entry tools require the exact current Botmux `<session_id>` in a
`sessionId` argument: `list_pages`, `new_page`, `browser_session_info`, and
`browser_session_set_writable`. The wrapper consumes that argument, binds its
short-lived MCP transport to the stable Botmux session, and does not forward the
extra argument to the upstream Chrome DevTools MCP. All other Chrome tools reuse
the established binding. The stable session id is identity only; broker access
continues to use a separate random transport token.

When Botmux Gateway supplies `BOTMUX_SESSION_ID`, the wrapper also attaches that
trusted id to its initial broker WebSocket. Dashboard metadata is therefore
linked before the model's first tool call; explicit entry-tool arguments remain
validated against the same id.

If the CLI/MCP process reconnects, a new transport can rebind to the same
`sessionId` during the broker grace period, preserving its pages and noVNC view.
`browser_session_info` includes both follow and free-view noVNC URLs.

`bin/browser-session` remains available for operator diagnostics only and
requires an explicit `ACS_SESSION_TOKEN`. Agents should use the MCP tools.

Stop or restart the browser stack with:

```bash
botmux plugin service stop agent-chrome
botmux plugin service restart agent-chrome
```

The broker overview and per-session noVNC ports expose browser-session metadata
and interactive views. Keep ports `9300` and `6090+` on a trusted network or
restrict them with the host firewall.

## Test Coverage From ACS

The original ACS test scripts are preserved under `test/`:

- `check-dpr.js`
- `check-window-map.js`
- `check-isolation.js`
- `check-vnc.js`
- `check-puppeteer.js`
- `check-writable-toggle.js`
- `check-view-modes.js`
- `check-3session.js`
- `check-mcp-e2e.js`

These tests require Chrome, Xvfb, xdotool, x11vnc, websockify/noVNC, and the
local machine runtime environment.
