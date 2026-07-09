#!/usr/bin/env bash
# L1 显示层：启动 Xvfb + openbox(微型WM) + xcompmgr(合成器)
# 幂等：已在则复用。合成器是刚需——多 kiosk 窗口叠加时，
# 被遮挡窗口需有独立后备缓冲，否则 x11vnc -id 抓出黑屏。
set -euo pipefail
source "$(dirname "$0")/env.sh"

DNUM="${ACS_DISPLAY#:}"

if [ -e "/tmp/.X11-unix/X${DNUM}" ]; then
  echo "[display] Xvfb $ACS_DISPLAY already running, reuse"
else
  echo "[display] starting Xvfb $ACS_DISPLAY ${ACS_SCREEN_W}x${ACS_SCREEN_H}x24"
  Xvfb "$ACS_DISPLAY" -screen 0 "${ACS_SCREEN_W}x${ACS_SCREEN_H}x24" \
    -ac +extension RANDR +extension GLX +render -nolisten tcp \
    >"$ACS_LOGS/xvfb.log" 2>&1 &
  for i in $(seq 1 50); do [ -e "/tmp/.X11-unix/X${DNUM}" ] && break; sleep 0.1; done
fi

export DISPLAY="$ACS_DISPLAY"

# openbox：提供窗口管理（fullscreen/标题/窗口id 才规整）
if ! pgrep -f "openbox.*--config-file.*acs|openbox --sm-disable" >/dev/null 2>&1 && \
   ! DISPLAY="$ACS_DISPLAY" wmctrl -m >/dev/null 2>&1; then
  echo "[display] starting openbox on $ACS_DISPLAY"
  DISPLAY="$ACS_DISPLAY" openbox --sm-disable >"$ACS_LOGS/openbox.log" 2>&1 &
  sleep 0.5
else
  echo "[display] WM already present"
fi

# xcompmgr：合成器，给每个窗口独立后备缓冲。picom 在这台 Xvfb 上会 SEGV。
if ! pgrep -f "xcompmgr -n" >/dev/null 2>&1; then
  echo "[display] starting xcompmgr compositor"
  DISPLAY="$ACS_DISPLAY" xcompmgr -n \
    >"$ACS_LOGS/xcompmgr.log" 2>&1 &
  sleep 0.3
else
  echo "[display] xcompmgr already present"
fi

echo "[display] ready: DISPLAY=$ACS_DISPLAY"
