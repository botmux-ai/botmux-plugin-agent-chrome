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

exec npx -y chrome-devtools-mcp@latest --wsEndpoint="$WS" "$@"
