// 当前平台 SQLCipher 运行时冒烟：确认 koffi、主库、依赖库与密钥 PRAGMA 都能工作。
// 发布流水线在每个平台打包前运行，避免只做了结构校验却在真机上加载失败。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cipher = require("../electron/backend/sqlcipher.cjs");
const dbPath = path.join(os.tmpdir(), `agenthub-sqlcipher-smoke-${process.pid}.db`);

function cleanup() {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });
}

try {
  cleanup();
  const db = cipher.open(dbPath);
  let version = "";
  try {
    version = cipher.queryAll(db, "PRAGMA cipher_version")[0]?.cipher_version || "";
  } finally {
    cipher.close(db);
  }
  if (!version) throw new Error("PRAGMA cipher_version 未返回版本");
  console.log(`[sqlcipher-smoke] ${process.platform}-${process.arch}: ${version}`);
} catch (error) {
  console.error(`[sqlcipher-smoke] ${process.platform}-${process.arch} 失败：${error.message}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
