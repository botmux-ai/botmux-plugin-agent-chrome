#!/usr/bin/env bash
# 一键拉起整条常驻栈（手动编排版；systemd 版见 systemd/）：
#   L1 Xvfb+合成器 → L2 chrome → L3 broker
# 幂等：各步自带"已在则复用"。
set -euo pipefail
source "$(dirname "$0")/env.sh"
cd "$ACS_RUN"

bash "$ACS_BIN/start-display.sh"
bash "$ACS_BIN/start-chrome.sh"

# broker：端口已健康则不重起
if curl -fsS "http://127.0.0.1:${ACS_BROKER_PORT}/sessions" >/dev/null 2>&1; then
  echo "[broker] already up on :${ACS_BROKER_PORT}"
else
  # broker 异常退出时，x11vnc/websockify 可能成为孤儿进程。新 broker 会从
  # 基础端口重新分配，先回收插件专属端口段，避免连到旧 Session 的画面。
  echo "[broker] cleaning stale VNC listeners"
  stale_pids=()
  for port in $(seq "$ACS_VNC_BASE" $((ACS_VNC_BASE+40))) $(seq "$ACS_NOVNC_BASE" $((ACS_NOVNC_BASE+40))); do
    pid=$(ss -ltnp 2>/dev/null | grep ":${port} " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)
    if [ -n "$pid" ]; then
      stale_pids+=("$pid")
      kill "$pid" 2>/dev/null || true
    fi
  done
  sleep 0.2
  for pid in "${stale_pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
  done
  echo "[broker] starting on :${ACS_BROKER_PORT}"
  # The distributable directory is replaced on update. All long-lived processes
  # inherit ACS_RUN as their stable working directory.
  nohup node "$ACS_BIN/broker.js" >"$ACS_LOGS/broker.log" 2>&1 &
  for i in $(seq 1 50); do
    curl -fsS "http://127.0.0.1:${ACS_BROKER_PORT}/sessions" >/dev/null 2>&1 && break; sleep 0.1
  done
fi

echo "=== ACS stack ready ==="
echo "  display : $ACS_DISPLAY (${ACS_SCREEN_W}x${ACS_SCREEN_H}, DPR$ACS_DPR → ${ACS_LOGICAL_W}x${ACS_LOGICAL_H})"
echo "  chrome  : 127.0.0.1:${ACS_CHROME_PORT} (仅本地)"
echo "  broker  : http://127.0.0.1:${ACS_BROKER_PORT}  总览 http://$(hostname -I 2>/dev/null | awk '{print $1}'):${ACS_BROKER_PORT}/"
echo "  接入    : MCP 用 --wsEndpoint=ws://127.0.0.1:${ACS_BROKER_PORT}/s/<token>/devtools/browser/x （或经 bin/mcp-launch.sh 自动分配）"
