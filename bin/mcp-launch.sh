#!/usr/bin/env bash
# Agent Chrome MCP launcher. It selects a compatible Node.js runtime and starts
# the plugin's composite MCP server. The composite server owns the session token,
# proxies chrome-devtools-mcp, and adds the native browser-session tools.
set -euo pipefail
source "$(dirname "$0")/env.sh"

node_is_supported() {
  [ -x "$1" ] || return 1
  "$1" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major > 20 || (major === 20 && minor >= 19) ? 0 : 1);
  ' >/dev/null 2>&1
}

find_node_bin() {
  if [ -n "${ACS_NODE_BIN:-}" ]; then
    node_is_supported "$ACS_NODE_BIN" && printf '%s\n' "$ACS_NODE_BIN"
    return 0
  fi

  local path_node
  path_node="$(command -v node 2>/dev/null || true)"
  if [ -n "$path_node" ] && node_is_supported "$path_node"; then
    printf '%s\n' "$path_node"
    return
  fi

  local candidate
  for candidate in \
    "$HOME"/.nvm/versions/node/*/bin/node \
    /usr/local/bin/node \
    /opt/homebrew/bin/node \
    /usr/bin/node; do
    if node_is_supported "$candidate"; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  return 0
}

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MCP_SERVER="${ACS_PLUGIN_MCP_SERVER:-$PLUGIN_ROOT/mcp/server.js}"
if [ ! -f "$MCP_SERVER" ]; then
  echo "agent-chrome: composite MCP server is missing from $MCP_SERVER" >&2
  echo "agent-chrome: rebuild or reinstall the plugin dist" >&2
  exit 127
fi

NODE_BIN="$(find_node_bin)"
if [ -z "$NODE_BIN" ]; then
  echo "agent-chrome: Node.js >=20.19.0 is required by chrome-devtools-mcp@1.5.0" >&2
  echo "agent-chrome: set ACS_NODE_BIN to a compatible Node.js executable" >&2
  exit 127
fi

exec "$NODE_BIN" "$MCP_SERVER" "$@"
