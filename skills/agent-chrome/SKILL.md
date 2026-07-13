---
name: agent-chrome
description: Use the Agent Chrome Stack browser session provided by botmux.
---

# Agent Chrome

Use the `agent-chrome` MCP server for all browser automation and visible-session
operations. Do not access the shared X11 display directly.

Use the regular Chrome DevTools tools for pages and DOM interactions. Use the
structured session tools only when the task needs the native browser window:

- `browser_session_info`: inspect the current window and noVNC state.
- `browser_session_get_vnc_url`: get the human-viewable noVNC URL.
- `browser_session_set_writable`: allow or prevent human noVNC input.
- `browser_session_screenshot`: capture the native browser window.
- `browser_session_activate`: bring the native window to the front.
- `browser_session_send_keys` and `browser_session_click`: use bounded native
  input only when browser chrome or another non-DOM surface requires it.

Prefer the normal page-level MCP tools whenever they can complete the task.
