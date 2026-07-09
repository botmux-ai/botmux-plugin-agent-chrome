#!/usr/bin/env bash
# 一键拉起整条常驻栈（手动编排版；systemd 版见 systemd/）：
#   L1 Xvfb+合成器 → L2 chrome → L3 broker
# 幂等：各步自带"已在则复用"。
set -euo pipefail
source "$(dirname "$0")/env.sh"

bash "$ACS_BIN/start-display.sh"
bash "$ACS_BIN/start-chrome.sh"

# broker：端口已健康则不重起
if curl -fsS "http://127.0.0.1:${ACS_BROKER_PORT}/sessions" >/dev/null 2>&1; then
  echo "[broker] already up on :${ACS_BROKER_PORT}"
else
  echo "[broker] starting on :${ACS_BROKER_PORT}"
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
