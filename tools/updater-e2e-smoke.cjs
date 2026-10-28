/**
 * Linux AppImage 真实更新 E2E（本地构建两版本 + 本地更新服务器）。
 * 默认会 npm run build 并构建 9.9.1 / 9.9.2；--skip-build 可复用已有目录。
 *
 * 覆盖：
 *   - electron-updater 下载真实 AppImage
 *   - SHA-512 校验
 *   - AppImage 替换安装
 *   - 更新后启动版本为 9.9.2
 *   - 损坏包校验失败，旧 AppImage 不被替换
 *   - 只读安装目录失败，旧 AppImage 不被替换
 *   - 文件大小受限模拟磁盘不足，旧 AppImage 不被替换
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const CACHE = path.join(ROOT, ".updater-e2e");
const OLD_VERSION = "9.9.1";
const NEW_VERSION = "9.9.2";
const skipBuild = process.argv.includes("--skip-build");
let child = null;

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exit=${r.status}`);
}
function findOne(dir, re) {
  const hit = fs.readdirSync(dir).find((name) => re.test(name));
  return hit ? path.join(dir, hit) : "";
}
function waitFor(fn, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      try {
        const value = fn();
        if (value) { clearInterval(timer); resolve(value); }
        else if (Date.now() - start > timeoutMs) { clearInterval(timer); reject(new Error(`等待超时：${label}`)); }
      } catch (error) { clearInterval(timer); reject(error); }
    }, 300);
  });
}
function stopChild() {
  if (!child) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
  child = null;
}
function serverFor(dir) {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    if (process.env.AGENTHUB_UPDATER_E2E_VERBOSE === "1") console.log(`[server] ${req.method} ${pathname}`);
    const file = path.join(dir, path.basename(pathname));
    if (!fs.existsSync(file)) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "content-length": fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
function extractAppImage(appImage, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "0", ELECTRON_RUN_AS_NODE: "" };
  const r = spawnSync(appImage, ["--appimage-extract"], { cwd: dir, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`AppImage 解包失败：${r.stderr || r.stdout}`);
  const bin = path.join(dir, "squashfs-root", "agenthub");
  if (!fs.existsSync(bin)) throw new Error("解包后未找到 agenthub");
  return bin;
}
function launchTestApp(binary, opts) {
  const log = fs.openSync(opts.log, "w");
  const env = {
    ...process.env,
    APPIMAGE: opts.appImage,
    AGENTHUB_UPDATE_URL: opts.url,
    AGENTHUB_UPDATE_FIRST_CHECK_MS: "1000",
    AGENTHUB_UPDATE_AUTO_DOWNLOAD: "1",
    AGENTHUB_UPDATE_AUTO_INSTALL: opts.autoInstall ? "1" : "0",
    AGENTHUB_UPDATE_SMOKE_RESULT_FILE: opts.resultFile,
    AGENTHUB_ALLOW_MULTI: "1",
    AGENTHUB_DATA_DIR: opts.dataDir,
    AGENT_SKILLS_HOME: opts.skillsDir,
    HOME: opts.home,
    XDG_CONFIG_HOME: opts.config,
    XDG_DATA_HOME: opts.dataHome,
    ELECTRON_DISABLE_GPU: "1",
  };
  delete env.APPIMAGE_EXTRACT_AND_RUN;
  if (opts.fileSizeLimitKb) {
    child = spawn("bash", ["-c", `ulimit -f ${Number(opts.fileSizeLimitKb)}; exec dbus-run-session -- xvfb-run -a "$@"`, "bash", binary, "--no-sandbox"], {
      cwd: ROOT, env, detached: true, stdio: ["ignore", log, log],
    });
  } else {
    child = spawn("dbus-run-session", ["--", "xvfb-run", "-a", binary, "--no-sandbox"], {
      cwd: ROOT, env, detached: true, stdio: ["ignore", log, log],
    });
  }
  fs.closeSync(log);
}
function readResult(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function verifyInstalledVersion(appImage, root) {
  const home = path.join(root, "verify-home");
  const config = path.join(root, "verify-config");
  const data = path.join(root, "verify-data");
  const env = {
    ...process.env,
    APPIMAGE_EXTRACT_AND_RUN: "1",
    AGENTHUB_ALLOW_MULTI: "1",
    AGENTHUB_DATA_DIR: data,
    AGENT_SKILLS_HOME: path.join(root, "verify-skills"),
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: path.join(root, "verify-data-home"),
    AGENTHUB_UPDATE_FIRST_CHECK_MS: "3600000",
    ELECTRON_DISABLE_GPU: "1",
  };
  const r = spawnSync("timeout", ["10s", "dbus-run-session", "--", "xvfb-run", "-a", appImage, "--no-sandbox"], {
    cwd: ROOT, env, encoding: "utf8", timeout: 20000,
  });
  if (r.status !== 0 && r.status !== 124) throw new Error(`更新后 AppImage 启动失败 exit=${r.status}`);
  const crash = path.join(config, "AgentHub-dev", "logs", "crash.log");
  const log = fs.readFileSync(crash, "utf8");
  if (!log.includes(`boot v${NEW_VERSION}`)) throw new Error(`更新后版本不是 ${NEW_VERSION}：${log.split("\n")[0] || "无日志"}`);
}

async function main() {
  fs.rmSync(CACHE, { recursive: true, force: true });
  fs.mkdirSync(CACHE, { recursive: true });
  if (!skipBuild) {
    run("npm", ["run", "build"]);
    run("node", ["tools/prepare-native-resources.cjs", "--platform=linux", "--arch=x64"]);
  }
  for (const [version, dir] of [[OLD_VERSION, "old"], [NEW_VERSION, "new"]]) {
    run("npx", [
      "electron-builder", "--linux", "AppImage", "--x64", "--publish", "never",
      `-c.extraMetadata.version=${version}`, `-c.directories.output=${path.join(CACHE, dir)}`,
    ], { env: { ...process.env, SKIP_NOTARIZE: "1", CSC_IDENTITY_AUTO_DISCOVERY: "false" } });
  }

  const oldDir = path.join(CACHE, "old");
  const newDir = path.join(CACHE, "new");
  const oldImage = findOne(oldDir, /\.AppImage$/i);
  const newImage = findOne(newDir, /\.AppImage$/i);
  if (!oldImage || !newImage) throw new Error("缺少 9.9.1/9.9.2 AppImage");

  const oldBackup = path.join(CACHE, "old-backup.AppImage");
  fs.copyFileSync(oldImage, oldBackup);
  const extractOld = path.join(CACHE, "old-extract");
  const oldBin = extractAppImage(oldBackup, extractOld);
  const oldHash = sha256(oldImage);
  const successRoot = path.join(CACHE, "success");
  const successResult = path.join(successRoot, "result.json");
  fs.mkdirSync(successRoot, { recursive: true });
  const successServer = await serverFor(newDir);
  const successPort = successServer.address().port;
  try {
    launchTestApp(oldBin, {
      appImage: oldImage,
      url: `http://127.0.0.1:${successPort}/`,
      resultFile: successResult,
      autoInstall: true,
      dataDir: path.join(successRoot, "data"),
      skillsDir: path.join(successRoot, "skills"),
      home: path.join(successRoot, "home"),
      config: path.join(successRoot, "config"),
      dataHome: path.join(successRoot, "data-home"),
      log: path.join(successRoot, "app.log"),
    });
    const updatedImage = await waitFor(() => {
      const candidate = findOne(oldDir, new RegExp(`AgentHub-${NEW_VERSION.replace(/\./g, "\\.")}.*\.AppImage$`, "i"));
      if (candidate && fs.existsSync(candidate)) return candidate;
      if (!fs.existsSync(oldImage)) return null;
      const current = sha256(oldImage);
      return current !== oldHash ? oldImage : null;
    }, 120000, "AppImage 被更新替换");
    const downloaded = readResult(successResult);
    if (!downloaded || downloaded.status !== "downloaded") throw new Error(`未观察到 downloaded 状态：${JSON.stringify(downloaded)}`);
    stopChild();
    if (sha256(updatedImage) !== sha256(newImage)) throw new Error("更新后 AppImage 与 9.9.2 不一致");
    verifyInstalledVersion(updatedImage, successRoot);
    console.log("更新成功链路通过：9.9.1 -> 9.9.2");
  } finally {
    stopChild();
    successServer.close();
  }

  const corruptDir = path.join(CACHE, "corrupt");
  fs.cpSync(newDir, corruptDir, { recursive: true });
  const corruptImage = findOne(corruptDir, /\.AppImage$/i);
  fs.appendFileSync(corruptImage, Buffer.from("corrupted-after-manifest"));
  const failureTarget = path.join(CACHE, "failure-target.AppImage");
  fs.copyFileSync(oldBackup, failureTarget);
  const failureRoot = path.join(CACHE, "failure");
  const failureResult = path.join(failureRoot, "result.json");
  fs.mkdirSync(failureRoot, { recursive: true });
  const failureServer = await serverFor(corruptDir);
  const failurePort = failureServer.address().port;
  const failureHash = sha256(failureTarget);
  try {
    launchTestApp(oldBin, {
      appImage: failureTarget,
      url: `http://127.0.0.1:${failurePort}/`,
      resultFile: failureResult,
      autoInstall: false,
      dataDir: path.join(failureRoot, "data"),
      skillsDir: path.join(failureRoot, "skills"),
      home: path.join(failureRoot, "home"),
      config: path.join(failureRoot, "config"),
      dataHome: path.join(failureRoot, "data-home"),
      log: path.join(failureRoot, "app.log"),
    });
    const failed = await waitFor(() => {
      const r = readResult(failureResult);
      return r && r.status === "error" ? r : null;
    }, 60000, "损坏包更新失败状态");
    if (!/完整性校验失败|SHA-512|checksum/i.test(failed.message || "")) throw new Error(`未识别为完整性失败：${failed.message}`);
    if (sha256(failureTarget) !== failureHash) throw new Error("损坏包失败后旧 AppImage 被替换");
    console.log("更新失败保护通过：损坏包未安装，旧版本保持不变");
  } finally {
    stopChild();
    failureServer.close();
  }

  // 安装目录只读：下载可完成，但替换旧 AppImage 必须失败，旧文件保持不变。
  const permissionRoot = path.join(CACHE, "permission");
  const permissionTargetDir = path.join(permissionRoot, "target");
  fs.mkdirSync(permissionTargetDir, { recursive: true });
  const permissionTarget = path.join(permissionTargetDir, "AgentHub-9.9.1-linux-x86_64.AppImage");
  fs.copyFileSync(oldBackup, permissionTarget);
  fs.chmodSync(permissionTargetDir, 0o555);
  const permissionResult = path.join(permissionRoot, "result.json");
  const permissionServer = await serverFor(newDir);
  const permissionHash = sha256(permissionTarget);
  try {
    launchTestApp(oldBin, {
      appImage: permissionTarget,
      url: `http://127.0.0.1:${permissionServer.address().port}/`,
      resultFile: permissionResult,
      autoInstall: true,
      dataDir: path.join(permissionRoot, "data"),
      skillsDir: path.join(permissionRoot, "skills"),
      home: path.join(permissionRoot, "home"),
      config: path.join(permissionRoot, "config"),
      dataHome: path.join(permissionRoot, "data-home"),
      log: path.join(permissionRoot, "app.log"),
    });
    const failed = await waitFor(() => {
      const r = readResult(permissionResult);
      return r && r.status === "error" ? r : null;
    }, 120000, "只读安装目录更新失败状态");
    if (sha256(permissionTarget) !== permissionHash) throw new Error("只读安装目录失败后旧 AppImage 被替换");
    if (!/权限|permission|EACCES|EPERM|更新失败|下载更新失败/i.test(failed.message || "")) throw new Error(`只读目录错误信息异常：${failed.message}`);
    console.log("更新失败保护通过：只读安装目录未改写旧版本");
  } finally {
    stopChild();
    permissionServer.close();
    fs.chmodSync(permissionTargetDir, 0o755);
  }

  // 文件大小受限：模拟磁盘不足/文件写入失败，旧 AppImage 必须保持不变。
  const diskRoot = path.join(CACHE, "disk");
  fs.mkdirSync(diskRoot, { recursive: true });
  const diskTarget = path.join(diskRoot, "AgentHub-9.9.1-linux-x86_64.AppImage");
  fs.copyFileSync(oldBackup, diskTarget);
  const diskResult = path.join(diskRoot, "result.json");
  const diskServer = await serverFor(newDir);
  const diskHash = sha256(diskTarget);
  try {
    launchTestApp(oldBin, {
      appImage: diskTarget,
      url: `http://127.0.0.1:${diskServer.address().port}/`,
      resultFile: diskResult,
      autoInstall: false,
      fileSizeLimitKb: 4096,
      dataDir: path.join(diskRoot, "data"),
      skillsDir: path.join(diskRoot, "skills"),
      home: path.join(diskRoot, "home"),
      config: path.join(diskRoot, "config"),
      dataHome: path.join(diskRoot, "data-home"),
      log: path.join(diskRoot, "app.log"),
    });
    const failed = await waitFor(() => {
      const r = readResult(diskResult);
      return r && r.status === "error" ? r : null;
    }, 120000, "磁盘受限更新失败状态");
    if (sha256(diskTarget) !== diskHash) throw new Error("磁盘受限失败后旧 AppImage 被替换");
    if (!/磁盘|空间|EFBIG|ENOSPC|File too large|update|下载更新失败/i.test(failed.message || "")) throw new Error(`磁盘受限错误信息异常：${failed.message}`);
    console.log("更新失败保护通过：磁盘/文件大小受限未改写旧版本");
  } finally {
    stopChild();
    diskServer.close();
  }
  fs.rmSync(CACHE, { recursive: true, force: true });
}

main().catch((error) => {
  stopChild();
  console.error("更新 E2E 失败：", (error && error.stack) || error);
  console.error(`诊断目录：${CACHE}`);
  process.exit(1);
});
