/**
 * 平台分支边界门禁。
 *
 * 业务代码禁止直接读取 process.platform/process.arch，也禁止调用 os.platform/os.arch/os.release；
 * 这些事实必须经 electron/backend/platform/ 暴露，才能通过注入在 Windows/macOS/Linux CI 上验证。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const ELECTRON = path.join(ROOT, "electron");
const PLATFORM_DIR = path.join(ELECTRON, "backend", "platform") + path.sep;
const PATTERNS = [
  /process\.platform/g,
  /process\.arch/g,
  /os\.platform\s*\(/g,
  /os\.arch\s*\(/g,
  /os\.release\s*\(/g,
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, out);
    else if (entry.isFile() && entry.name.endsWith(".cjs")) out.push(file);
  }
  return out;
}

/** 去注释但保留换行，避免注释里的说明触发门禁，同时保留报告行号。 */
function stripComments(source) {
  let out = "";
  let inBlock = false;
  let inLine = false;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      } else {
        out += " ";
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        out += "  ";
        i++;
        inBlock = false;
      } else {
        out += ch === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (quote) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "/" && next === "/") {
      out += "  ";
      i++;
      inLine = true;
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  ";
      i++;
      inBlock = true;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    out += ch;
  }
  return out;
}

const violations = [];
let scanned = 0;
for (const file of walk(ELECTRON)) {
  if (file.startsWith(PLATFORM_DIR)) continue;
  scanned++;
  const source = stripComments(fs.readFileSync(file, "utf8"));
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const re of PATTERNS) {
      re.lastIndex = 0;
      if (re.test(lines[i])) {
        violations.push(`${path.relative(ROOT, file)}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  }
}

if (violations.length) {
  console.error(`[platform-check] 发现 ${violations.length} 处越界平台分支：`);
  for (const item of violations) console.error(`  ${item}`);
  console.error("请改用 electron/backend/platform/index.cjs 或 platform/paths.cjs。");
  process.exit(1);
}

console.log(`[platform-check] ${scanned} 个 Electron CJS 文件均通过平台边界门禁`);
