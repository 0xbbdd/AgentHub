#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
dmg="$(find "$repo/release" -maxdepth 1 -name '*.dmg' | head -1)"
[ -n "$dmg" ] || { echo "未找到 macOS DMG" >&2; exit 1; }

root="$(mktemp -d "${RUNNER_TEMP:-/tmp}/agenthub-mac-smoke.XXXXXX")"
mnt="$root/mnt"
app_copy="$root/AgentHub.app"
mkdir -p "$mnt"
cleanup() {
  if [ -n "${app_pid:-}" ] && kill -0 "$app_pid" 2>/dev/null; then kill "$app_pid" 2>/dev/null || true; fi
  hdiutil detach "$mnt" -quiet 2>/dev/null || true
  rm -rf "$root"
}
trap cleanup EXIT

hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$dmg" >/dev/null
app="$(find "$mnt" -maxdepth 2 -type d -name '*.app' | head -1)"
[ -n "$app" ] || { echo "DMG 中未找到 .app" >&2; exit 1; }
ditto "$app" "$app_copy"
bin="$app_copy/Contents/MacOS/AgentHub"
[ -x "$bin" ] || { echo "未找到可执行主程序：$bin" >&2; exit 1; }
codesign --verify --deep --strict --verbose=2 "$app_copy"

export AGENTHUB_ALLOW_MULTI=1
export AGENTHUB_DATA_DIR="$root/data"
export AGENT_SKILLS_HOME="$root/skills"
export HOME="$root/home"
export ELECTRON_DISABLE_GPU=1
"$bin" >"$root/app.log" 2>&1 &
app_pid=$!
sleep 10
if ! kill -0 "$app_pid" 2>/dev/null; then
  cat "$root/app.log" >&2
  echo "AgentHub 启动后提前退出" >&2
  exit 1
fi
kill "$app_pid" 2>/dev/null || true
wait "$app_pid" 2>/dev/null || true
app_pid=""
echo "macOS DMG 挂载/启动 smoke 通过"
