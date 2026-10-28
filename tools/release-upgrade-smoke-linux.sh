#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
old_dir="${OLD_RELEASE_DIR:-$repo/old-release}"
new_dir="${NEW_RELEASE_DIR:-$repo/release}"
old_deb="$(find "$old_dir" -maxdepth 1 -name '*.deb' | head -1)"
new_deb="$(find "$new_dir" -maxdepth 1 -name '*.deb' | head -1)"
old_appimage="$(find "$old_dir" -maxdepth 1 -name '*.AppImage' | head -1)"
new_appimage="$(find "$new_dir" -maxdepth 1 -name '*.AppImage' | head -1)"
[ -n "$new_deb" ] && [ -n "$new_appimage" ] || { echo "缺少当前版本 DEB/AppImage" >&2; exit 1; }
if [ -z "$old_deb" ] || [ -z "$old_appimage" ]; then
  if [ "${ALLOW_MISSING_UPGRADE_BASELINE:-0}" = "1" ]; then echo "无上一版 Linux 资产，跳过升级 smoke"; exit 0; fi
  echo "缺少上一版 Linux DEB/AppImage；如为首个跨平台版本，请显式允许缺失基线" >&2
  exit 1
fi
chmod +x "$old_appimage" "$new_appimage"

root="$(mktemp -d "${RUNNER_TEMP:-/tmp}/agenthub-linux-upgrade.XXXXXX")"
cleanup() { rm -rf "$root"; }
trap cleanup EXIT

run_app() {
  local bin="$1" label="$2" data="$3" config="$4"
  local rc=0
  AGENTHUB_ALLOW_MULTI=1 AGENTHUB_DATA_DIR="$data" AGENT_SKILLS_HOME="$root/skills-$label" HOME="$root/home-$label" XDG_CONFIG_HOME="$config" XDG_DATA_HOME="$root/data-home-$label" ELECTRON_DISABLE_GPU=1 APPIMAGE_EXTRACT_AND_RUN=1 timeout 8s dbus-run-session -- xvfb-run -a "$bin" --no-sandbox >"$root/$label.log" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 124 ]; then cat "$root/$label.log" >&2; echo "$label 启动失败 exit=$rc" >&2; return 1; fi
}

pkg="$(dpkg-deb -f "$new_deb" Package)"
old_version="$(dpkg-deb -f "$old_deb" Version)"
new_version="$(dpkg-deb -f "$new_deb" Version)"
if [ "${AGENTHUB_ALLOW_SAME_VERSION:-0}" != "1" ]; then
  if ! dpkg --compare-versions "$new_version" gt "$old_version"; then echo "升级版本未递增：$old_version -> $new_version" >&2; exit 1; fi
fi

if [ "${AGENTHUB_SKIP_DEB_UPGRADE:-0}" != "1" ]; then
  sudo dpkg -i "$old_deb" || sudo apt-get install -f -y
  bin="$(dpkg -L "$pkg" | grep -E '/agenthub$' | head -1)"
  [ -n "$bin" ] || { echo "旧 DEB 安装后未找到主程序" >&2; exit 1; }
  [ "$(dpkg-query -W -f='${Version}' "$pkg")" = "$old_version" ]
  data="$root/deb-data"
  mkdir -p "$data"
  printf '%s' "$old_version" > "$data/upgrade-smoke.txt"
  run_app "$bin" "deb-old" "$data" "$root/deb-config"
  [ "$(cat "$data/upgrade-smoke.txt")" = "$old_version" ]

  sudo dpkg -i "$new_deb" || sudo apt-get install -f -y
  [ "$(dpkg-query -W -f='${Version}' "$pkg")" = "$new_version" ]
  [ "$(cat "$data/upgrade-smoke.txt")" = "$old_version" ] || { echo "升级后用户数据丢失" >&2; exit 1; }
  run_app "$bin" "deb-new" "$data" "$root/deb-config"

  sudo dpkg --force-downgrade -i "$old_deb" || sudo apt-get install -f -y
  [ "$(dpkg-query -W -f='${Version}' "$pkg")" = "$old_version" ]
  [ "$(cat "$data/upgrade-smoke.txt")" = "$old_version" ] || { echo "回滚后用户数据丢失" >&2; exit 1; }
  run_app "$bin" "deb-rollback" "$data" "$root/deb-config"
  sudo apt-get remove -y "$pkg"
else
  echo "跳过 DEB 系统升级（AGENTHUB_SKIP_DEB_UPGRADE=1）"
fi

app_data="$root/appimage-data"
mkdir -p "$app_data"
printf '%s' "$old_version" > "$app_data/upgrade-smoke.txt"
run_app "$old_appimage" "appimage-old" "$app_data" "$root/appimage-config"
run_app "$new_appimage" "appimage-new" "$app_data" "$root/appimage-config"
[ "$(cat "$app_data/upgrade-smoke.txt")" = "$old_version" ] || { echo "AppImage 升级后用户数据丢失" >&2; exit 1; }
run_app "$old_appimage" "appimage-rollback" "$app_data" "$root/appimage-config"
[ "$(cat "$app_data/upgrade-smoke.txt")" = "$old_version" ] || { echo "AppImage 回滚后用户数据丢失" >&2; exit 1; }
echo "Linux 升级/回滚 smoke 通过：$old_version -> $new_version -> $old_version"
