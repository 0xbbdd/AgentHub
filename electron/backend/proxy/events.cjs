// 反代网关 · 事件广播：请求完成 / OAuth 结果等推送到渲染层（app:event，与更新推送同通道）
// 已迁移至平台适配层：Electron 走 IPC，纯 Node 走日志降级（见 platform/index.cjs）
"use strict";

const platform = require("./platform/index.cjs");

function emit(payload) {
  platform.emit(payload);
}

module.exports = { emit };
