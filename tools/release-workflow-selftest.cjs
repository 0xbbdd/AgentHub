"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const workflowDir = path.join(__dirname, "..", ".github", "workflows");
const file = path.join(workflowDir, "release.yml");
const workflow = yaml.load(fs.readFileSync(file, "utf8"));
const ciWorkflow = yaml.load(fs.readFileSync(path.join(workflowDir, "ci.yml"), "utf8"));
assert.ok(workflow.jobs.validate, "缺少 validate job");
assert.ok(workflow.jobs.package, "缺少 package job");
assert.ok(workflow.jobs.publish, "缺少 publish job");
assert.ok(workflow.jobs["updater-e2e"], "缺少 Linux updater E2E");
assert.ok(workflow.jobs["updater-e2e-win"], "缺少 Windows updater E2E");
assert.ok(workflow.jobs["updater-e2e-mac"], "缺少 macOS updater E2E");
const publishNeeds = workflow.jobs.publish.needs;
for (const needed of ["package", "updater-e2e", "updater-e2e-win", "updater-e2e-mac"]) {
  assert.ok(publishNeeds.includes(needed), `publish 未依赖 ${needed}`);
}
const inputs = workflow.jobs.validate.steps.find((s) => String(s.name).includes("校验版本号")).env;
assert.ok(inputs && "DRY_RUN" in inputs, "版本校验步骤缺少 DRY_RUN");
const publishSteps = workflow.jobs.publish.steps;
for (const name of ["创建草稿 Release", "发布前校验草稿 Release 资产与更新清单", "发布 Release"]) {
  const step = publishSteps.find((s) => s.name === name);
  assert.ok(step, `缺少步骤 ${name}`);
  assert.match(String(step.if || ""), /dry_run/, `${name} 未受 dry_run 控制`);
}
assert.ok(publishSteps.some((s) => s.name === "上传 Dry Run 发布制品"), "缺少 dry-run 制品上传");

for (const [label, candidate] of [["CI", ciWorkflow], ["Release", workflow]]) {
  const steps = candidate.jobs.package.steps;
  for (const name of [
    "Linux Electron GUI E2E",
    "Windows/macOS Electron GUI E2E",
    "Linux 真实 Secret Service 安全存储 E2E",
    "Windows/macOS 真实系统安全存储 E2E",
    "Linux 轻量模式桌面 E2E",
    "Windows/macOS 轻量模式桌面 E2E",
    "上传 GUI E2E 失败截图",
  ]) {
    assert.ok(steps.some((s) => s.name === name), `${label} package job 缺少步骤 ${name}`);
  }
  const screenshot = steps.find((s) => s.name === "上传 GUI E2E 失败截图");
  assert.equal(screenshot.if, "failure()", `${label} GUI E2E 截图未在失败时上传`);
  assert.match(String(screenshot.with.path), /gui-e2e-failure\.png/, `${label} GUI E2E 截图路径不正确`);
  assert.match(String(screenshot.with.path), /window-mode-main-e2e-failure\.png/, `${label} 轻量模式截图路径缺失`);
}
const releasePackageSteps = workflow.jobs.package.steps;
const signatureIndex = releasePackageSteps.findIndex((s) => String(s.name).includes("验证 macOS 签名"));
const guiIndex = releasePackageSteps.findIndex((s) => s.name === "Linux Electron GUI E2E");
const secureIndex = releasePackageSteps.findIndex((s) => s.name === "Linux 真实 Secret Service 安全存储 E2E");
const windowIndex = releasePackageSteps.findIndex((s) => s.name === "Linux 轻量模式桌面 E2E");
const uploadIndex = releasePackageSteps.findIndex((s) => s.name === "上传当前平台构建产物");
assert.ok(signatureIndex >= 0 && signatureIndex < guiIndex, "GUI E2E 必须在签名验证之后执行");
assert.ok(guiIndex < secureIndex, "系统安全存储 E2E 必须在主 GUI E2E 之后执行");
assert.ok(secureIndex < windowIndex, "轻量模式 E2E 必须在安全存储 E2E 之后执行");
assert.ok(windowIndex < uploadIndex, "轻量模式 E2E 必须在制品上传之前执行");

const pkg = require(path.join(__dirname, "..", "package.json"));
assert.equal(pkg.scripts["e2e:electron"], "node tools/electron-gui-e2e.cjs", "缺少 e2e:electron 命令");
assert.equal(pkg.scripts["e2e:window-mode"], "node tools/window-mode-e2e.cjs", "缺少 e2e:window-mode 命令");
assert.equal(pkg.scripts["e2e:window-mode:main"], "node tools/window-mode-main-e2e.cjs", "缺少 e2e:window-mode:main 命令");
assert.equal(pkg.scripts["e2e:secure-storage"], "electron tools/electron-secure-storage-e2e.cjs", "缺少 e2e:secure-storage 命令");
console.log("发布工作流结构自测通过");
