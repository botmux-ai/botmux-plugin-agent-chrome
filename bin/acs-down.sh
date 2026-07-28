#!/usr/bin/env bash
# 停整条栈 + 清理本系统起的 per-session vnc/novnc 与 chrome 窗口。
# 只动本系统资源（:77、591x/609x、acs-chrome 窗口、9223/9300），不碰 :99/:100 等他人设置。
source "$(dirname "$0")/env.sh"

# broker
BPID=$(ss -ltnp 2>/dev/null | grep ":${ACS_BROKER_PORT}" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)
[ -n "$BPID" ] && { echo "stopping broker $BPID"; kill "$BPID" 2>/dev/null; }

# 本系统的 per-session x11vnc / websockify（端口段 591x/609x）
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

# chrome（按调试端口确认是本系统的再关）
if [ "${1:-}" = "--all" ]; then
  CPID=$(ss -ltnp 2>/dev/null | grep ":${ACS_CHROME_PORT}" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)
  [ -n "$CPID" ] && { echo "stopping chrome $CPID"; kill "$CPID" 2>/dev/null; }
  echo "（--all：Xvfb/openbox/picom 保留，如需彻底停： pkill -f 'Xvfb :77'）"
fi

rm -f "$ACS_MANIFESTS"/*.json 2>/dev/null
echo "done. (默认保留 chrome/display；加 --all 连 chrome 一起停)"
