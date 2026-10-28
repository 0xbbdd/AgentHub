"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function findOne(dir, re) { const hit = fs.readdirSync(dir).find((name) => re.test(name)); return hit ? path.join(dir, hit) : ""; }
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exit=${r.status}`);
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
function readResult(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function serverFor(dir) {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    if (process.env.AGENTHUB_UPDATER_E2E_VERBOSE === "1") console.log(`[server] ${req.method} ${pathname}`);
    const file = path.join(dir, path.basename(pathname));
    if (!fs.existsSync(file)) { res.writeHead(404); res.end("not found"); return; }
    const range = req.headers.range;
    const size = fs.statSync(file).size;
    if (range && /^bytes=(\d+)-(\d*)$/.test(range)) {
      const m = range.match(/^bytes=(\d+)-(\d*)$/);
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      res.writeHead(206, { "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes" });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { "content-length": size, "accept-ranges": "bytes" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
function stopProcess(child) {
  if (!child) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
}
module.exports = { ROOT, sha256, findOne, run, waitFor, readResult, serverFor, stopProcess };
