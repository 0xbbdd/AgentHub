/**
 * 跨平台敏感数据信封。
 *
 * 支持两种既有格式：
 *   enc:v1: Electron safeStorage（Windows DPAPI / macOS Keychain / Linux Secret Service）
 *   enc:v2: AES-256-GCM，密钥来自 AGENTHUB_SECRET_KEY（headless 与桌面都可显式使用）
 *
 * 开发/自测环境在两种后端都不可用时兼容历史明文透传；打包后的生产应用默认
 * fail-closed（allowPlaintext=false），必须启用系统安全存储或 AGENTHUB_SECRET_KEY。
 * 测试可通过 allowPlaintext / packaged 显式覆盖策略。
 */
"use strict";

const crypto = require("node:crypto");

const ENC_PREFIX = "enc:v1:";
const AES_PREFIX = "enc:v2:";

function detectSafeStorage() {
  try {
    const electron = require("electron");
    if (electron && typeof electron === "object" && electron.safeStorage) return electron.safeStorage;
  } catch {
    /* 纯 Node 自测环境 */
  }
  return null;
}

function detectPackagedApp() {
  try {
    const electron = require("electron");
    return !!(electron && typeof electron === "object" && electron.app && electron.app.isPackaged);
  } catch {
    return false;
  }
}

function createSecureStore(opts = {}) {
  const env = opts.env || process.env;
  const injectedSafeStorage = Object.prototype.hasOwnProperty.call(opts, "safeStorage")
    ? opts.safeStorage
    : detectSafeStorage();
  const packaged = typeof opts.packaged === "boolean" ? opts.packaged : detectPackagedApp();
  const envFailClosed = String(env.AGENTHUB_SECURE_STORAGE_FAIL_CLOSED || "") === "1";
  const allowPlaintext = typeof opts.allowPlaintext === "boolean" ? opts.allowPlaintext : !(packaged || envFailClosed);

  function safeStorageState() {
    try {
      if (!injectedSafeStorage || !injectedSafeStorage.isEncryptionAvailable()) {
        return { available: false, backend: "", reason: "Electron safeStorage 不可用" };
      }
      // Linux 无 Secret Service/KWallet 时 Electron 可能返回 basic_text：
      // isEncryptionAvailable() 仍为 true，但密钥是固定弱口令，不能视为生产安全存储。
      const selected = typeof injectedSafeStorage.getSelectedStorageBackend === "function"
        ? String(injectedSafeStorage.getSelectedStorageBackend() || "")
        : "";
      if (process.platform === "linux" && selected === "basic_text") {
        return { available: false, backend: selected, reason: "Electron 仅提供 basic_text 弱加密后端" };
      }
      return { available: true, backend: selected, reason: "" };
    } catch (error) {
      return { available: false, backend: "", reason: String((error && error.message) || error) };
    }
  }

  function aesKey() {
    const secret = String(env.AGENTHUB_SECRET_KEY || "");
    return secret ? crypto.createHash("sha256").update(secret).digest() : null;
  }

  function isEncrypted(value) {
    return typeof value === "string" && (value.startsWith(ENC_PREFIX) || value.startsWith(AES_PREFIX));
  }

  function encrypt(plain, options = {}) {
    const text = String(plain || "");
    if (!text || isEncrypted(text)) return text;

    if (safeStorageState().available) {
      return ENC_PREFIX + injectedSafeStorage.encryptString(text).toString("base64");
    }

    const key = aesKey();
    if (key) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
      const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return AES_PREFIX + [nonce, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
    }

    if (options.allowPlaintext === false || !allowPlaintext) {
      throw new Error("安全存储不可用：生产环境拒绝明文落盘；请启用系统钥匙串，或设置 AGENTHUB_SECRET_KEY");
    }
    return text;
  }

  function decrypt(stored) {
    const text = String(stored || "");

    if (text.startsWith(AES_PREFIX)) {
      const key = aesKey();
      if (!key) return "";
      try {
        const [nonce, tag, ciphertext] = text.slice(AES_PREFIX.length).split(".");
        if (!nonce || !tag || ciphertext == null) return "";
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
        decipher.setAuthTag(Buffer.from(tag, "base64url"));
        return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
      } catch {
        return "";
      }
    }

    if (text.startsWith(ENC_PREFIX)) {
      if (!safeStorageState().available) return "";
      try {
        return injectedSafeStorage.decryptString(Buffer.from(text.slice(ENC_PREFIX.length), "base64"));
      } catch {
        return "";
      }
    }

    if (!allowPlaintext) return "";
    return text;
  }

  function status() {
    const policy = { failClosed: !allowPlaintext, plaintextAllowed: allowPlaintext, packaged, envFailClosed };
    const safe = safeStorageState();
    if (safe.available) {
      return {
        backend: "os-keychain",
        encrypted: true,
        platform: process.platform,
        safeStorageBackend: safe.backend,
        policy,
      };
    }
    if (aesKey()) return { backend: "aes-256-gcm", encrypted: true, platform: process.platform, policy };
    const backendReason = safe.reason ? `${safe.reason}；` : "";
    return {
      backend: "plaintext-fallback",
      encrypted: false,
      platform: process.platform,
      safeStorageBackend: safe.backend,
      policy,
      reason: allowPlaintext
        ? `${backendReason}未设置 AGENTHUB_SECRET_KEY（开发环境允许明文兼容）`
        : `${backendReason}未设置 AGENTHUB_SECRET_KEY；生产环境已拒绝明文落盘`,
    };
  }

  return { encrypt, decrypt, isEncrypted, status, ENC_PREFIX, AES_PREFIX };
}

const defaultStore = createSecureStore();

module.exports = {
  ...defaultStore,
  ENC_PREFIX,
  AES_PREFIX,
  createSecureStore,
};
