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

const root = path.join(__dirname, "..", "resources", "sqlcipher");
const out = path.join(__dirname, "..", "build", "native-resources", "sqlcipher");
const key = `${process.platform}-${process.arch}`;
const source = path.join(root, key);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

if (fs.existsSync(source)) {
  fs.cpSync(source, path.join(out, key), { recursive: true });
  console.log(`SQLCipher：已准备 ${key} 原生库`);
} else if (process.platform === "win32" && process.arch === "x64" && fs.existsSync(path.join(root, "sqlcipher.dll"))) {
  fs.cpSync(root, path.join(out, key), {
    recursive: true,
    filter: (file) => path.extname(file).toLowerCase() === ".dll" || fs.statSync(file).isDirectory(),
  });
  console.log("SQLCipher：已将旧版 Windows x64 DLL 归入平台目录");
} else {
  fs.writeFileSync(
    path.join(out, "README.txt"),
    `AgentHub ${key} 安装包未附带 SQLCipher 原生库。Trae 系用量数据源不可用，其他功能不受影响。\n`,
  );
  console.warn(`SQLCipher：未提供 ${key} 原生库，Trae 系数据源将禁用`);
}
