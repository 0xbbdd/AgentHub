// SFC 组件解析检查：捕获 `dirs: []` 关闭自动注册后，模板里引用本地组件却漏 import 的回归。
// 只检查 PascalCase 标签；Element Plus 的自动导入组件从 src/components.d.ts 读取。
// 用法：node tools/check-sfc-components.cjs [--root <dir>]
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
function argOf(flag, dft) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dft;
}

const ROOT = path.resolve(argOf("--root", path.join(__dirname, "..")));
const SRC = path.join(ROOT, "src");
const DTS = path.join(SRC, "components.d.ts");

// Vue 运行时内置组件不会出现在本地 import 里，也不应由业务代码重复注册。
const BUILTINS = new Set([
  "Teleport",
  "Transition",
  "TransitionGroup",
  "KeepAlive",
  "Suspense",
  "Component",
  "Slot",
  "Fragment",
  "BaseTransition",
  "AsyncComponent",
]);

function walkVue(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walkVue(file, out);
    else if (entry.isFile() && entry.name.endsWith(".vue")) out.push(file);
  }
  return out;
}

function walkSource(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSource(file, out);
    else if (entry.isFile() && /\.(ts|vue)$/.test(entry.name)) out.push(file);
  }
  return out;
}

function templateOf(source) {
  const match = source.match(/<template\b[^>]*>([\s\S]*)<\/template>/i);
  return match ? match[1].replace(/<!--[\s\S]*?-->/g, "") : "";
}

function scriptOf(source) {
  return [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .join("\n");
}

function stripJsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function importBindings(script) {
  const out = new Set();
  const clean = stripJsComments(script);
  for (const match of clean.matchAll(/^\s*import\s+([\s\S]*?)\s+from\s+["'][^"']+["']/gm)) {
    const clause = match[1].trim();
    if (!clause || /^type\b/.test(clause)) continue;

    const named = clause.match(/\{([\s\S]*?)\}/);
    if (named) {
      for (const part of named[1].split(",")) {
        const item = part.trim().replace(/^type\s+/, "");
        if (!item) continue;
        const parsed = item.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
        if (parsed) out.add(parsed[2] || parsed[1]);
      }
    }

    const namespace = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (namespace) out.add(namespace[1]);

    const withoutNamed = clause.replace(/\{[\s\S]*?\}/g, "");
    const defaultBinding = withoutNamed.split(",")[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(defaultBinding)) out.add(defaultBinding);
  }
  return out;
}

function localBindings(script) {
  const out = importBindings(script);
  const clean = stripJsComments(script);

  // <script setup> 的顶层变量/函数/类都会暴露给模板；App.vue 的 asyncView 组件就走这里。
  for (const match of clean.matchAll(/^\s*(?:const|let|var|function|class)\s+([A-Z][A-Za-z0-9]*)\b/gm)) {
    out.add(match[1]);
  }

  // 兼容 Options API 的 components: { Foo } 写法。
  const options = clean.match(/components\s*:\s*\{([\s\S]*?)\}/);
  if (options) {
    for (const match of options[1].matchAll(/(?:^|,)\s*([A-Z][A-Za-z0-9]*)\s*(?::|,|$)/gm)) out.add(match[1]);
  }
  return out;
}

function globalBindings() {
  const out = new Set();
  if (fs.existsSync(DTS)) {
    const dts = fs.readFileSync(DTS, "utf8");
    for (const match of dts.matchAll(/^\s*([A-Z][A-Za-z0-9]*)\s*:/gm)) out.add(match[1]);
  }
  for (const file of walkSource(SRC)) {
    if (file.endsWith(".vue")) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/\.component\(\s*["']([A-Z][A-Za-z0-9]*)["']/g)) out.add(match[1]);
  }
  return out;
}

function componentTags(source) {
  const template = templateOf(source);
  const tags = new Set();
  for (const match of template.matchAll(/<(?![\/!])([A-Z][A-Za-z0-9]*)\b/g)) tags.add(match[1]);
  return tags;
}

const files = walkVue(SRC);
const globals = globalBindings();
const issues = [];
let tagCount = 0;

for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  const tags = componentTags(source);
  tagCount += tags.size;
  const known = localBindings(scriptOf(source));
  for (const tag of tags) {
    if (BUILTINS.has(tag) || globals.has(tag) || known.has(tag)) continue;
    issues.push({ file: path.relative(ROOT, file), tag });
  }
}

if (issues.length) {
  console.error(`[sfc-check] 发现 ${issues.length} 个未解析的 PascalCase 组件：`);
  for (const issue of issues) console.error(`  ${issue.file}: <${issue.tag}>`);
  console.error("请在对应 SFC 的 <script setup> 中 import，或在 src/components.d.ts / app.component 中显式注册。");
  process.exit(1);
}

console.log(`[sfc-check] ${files.length} 个 SFC，${tagCount} 个 PascalCase 组件引用，全部可解析`);
