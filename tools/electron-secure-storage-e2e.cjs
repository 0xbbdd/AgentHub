/**
 * 真实系统安全存储 E2E：在 Electron 内核中验证 safeStorage 后端可用、enc:v1 往返、
 * 以及框架 WebDAV 凭据确实以密文落盘。Linux 需在 dbus + gnome-keyring 会话中运行。
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-safe-storage-e2e-"));
process.env.AGENTHUB_DATA_DIR = path.join(tmp, "data");
process.env.AGENTHUB_SECRET_KEY = "";
delete process.env.AGENTHUB_SECRET_KEY;

const { app, safeStorage } = require("electron");

app.whenReady().then(async () => {
  try {
    assert.equal(safeStorage.isEncryptionAvailable(), true, "safeStorage.isEncryptionAvailable() 必须为 true");
    const backend = typeof safeStorage.getSelectedStorageBackend === "function"
      ? String(safeStorage.getSelectedStorageBackend() || "")
      : "";
    if (process.platform === "linux") {
      assert.ok(backend, "Linux 必须返回 safeStorage 后端");
      assert.notEqual(backend, "basic_text", "Linux 生产验收拒绝 basic_text 弱后端");
      assert.match(backend, /libsecret|kwallet/i, `Linux 未使用 Secret Service/KWallet：${backend}`);
    }

    const secretStore = require("../electron/backend/platform/secure-store.cjs");
    const config = require("../electron/backend/config.cjs");
    const status = secretStore.status();
    assert.equal(status.backend, "os-keychain", `安全存储后端错误：${status.backend}`);
    assert.equal(status.encrypted, true);
    assert.equal(status.safeStorageBackend, backend);

    const secret = `safe-storage-${Date.now()}-must-not-leak`;
    const cipher = secretStore.encrypt(secret);
    assert.match(cipher, /^enc:v1:/);
    assert.ok(!cipher.includes(secret));
    assert.equal(secretStore.decrypt(cipher), secret, "safeStorage 解密往返失败");

    const saved = config.saveSharedWebdav({
      endpoint: "https://dav.example.com/dav",
      username: "keychain-e2e",
      password: secret,
      roots: {},
    });
    assert.equal(saved && saved.ok, true);
    const raw = fs.readFileSync(config.configPath(), "utf8");
    assert.ok(!raw.includes(secret), "框架配置泄漏安全存储明文");
    assert.match(JSON.parse(raw).webdavShared.password, /^enc:v1:/);
    assert.equal(config.loadSharedWebdav().password, secret);

    console.log(`系统安全存储 E2E 通过：backend=${backend || status.backend} enc:v1 roundtrip + config ciphertext`);
    app.exit(0);
  } catch (error) {
    console.error((error && error.stack) || error);
    app.exit(1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
