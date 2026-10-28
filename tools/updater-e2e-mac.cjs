"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { ROOT, sha256, findOne, run, waitFor, readResult, serverFor, stopProcess } = require("./updater-e2e-common.cjs");

const CACHE = path.join(ROOT, ".updater-e2e-mac");
const OLD_VERSION = "9.9.1";
const NEW_VERSION = "9.9.2";
const skipBuild = process.argv.includes("--skip-build");
let child = null;

function findApp(dir) {
  const queue = [dir];
  while (queue.length) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && entry.name.endsWith(".app")) return full;
      if (entry.isDirectory()) queue.push(full);
    }
  }
  return "";
}
function extractZip(zip, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync("ditto", ["-x", "-k", zip, dir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`解压 zip 失败：${r.stderr}`);
  const app = findApp(dir);
  if (!app) throw new Error("zip 中未找到 .app");
  return app;
}
function appVersion(app) {
  const r = spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", path.join(app, "Contents", "Info.plist")], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || "读取 Info.plist 失败");
  return String(r.stdout || "").trim();
}
function killApp(app) {
  stopProcess(child);
  child = null;
  spawnSync("pkill", ["-f", path.join(app, "Contents", "MacOS", "AgentHub")], { stdio: "ignore" });
}
function launchApp(app, opts) {
  const binary = path.join(app, "Contents", "MacOS", "AgentHub");
  const env = {
    ...process.env,
    AGENTHUB_UPDATE_URL: opts.url,
    AGENTHUB_UPDATE_FIRST_CHECK_MS: "1000",
    AGENTHUB_UPDATE_AUTO_DOWNLOAD: "1",
    AGENTHUB_UPDATE_AUTO_INSTALL: opts.autoInstall ? "1" : "0",
    AGENTHUB_UPDATE_SMOKE_RESULT_FILE: opts.resultFile,
    AGENTHUB_ALLOW_MULTI: "1",
    AGENTHUB_DATA_DIR: opts.dataDir,
    AGENT_SKILLS_HOME: opts.skillsDir,
    HOME: opts.home,
    ELECTRON_DISABLE_GPU: "1",
  };
  const log = fs.openSync(opts.log, "w");
  child = spawn(binary, [], { env, detached: true, stdio: ["ignore", log, log] });
  fs.closeSync(log);
}

(async () => {
  if (process.platform !== "darwin") throw new Error("此脚本只能在 macOS 运行");
  if (!process.env.MAC_CSC_LINK || !process.env.MAC_CSC_KEY_PASSWORD) throw new Error("缺少 MAC_CSC_LINK / MAC_CSC_KEY_PASSWORD");
  fs.rmSync(CACHE, { recursive: true, force: true });
  fs.mkdirSync(CACHE, { recursive: true });
  if (!skipBuild) {
    run("npm", ["run", "build"]);
    run("node", ["tools/prepare-native-resources.cjs", "--platform=darwin", `--arch=${process.arch}`]);
  }
  const arch = process.arch === "arm64" ? "--arm64" : "--x64";
  const buildEnv = {
    ...process.env,
    CSC_LINK: process.env.MAC_CSC_LINK,
    CSC_KEY_PASSWORD: process.env.MAC_CSC_KEY_PASSWORD,
    SKIP_NOTARIZE: "1",
  };
  for (const [version, dir] of [[OLD_VERSION, "old"], [NEW_VERSION, "new"]]) {
    run("npx", [
      "electron-builder", "--mac", "zip", arch, "--publish", "never",
      `-c.extraMetadata.version=${version}`, `-c.directories.output=${path.join(CACHE, dir)}`,
      "-c.forceCodeSigning=true",
    ], { env: buildEnv });
  }
  const oldZip = findOne(path.join(CACHE, "old"), /\.zip$/i);
  const newZip = findOne(path.join(CACHE, "new"), /\.zip$/i);
  if (!oldZip || !newZip) throw new Error("缺少旧/新 macOS ZIP");

  const successRoot = path.join(CACHE, "success");
  const successApp = extractZip(oldZip, path.join(successRoot, "app-root"));
  if (appVersion(successApp) !== OLD_VERSION) throw new Error("旧版本解压异常");
  const dataDir = path.join(successRoot, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const sentinel = path.join(dataDir, "updater-e2e.txt");
  fs.writeFileSync(sentinel, OLD_VERSION, "utf8");
  const successServer = await serverFor(path.join(CACHE, "new"));
  try {
    launchApp(successApp, {
      url: `http://127.0.0.1:${successServer.address().port}/`,
      resultFile: path.join(successRoot, "result.json"),
      autoInstall: true,
      dataDir,
      skillsDir: path.join(successRoot, "skills"),
      home: path.join(successRoot, "home"),
      log: path.join(successRoot, "app.log"),
    });
    await waitFor(() => {
      try { return appVersion(successApp) === NEW_VERSION; } catch { return false; }
    }, 180000, "macOS 更新后版本变成 9.9.2");
    const codesign = spawnSync("codesign", ["--verify", "--deep", "--strict", successApp], { encoding: "utf8" });
    if (codesign.status !== 0) throw new Error(`更新后签名校验失败：${codesign.stderr}`);
    killApp(successApp);
    if (fs.readFileSync(sentinel, "utf8") !== OLD_VERSION) throw new Error("更新后用户数据丢失");
    console.log("macOS 更新成功链路通过：9.9.1 -> 9.9.2");
  } finally {
    killApp(successApp);
    successServer.close();
  }

  const failureRoot = path.join(CACHE, "failure");
  const failureApp = extractZip(oldZip, path.join(failureRoot, "app-root"));
  const corruptDir = path.join(CACHE, "corrupt");
  fs.cpSync(path.join(CACHE, "new"), corruptDir, { recursive: true });
  const corruptZip = findOne(corruptDir, /\.zip$/i);
  fs.appendFileSync(corruptZip, Buffer.from("corrupted"));
  const failureServer = await serverFor(corruptDir);
  const failureBefore = sha256(path.join(failureApp, "Contents", "Info.plist"));
  try {
    launchApp(failureApp, {
      url: `http://127.0.0.1:${failureServer.address().port}/`,
      resultFile: path.join(failureRoot, "result.json"),
      autoInstall: false,
      dataDir: path.join(failureRoot, "data"),
      skillsDir: path.join(failureRoot, "skills"),
      home: path.join(failureRoot, "home"),
      log: path.join(failureRoot, "app.log"),
    });
    const failed = await waitFor(() => {
      const r = readResult(path.join(failureRoot, "result.json"));
      return r && r.status === "error" ? r : null;
    }, 90000, "损坏 macOS 更新进入 error");
    if (!/完整性校验失败|SHA-512|checksum/i.test(failed.message || "")) throw new Error(`错误分类异常：${failed.message}`);
    if (appVersion(failureApp) !== OLD_VERSION || sha256(path.join(failureApp, "Contents", "Info.plist")) !== failureBefore) throw new Error("损坏更新改变了旧安装");
    console.log("macOS 更新失败保护通过：损坏包未安装");
  } finally {
    killApp(failureApp);
    failureServer.close();
  }
  fs.rmSync(CACHE, { recursive: true, force: true });
})().catch((error) => {
  killApp("");
  console.error("macOS 更新 E2E 失败：", (error && error.stack) || error);
  console.error(`诊断目录：${CACHE}`);
  process.exit(1);
});
