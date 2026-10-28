/**
 * 平台基础层自测：目录语义 + 能力矩阵可跨平台注入验证。
 * 用法：node tools/platform-services-selftest.cjs
 */
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const platform = require("../electron/backend/platform/index.cjs");
const paths = require("../electron/backend/platform/paths.cjs");
const caps = require("../electron/backend/platform/capabilities.cjs");
const { createSecureStore } = require("../electron/backend/platform/secure-store.cjs");

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

console.log("\n平台基础层自测");

test("平台名称、家族与支持范围", () => {
  assert.equal(platform.nameOf("win32"), "win32");
  assert.equal(platform.nameOf("darwin"), "darwin");
  assert.equal(platform.nameOf("linux"), "linux");
  assert.equal(platform.nameOf("freebsd"), "unknown");
  assert.equal(platform.familyOf("win32"), "windows");
  assert.equal(platform.familyOf("darwin"), "macos");
  assert.equal(platform.familyOf("linux"), "linux");
  assert.equal(platform.isSupported("linux"), true);
  assert.equal(platform.isSupported("freebsd"), false);
  assert.equal(platform.current().supported, true);
});

test("Windows 目录优先使用 APPDATA/LOCALAPPDATA", () => {
  const home = path.join(path.sep, "Users", "demo");
  const env = { APPDATA: path.join(home, "Roaming"), LOCALAPPDATA: path.join(home, "Local") };
  assert.equal(paths.roamingAppData({ platform: "win32", home, env }), env.APPDATA);
  assert.equal(paths.localAppData({ platform: "win32", home, env }), env.LOCALAPPDATA);
  assert.equal(paths.caseInsensitiveByDefault("win32"), true);
});

test("Windows 无环境变量时使用标准 AppData 路径", () => {
  const home = path.join(path.sep, "Users", "demo");
  assert.equal(paths.roamingAppData({ platform: "win32", home, env: {} }), path.join(home, "AppData", "Roaming"));
  assert.equal(paths.localAppData({ platform: "win32", home, env: {} }), path.join(home, "AppData", "Local"));
});

test("macOS 配置/数据目录均为 Application Support", () => {
  const home = path.join(path.sep, "Users", "demo");
  const expected = path.join(home, "Library", "Application Support");
  assert.equal(paths.roamingAppData({ platform: "darwin", home, env: {} }), expected);
  assert.equal(paths.localAppData({ platform: "darwin", home, env: {} }), expected);
  assert.equal(paths.autostartDir({ platform: "darwin", home, env: {} }), path.join(home, "Library", "LaunchAgents"));
});

test("APPDATA/LOCALAPPDATA 显式覆盖在任意平台优先（沙箱兼容）", () => {
  const home = path.join(path.sep, "home", "demo");
  assert.equal(paths.roamingAppData({ platform: "linux", home, env: { APPDATA: "/tmp/roam", XDG_CONFIG_HOME: "/tmp/config" } }), "/tmp/roam");
  assert.equal(paths.localAppData({ platform: "linux", home, env: { LOCALAPPDATA: "/tmp/local", XDG_DATA_HOME: "/tmp/data" } }), "/tmp/local");
  assert.equal(paths.roamingAppData({ platform: "darwin", home, env: { APPDATA: "/tmp/mac-roam" } }), "/tmp/mac-roam");
  assert.equal(paths.localAppData({ platform: "darwin", home, env: { LOCALAPPDATA: "/tmp/mac-local" } }), "/tmp/mac-local");
});

test("Linux 遵循 XDG_CONFIG_HOME / XDG_DATA_HOME", () => {
  const home = path.join(path.sep, "home", "demo");
  const env = { XDG_CONFIG_HOME: path.join(home, "xdg-config"), XDG_DATA_HOME: path.join(home, "xdg-data") };
  assert.equal(paths.roamingAppData({ platform: "linux", home, env }), env.XDG_CONFIG_HOME);
  assert.equal(paths.localAppData({ platform: "linux", home, env }), env.XDG_DATA_HOME);
  assert.equal(paths.autostartDir({ platform: "linux", home, env }), path.join(env.XDG_CONFIG_HOME, "autostart"));
  assert.equal(paths.caseInsensitiveByDefault("linux"), false);
});

