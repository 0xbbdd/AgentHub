"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { ROOT, sha256, findOne, run, waitFor, readResult, serverFor, stopProcess } = require("./updater-e2e-common.cjs");

const CACHE = path.join(ROOT, ".updater-e2e-win");
const OLD_VERSION = "9.9.1";
const NEW_VERSION = "9.9.2";
const skipBuild = process.argv.includes("--skip-build");
let child = null;

function ps(script) {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return String(r.stdout || "").trim();
}
function installNsis(installer, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync(installer, ["/S", `/D=${dir}`], { windowsHide: true, timeout: 120000 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`NSIS 安装失败 exit=${r.status}`);
  const app = findOne(dir, /^AgentHub\.exe$/i);
  if (!app || !fs.existsSync(app)) throw new Error("安装后未找到 AgentHub.exe");
  return app;
}
function appVersion(file) {
  return ps(`(Get-Item -LiteralPath '${file.replace(/'/g, "''")}').VersionInfo.ProductVersion`);
}
function launchApp(app, opts) {
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
    ELECTRON_DISABLE_GPU: "1",
  };
  const log = fs.openSync(opts.log, "w");
  child = spawn(app, [], { cwd: path.dirname(app), env, detached: true, stdio: ["ignore", log, log] });
  fs.closeSync(log);
}
function killAgentHub() {
  stopProcess(child);
  child = null;
  spawnSync("taskkill", ["/IM", "AgentHub.exe", "/T", "/F"], { windowsHide: true });
}

(async () => {
  if (process.platform !== "win32") throw new Error("此脚本只能在 Windows 运行");
  if (!process.env.WIN_CSC_LINK || !process.env.WIN_CSC_KEY_PASSWORD || !process.env.WIN_PUBLISHER_NAME) {
    throw new Error("缺少 WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD / WIN_PUBLISHER_NAME");
  }
  fs.rmSync(CACHE, { recursive: true, force: true });
  fs.mkdirSync(CACHE, { recursive: true });
  if (!skipBuild) {
    run("npm", ["run", "build"]);
    run("node", ["tools/prepare-native-resources.cjs", "--platform=win32", "--arch=x64"]);
  }
  const buildEnv = { ...process.env, CSC_LINK: process.env.WIN_CSC_LINK, CSC_KEY_PASSWORD: process.env.WIN_CSC_KEY_PASSWORD };
  for (const [version, dir] of [[OLD_VERSION, "old"], [NEW_VERSION, "new"]]) {
    run("npx", [
      "electron-builder", "--win", "nsis", "--x64", "--publish", "never",
      `-c.extraMetadata.version=${version}`, `-c.directories.output=${path.join(CACHE, dir)}`,
      "-c.forceCodeSigning=true", `-c.win.publisherName=${process.env.WIN_PUBLISHER_NAME}`,
    ], { env: buildEnv });
  }
  const oldInstaller = findOne(path.join(CACHE, "old"), /\.exe$/i);
  const newInstaller = findOne(path.join(CACHE, "new"), /\.exe$/i);
  if (!oldInstaller || !newInstaller) throw new Error("缺少旧/新 Windows 安装包");

  const successRoot = path.join(CACHE, "success");
  const successInstall = path.join(successRoot, "app");
  const successApp = installNsis(oldInstaller, successInstall);
  if (appVersion(successApp) !== OLD_VERSION) throw new Error("旧版本安装异常");
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
      log: path.join(successRoot, "app.log"),
    });
    await waitFor(() => {
      try { return appVersion(successApp) === NEW_VERSION; } catch { return false; }
    }, 180000, "Windows 更新后版本变成 9.9.2");
    const result = readResult(path.join(successRoot, "result.json"));
    if (!result || !["downloaded", "up-to-date"].includes(result.status)) throw new Error(`未观察到完成状态：${JSON.stringify(result)}`);
    killAgentHub();
    if (fs.readFileSync(sentinel, "utf8") !== OLD_VERSION) throw new Error("更新后用户数据丢失");
    console.log("Windows 更新成功链路通过：9.9.1 -> 9.9.2");
  } finally {
    killAgentHub();
    successServer.close();
  }

  const failureRoot = path.join(CACHE, "failure");
  const failureInstall = path.join(failureRoot, "app");
  const failureApp = installNsis(oldInstaller, failureInstall);
  const corruptDir = path.join(CACHE, "corrupt");
  fs.cpSync(path.join(CACHE, "new"), corruptDir, { recursive: true });
  const corruptInstaller = findOne(corruptDir, /\.exe$/i);
  fs.appendFileSync(corruptInstaller, Buffer.from("corrupted"));
  const failureServer = await serverFor(corruptDir);
  const failureBefore = sha256(failureApp);
  try {
    launchApp(failureApp, {
      url: `http://127.0.0.1:${failureServer.address().port}/`,
      resultFile: path.join(failureRoot, "result.json"),
      autoInstall: false,
      dataDir: path.join(failureRoot, "data"),
      skillsDir: path.join(failureRoot, "skills"),
      log: path.join(failureRoot, "app.log"),
    });
    const failed = await waitFor(() => {
      const r = readResult(path.join(failureRoot, "result.json"));
      return r && r.status === "error" ? r : null;
    }, 90000, "损坏 Windows 更新进入 error");
    if (!/完整性校验失败|SHA-512|checksum/i.test(failed.message || "")) throw new Error(`错误分类异常：${failed.message}`);
    if (appVersion(failureApp) !== OLD_VERSION || sha256(failureApp) !== failureBefore) throw new Error("损坏更新改变了旧安装");
    console.log("Windows 更新失败保护通过：损坏包未安装");
  } finally {
    killAgentHub();
    failureServer.close();
  }
  fs.rmSync(CACHE, { recursive: true, force: true });
})().catch((error) => {
  killAgentHub();
  console.error("Windows 更新 E2E 失败：", (error && error.stack) || error);
  console.error(`诊断目录：${CACHE}`);
  process.exit(1);
});
