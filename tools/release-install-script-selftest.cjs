// 安装 smoke 脚本静态校验：shell 语法与关键安装/卸载步骤存在。
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
for (const file of [
  "tools/release-install-smoke-mac.sh",
  "tools/release-install-smoke-linux.sh",
  "tools/release-upgrade-smoke-mac.sh",
  "tools/release-upgrade-smoke-linux.sh",
]) {
  const r = spawnSync("bash", ["-n", path.join(root, file)], { encoding: "utf8" });
  assert.equal(r.status, 0, `${file} shell 语法失败：${r.stderr}`);
}
for (const file of ["tools/updater-e2e-smoke.cjs", "tools/updater-e2e-win.cjs", "tools/updater-e2e-mac.cjs"]) {
  const updaterCheck = spawnSync(process.execPath, ["--check", path.join(root, file)], { encoding: "utf8" });
  assert.equal(updaterCheck.status, 0, `${file} 语法失败：${updaterCheck.stderr}`);
}
const win = fs.readFileSync(path.join(root, "tools/release-install-smoke-win.ps1"), "utf8");
for (const token of ["/S", "AgentHub.exe", "taskkill", "Uninstall", "/D="]) assert.ok(win.includes(token), `Windows smoke 缺少 ${token}`);
const mac = fs.readFileSync(path.join(root, "tools/release-install-smoke-mac.sh"), "utf8");
for (const token of ["hdiutil attach", "ditto", "AgentHub", "kill -0"]) assert.ok(mac.includes(token), `macOS smoke 缺少 ${token}`);
const linux = fs.readFileSync(path.join(root, "tools/release-install-smoke-linux.sh"), "utf8");
for (const token of ["APPIMAGE_EXTRACT_AND_RUN=1", "dpkg-deb --info", "sudo dpkg -i", "apt-get remove"]) assert.ok(linux.includes(token), `Linux smoke 缺少 ${token}`);
const winUpgrade = fs.readFileSync(path.join(root, "tools/release-upgrade-smoke-win.ps1"), "utf8");
for (const token of ["upgrade-smoke.txt", "App-Version", "回滚", "/D="]) assert.ok(winUpgrade.includes(token), `Windows upgrade smoke 缺少 ${token}`);
const macUpgrade = fs.readFileSync(path.join(root, "tools/release-upgrade-smoke-mac.sh"), "utf8");
for (const token of ["hdiutil attach", "upgrade-smoke.txt", "ditto", "回滚"]) assert.ok(macUpgrade.includes(token), `macOS upgrade smoke 缺少 ${token}`);
const linuxUpgrade = fs.readFileSync(path.join(root, "tools/release-upgrade-smoke-linux.sh"), "utf8");
for (const token of ["dpkg --force-downgrade", "upgrade-smoke.txt", "AppImage", "回滚"]) assert.ok(linuxUpgrade.includes(token), `Linux upgrade smoke 缺少 ${token}`);
console.log("安装/升级 smoke 脚本静态校验通过");
