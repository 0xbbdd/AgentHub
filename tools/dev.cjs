"use strict";
const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
let viteServer = null;
let electronProcess = null;
let shuttingDown = false;

function stop(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (electronProcess && electronProcess.exitCode === null) electronProcess.kill();
  const closing = viteServer ? viteServer.close() : Promise.resolve();
  Promise.resolve(closing)
    .catch((err) => console.error("[dev] failed to close Vite:", err))
    .finally(() => process.exit(code));
}

async function main() {
  const { createServer } = await import("vite");
  viteServer = await createServer({
    configFile: path.join(ROOT, "vite.config.ts"),
    server: { port: 0, strictPort: true },
  });
  await viteServer.listen();
  viteServer.printUrls();

  const devUrl = viteServer.resolvedUrls?.local?.[0]?.replace(/\/$/, "");
  if (!devUrl) throw new Error("Vite did not expose a local development URL");

  console.log(`[dev] starting Electron with ${devUrl}`);
  electronProcess = spawn(require("electron"), ["."], {
    cwd: ROOT,
    env: { ...process.env, VITE_DEV_SERVER_URL: devUrl },
    stdio: "inherit",
  });
  electronProcess.once("error", (err) => {
    console.error("[dev] failed to start Electron:", err);
    stop(1);
  });
  electronProcess.once("exit", (code, signal) => {
    if (!shuttingDown) {
      console.log(signal ? `[dev] Electron stopped by ${signal}` : `[dev] Electron exited (${code ?? 0})`);
    }
    stop(code ?? (signal ? 1 : 0));
  });
}

process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));

main().catch((err) => {
  console.error("[dev] startup failed:", err);
  stop(1);
});
