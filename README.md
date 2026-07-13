# Agent Chrome Plugin

Botmux plugin packaging for ACS — Agent Chrome Stack. It provides one shared
headful Chrome instance, per-session CDP isolation, and per-session noVNC views
for agent CLIs.

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
botmux plugin install "file:/absolute/path/agent-chrome-botmux-plugin-0.1.1.tgz"
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

Start a new Codex/agent session after enabling the plugin so it reloads the
`agent-chrome` MCP configuration and skill.

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
- Per-session broker tokens and target filtering.
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

The Agent Chrome MCP adds these session-scoped tools alongside the standard
Chrome DevTools tools:

- `browser_session_info`
- `browser_session_get_vnc_url`
- `browser_session_set_writable`
- `browser_session_screenshot`
- `browser_session_activate`
- `browser_session_send_keys`
- `browser_session_click`

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
- `check-3session.js`
- `check-mcp-e2e.js`

These tests require Chrome, Xvfb, xdotool, x11vnc, websockify/noVNC, and the
local machine runtime environment.
