---
name: agent-chrome
description: Use the Agent Chrome Stack browser session provided by botmux.
---

# Agent Chrome

Use the `agent-chrome` MCP server for browser automation. When you need to inspect
the visible browser session, use the `browser-session` helper from the plugin.

Useful shell commands:

```bash
"$HOME/.botmux/plugins/agent-chrome/dist/bin/browser-session" info
"$HOME/.botmux/plugins/agent-chrome/dist/bin/browser-session" vnc
"$HOME/.botmux/plugins/agent-chrome/dist/bin/browser-session" writable on
"$HOME/.botmux/plugins/agent-chrome/dist/bin/browser-session" screenshot /tmp/browser.png
```

Only operate through the helper or the MCP server. Do not use the shared X11
display directly.
