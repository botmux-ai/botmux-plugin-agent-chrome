#!/usr/bin/env bash
# L5 接入层：未改动的 chrome-devtools-mcp 的"启动命令替身"。
# CLI 只执行配置里的 command，本脚本就是那条 command，透明 exec 真 MCP。
# 每次被调（= 一个 session 起一个 MCP 进程）mint 一个 token，
# 通过 --wsEndpoint 把 token 带进 broker（ws 路径不会被 puppeteer 吞掉）。
#
# 同时把 token 落到一个按"父进程(=CLI)pid"命名的文件，供同一 CLI 下的
# browser-session helper（agent 的 Bash 工具）反查自己的 session。
set -euo pipefail
source "$(dirname "$0")/env.sh"

# token：优先用 CLI 注入的 env，否则按进程生成（每个 MCP 进程一个）
TOKEN="${ACS_SESSION_TOKEN:-$(cat /proc/sys/kernel/random/uuid)}"

# 记录 token，键为本进程的父 pid（即启动 MCP 的 CLI 进程）
BYPID_DIR="$ACS_RUN/sessions/by-pid"
mkdir -p "$BYPID_DIR"
CLI_PID="$PPID"
echo "$TOKEN" > "$BYPID_DIR/${CLI_PID}.token"
# MCP 退出即清理（会话结束）
trap 'rm -f "$BYPID_DIR/${CLI_PID}.token"' EXIT

WS="ws://127.0.0.1:${ACS_BROKER_PORT}/s/${TOKEN}/devtools/browser/$(cat /proc/sys/kernel/random/uuid | tr -d -)"

find_mcp_entry() {
  if [ -n "${ACS_MCP_BIN:-}" ]; then
    [ -f "$ACS_MCP_BIN" ] && readlink -f "$ACS_MCP_BIN"
    return 0
  fi

  local bundled="$ACS_ROOT/vendor/chrome-devtools-mcp/src/bin/chrome-devtools-mcp.js"
  [ -f "$bundled" ] && printf '%s\n' "$bundled"
  return 0
}

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

MCP_ENTRY="$(find_mcp_entry)"
if [ -z "$MCP_ENTRY" ]; then
  echo "agent-chrome: bundled chrome-devtools-mcp@1.5.0 is missing from $ACS_ROOT" >&2
  echo "agent-chrome: rebuild or reinstall the plugin dist" >&2
  exit 127
fi

NODE_BIN="$(find_node_bin)"
if [ -z "$NODE_BIN" ]; then
  echo "agent-chrome: Node.js >=20.19.0 is required by chrome-devtools-mcp@1.5.0" >&2
  echo "agent-chrome: set ACS_NODE_BIN to a compatible Node.js executable" >&2
  exit 127
fi

exec "$NODE_BIN" "$MCP_ENTRY" --wsEndpoint="$WS" "$@"
