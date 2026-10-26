// 开机自启：Windows/macOS 走 Electron 登录项；Linux 写 XDG autostart 桌面文件。
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function autostartDir(env = process.env, home = os.homedir()) {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "autostart");
}

function desktopPath(env = process.env, home = os.homedir()) {
  return path.join(autostartDir(env, home), "AgentHub.desktop");
}

function quoteExec(value) {
  return `"${String(value).replace(/([\\`"$])/g, "\\$1")}"`;
}

function executablePath(app) {
  if (process.env.APPIMAGE) return process.env.APPIMAGE;
  try {
    if (app && typeof app.getPath === "function") return app.getPath("exe");
  } catch { /* 非 Electron 环境回退到当前进程 */ }
  return process.execPath;
}

function desktopEntry(app) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    "Name=AgentHub",
    "Comment=AgentHub Agent control center",
    `Exec=${quoteExec(executablePath(app))}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

function applyLoginItem(app, enabled) {
  if (process.platform === "linux") {
    const file = desktopPath();
    if (!enabled) {
      fs.rmSync(file, { force: true });
      return true;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, desktopEntry(app), { encoding: "utf8", mode: 0o644 });
    return true;
  }
  if (app && typeof app.setLoginItemSettings === "function") {
    app.setLoginItemSettings({ openAtLogin: !!enabled });
    return true;
  }
  return false;
}

module.exports = { applyLoginItem, autostartDir, desktopPath, desktopEntry, executablePath };
