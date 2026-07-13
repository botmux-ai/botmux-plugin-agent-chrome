#!/usr/bin/env bash
# 全量自测：逐项跑，汇总 PASS/FAIL。前提：ACS 栈已起（systemd 或 acs-up.sh）。
cd "$(dirname "$0")/.."
source bin/env.sh

# 前置健康检查
curl -fsS "http://127.0.0.1:${ACS_BROKER_PORT}/sessions" >/dev/null 2>&1 || { echo "broker 未运行，先 systemctl start acs-broker 或 bash bin/acs-up.sh"; exit 1; }

declare -a TESTS=(
  "对齐16寸/DPR2:check-dpr.js"
  "窗口id映射+遮挡截图:check-window-map.js"
  "硬隔离(可见性+关闭防护):check-isolation.js"
  "noVNC就绪:check-vnc.js"
  "真实puppeteer隔离:check-puppeteer.js"
  "只读可写切换:check-writable-toggle.js"
  "Follow/自由浏览状态机:check-view-modes.js"
  "3并发session隔离:check-3session.js"
  "端到端真实MCP:check-mcp-e2e.js"
)
pass=0; fail=0
for entry in "${TESTS[@]}"; do
  name="${entry%%:*}"; file="${entry##*:}"
  printf "▶ %-28s ... " "$name"
  if timeout 100 node "test/$file" >"/tmp/acs-test-$file.log" 2>&1; then
    echo "PASS"; pass=$((pass+1))
  else
    echo "FAIL (见 /tmp/acs-test-$file.log)"; fail=$((fail+1))
  fi
done
echo "──────────────────────────────"
echo "合计: $pass PASS / $fail FAIL"
exit $fail
