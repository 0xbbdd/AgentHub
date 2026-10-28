/**
 * 跨平台运行时事实源。
 *
 * 业务模块不应直接读取 process.platform / process.arch 或调用 os.platform()：
 * 统一从这里取平台语义，测试可传参覆盖，发布矩阵也以同一组标识为准。
 */
"use strict";

const os = require("node:os");

const PLATFORM_NAMES = Object.freeze(["win32", "darwin", "linux"]);
const PLATFORM_SET = new Set(PLATFORM_NAMES);

const LABELS = Object.freeze({
  win32: "Windows",
  darwin: "macOS",
  linux: "Linux",
  unknown: "Unknown",
});

const FAMILIES = Object.freeze({
  win32: "windows",
  darwin: "macos",
  linux: "linux",
  unknown: "unknown",
});

function nameOf(value = process.platform) {
  return PLATFORM_SET.has(value) ? value : "unknown";
}

function isSupported(value = process.platform) {
  return PLATFORM_SET.has(value);
}

function familyOf(value = process.platform) {
  return FAMILIES[nameOf(value)];
}

function labelOf(value = process.platform) {
  return LABELS[nameOf(value)];
}

function isWindows(value = process.platform) {
  return nameOf(value) === "win32";
}

function isMac(value = process.platform) {
  return nameOf(value) === "darwin";
}

function isLinux(value = process.platform) {
  return nameOf(value) === "linux";
}

/** Qoder 等服务端设备指纹使用的宿主标识：Windows 优先给系统版本，其余给平台-架构。 */
function hostFingerprint(value = process.platform, arch = process.arch) {
  const name = nameOf(value);
  if (name === "win32") return os.release();
  return `${name}-${arch || "unknown"}`;
}

/** 当前进程快照；显式函数便于测试与日志记录。 */
function current() {
  return {
    name: nameOf(process.platform),
    arch: process.arch,
    family: familyOf(process.platform),
    label: labelOf(process.platform),
    supported: isSupported(process.platform),
  };
}

module.exports = {
  PLATFORM_NAMES,
  name: nameOf(process.platform),
  arch: process.arch,
  nameOf,
  isSupported,
  familyOf,
  labelOf,
  isWindows,
  isMac,
  isLinux,
  hostFingerprint,
  current,
  paths: require("./paths.cjs"),
  capabilities: require("./capabilities.cjs"),
  secureStore: require("./secure-store.cjs"),
  desktop: require("./desktop.cjs"),
  runtimeState: require("./runtime-state.cjs"),
  process: require("./process.cjs"),
};
