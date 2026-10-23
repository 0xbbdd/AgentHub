/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 各平台桌面应用数据目录。适配器仍可优先使用自己的显式环境变量；这里仅统一默认值，
// 避免 macOS/Linux 回退到不存在的 ~/AppData/Roaming。
"use strict";
const os = require("node:os");
const path = require("node:path");

function homeDir() {
  return os.homedir();
}

function roamingAppData() {
  if (process.env.APPDATA) return process.env.APPDATA;
  if (process.platform === "darwin") return path.join(homeDir(), "Library", "Application Support");
  if (process.platform === "linux") return process.env.XDG_CONFIG_HOME || path.join(homeDir(), ".config");
  return path.join(homeDir(), "AppData", "Roaming");
}

function localAppData() {
  if (process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
  if (process.platform === "darwin") return path.join(homeDir(), "Library", "Application Support");
  if (process.platform === "linux") return process.env.XDG_DATA_HOME || path.join(homeDir(), ".local", "share");
  return path.join(homeDir(), "AppData", "Local");
}

module.exports = { homeDir, roamingAppData, localAppData };
