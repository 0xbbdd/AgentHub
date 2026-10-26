// IPC 白名单一致性检查：preload 放行的命令必须与主进程 ipcMain.handle 注册完全一致。
// 用法：node tools/check-ipc-commands.cjs [--root <dir>]
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
function argOf(flag, dft) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dft;
}

const ROOT = path.resolve(argOf("--root", path.join(__dirname, "..")));
const PRELOAD = path.join(ROOT, "electron", "preload.cjs");
const ELECTRON = path.join(ROOT, "electron");

function walkCjs(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walkCjs(file, out);
    else if (entry.isFile() && entry.name.endsWith(".cjs")) out.push(file);
  }
  return out;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function addCommand(map, command, file) {
  const list = map.get(command) || [];
  list.push(file);
  map.set(command, list);
}

const preloadSource = stripComments(fs.readFileSync(PRELOAD, "utf8"));
const allowedBlock = preloadSource.match(/const\s+ALLOWED_COMMANDS\s*=\s*new\s+Set\s*\(\s*\[([\s\S]*?)\]\s*\)\s*;/);
if (!allowedBlock) {
  console.error("[ipc-check] 未找到 electron/preload.cjs 中的 ALLOWED_COMMANDS = new Set([...])");
  process.exit(1);
}

const allowed = new Map();
for (const match of allowedBlock[1].matchAll(/["']([^"']+)["']/g)) {
  addCommand(allowed, match[1], "electron/preload.cjs");
}

const registered = new Map();
const dynamicRegistrations = [];
for (const file of walkCjs(ELECTRON)) {
  const source = stripComments(fs.readFileSync(file, "utf8"));
  for (const match of source.matchAll(/ipcMain\.handle\s*\(\s*(["'])([^"']+)\1/g)) {
    addCommand(registered, match[2], path.relative(ROOT, file));
  }
  for (const match of source.matchAll(/ipcMain\.handle\s*\(\s*([^"')\s][^,)]*)/g)) {
    dynamicRegistrations.push(`${path.relative(ROOT, file)}: ${match[1].trim()}`);
  }
}

const issues = [];
function duplicateIssues(label, map) {
  for (const [command, files] of map) {
    if (files.length > 1) issues.push(`${label}重复：${command} -> ${files.join(", ")}`);
  }
}
duplicateIssues("白名单", allowed);
duplicateIssues("注册", registered);

for (const command of allowed.keys()) {
  if (!registered.has(command)) issues.push(`白名单有、主进程未注册：${command}`);
}
for (const command of registered.keys()) {
  if (!allowed.has(command)) issues.push(`主进程已注册、白名单遗漏：${command}`);
}
for (const item of dynamicRegistrations) issues.push(`无法静态校验的动态注册：${item}`);

if (issues.length) {
  console.error(`[ipc-check] 发现 ${issues.length} 个 IPC 命令一致性问题：`);
  for (const issue of issues) console.error(`  ${issue}`);
  process.exit(1);
}

console.log(`[ipc-check] ${allowed.size} 个白名单命令与 ${registered.size} 个主进程注册完全一致`);
