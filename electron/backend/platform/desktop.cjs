/**
 * 桌面会话事实与跨平台降级策略。
 * Linux 需要区分 X11/Wayland；Wayland 的全局快捷键必须启用 GlobalShortcutsPortal。
 */
"use strict";

const { platformName } = require("./paths.cjs");

function session(opts = {}) {
  const name = platformName(opts.platform || process.platform);
  const env = opts.env || process.env;
  if (name === "win32") return { platform: name, type: "windows", desktop: "Windows", isWayland: false };
  if (name === "darwin") return { platform: name, type: "macos", desktop: "macOS", isWayland: false };

  const desktop = String(env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || "").trim();
  const declared = String(env.XDG_SESSION_TYPE || "").trim().toLowerCase();
  const wayland = declared === "wayland" || !!env.WAYLAND_DISPLAY;
  const x11 = declared === "x11" || (!wayland && !!env.DISPLAY);
  return {
    platform: name,
    type: wayland ? "wayland" : x11 ? "x11" : "unknown",
    desktop,
    isWayland: wayland,
    globalShortcutHint: wayland ? "Wayland 已启用 GlobalShortcutsPortal；是否生效取决于桌面合成器授权" : "",
    trayHint: /gnome/i.test(desktop) ? "GNOME 默认可能不显示传统托盘，运行时会检测创建结果" : "",
  };
}

/** Electron 必须在 ready 前追加该 switch；Wayland 无 portal 时 globalShortcut 会静默不可用。 */
function enableWaylandGlobalShortcuts(app, opts = {}) {
  const info = session(opts);
  if (!info.isWayland) return false;
  try {
    app.commandLine.appendSwitch("enable-features", "GlobalShortcutsPortal");
    return true;
  } catch {
    return false;
  }
}

module.exports = { session, enableWaylandGlobalShortcuts };
