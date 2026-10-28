// 汇总三平台构建 artifact：合并 macOS 双架构更新清单、生成 SHA256SUMS 并校验更新引用。
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const MANIFESTS = ["latest.yml", "latest-mac.yml", "latest-linux.yml"];
const CHECKSUM_FILE = "SHA256SUMS.txt";
const CHECKSUM_SIG = "SHA256SUMS.txt.asc";

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sha512Base64(file) {
  return crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64");
}

/** electron-updater 清单完整性：文件存在、size/sha512 匹配，blockmap 存在时校验大小。 */
function verifyManifestAssets(dest, doc, name = "manifest") {
  for (const item of Array.isArray(doc.files) ? doc.files : []) {
    const targetName = safeBase(item.url);
    const target = path.join(dest, targetName);
    if (!fs.existsSync(target)) throw new Error(`${name} 引用不存在的资产：${targetName}`);
    const st = fs.statSync(target);
    if (item.size != null && Number(item.size) !== st.size) {
      throw new Error(`${name} 文件大小不一致：${targetName} 期望 ${item.size} 实际 ${st.size}`);
    }
    if (item.sha512) {
      const actual = sha512Base64(target);
      if (actual !== item.sha512) throw new Error(`${name} SHA-512 不一致：${targetName}`);
    }
    if (item.blockMapSize != null) {
      const blockmap = `${target}.blockmap`;
      if (fs.existsSync(blockmap) && fs.statSync(blockmap).size !== Number(item.blockMapSize)) {
        throw new Error(`${name} blockmap 大小不一致：${targetName}.blockmap`);
      }
    }
  }
  if (doc.path) {
    const primary = path.join(dest, safeBase(doc.path));
    if (!fs.existsSync(primary)) throw new Error(`${name} path 指向不存在的资产：${doc.path}`);
    if (doc.sha512 && sha512Base64(primary) !== doc.sha512) throw new Error(`${name} path SHA-512 不一致：${doc.path}`);
  }
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, out);
    else if (entry.isFile()) out.push(file);
  }
  return out;
}

function safeBase(value) {
  const text = decodeURIComponent(String(value || "").split("?")[0]);
  return path.basename(text.replace(/\\/g, "/"));
}

function mergeDocs(name, docs) {
  if (!docs.length) throw new Error(`缺少 ${name}`);
  const version = String(docs[0].version || "");
  if (!version) throw new Error(`${name} 缺少 version`);
  for (const doc of docs) {
    if (String(doc.version || "") !== version) throw new Error(`${name} 版本不一致：${version} / ${doc.version}`);
  }
  const base = { ...docs[0] };
  const byUrl = new Map();
  for (const doc of docs) {
    for (const item of Array.isArray(doc.files) ? doc.files : []) {
      if (!item || !item.url) continue;
      const key = safeBase(item.url);
      if (!byUrl.has(key)) byUrl.set(key, { ...item, url: key });
    }
  }
  const rank = (item) => (/arm64/i.test(item.url) ? 20 : /x64/i.test(item.url) ? 10 : 0);
  const files = [...byUrl.values()].sort((a, b) => rank(a) - rank(b) || a.url.localeCompare(b.url));
  if (!files.length) throw new Error(`${name} 没有 files[]`);
  const primary = files[0];
  base.files = files;
  base.path = primary.url;
  base.sha512 = primary.sha512;
  if (docs.length > 1) base.releaseDate = docs.map((d) => d.releaseDate || "").filter(Boolean).sort().pop() || base.releaseDate;
  const notes = docs.find((d) => String(d.releaseNotes || "").trim());
  if (notes) base.releaseNotes = notes.releaseNotes;
  return base;
}

function validatePlatformAssets(files) {
  const names = files.map((file) => path.basename(file));
  const has = (re) => names.some((name) => re.test(name));
  const missing = [];
  if (!has(/\.exe$/i)) missing.push("Windows .exe");
  if (!has(/mac.*x64.*\.dmg$/i) && !has(/x64.*mac.*\.dmg$/i)) missing.push("macOS x64 .dmg");
  if (!has(/mac.*arm64.*\.dmg$/i) && !has(/arm64.*mac.*\.dmg$/i)) missing.push("macOS arm64 .dmg");
  if (!has(/\.AppImage$/i)) missing.push("Linux .AppImage");
  if (!has(/\.deb$/i)) missing.push("Linux .deb");
  if (missing.length) throw new Error(`发布资产不完整：${missing.join("、")}`);
}

