#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
old_dir="${OLD_RELEASE_DIR:-$repo/old-release}"
new_dir="${NEW_RELEASE_DIR:-$repo/release}"
arch="$(uname -m)"
want_arch="x64"
[ "$arch" = "arm64" ] && want_arch="arm64"
old_dmg="$(find "$old_dir" -maxdepth 1 -name '*.dmg' 2>/dev/null | grep -i "$want_arch" | head -1 || true)"
new_dmg="$(find "$new_dir" -maxdepth 1 -name '*.dmg' | grep -i "$want_arch" | head -1 || true)"
[ -n "$new_dmg" ] || { echo "未找到当前版本 $want_arch DMG" >&2; exit 1; }
if [ -z "$old_dmg" ]; then
  if [ "${ALLOW_MISSING_UPGRADE_BASELINE:-0}" = "1" ]; then echo "无上一版 macOS 资产，跳过升级 smoke"; exit 0; fi
  echo "缺少上一版 macOS DMG；如为首个跨平台版本，请显式允许缺失基线" >&2
  exit 1
fi

root="$(mktemp -d "${RUNNER_TEMP:-/tmp}/agenthub-mac-upgrade.XXXXXX")"
install_app="$root/Applications/AgentHub.app"
data_dir="$root/data"
skills_dir="$root/skills"
mkdir -p "$(dirname "$install_app")" "$data_dir" "$skills_dir"
mnt_old="$root/mnt-old"
mnt_new="$root/mnt-new"
mkdir -p "$mnt_old" "$mnt_new"
app_pid=""
cleanup() {
  [ -n "$app_pid" ] && kill "$app_pid" 2>/dev/null || true
  hdiutil detach "$mnt_old" -quiet 2>/dev/null || true
  hdiutil detach "$mnt_new" -quiet 2>/dev/null || true
  rm -rf "$root"
}
trap cleanup EXIT

app_version() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist"; }
launch_app() {
  local app="$1"
  local bin="$app/Contents/MacOS/AgentHub"
  AGENTHUB_ALLOW_MULTI=1 AGENTHUB_DATA_DIR="$data_dir" AGENT_SKILLS_HOME="$skills_dir" HOME="$root/home" ELECTRON_DISABLE_GPU=1 "$bin" >"$root/app.log" 2>&1 &
  app_pid=$!
  sleep 8
  if ! kill -0 "$app_pid" 2>/dev/null; then cat "$root/app.log" >&2; echo "macOS 应用启动后提前退出" >&2; exit 1; fi
  kill "$app_pid" 2>/dev/null || true
  wait "$app_pid" 2>/dev/null || true
  app_pid=""
}

hdiutil attach -nobrowse -readonly -mountpoint "$mnt_old" "$old_dmg" >/dev/null
old_src="$(find "$mnt_old" -maxdepth 2 -type d -name '*.app' | head -1)"
[ -n "$old_src" ] || { echo "旧 DMG 未找到 .app" >&2; exit 1; }
ditto "$old_src" "$install_app"
v_old="$(app_version "$install_app")"
printf '%s' "$v_old" > "$data_dir/upgrade-smoke.txt"
launch_app "$install_app"

hdiutil attach -nobrowse -readonly -mountpoint "$mnt_new" "$new_dmg" >/dev/null
new_src="$(find "$mnt_new" -maxdepth 2 -type d -name '*.app' | head -1)"
[ -n "$new_src" ] || { echo "新 DMG 未找到 .app" >&2; exit 1; }
rm -rf "$install_app"
ditto "$new_src" "$install_app"
v_new="$(app_version "$install_app")"
if [ "${AGENTHUB_ALLOW_SAME_VERSION:-0}" != "1" ]; then
  node -e 'const [a,b]=process.argv.slice(1).map(v=>v.split(".").map(Number)); for(let i=0;i<Math.max(a.length,b.length);i++){const d=(b[i]||0)-(a[i]||0);if(d>0)process.exit(0);if(d<0)process.exit(1)} process.exit(1)' "$v_old" "$v_new" || { echo "升级版本未递增：$v_old -> $v_new" >&2; exit 1; }
fi
[ "$(cat "$data_dir/upgrade-smoke.txt")" = "$v_old" ] || { echo "升级后用户数据丢失" >&2; exit 1; }
codesign --verify --deep --strict --verbose=2 "$install_app"
launch_app "$install_app"

rm -rf "$install_app"
ditto "$old_src" "$install_app"
[ "$(app_version "$install_app")" = "$v_old" ] || { echo "回滚版本异常" >&2; exit 1; }
[ "$(cat "$data_dir/upgrade-smoke.txt")" = "$v_old" ] || { echo "回滚后用户数据丢失" >&2; exit 1; }
launch_app "$install_app"
echo "macOS 升级/回滚 smoke 通过：$v_old -> $v_new -> $v_old"
