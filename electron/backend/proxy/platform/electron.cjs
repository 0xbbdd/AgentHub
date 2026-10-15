// 反代网关 · 平台适配层 · Electron 实现
// 把现有各模块里散落 require("electron") 的逻辑收敛到这里，统一出口。
// ⚠ 不能顶层 require config.cjs——config.cjs 也 require 了 platform/index.cjs，会循环依赖。
//    所有 config 相关调用都改为惰性 require。
"use strict";

module.exports = {
  // ===== 事件广播（原 events.cjs） =====
  emit(payload) {
    try {
      const { BrowserWindow } = require("electron");
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send("app:event", { event: "proxy", ...payload });
      }
    } catch { /* 无窗口时静默 */ }
  },

  // ===== 本机软件导入扫描（原 discovery.cjs 的 scanAll） =====
  async scanLocalAccounts() {
    const discovery = require("../discovery.cjs");
    return discovery.scanAll();
  },

  // ===== IDE 切号（原 ideswitch.cjs） =====
  async switchIdeAccount(args) {
    const ideswitch = require("../ideswitch.cjs");
    return ideswitch.precheckSwitch(args);
  },

  // ===== 人机校验（原 zcodeCapture.cjs） =====
  async solveCaptcha(captcha) {
    const zcodeCapture = require("../zcodeCapture.cjs");
    return zcodeCapture.solveCaptcha(captcha);
  },

  // ===== 凭据加解密（原 config.cjs 的 DPAPI 封装） =====
  // 惰性 require，避免与 config.cjs 循环依赖
  encryptSecret(plain) {
    const config = require("../../config.cjs");
    return config.encryptSecret(plain);
  },
  decryptSecret(stored) {
    const config = require("../../config.cjs");
    return config.decryptSecret(stored);
  },

  // ===== 数据目录 =====
  getDataDir() {
    const config = require("../../config.cjs");
    return config.dataDir();
  },

  // ===== 休眠唤醒守卫 =====
  wakeGuard: require("../../wakeGuard.cjs"),
};
