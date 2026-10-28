/**
 * 三平台 Electron GUI E2E：启动 electron-builder --dir 产物，验证窗口、四模块切换和设置弹窗。
 * Linux 需要外层 xvfb-run + dbus-run-session。
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright-core");

const ROOT = path.join(__dirname, "..");
const RELEASE = path.join(ROOT, "release");

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, out);
    else if (entry.isFile()) out.push(file);
  }
  return out;
}

function executablePath() {
  if (process.platform === "win32") {
    const p = path.join(RELEASE, "win-unpacked", "AgentHub.exe");
    if (fs.existsSync(p)) return p;
  }
  if (process.platform === "linux") {
    const p = path.join(RELEASE, "linux-unpacked", "agenthub");
    if (fs.existsSync(p)) return p;
  }
  if (process.platform === "darwin") {
    const app = walk(RELEASE).find((file) => /\/AgentHub\.app\/Contents\/MacOS\/AgentHub$/.test(file));
    if (app) return app;
  }
  throw new Error("未找到打包后的 AgentHub 可执行文件，请先运行 electron-builder --dir");
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-gui-e2e-"));
  const env = {
    ...process.env,
    AGENTHUB_ALLOW_MULTI: "1",
    AGENTHUB_DATA_DIR: path.join(tmp, "data"),
    AGENT_SKILLS_HOME: path.join(tmp, "skills"),
    AGENTHUB_UPDATE_FIRST_CHECK_MS: "3600000",
    ELECTRON_DISABLE_GPU: "1",
  };
  if (process.platform === "win32") {
    env.APPDATA = path.join(tmp, "AppData", "Roaming");
    env.LOCALAPPDATA = path.join(tmp, "AppData", "Local");
    env.USERPROFILE = path.join(tmp, "home");
  } else {
    env.HOME = path.join(tmp, "home");
    env.XDG_CONFIG_HOME = path.join(tmp, "config");
    env.XDG_DATA_HOME = path.join(tmp, "data-home");
  }

  const errors = [];
  let app;
  try {
    app = await electron.launch({
      executablePath: executablePath(),
      args: process.platform === "linux" ? ["--no-sandbox", "--disable-gpu"] : ["--disable-gpu"],
      env,
      timeout: 30000,
    });
    const page = await app.firstWindow({ timeout: 30000 });
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    await page.waitForSelector(".module-card", { timeout: 30000 });

    const capabilities = await page.evaluate(() => window.agenthub.invoke("get_platform_capabilities"));
    if (!capabilities?.runtime?.secureStorage?.policy?.failClosed) {
      throw new Error("打包产物未启用安全存储 fail-closed 策略");
    }
    if (capabilities.runtime.secureStorage.encrypted === false
      && capabilities.features?.["secure-storage"]?.status !== "blocked") {
      throw new Error("安全存储不可用但能力矩阵未降为 blocked");
    }
    const desktopRuntime = capabilities.runtime?.desktop;
    if (!desktopRuntime?.session || typeof desktopRuntime.session.isWayland !== "boolean") {
      throw new Error("平台能力缺少桌面会话事实");
    }
    if (desktopRuntime.tray.available === false
      && capabilities.features?.["desktop.tray"]?.status !== "blocked") {
      throw new Error("托盘创建失败但能力矩阵未降为 blocked");
    }
    if (desktopRuntime.globalShortcut.available === false
      && capabilities.features?.["desktop.global-shortcut"]?.status !== "blocked") {
      throw new Error("全局快捷键不可用但能力矩阵未降为 blocked");
    }

    const modules = ["技能仓库", "用量统计", "反代网关", "记忆中枢"];
    for (const label of modules) {
      const card = page.locator(".module-card", { hasText: label }).first();
      await card.waitFor({ state: "visible", timeout: 15000 });
      await card.click();
      await page.waitForFunction(
        (text) => [...document.querySelectorAll(".module-card.active")].some((el) => el.textContent?.includes(text)),
        label,
        { timeout: 15000 },
      );
      await page.waitForTimeout(300);
    }

    await page.locator(".settings-btn").click();
    const updateActions = page.locator(".upd-actions").first();
    await updateActions.getByRole("button", { name: "检查更新" }).waitFor({ state: "visible", timeout: 15000 });
    await page.getByText("自动检查更新", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    if (errors.length) throw new Error(`渲染层异常：\n${errors.join("\n")}`);
    console.log(`Electron GUI E2E 通过：${modules.join(" / ")} + 设置弹窗`);
  } catch (error) {
    try {
      if (app) {
        const pages = app.windows();
        if (pages[0]) await pages[0].screenshot({ path: path.join(ROOT, "gui-e2e-failure.png"), fullPage: true });
      }
    } catch { /* 截图失败不覆盖原异常 */ }
    throw error;
  } finally {
    try { if (app) await app.close(); } catch { /* 已退出 */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("Electron GUI E2E 失败：", (error && error.stack) || error);
  process.exit(1);
});