function assemble(src, dest, opts = {}) {
  const expectedVersion = String(opts.version || require("../package.json").version);
  if (!fs.existsSync(src)) throw new Error(`artifact 目录不存在：${src}`);
  fs.mkdirSync(dest, { recursive: true });
  const sourceFiles = walk(src);
  const manifestDocs = new Map();
  const copied = new Map();

  for (const file of sourceFiles) {
    const name = path.basename(file);
    if (name.endsWith(".blockmap")) continue; // 与主包一起复制，避免重复处理
    if (MANIFESTS.includes(name)) {
      const doc = yaml.load(fs.readFileSync(file, "utf8"));
      if (!doc || typeof doc !== "object") throw new Error(`${name} 解析失败：${file}`);
      if (String(doc.version) !== expectedVersion) throw new Error(`${name} 版本 ${doc.version} != ${expectedVersion}`);
      const list = manifestDocs.get(name) || [];
      list.push(doc);
      manifestDocs.set(name, list);
      continue;
    }
    if (name === CHECKSUM_FILE || name === CHECKSUM_SIG) continue;
    const target = path.join(dest, name);
    const digest = sha256(file);
    if (copied.has(name)) {
      if (copied.get(name) !== digest) throw new Error(`文件名冲突且内容不同：${name}`);
      continue;
    }
    fs.copyFileSync(file, target);
    copied.set(name, digest);
  }

  // blockmap 与同名主包一起复制，但不参与清单主文件选择。
  for (const file of sourceFiles) {
    const name = path.basename(file);
    if (!name.endsWith(".blockmap")) continue;
    const target = path.join(dest, name);
    const digest = sha256(file);
    if (copied.has(name)) {
      if (copied.get(name) !== digest) throw new Error(`文件名冲突且内容不同：${name}`);
      continue;
    }
    fs.copyFileSync(file, target);
    copied.set(name, digest);
  }

  const merged = {};
  for (const name of MANIFESTS) {
    const docs = manifestDocs.get(name);
    if (!docs || !docs.length) throw new Error(`缺少更新清单：${name}`);
    const doc = mergeDocs(name, docs);
    if (String(doc.version) !== expectedVersion) throw new Error(`${name} 合并后版本异常`);
    verifyManifestAssets(dest, doc, name);
    merged[name] = doc;
    fs.writeFileSync(path.join(dest, name), yaml.dump(doc, { noRefs: true, lineWidth: -1, noCompatMode: true }), "utf8");
    copied.set(name, sha256(path.join(dest, name)));
  }

  if (!opts.skipPlatformValidation) {
    validatePlatformAssets([...copied.keys()].map((name) => path.join(dest, name)));
  }

  const summary = {
    version: expectedVersion,
    generatedAt: new Date().toISOString(),
    manifests: Object.fromEntries(Object.entries(merged).map(([name, doc]) => [name, {
      version: doc.version,
      files: doc.files.map((item) => item.url),
      primary: doc.path,
    }])),
    assets: [...copied.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, digest]) => ({ name, sha256: digest })),
  };
  fs.writeFileSync(path.join(dest, "RELEASE-MANIFEST.json"), JSON.stringify(summary, null, 2), "utf8");

  const checksumFiles = fs.readdirSync(dest).filter((name) => name !== CHECKSUM_FILE && name !== CHECKSUM_SIG).sort();
  const lines = checksumFiles.map((name) => `${sha256(path.join(dest, name))}  ${name}`);
  fs.writeFileSync(path.join(dest, CHECKSUM_FILE), `${lines.join("\n")}\n`, "utf8");
  return summary;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const src = args.find((arg) => !arg.startsWith("--")) || "release-artifacts";
  const dest = args.filter((arg) => !arg.startsWith("--"))[1] || "release-assets";
  try {
    const summary = assemble(src, dest, { skipPlatformValidation: args.includes("--skip-platform-validation") });
    console.log(`[release] v${summary.version} 汇总完成：${summary.assets.length} 个资产 -> ${dest}`);
    for (const [name, doc] of Object.entries(summary.manifests)) console.log(`  ${name}: ${doc.files.join(", ")}`);
  } catch (error) {
    console.error(`[release] 汇总失败：${(error && error.message) || error}`);
    process.exit(1);
  }
}

module.exports = { assemble, mergeDocs, validatePlatformAssets, verifyManifestAssets, sha256, sha512Base64 };
