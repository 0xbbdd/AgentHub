// 反代网关 · 平台适配层入口：按运行环境分发到 Electron 或纯 Node 实现
// 上层模块（events / config / zcodeCapture / discovery / ideswitch 等）只许 require 本文件，
// 绝不直接 require("electron")——同一份代码因此能在桌面壳与 Docker headless 两种形态下运行。
"use strict";

// 判定三条铁律：① electron 包在纯 Node 下 require 不报错、而是返回可执行文件路径（truthy），
// 不能用 !!require("electron")；② ELECTRON_RUN_AS_NODE 下 versions.electron 仍在但 API 全不可用
// （require 只拿得到路径字符串），该模式按 node 处理；③ 其余以 versions.electron 为准
const isElectron = !!process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE;

const impl = isElectron ? require("./electron.cjs") : require("./node.cjs");

module.exports = {
  isElectron,
  // 事件广播（Electron → IPC；Node → 日志/SSE 降级）
  emit: impl.emit,
  // 本机软件导入扫描（Electron → 真实扫描；Node → 空数组）
  scanLocalAccounts: impl.scanLocalAccounts,
  // IDE 切号（Electron → 真实切换；Node → 拒绝并提示）
  switchIdeAccount: impl.switchIdeAccount,
  // 人机校验（Electron → 弹窗；Node → needCaptcha 降级）
  solveCaptcha: impl.solveCaptcha,
  // 凭据加解密（Electron → DPAPI；Node → AES-256-GCM）
  encryptSecret: impl.encryptSecret,
  decryptSecret: impl.decryptSecret,
  // 数据目录（Electron → userData；Node → AGENTHUB_DATA_DIR 或 ./data）
  getDataDir: impl.getDataDir,
  // 休眠唤醒守卫（Electron → 真实守卫；Node → 空实现恒允许）
  wakeGuard: impl.wakeGuard,
};
