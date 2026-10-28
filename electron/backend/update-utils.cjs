// 更新错误分类：纯逻辑，便于在没有 Electron 的环境下回归。
"use strict";

function classifyUpdateError(error) {
  const text = String((error && error.message) || error || "");
  if (/sha512|checksum|integrity|hash mismatch/i.test(text)) {
    return {
      kind: "checksum",
      hint: "更新包完整性校验失败，已拒绝安装。请删除更新缓存后重试，或前往 GitHub 手动下载。",
    };
  }
  if (/signature|publishername|authenticode|not signed|code sign/i.test(text)) {
    return {
      kind: "signature",
      hint: "更新包发布者签名校验失败，已拒绝安装。请从 GitHub Releases 手动下载并核对发布者。",
    };
  }
  if (/ENOSPC|EFBIG|disk full|no space|quota exceeded|EROFS|read-only file system|磁盘空间|只读文件系统/i.test(text)) {
    return {
      kind: "disk",
      hint: "磁盘空间不足或目标目录只读，更新未写入。请释放空间并确认安装目录可写后重试。",
    };
  }
  if (/EACCES|EPERM|access is denied|permission denied|权限/i.test(text)) {
    return {
      kind: "permission",
      hint: "更新安装权限不足，请关闭占用程序后重试，或以允许的方式重新安装。",
    };
  }
  return { kind: "unknown", hint: "" };
}

function updaterCacheCandidates(opts = {}) {
  const path = require("node:path");
  const base = String(opts.cachePath || "").trim();
  if (!base) return [];
  const names = [...new Set([opts.name, opts.productName, "agenthub", "AgentHub"].filter(Boolean).map(String))];
  return [...new Set(names.map((name) => path.join(base, `${name}-updater`)))];
}

module.exports = { classifyUpdateError, updaterCacheCandidates };
