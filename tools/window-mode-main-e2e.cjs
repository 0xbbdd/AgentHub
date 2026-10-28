/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 真实 main.cjs 的轻量模式 E2E：Playwright 启动真实主进程，验证关窗释放、托盘存活、
// 二次启动唤回和窗口几何恢复。Windows/macOS/Linux 共用同一套断言。
// Linux 外层需要 xvfb-run + dbus-run-session。
"use strict";

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { _electron: electron } = require("playwright-core");
const { electronExecutable, guiArgs } = require("./electron-runtime.cjs");

const ROOT = path.join(__dirname, "..");
const ELECTRON = electronExecutable(ROOT);
const SBX = path.join(os.tmpdir(), "ah-main-e2e");
const DATA = path.join(SBX, "data");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let pass = 0;
let fail = 0;
function test(name, condition, detail) {
  if (condition) {
    pass++;
    console.log(`  ok    ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitPort(port, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const ok = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
      socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
    });
    if (ok) return;
    await sleep(100);
  }
  throw new Error(`静态服务器端口 ${port} 未就绪`);
}

async function rendererCount(app) {
  return app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics()
    .filter((proc) => ["Tab", "renderer", "Renderer"].includes(proc.type)).length);
}

(async () => {
  fs.rmSync(SBX, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, "config.json"), JSON.stringify({
    theme: "dark",
    schedule: { minimizeToTray: true, lightweightMode: true, autoStart: false, hourly: false, daily: false, dailyTime: "09:00", notifyOnSuccess: false },
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(DATA, "window-state.json"), JSON.stringify({
    bounds: { x: 140, y: 110, width: 1180, height: 760 }, maximized: false,
  }, null, 2), "utf8");

  const port = await freePort();
  const server = spawn(process.execPath, [path.join(__dirname, "tmp-static-dist-server.cjs"), String(port)], {
    cwd: ROOT,
    stdio: "ignore",
  });
  const env = {
    ...process.env,
    VITE_DEV_SERVER_URL: `http://127.0.0.1:${port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.AGENTHUB_ALLOW_MULTI;

  let app = null;
  let second = null;
  try {
    await waitPort(port);
    app = await electron.launch({
      executablePath: ELECTRON,
      args: [".", `--user-data-dir=${DATA}`, ...guiArgs()],
      cwd: ROOT,
      env,
      timeout: 30000,
    });
    await app.firstWindow({ timeout: 30000 });
    await sleep(1200);
    test("M1 真实 main.cjs 起了窗口（渲染进程存在）", (await rendererCount(app)) >= 1);

    // 从主进程调用 BrowserWindow.close()：与用户点关闭按钮走同一个 close 事件链。
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await sleep(4000);
    const after = await rendererCount(app);
    const mainAlive = await app.evaluate(({ app: electronApp }) => electronApp.isReady());
    test("M2 关窗后渲染进程消失（轻量模式真的释放了内存）", after === 0, `renderers=${after}`);
    test("M3 主进程仍存活（托盘常驻、后台服务不受影响）", mainAlive === true);

    let state = {};
    try { state = JSON.parse(fs.readFileSync(path.join(DATA, "window-state.json"), "utf8")); } catch { /* 无状态 */ }
    const bounds = state.bounds || {};
    test("M4 关窗时写回的是恢复出的用户几何（非默认值）—— 证明恢复链路真的生效",
      bounds.width === 1180 && bounds.height === 760 && bounds.x === 140 && bounds.y === 110,
      `实际 ${JSON.stringify(bounds)}`);

    let log = "";
    try { log = fs.readFileSync(path.join(DATA, "logs", "crash.log"), "utf8"); } catch { /* 无日志 */ }
    test("M5 crash.log 留有 lightweight-enter 取证（可事后排查）",
      /lightweight-enter/.test(log), log.split(/\r?\n/).slice(-8).join("\n"));

    // 第二个实例触发 single-instance → showWindow → 重建窗口。
    second = spawn(ELECTRON, [".", `--user-data-dir=${DATA}`, ...guiArgs()], {
      cwd: ROOT,
      env,
      stdio: "ignore",
    });
    let revived = 0;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      revived = app.windows().length;
      if (revived >= 1) break;
    }
    const revivedRenderers = await rendererCount(app);
    test("M6 第二次启动唤回界面（渲染进程回来）", revived >= 1 && revivedRenderers >= 1,
      `windows=${revived} renderers=${revivedRenderers}`);

    await sleep(1000);
    let state2 = {};
    try { state2 = JSON.parse(fs.readFileSync(path.join(DATA, "window-state.json"), "utf8")); } catch { /* 无状态 */ }
    const bounds2 = state2.bounds || {};
    test("M7 唤回后几何仍是用户原位置（未被重置为默认）",
      bounds2.width === 1180 && bounds2.height === 760,
      `实际 ${JSON.stringify(bounds2)}`);
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    fail++;
    try {
      const pages = app ? app.windows() : [];
      if (pages[0]) await pages[0].screenshot({ path: path.join(ROOT, "window-mode-main-e2e-failure.png"), fullPage: true });
    } catch { /* 截图失败不覆盖原异常 */ }
  } finally {
    try { if (second) second.kill(); } catch { /* 已退出 */ }
    try { if (app) await app.close(); } catch { /* 已退出 */ }
    try { server.kill(); } catch { /* 已退出 */ }
  }

  console.log(`\n  真实 main.cjs 端到端: 通过 ${pass}  失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
