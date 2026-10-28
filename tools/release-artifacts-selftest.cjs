// 发布制品装配器自测：用假三平台 artifact 验证合并、清单引用与 SHA256SUMS。
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const yaml = require("js-yaml");
const { assemble, verifyManifestAssets } = require("./assemble-release.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-release-test-"));
const src = path.join(root, "artifacts");
const dest = path.join(root, "assets");
const version = "9.9.9";
function put(rel, content = rel) {
  const file = path.join(src, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}
function digest(file) { return crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64"); }
function manifest(files) {
  const rows = files.map(({ url, file }) => ({ url, sha512: digest(file), size: fs.statSync(file).size }));
  return yaml.dump({
    version,
    files: rows,
    path: rows[0].url,
    sha512: rows[0].sha512,
    releaseDate: "2026-10-27T00:00:00.000Z",
    releaseNotes: "release notes",
  });
}

try {
  put("win/AgentHub-9.9.9-win-x64.exe", "win-installer");
  put("win/AgentHub-9.9.9-win-x64.exe.blockmap", "win-blockmap");
  put("mac-x64/AgentHub-9.9.9-mac-x64.dmg", "mac-x64-dmg");
  put("mac-x64/AgentHub-9.9.9-mac-x64.zip", "mac-x64-zip");
  put("mac-arm64/AgentHub-9.9.9-mac-arm64.dmg", "mac-arm64-dmg");
  put("mac-arm64/AgentHub-9.9.9-mac-arm64.zip", "mac-arm64-zip");
  put("linux/AgentHub-9.9.9-linux-x64.AppImage", "linux-appimage");
  put("linux/AgentHub-9.9.9-linux-x64.deb", "linux-deb");
  put("win/latest.yml", manifest([{ url: "AgentHub-9.9.9-win-x64.exe", file: path.join(src, "win/AgentHub-9.9.9-win-x64.exe") }]));
  put("mac-x64/latest-mac.yml", manifest([{ url: "AgentHub-9.9.9-mac-x64.zip", file: path.join(src, "mac-x64/AgentHub-9.9.9-mac-x64.zip") }]));
  put("mac-arm64/latest-mac.yml", manifest([{ url: "AgentHub-9.9.9-mac-arm64.zip", file: path.join(src, "mac-arm64/AgentHub-9.9.9-mac-arm64.zip") }]));
  put("linux/latest-linux.yml", manifest([{ url: "AgentHub-9.9.9-linux-x64.AppImage", file: path.join(src, "linux/AgentHub-9.9.9-linux-x64.AppImage") }]));

  const summary = assemble(src, dest, { version });
  assert.equal(summary.version, version);
  assert.equal(summary.manifests["latest-mac.yml"].files.length, 2, "macOS 双架构 files[] 已合并");
  const mac = yaml.load(fs.readFileSync(path.join(dest, "latest-mac.yml"), "utf8"));
  assert.deepEqual(mac.files.map((file) => file.url), [
    "AgentHub-9.9.9-mac-x64.zip",
    "AgentHub-9.9.9-mac-arm64.zip",
  ]);
  for (const name of ["latest.yml", "latest-mac.yml", "latest-linux.yml", "SHA256SUMS.txt", "RELEASE-MANIFEST.json"]) {
    assert.ok(fs.existsSync(path.join(dest, name)), `生成 ${name}`);
  }
  const sums = fs.readFileSync(path.join(dest, "SHA256SUMS.txt"), "utf8");
  for (const name of ["AgentHub-9.9.9-win-x64.exe", "AgentHub-9.9.9-mac-x64.zip", "AgentHub-9.9.9-linux-x64.AppImage"]) {
    assert.ok(sums.includes(`  ${name}`), `SHA256SUMS 覆盖 ${name}`);
  }
  const linuxDoc = yaml.load(fs.readFileSync(path.join(dest, "latest-linux.yml"), "utf8"));
  const tampered = path.join(dest, "AgentHub-9.9.9-linux-x64.AppImage");
  fs.appendFileSync(tampered, "-tampered");
  assert.throws(() => verifyManifestAssets(dest, linuxDoc, "latest-linux.yml"), /大小不一致|SHA-512 不一致/);
  console.log(`发布制品装配器自测通过：${summary.assets.length} 个资产，篡改校验生效`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
