#!/usr/bin/env bash
# L2 浏览器层：单实例 headful Chrome，挂在共享 Xvfb 上。
# - 共享单 profile（持久盘）→ 实时共享登录
# - --force-device-scale-factor=2 → 对齐 16" MBP 的 Retina(DPR2)
# - 调试端口仅本地，只给 broker 连
# - 幂等：端口已健康则复用；清理 Singleton* 野锁
set -euo pipefail
source "$(dirname "$0")/env.sh"

# 已健康则复用
if curl -fsS "http://127.0.0.1:${ACS_CHROME_PORT}/json/version" >/dev/null 2>&1; then
  echo "[chrome] already healthy on :${ACS_CHROME_PORT}, reuse"
  exit 0
fi

# 清野锁（被 kill/OOM 后残留的单例锁）
rm -f "$ACS_PROFILE"/Singleton* 2>/dev/null || true

export DISPLAY="$ACS_DISPLAY"
export TMPDIR="$ACS_TMP"

[ -x "$ACS_CHROME_BIN" ] || {
  echo "[chrome] executable not found: $ACS_CHROME_BIN" >&2
  echo "[chrome] set ACS_CHROME_BIN to a Chrome/Chromium executable" >&2
  exit 1
}

echo "[chrome] launching headful chrome on $ACS_DISPLAY port $ACS_CHROME_PORT"
"$ACS_CHROME_BIN" \
  --no-sandbox \
  --no-first-run --no-default-browser-check --noerrdialogs \
  --disable-features=Translate,InfiniteSessionRestore \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="${ACS_CHROME_PORT}" \
  --user-data-dir="$ACS_PROFILE" \
  --force-device-scale-factor="${ACS_DPR}" \
  --window-position=0,0 \
  --window-size="${ACS_LOGICAL_W},${ACS_LOGICAL_H}" \
  --class=acs-chrome \
  about:blank \
  >"$ACS_LOGS/chrome.log" 2>&1 &

# 等调试端口就绪
for i in $(seq 1 100); do
  curl -fsS "http://127.0.0.1:${ACS_CHROME_PORT}/json/version" >/dev/null 2>&1 && {
    echo "[chrome] ready on :${ACS_CHROME_PORT}"; exit 0; }
  sleep 0.1
done
echo "[chrome] FAILED to become ready, see $ACS_LOGS/chrome.log" >&2
exit 1
