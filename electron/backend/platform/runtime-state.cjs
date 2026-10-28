/** 主进程运行时能力状态：用于把“实际创建/注册结果”反哺平台能力矩阵。 */
"use strict";

const state = {
  tray: { available: null, reason: "尚未初始化" },
  globalShortcut: { available: null, reason: "尚未初始化" },
};

function normalize(value) {
  if (!value || typeof value !== "object") return { available: null, reason: "" };
  return {
    available: typeof value.available === "boolean" ? value.available : null,
    reason: String(value.reason || ""),
  };
}

function setTray(value) { state.tray = normalize(value); return { ...state.tray }; }
function setGlobalShortcut(value) { state.globalShortcut = normalize(value); return { ...state.globalShortcut }; }
function snapshot() { return { tray: { ...state.tray }, globalShortcut: { ...state.globalShortcut } }; }
function reset() { setTray({ available: null, reason: "尚未初始化" }); setGlobalShortcut({ available: null, reason: "尚未初始化" }); }

module.exports = { setTray, setGlobalShortcut, snapshot, reset };
