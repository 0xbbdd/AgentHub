/** 定位开发依赖或打包后的 Electron 可执行文件；三平台路径集中在这里。 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function electronExecutable(root) {
  const base = root || path.join(__dirname, "..");
  if (process.env.ELECTRON_EXECUTABLE) {
    const custom = path.resolve(process.env.ELECTRON_EXECUTABLE);
    if (fs.existsSync(custom)) return custom;
    throw new Error(`ELECTRON_EXECUTABLE 不存在：${custom}`);
  }
  const dist = path.join(base, "node_modules", "electron", "dist");
  const candidates = process.platform === "win32"
    ? [path.join(dist, "electron.exe")]
    : process.platform === "darwin"
      ? [path.join(dist, "Electron.app", "Contents", "MacOS", "Electron"), path.join(dist, "electron")]
      : [path.join(dist, "electron")];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`未找到 Electron 可执行文件，已检查：${candidates.join(", ")}`);
  return found;
}

function guiArgs(extra = []) {
  return process.platform === "linux" ? ["--no-sandbox", "--disable-gpu", ...extra] : ["--disable-gpu", ...extra];
}

module.exports = { electronExecutable, guiArgs };
