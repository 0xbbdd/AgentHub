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
// 为当前平台准备 electron-builder extraResources。缺少 SQLCipher 时保留目录与说明，
// Trae 系数据源会优雅降级；其余桌面功能和安装包仍可正常构建运行。
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [name, value = ""] = arg.replace(/^--/, "").split("=");
    return [name, value];
  }),
);
const targetPlatform = args.get("platform") || process.platform;
const targetArch = args.get("arch") || process.arch;

const root = path.join(__dirname, "..", "resources", "sqlcipher");
const out = path.join(__dirname, "..", "build", "native-resources", "sqlcipher");
const key = `${targetPlatform}-${targetArch}`;
const source = path.join(root, key);
const EXPECTED = {
  "win32-x64": ["sqlcipher.dll", "libcrypto-1_1-x64.dll", "libssl-1_1-x64.dll"],
  "darwin-x64": ["libsqlcipher.dylib", "libcrypto.3.dylib"],
  "darwin-arm64": ["libsqlcipher.dylib", "libcrypto.3.dylib"],
  "linux-x64": ["libsqlcipher.so", "libcrypto.so.3"],
};

function missingFiles(dir, names) {
  return names.filter((name) => !fs.existsSync(path.join(dir, name)));
}

function makeExecutable(dir, names) {
  if (targetPlatform === "win32") return;
  for (const name of names) fs.chmodSync(path.join(dir, name), 0o755);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// 许可证与来源说明随安装包一起分发（不参与平台目录选择）。
for (const file of ["NOTICE.md"]) {
  const from = path.join(root, file);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(out, file));
}
const licenses = path.join(root, "licenses");
if (fs.existsSync(licenses)) fs.cpSync(licenses, path.join(out, "licenses"), { recursive: true });

if (fs.existsSync(source)) {
  const dest = path.join(out, key);
  fs.cpSync(source, dest, { recursive: true });
  const names = EXPECTED[key] || [];
  const missing = missingFiles(dest, names);
  if (missing.length) {
    console.warn(`SQLCipher：${key} 原生库不完整，缺少 ${missing.join("、")}；Trae 系数据源将禁用`);
  } else {
    makeExecutable(dest, names);
    console.log(`SQLCipher：已准备 ${key} 原生库`);
  }
} else if (targetPlatform === "win32" && targetArch === "x64" && fs.existsSync(path.join(root, "sqlcipher.dll"))) {
  const dest = path.join(out, key);
  fs.mkdirSync(dest, { recursive: true });
  for (const name of EXPECTED["win32-x64"]) {
    const from = path.join(root, name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dest, name));
  }
  const missing = missingFiles(dest, EXPECTED["win32-x64"]);
  if (missing.length) {
    console.warn(`SQLCipher：Windows x64 DLL 不完整，缺少 ${missing.join("、")}；Trae 系数据源将禁用`);
  } else {
    console.log("SQLCipher：已将旧版 Windows x64 DLL 归入平台目录");
  }
} else {
  fs.writeFileSync(
    path.join(out, "README.txt"),
    `AgentHub ${key} 安装包未附带 SQLCipher 原生库。Trae 系用量数据源不可用，其他功能不受影响。\n`,
  );
  console.warn(`SQLCipher：未提供 ${key} 原生库，Trae 系数据源将禁用`);
}
