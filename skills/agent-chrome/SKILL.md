---
name: agent-chrome
description: Use the Agent Chrome Stack browser session provided by botmux.
---

# Agent Chrome

Use the `agent-chrome` MCP server for all browser automation and visible-session
operations. Do not access the shared X11 display directly.

Pass the exact current Botmux `<session_id>` as `sessionId` whenever calling one
of these session-entry tools:

- `list_pages`
- `new_page`
- `browser_session_info`
- `browser_session_set_writable`

The entry call binds this MCP connection to that stable Botmux session. Other
Chrome DevTools tools then inherit the binding and do not accept `sessionId`.
Never invent or reuse a session id from another conversation.

Use `browser_session_info` to inspect the current pages, follow/free view state,
and human-viewable noVNC URLs. Use `browser_session_set_writable` to allow or
prevent human noVNC input.

Prefer the normal page-level MCP tools whenever they can complete the task.
