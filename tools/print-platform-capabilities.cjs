/**
 * 输出当前平台或三平台能力矩阵。
 * 用法：node tools/print-platform-capabilities.cjs [--all]
 */
"use strict";

const caps = require("../electron/backend/platform/capabilities.cjs");
const all = process.argv.includes("--all");
if (all) {
  const out = {};
  for (const name of caps.PLATFORMS) out[name] = caps.snapshot({ platform: name, arch: name === "win32" || name === "linux" ? "x64" : "arm64" });
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(JSON.stringify(caps.snapshot(), null, 2));
}
