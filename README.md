# Agent Chrome Plugin

Botmux plugin packaging for ACS — Agent Chrome Stack. It provides one shared
headful Chrome instance, per-session CDP isolation, and per-session noVNC views
for agent CLIs.

The original ACS scripts are kept under `bin/` and `lib/`. Runtime state such as
Chrome profile, logs, screenshots, and manifests is intentionally excluded from
this repository and generated under the installed plugin directory.

## Botmux Usage

```bash
botmux plugin install @botmux-ai/plugin-agent-chrome
botmux plugin enable agent-chrome
botmux plugin service start agent-chrome
botmux plugin service status
botmux agent-chrome:status
```

After enable, botmux materializes:

- Skill: `agent-chrome`
- MCP server: `agent-chrome`
- CLI command: `botmux agent-chrome:status`
- Dashboard page under Plugins
- Manual PM2 service controlled by CLI/Dashboard

The service is `manual` by default because it runs a full Xvfb + Chrome + broker
stack. It does not start automatically on `botmux start`; users start it from
Dashboard or with `botmux plugin service start agent-chrome`.

## Local Development

```bash
npm install
npm test
botmux plugin install . --link
botmux plugin enable agent-chrome
botmux plugin service start agent-chrome
botmux agent-chrome:status
```

## ACS Architecture

ACS provides:

- Single shared Chrome profile for live login reuse.
- Per-session broker tokens and target filtering.
- Per-session kiosk windows and noVNC views.
- MCP connection through `bin/mcp-launch.sh`.
- Restricted browser helper through `bin/browser-session`.

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

Agent-side helper:

```bash
browser-session info
browser-session vnc
browser-session writable on
browser-session screenshot /tmp/browser.png
```

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

