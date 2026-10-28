/**
 * 三平台标准目录解析。
 *
 * 所有函数都接受注入参数，既服务运行时，也可在任意 CI runner 上验证三平台分支。
 */
"use strict";

const os = require("node:os");
const path = require("node:path");

const SUPPORTED = new Set(["win32", "darwin", "linux"]);

function platformName(value) {
  return SUPPORTED.has(value) ? value : "unknown";
}

function normalizeHome(home) {
  return home || os.homedir();
}

function homeDir(home) {
  return normalizeHome(home);
}

function windowsRoaming(home, env) {
  return env.APPDATA || path.join(home, "AppData", "Roaming");
}

function windowsLocal(home, env) {
  return env.LOCALAPPDATA || path.join(home, "AppData", "Local");
}

function macAppSupport(home) {
  return path.join(home, "Library", "Application Support");
}

function linuxConfig(home, env) {
  return env.XDG_CONFIG_HOME || path.join(home, ".config");
}

function linuxData(home, env) {
  return env.XDG_DATA_HOME || path.join(home, ".local", "share");
}

function assertSupported(name) {
  if (!SUPPORTED.has(name)) {
    throw new Error(`不支持的平台目录语义：${name || "(empty)"}`);
  }
}

/** 应用配置/漫游数据根。macOS 与 Windows 的“漫游”语义不同，但上游客户端常共用同一目录。 */
function roamingAppData(opts = {}) {
  const name = platformName(opts.platform || process.platform);
  const env = opts.env || process.env;
  const home = normalizeHome(opts.home);
  assertSupported(name);
  // 显式覆盖优先：兼容历史沙箱约定（任意平台都可能设置 APPDATA 指向临时目录）。
  if (env.APPDATA) return env.APPDATA;
  if (name === "win32") return windowsRoaming(home, env);
  if (name === "darwin") return macAppSupport(home);
  return linuxConfig(home, env);
}

/** 本机数据根。 */
function localAppData(opts = {}) {
  const name = platformName(opts.platform || process.platform);
  const env = opts.env || process.env;
  const home = normalizeHome(opts.home);
  assertSupported(name);
  // 同上：LOCALAPPDATA 是跨平台自测与故障隔离使用的显式覆盖。
  if (env.LOCALAPPDATA) return env.LOCALAPPDATA;
  if (name === "win32") return windowsLocal(home, env);
  if (name === "darwin") return macAppSupport(home);
  return linuxData(home, env);
}

/** 配置根：Linux 使用 XDG_CONFIG_HOME，其余平台与漫游目录一致。 */
function configHome(opts = {}) {
  return roamingAppData(opts);
}

/** 数据根：Linux 使用 XDG_DATA_HOME，macOS 使用 Application Support。 */
function dataHome(opts = {}) {
  return localAppData(opts);
}

/** XDG autostart 目录；仅 Linux 使用，但保留三平台可测试语义。 */
function autostartDir(opts = {}) {
  const name = platformName(opts.platform || process.platform);
  const env = opts.env || process.env;
  const home = normalizeHome(opts.home);
  assertSupported(name);
  if (name === "linux") return path.join(linuxConfig(home, env), "autostart");
  if (name === "darwin") return path.join(home, "Library", "LaunchAgents");
  return path.join(windowsRoaming(home, env), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

/** Windows 默认不区分大小写；macOS 常见 APFS 默认不区分但可配置，因此不在此处武断折叠。 */
function caseInsensitiveByDefault(platform) {
  return platformName(platform) === "win32";
}

module.exports = {
  SUPPORTED,
  platformName,
  homeDir,
  roamingAppData,
  localAppData,
  configHome,
  dataHome,
  autostartDir,
  caseInsensitiveByDefault,
};
