/**
 * 跨平台进程服务。
 *
 * Windows 使用 tasklist/taskkill；macOS/Linux 使用 pgrep（缺失时回退 ps）与系统 signal。
 * 所有外部命令都通过参数数组执行，不拼 shell 字符串，避免进程名中的空格/引号造成命令注入。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { platformName } = require("./paths.cjs");

function syncSleep(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 降级兜底 */ }
  }
}

function windowsName(name) {
  const base = path.basename(String(name || "").trim());
  return /\.exe$/i.test(base) ? base : `${base}.exe`;
}

function unixName(name) {
  return path.basename(String(name || "").trim()).replace(/\.exe$/i, "");
}

function asPosixPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function createProcessService(opts = {}) {
  const name = platformName(opts.platform || process.platform);
  if (name === "unknown") throw new Error(`未知平台进程语义：${opts.platform}`);
  const isWindows = name === "win32";
  const execFileSync = opts.execFileSync || childProcess.execFileSync;
  const spawn = opts.spawn || childProcess.spawn;
  const existsSync = opts.existsSync || fs.existsSync;
  const killPid = opts.killPid || process.kill.bind(process);
  const sleep = opts.sleep || syncSleep;
  const now = opts.now || Date.now;

  function run(file, args, runOpts = {}) {
    const timeout = Math.max(500, Number(runOpts.timeoutMs) || 8000);
    try {
      return String(execFileSync(file, args, {
        encoding: "utf8",
        windowsHide: true,
        timeout,
        stdio: ["ignore", "pipe", "ignore"],
      }) || "").trim();
    } catch (error) {
      if (runOpts.optional) return "";
      throw error;
    }
  }

  function unixPids(procName) {
    const wanted = unixName(procName);
    if (!wanted) return [];
    const fromPgrep = run("pgrep", ["-x", wanted], { optional: true });
    if (fromPgrep) {
      return [...new Set(fromPgrep.split(/\s+/).map(Number).filter((pid) => pid > 1))];
    }
    // pgrep 在极简发行版可能缺失；ps 是 POSIX 基线。
    const table = run("ps", ["-axo", "pid=,comm="], { optional: true });
    const out = [];
    for (const line of table.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      const comm = asPosixPath(m[2]).split("/").pop();
      if (comm === wanted) out.push(Number(m[1]));
    }
    return [...new Set(out.filter((pid) => pid > 1))];
  }

  function isPidRunning(pid) {
    const value = Number(pid);
    if (!Number.isInteger(value) || value <= 1) return false;
    if (isWindows) {
      const out = run("tasklist", ["/FI", `PID eq ${value}`, "/FO", "CSV", "/NH"], { optional: true });
      return new RegExp(`\\b${value}\\b`).test(out);
    }
    try {
      killPid(value, 0);
      return true;
    } catch (error) {
      return error && error.code === "EPERM";
    }
  }

  function isRunning(procName) {
    const raw = String(procName || "").trim();
    if (!raw) return false;
    if (isWindows) {
      const wanted = windowsName(raw);
      const out = run("tasklist", ["/FI", `IMAGENAME eq ${wanted}`, "/FO", "CSV", "/NH"], { optional: true });
      return out.toLowerCase().includes(`"${wanted.toLowerCase()}"`);
    }
    return unixPids(raw).length > 0;
  }

  function isAnyRunning(procNames) {
    return (Array.isArray(procNames) ? procNames : [procNames]).some((procName) => isRunning(procName));
  }

  function descendants(pid) {
    if (isWindows) return [];
    const out = [];
    const queue = [Number(pid)];
    const seen = new Set(queue);
    while (queue.length) {
      const parent = queue.shift();
      const text = run("pgrep", ["-P", String(parent)], { optional: true });
      for (const token of text.split(/\s+/)) {
        const child = Number(token);
        if (child > 1 && !seen.has(child)) {
          seen.add(child);
          out.push(child);
          queue.push(child);
        }
      }
    }
    return out;
  }

  function signal(pid, sig) {
    try {
      killPid(Number(pid), sig);
      return true;
    } catch (error) {
      return error && error.code === "EPERM";
    }
  }

  function waitStopped(procNames, timeoutMs, pids = []) {
    const names = (Array.isArray(procNames) ? procNames : [procNames]).filter(Boolean);
    const check = () => !isAnyRunning(names) && !pids.some((pid) => isPidRunning(pid));
    const deadline = now() + Math.max(0, Number(timeoutMs) || 0);
    while (now() < deadline) {
      if (check()) return true;
      sleep(200);
    }
    return check();
  }

  function killOneWindows(procName, options) {
    const wanted = windowsName(procName);
    if (!isRunning(wanted)) return true;
    const force = !!options.force;
    const graceMs = force ? 0 : Math.max(0, Number(options.graceMs) || 0);
    if (graceMs > 0) {
      run("taskkill", ["/IM", wanted, "/T"], { optional: true, timeoutMs: options.commandTimeoutMs });
      if (waitStopped([wanted], Math.min(graceMs, options.timeoutMs))) return true;
    }
    run("taskkill", ["/F", "/IM", wanted, "/T"], { optional: true, timeoutMs: options.commandTimeoutMs });
    return waitStopped([wanted], options.timeoutMs);
  }

  function killMany(procNames, options = {}) {
    const names = [...new Set((Array.isArray(procNames) ? procNames : [procNames])
      .map((item) => String(item || "").trim())
      .filter(Boolean))];
    if (!names.length) return true;
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 8000);
    const commandTimeoutMs = Math.max(1000, Number(options.commandTimeoutMs) || 8000);
    if (isWindows) {
      let allGone = true;
      for (const procName of names) {
        if (!killOneWindows(procName, {
          force: options.force,
          graceMs: Math.min(3000, Number(options.graceMs) || 0),
          timeoutMs,
          commandTimeoutMs,
        })) allGone = false;
      }
      return allGone;
    }

    const roots = names.flatMap((procName) => unixPids(procName));
    if (!roots.length) return true;
    const tree = options.tree === false ? [] : roots.flatMap((pid) => descendants(pid));
    const pids = [...new Set([...tree, ...roots])];
    const force = !!options.force;
    const graceMs = force ? 0 : Math.max(0, Number(options.graceMs) || 0);
    for (const pid of pids) signal(pid, force ? "SIGKILL" : "SIGTERM");
    if (graceMs > 0 && waitStopped(names, Math.min(graceMs, timeoutMs), pids)) return true;
    if (!waitStopped(names, 0, pids) && !force) {
      for (const pid of pids) signal(pid, "SIGKILL");
    }
    return waitStopped(names, timeoutMs, pids);
  }

  function launch(file, args = [], launchOpts = {}) {
    const target = String(file || "").trim();
    if (!target || !existsSync(target)) return { ok: false, message: "可执行文件不存在" };
    try {
      const child = spawn(target, Array.isArray(args) ? args : [], {
        detached: launchOpts.detached !== false,
        stdio: launchOpts.stdio || "ignore",
        windowsHide: launchOpts.windowsHide === true,
      });
      if (child && typeof child.unref === "function") child.unref();
      return { ok: true, file: target };
    } catch (error) {
      return { ok: false, message: String((error && error.message) || error) };
    }
  }

  function findExecutable(candidates) {
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      try {
        if (candidate && existsSync(candidate)) return candidate;
      } catch { /* 下一个 */ }
    }
    return "";
  }

  function which(command) {
    if (!command) return "";
    const text = isWindows
      ? run("where", [String(command)], { optional: true })
      : run("which", [String(command)], { optional: true });
    return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  }

  return {
    platform: name,
    isWindows,
    isPidRunning,
    isRunning,
    isAnyRunning,
    kill: (procName, options) => killMany([procName], options),
    killMany,
    launch,
    findExecutable,
    which,
    sleep,
  };
}

const defaultService = createProcessService();

module.exports = {
  ...defaultService,
  createProcessService,
  syncSleep,
  windowsName,
  unixName,
};