test("未知平台不会静默套用 Windows 路径", () => {
  assert.throws(() => paths.roamingAppData({ platform: "freebsd", home: "/tmp/demo", env: {} }), /不支持的平台/);
  assert.throws(() => caps.snapshot({ platform: "freebsd", arch: "x64" }), /未知平台/);
});

test("能力快照覆盖三平台且状态合法", () => {
  const allowed = new Set(caps.STATUSES);
  for (const name of caps.PLATFORMS) {
    const snap = caps.snapshot({ platform: name, arch: "x64" });
    assert.equal(snap.platform.name, name);
    assert.ok(Object.keys(snap.features).length >= 7);
    assert.equal(snap.sources.length, Object.keys(caps.SOURCES).length);
    assert.equal(snap.channels.length, Object.keys(caps.CHANNELS).length);
    for (const item of Object.values(snap.features)) assert.ok(allowed.has(item.status), `${name}/${item.id}`);
    for (const item of snap.sources) assert.ok(allowed.has(item.status), `${name}/source/${item.id}`);
    for (const item of snap.channels) {
      assert.ok(allowed.has(item.inference.status), `${name}/channel/${item.id}/inference`);
      if (item.localImport) assert.ok(allowed.has(item.localImport.status), `${name}/channel/${item.id}/localImport`);
      if (item.ideSwitch) assert.ok(allowed.has(item.ideSwitch.status), `${name}/channel/${item.id}/ideSwitch`);
    }
  }
});

test("已知硬阻塞在能力矩阵中显式表达", () => {
  const mac = caps.snapshot({ platform: "darwin", arch: "arm64" });
  const linux = caps.snapshot({ platform: "linux", arch: "x64" });
  const find = (snap, id) => snap.channels.find((item) => item.id === id);
  assert.equal(find(mac, "qoder").inference.status, "blocked");
  assert.equal(find(linux, "qoder").inference.status, "blocked");
  assert.equal(find(mac, "workbuddy").ideSwitch.status, "blocked");
  assert.equal(find(linux, "zcode").localImport.status, "compatible");
  assert.equal(mac.sources.find((item) => item.id === "antigravity-legacy").status, "blocked");
  assert.equal(linux.features["release.code-signing"].status, "blocked");
});

test("系统凭据后端缺失时只阻断依赖它的渠道", () => {
  const snap = caps.snapshot({
    platform: "linux",
    arch: "x64",
    runtime: { credentialBackend: { available: false, reason: "未找到 secret-tool" } },
  });
  const qoder = snap.channels.find((item) => item.id === "qoder");
  const autoclaw = snap.channels.find((item) => item.id === "autoclaw");
  const catpaw = snap.channels.find((item) => item.id === "catpaw");
  assert.equal(qoder.localImport.status, "blocked");
  assert.equal(autoclaw.localImport.status, "blocked");
  assert.equal(catpaw.localImport.status, "compatible");
  assert.equal(snap.features["credentials.chromium-os-crypt"].status, "blocked");
  assert.match(qoder.localImport.reason, /secret-tool/);
});

