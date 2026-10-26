// 校验 resources/sqlcipher 下三平台原生库是否齐全、是否与清单一致。
// 本地默认只报告（缺库时应用会优雅降级）；发布流程应加 --strict 阻断不完整发版。
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "resources", "sqlcipher");
const strict = process.argv.includes("--strict");
const manifestPath = path.join(root, "manifest.json");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function checkMagic(file, platform) {
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(4);
  try {
    fs.readSync(fd, head, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (platform === "win32-x64") return head.toString("latin1").startsWith("MZ");
  if (platform.startsWith("darwin-")) return head.readUInt32LE(0) === 0xfeedfacf;
  if (platform === "linux-x64") return head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  return true;
}

function checkPatch(file, platform, name) {
  const data = fs.readFileSync(file);
  if (platform.startsWith("darwin-")) {
    if (name === "libsqlcipher.dylib") {
      return data.includes("@loader_path/libsqlcipher.dylib") && data.includes("@loader_path/libcrypto.3.dylib");
    }
    return data.includes("@loader_path/libcrypto.3.dylib");
  }
  if (platform === "linux-x64") return data.includes("$ORIGIN") && data.includes("libcrypto.so.3");
  return true;
}

function resolveFile(platform, name) {
  const platformFile = path.join(root, platform, name);
  if (fs.existsSync(platformFile)) return platformFile;
  // Windows x64 仍兼容仓库根目录的旧版平铺 DLL。
  if (platform === "win32-x64") {
    const legacyFile = path.join(root, name);
    if (fs.existsSync(legacyFile)) return legacyFile;
  }
  return null;
}

let failed = false;
let checked = 0;
function problem(message) {
  failed = true;
  console.error(`  ✗ ${message}`);
}

console.log(`SQLCipher 原生库校验：${root}`);
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (error) {
  console.error(`无法读取 manifest.json：${error.message}`);
  process.exitCode = 1;
  return;
}

for (const [platform, spec] of Object.entries(manifest.platforms || {})) {
  console.log(`\n[${platform}] ${spec.source || ""}`);
  for (const [name, meta] of Object.entries(spec.files || {})) {
    const file = resolveFile(platform, name);
    if (!file) {
      problem(`缺少 ${platform}/${name}`);
      continue;
    }
    checked++;
    const digest = sha256(file);
    if (meta.sha256 && digest !== meta.sha256) {
      problem(`${platform}/${name} SHA256 不匹配（期望 ${meta.sha256.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…）`);
      continue;
    }
    if (!checkMagic(file, platform)) {
      problem(`${platform}/${name} 文件格式不正确`);
      continue;
    }
    if (!checkPatch(file, platform, name)) {
      problem(`${platform}/${name} 未使用可重定位的库路径`);
      continue;
    }
    console.log(`  ✓ ${name}`);
  }
}

for (const name of ["NOTICE.md", "licenses/SQLCipher-LICENSE.md", "licenses/OpenSSL-LICENSE.txt"]) {
  if (!fs.existsSync(path.join(root, name))) problem(`缺少 ${name}`);
}

if (failed) {
  if (strict) {
    console.error(`\n校验失败：检查了 ${checked} 个文件；发布构建必须补齐上述资源。`);
    process.exitCode = 1;
  } else {
    console.warn(`\n校验未通过：检查了 ${checked} 个文件；缺少的平台会在运行时禁用 Trae 系数据源。`);
  }
} else {
  console.log(`\n校验通过：${checked} 个原生库文件齐全且与清单一致。`);
}
