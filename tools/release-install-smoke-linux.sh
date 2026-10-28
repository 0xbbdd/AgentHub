#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
appimage="$(find "$repo/release" -maxdepth 1 -name '*.AppImage' | head -1)"
deb="$(find "$repo/release" -maxdepth 1 -name '*.deb' | head -1)"
[ -n "$appimage" ] || { echo "未找到 AppImage" >&2; exit 1; }
[ -n "$deb" ] || { echo "未找到 DEB" >&2; exit 1; }
chmod +x "$appimage"

root="$(mktemp -d "${RUNNER_TEMP:-/tmp}/agenthub-linux-smoke.XXXXXX")"
cleanup() { rm -rf "$root"; }
trap cleanup EXIT

run_app() {
  local bin="$1" label="$2"
  local rc=0
  AGENTHUB_ALLOW_MULTI=1 \
  AGENTHUB_DATA_DIR="$root/data-$label" \
  AGENT_SKILLS_HOME="$root/skills-$label" \
  HOME="$root/home-$label" \
  XDG_CONFIG_HOME="$root/config-$label" \
  XDG_DATA_HOME="$root/data-home-$label" \
  ELECTRON_DISABLE_GPU=1 \
  APPIMAGE_EXTRACT_AND_RUN=1 \
  timeout 10s dbus-run-session -- xvfb-run -a "$bin" --no-sandbox >"$root/$label.log" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 124 ]; then
    cat "$root/$label.log" >&2
    echo "$label 启动失败，exit=$rc" >&2
    return 1
  fi
  crash_log="$root/config-$label/AgentHub-dev/logs/crash.log"
  if ! grep -q " boot v" "$crash_log" 2>/dev/null; then
    cat "$root/$label.log" >&2
    echo "$label 未产生启动留痕：$crash_log" >&2
    return 1
  fi
  echo "$label 启动 smoke 通过"
}

run_app "$appimage" "appimage"
dpkg-deb --info "$deb" >/dev/null

if [ "${AGENTHUB_INSTALL_DEB:-0}" = "1" ]; then
  sudo dpkg -i "$deb" || sudo apt-get install -f -y
  pkg="$(dpkg-deb -f "$deb" Package)"
  bin="$(dpkg -L "$pkg" | grep -E '/agenthub$' | head -1)"
  [ -n "$bin" ] || { echo "DEB 安装后未找到 agenthub 主程序" >&2; exit 1; }
  run_app "$bin" "deb"
  sudo apt-get remove -y "$pkg"
  if command -v "$bin" >/dev/null 2>&1; then
    echo "卸载后仍能找到 $bin" >&2
    exit 1
  fi
  echo "Linux DEB 安装/启动/卸载 smoke 通过"
else
  echo "跳过 DEB 系统安装（设置 AGENTHUB_INSTALL_DEB=1 启用）"
fi