test("桌面会话识别 Wayland/X11 与托盘运行时降级", () => {
  const wayland = platform.desktop.session({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "GNOME" } });
  assert.equal(wayland.isWayland, true);
  assert.match(wayland.globalShortcutHint, /GlobalShortcutsPortal/);
  assert.match(wayland.trayHint, /GNOME/);
  const x11 = platform.desktop.session({ platform: "linux", env: { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" } });
  assert.equal(x11.type, "x11");
  const win = platform.desktop.session({ platform: "win32", env: {} });
  assert.equal(win.type, "windows");
  const switches = [];
  const enabled = platform.desktop.enableWaylandGlobalShortcuts({
    commandLine: { appendSwitch: (name, value) => switches.push([name, value]) },
  }, { platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } });
  assert.equal(enabled, true);
  assert.deepEqual(switches, [["enable-features", "GlobalShortcutsPortal"]]);

  const snap = caps.snapshot({
    platform: "linux",
    arch: "x64",
    runtime: {
      desktop: {
        tray: { available: false, reason: "系统托盘不可用" },
        globalShortcut: { available: true, reason: "Wayland 全局快捷键由合成器授权" },
      },
    },
  });
  assert.equal(snap.features["desktop.tray"].status, "blocked");
  assert.match(snap.features["desktop.tray"].reason, /系统托盘不可用/);
  assert.match(snap.features["desktop.global-shortcut"].reason, /Wayland/);
});

test("生产安全存储不可用时能力矩阵降为 blocked", () => {
  const snap = caps.snapshot({
    platform: "linux",
    arch: "x64",
    runtime: {
      secureStorage: {
        backend: "plaintext-fallback",
        encrypted: false,
        platform: "linux",
        policy: { failClosed: true, plaintextAllowed: false, packaged: true },
        reason: "系统安全存储不可用",
      },
    },
  });
  assert.equal(snap.features["secure-storage"].status, "blocked");
  assert.match(snap.features["secure-storage"].reason, /安全存储不可用/);
});

test("SQLCipher 能力按平台与架构精确匹配", () => {
  assert.equal(caps.sqlcipherSupport("win32", "x64").status, "supported");
  assert.equal(caps.sqlcipherSupport("darwin", "arm64").status, "supported");
  assert.equal(caps.sqlcipherSupport("linux", "x64").status, "supported");
  assert.equal(caps.sqlcipherSupport("linux", "arm64").status, "blocked");
});

test("安全存储开发环境兼容明文，打包环境默认 fail-closed", () => {
  const env = {};
  const dev = createSecureStore({ safeStorage: null, env, packaged: false });
  assert.equal(dev.encrypt("legacy"), "legacy");
  assert.equal(dev.status().backend, "plaintext-fallback");
  assert.equal(dev.status().policy.failClosed, false);
  assert.throws(() => dev.encrypt("must-encrypt", { allowPlaintext: false }), /安全存储不可用/);

  const production = createSecureStore({ safeStorage: null, env, packaged: true });
  assert.equal(production.status().backend, "plaintext-fallback");
  assert.equal(production.status().policy.failClosed, true);
  assert.throws(() => production.encrypt("must-not-leak"), /生产环境拒绝明文落盘/);
  assert.equal(production.encrypt(""), "");
  assert.equal(production.decrypt("legacy-plaintext"), "");

  const forced = createSecureStore({ safeStorage: null, env: { AGENTHUB_SECURE_STORAGE_FAIL_CLOSED: "1" }, packaged: false });
  assert.equal(forced.status().policy.failClosed, true);
  assert.match(forced.status().reason, /拒绝明文落盘/);

  const basicText = createSecureStore({
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "basic_text",
      encryptString: () => Buffer.from("unsafe"),
      decryptString: () => "unsafe",
    },
    env: {},
    packaged: true,
  });
  assert.equal(basicText.status().encrypted, false);
  assert.equal(basicText.status().safeStorageBackend, "basic_text");
  assert.throws(() => basicText.encrypt("must-not-use-basic-text"), /生产环境拒绝明文落盘/);
  assert.match(basicText.status().reason, /basic_text/);
});

test("AGENTHUB_SECRET_KEY 使用 enc:v2 AES-256-GCM", () => {
  const env = { AGENTHUB_SECRET_KEY: "unit-test-key" };
  const store = createSecureStore({ safeStorage: null, env });
  const cipher = store.encrypt("secret-value");
  assert.ok(cipher.startsWith("enc:v2:"));
  assert.ok(!cipher.includes("secret-value"));
  assert.equal(store.decrypt(cipher), "secret-value");
  assert.equal(store.status().backend, "aes-256-gcm");
  env.AGENTHUB_SECRET_KEY = "different-key";
  assert.equal(store.decrypt(cipher), "");
});

test("Electron safeStorage 使用 enc:v1 并保持跨机器不可解语义", () => {
  const fake = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`wrapped:${value}`),
    decryptString: (buf) => String(buf).replace(/^wrapped:/, ""),
  };
  const store = createSecureStore({ safeStorage: fake, env: {} });
  const cipher = store.encrypt("safe-value");
  assert.ok(cipher.startsWith("enc:v1:"));
  assert.equal(store.decrypt(cipher), "safe-value");
  assert.equal(store.status().backend, "os-keychain");
  const unavailable = createSecureStore({ safeStorage: null, env: {} });
  assert.equal(unavailable.decrypt(cipher), "");
});

console.log(`\n平台基础层自测通过：${pass} 项`);
