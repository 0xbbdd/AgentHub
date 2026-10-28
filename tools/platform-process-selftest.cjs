/**
 * 进程服务自测：不启动真实客户端、不杀真实进程，注入命令执行器验证三平台分支。
 * 用法：node tools/platform-process-selftest.cjs
 */
"use strict";

const assert = require("node:assert/strict");
const { createProcessService, windowsName, unixName } = require("../electron/backend/platform/process.cjs");

let pass = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok    ${name}`);
  } catch (error) {
    console.error(`  FAIL  ${name}`);
    throw error;
  }
}

console.log("\n进程服务自测");

test("进程名按平台规范化", () => {
  assert.equal(windowsName("WorkBuddy"), "WorkBuddy.exe");
  assert.equal(windowsName("WorkBuddy.exe"), "WorkBuddy.exe");
  assert.equal(unixName("WorkBuddy.exe"), "WorkBuddy");
  assert.equal(unixName("/Applications/ZCode.app/Contents/MacOS/ZCode"), "ZCode");
});

test("Windows 使用 tasklist 精确探测并支持优雅关闭", () => {
  let running = true;
  const calls = [];
  let clock = 0;
  const service = createProcessService({
    platform: "win32",
    now: () => (clock += 300),
    sleep: () => {},
    execFileSync(file, args) {
      calls.push([file, ...args]);
      if (file === "tasklist") return running ? '"WorkBuddy.exe","1234","Console","1","100 K"\n' : "INFO: No tasks are running\n";
      if (file === "taskkill") {
        if (!args.includes("/F")) running = false;
        return "";
      }
      if (file === "where") return "C:\\Program Files\\WorkBuddy\\WorkBuddy.exe\n";
      return "";
    },
  });
  assert.equal(service.isRunning("WorkBuddy"), true);
  assert.equal(service.kill("WorkBuddy", { graceMs: 1000, timeoutMs: 1000 }), true);
  assert.equal(calls.some((call) => call[0] === "taskkill" && !call.includes("/F")), true);
  assert.equal(service.which("WorkBuddy"), "C:\\Program Files\\WorkBuddy\\WorkBuddy.exe");
});

test("Windows 强制关闭使用 /F，未运行时不执行命令", () => {
  let running = true;
  const calls = [];
  const service = createProcessService({
    platform: "win32",
    now: Date.now,
    sleep: () => {},
    execFileSync(file, args) {
      calls.push([file, ...args]);
      if (file === "tasklist") return running ? '"ZCode.exe","99","Console","1","100 K"\n' : "";
      if (file === "taskkill") { running = false; return ""; }
      return "";
    },
  });
  assert.equal(service.kill("ZCode.exe", { force: true, timeoutMs: 1000 }), true);
  assert.equal(calls.some((call) => call[0] === "taskkill" && call.includes("/F")), true);
  assert.equal(service.kill("ZCode.exe", { force: true, timeoutMs: 1000 }), true);
});

test("Unix 使用 pgrep + signal，并清理子进程", () => {
  let alive = true;
  const signals = [];
  const service = createProcessService({
    platform: "darwin",
    now: Date.now,
    sleep: () => {},
    execFileSync(file, args) {
      if (file === "pgrep" && args[0] === "-x") return alive ? "123\n" : "";
      if (file === "pgrep" && args[0] === "-P" && args[1] === "123") return "124\n";
      if (file === "pgrep" && args[0] === "-P" && args[1] === "124") return "";
      if (file === "which") return "/usr/local/bin/zcode\n";
      return "";
    },
    killPid(pid, signal) {
      signals.push([pid, signal]);
      if (signal === 0) {
        if (!alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        return;
      }
      alive = false;
    },
  });
  assert.equal(service.isRunning("ZCode"), true);
  assert.equal(service.kill("ZCode", { timeoutMs: 1000 }), true);
  assert.deepEqual(signals.slice(0, 2), [[124, "SIGTERM"], [123, "SIGTERM"]]);
  assert.equal(service.which("zcode"), "/usr/local/bin/zcode");
});

test("Unix 强制关闭发送 SIGKILL", () => {
  let alive = true;
  const signals = [];
  const service = createProcessService({
    platform: "linux",
    now: Date.now,
    sleep: () => {},
    execFileSync(file, args) {
      if (file === "pgrep" && args[0] === "-x") return alive ? "321\n" : "";
      if (file === "pgrep" && args[0] === "-P") return "";
      return "";
    },
    killPid(pid, signal) {
      signals.push([pid, signal]);
      if (signal === 0) {
        if (!alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        return;
      }
      alive = false;
    },
  });
  assert.equal(service.kill("ZCode", { force: true, timeoutMs: 1000 }), true);
  assert.deepEqual(signals[0], [321, "SIGKILL"]);
});

test("启动进程与可执行文件探测使用参数化调用", () => {
  let spawned = null;
  let unrefed = false;
  const service = createProcessService({
    platform: "linux",
    execFileSync: () => "",
    existsSync: (file) => file === "/opt/ZCode/zcode",
    spawn(file, args, opts) {
      spawned = { file, args, opts };
      return { unref: () => { unrefed = true; } };
    },
  });
  assert.equal(service.findExecutable(["/missing", "/opt/ZCode/zcode"]), "/opt/ZCode/zcode");
  assert.deepEqual(service.launch("/opt/ZCode/zcode"), { ok: true, file: "/opt/ZCode/zcode" });
  assert.deepEqual(spawned.args, []);
  assert.equal(spawned.opts.detached, true);
  assert.equal(unrefed, true);
  assert.equal(service.launch("/missing").ok, false);
});

console.log(`\n进程服务自测通过：${pass} 项`);
