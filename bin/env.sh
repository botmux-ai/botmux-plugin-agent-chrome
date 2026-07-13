#!/usr/bin/env bash
set -euo pipefail

# Shared ACS runtime environment. Keep values overridable for manual runs.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_ACS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ACS_ROOT="${ACS_ROOT:-$DEFAULT_ACS_ROOT}"
if [ -n "${BOTMUX_PLUGIN_HOME:-}" ]; then
  DEFAULT_ACS_DATA_ROOT="$BOTMUX_PLUGIN_HOME"
elif [ "$(basename "$ACS_ROOT")" = "dist" ]; then
  DEFAULT_ACS_DATA_ROOT="$(dirname "$ACS_ROOT")"
else
  DEFAULT_ACS_DATA_ROOT="$ACS_ROOT"
fi
ACS_DATA_ROOT="${ACS_DATA_ROOT:-$DEFAULT_ACS_DATA_ROOT}"
ACS_DISPLAY="${ACS_DISPLAY:-:77}"
ACS_SCREEN_W="${ACS_SCREEN_W:-3456}"
ACS_SCREEN_H="${ACS_SCREEN_H:-2234}"
ACS_DPR="${ACS_DPR:-2}"
ACS_LOGICAL_W="${ACS_LOGICAL_W:-1728}"
ACS_LOGICAL_H="${ACS_LOGICAL_H:-1117}"

# Prefer an explicit override, then the machine-local Chrome bundle, followed by
# common Linux package names. Resolve command names to absolute paths so the
# PM2-managed service does not depend on a later PATH change.
if [ -n "${ACS_CHROME_BIN:-}" ]; then
  :
elif [ -n "${CHROME_BIN:-}" ]; then
  ACS_CHROME_BIN="$CHROME_BIN"
else
  for chrome_candidate in \
    /data00/google/chrome/chrome \
    google-chrome-stable \
    google-chrome \
    chromium \
    chromium-browser; do
    if [[ "$chrome_candidate" == */* ]]; then
      [ -x "$chrome_candidate" ] || continue
      ACS_CHROME_BIN="$chrome_candidate"
    else
      chrome_candidate_path="$(command -v "$chrome_candidate" 2>/dev/null || true)"
      [ -n "$chrome_candidate_path" ] || continue
      ACS_CHROME_BIN="$chrome_candidate_path"
    fi
    break
  done
fi
ACS_CHROME_BIN="${ACS_CHROME_BIN:-/data00/google/chrome/chrome}"
if [[ "$ACS_CHROME_BIN" != */* ]]; then
  chrome_candidate_path="$(command -v "$ACS_CHROME_BIN" 2>/dev/null || true)"
  [ -z "$chrome_candidate_path" ] || ACS_CHROME_BIN="$chrome_candidate_path"
fi
ACS_CHROME_PORT="${ACS_CHROME_PORT:-9223}"
ACS_BROKER_PORT="${ACS_BROKER_PORT:-9300}"
ACS_VNC_BASE="${ACS_VNC_BASE:-5910}"
ACS_NOVNC_BASE="${ACS_NOVNC_BASE:-6090}"
ACS_NOVNC_WEB="${ACS_NOVNC_WEB:-/usr/share/novnc}"
ACS_PROFILE="${ACS_PROFILE:-$ACS_DATA_ROOT/profile}"
ACS_TMP="${ACS_TMP:-$ACS_DATA_ROOT/tmp}"
ACS_RUN="${ACS_RUN:-$ACS_DATA_ROOT/run}"
ACS_MANIFESTS="${ACS_MANIFESTS:-$ACS_RUN/manifests}"
ACS_LOGS="${ACS_LOGS:-$ACS_DATA_ROOT/logs}"
ACS_BIN="${ACS_BIN:-$ACS_ROOT/bin}"

export ACS_ROOT ACS_DATA_ROOT ACS_DISPLAY ACS_SCREEN_W ACS_SCREEN_H ACS_DPR ACS_LOGICAL_W ACS_LOGICAL_H
export ACS_CHROME_BIN ACS_CHROME_PORT ACS_BROKER_PORT ACS_VNC_BASE ACS_NOVNC_BASE ACS_NOVNC_WEB
export ACS_PROFILE ACS_TMP ACS_RUN ACS_MANIFESTS ACS_LOGS ACS_BIN

mkdir -p "$ACS_PROFILE" "$ACS_TMP" "$ACS_RUN" "$ACS_MANIFESTS" "$ACS_LOGS"
