/**
 * Chromium/Electron 凭据解密服务。
 *
 * 两种 v10 形态并存：
 *   Windows：AES-256-GCM，12B nonce + 16B tag，32B key 通常由 DPAPI 解出；
 *   macOS/Linux：AES-128-CBC + "saltysalt"/1003 次 PBKDF2-SHA1，密钥来自 Keychain/Secret Service。
 *
 * macOS Keychain 与 Linux Secret Service 的读取依赖客户端写入时使用的 service/attributes。
 * 因此这里提供候选列表与可注入执行器；真实客户端版本仍需逐项验收，未验证前能力矩阵不得标 supported。
 */
"use strict";

const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const { platformName } = require("./paths.cjs");

const V10_MAGIC = Buffer.from("v10", "ascii");
const PBKDF2_SALT = Buffer.from("saltysalt", "ascii");
const CBC_IV = Buffer.from(" ".repeat(16), "ascii");
const PBKDF2_ITERATIONS = 1003;
const BASIC_TEXT_PASSWORD = "peanuts";

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function deriveKey(password) {
  const secret = String(password || "");
  if (!secret) throw new Error("Chromium 安全存储口令为空");
  return crypto.pbkdf2Sync(secret, PBKDF2_SALT, PBKDF2_ITERATIONS, 16, "sha1");
}

function assertV10(blob) {
  if (!Buffer.isBuffer(blob) || blob.length < 3 || !blob.subarray(0, 3).equals(V10_MAGIC)) {
    throw new Error("不是 Chromium v10 信封");
  }
}

function decryptGcm(blob, key) {
  assertV10(blob);
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error(`AES-256-GCM 密钥长度异常：${key && key.length}`);
  if (blob.length < 31) throw new Error("v10 GCM 信封过短");
  const nonce = blob.subarray(3, 15);
  const tag = blob.subarray(blob.length - 16);
  const ciphertext = blob.subarray(15, blob.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function encryptGcm(plain, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error(`AES-256-GCM 密钥长度异常：${key && key.length}`);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plain)), cipher.final()]);
  return Buffer.concat([V10_MAGIC, nonce, ciphertext, cipher.getAuthTag()]);
}

function decryptCbc(blob, key) {
  assertV10(blob);
  if (!Buffer.isBuffer(key) || key.length !== 16) throw new Error(`AES-128-CBC 密钥长度异常：${key && key.length}`);
  if (blob.length <= 3 || (blob.length - 3) % 16 !== 0) throw new Error("v10 CBC 信封长度异常");
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, CBC_IV);
  return Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]);
}

function encryptCbc(plain, key) {
  if (!Buffer.isBuffer(key) || key.length !== 16) throw new Error(`AES-128-CBC 密钥长度异常：${key && key.length}`);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, CBC_IV);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plain)), cipher.final()]);
  return Buffer.concat([V10_MAGIC, ciphertext]);
}

function materialFromPassword(password, source = "password") {
  return { mode: "cbc", key: deriveKey(password), password: String(password), source };
}

function materialFromKey(key, mode = "gcm", source = "key") {
  const buf = Buffer.from(key);
  return { mode: mode || (buf.length === 32 ? "gcm" : "cbc"), key: buf, source };
}

function decryptAuto(blob, material) {
  if (!material || !Buffer.isBuffer(material.key)) throw new Error("缺少 Chromium 解密密钥材料");
  const preferred = material.mode === "gcm" ? "gcm" : "cbc";
  const order = preferred === "gcm" ? ["gcm", "cbc"] : ["cbc", "gcm"];
  let lastError = null;
  for (const mode of order) {
    try {
      const plain = mode === "gcm" ? decryptGcm(blob, material.key) : decryptCbc(blob, material.key);
      return { plain, mode };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Chromium v10 解密失败：${lastError ? lastError.message : "未知错误"}`);
}

function encryptAuto(plain, material, preferredMode) {
  if (!material || !Buffer.isBuffer(material.key)) throw new Error("缺少 Chromium 加密密钥材料");
  const mode = preferredMode || material.mode || (material.key.length === 32 ? "gcm" : "cbc");
  return mode === "gcm" ? encryptGcm(plain, material.key) : encryptCbc(plain, material.key);
}

function writeThrough(execFileSync, file, args, opts = {}) {
  try {
    return String(execFileSync(file, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: Math.max(1000, Number(opts.timeoutMs) || 10000),
      stdio: ["ignore", "pipe", "ignore"],
    }) || "").trim();
  } catch (error) {
    if (opts.optional) return "";
    throw error;
  }
}

function decodeEncryptedKey(encryptedKeyB64) {
  const raw = Buffer.from(String(encryptedKeyB64 || ""), "base64");
  if (raw.length < 6) throw new Error("os_crypt.encrypted_key 为空或格式异常");
  const magic = raw.subarray(0, 5).toString("ascii");
  if (magic === "DPAPI") return { type: "dpapi", keyBlob: raw.subarray(5) };
  if (raw.subarray(0, 3).toString("ascii") === "v10") return { type: "v10", keyBlob: raw };
  throw new Error(`os_crypt 前缀异常：${magic}`);
}

function dpapiUnprotectKey(encryptedKeyB64, opts = {}) {
  const execFileSync = opts.execFileSync || childProcess.execFileSync;
  const decoded = decodeEncryptedKey(encryptedKeyB64);
  if (decoded.type !== "dpapi") throw new Error("Windows os_crypt 密钥不是 DPAPI 信封");
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security | Out-Null",
    `$b=[Convert]::FromBase64String('${decoded.keyBlob.toString("base64")}')`,
    "$k=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Convert]::ToBase64String($k)",
  ].join("; ");
  let out = "";
  try {
    out = String(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: Math.max(1000, Number(opts.timeoutMs) || 15000),
      stdio: ["ignore", "pipe", "ignore"],
    }) || "").trim();
  } catch (error) {
    throw new Error(`DPAPI 解密失败（需与客户端同一 Windows 用户）：${String((error && error.message) || error).slice(0, 120)}`);
  }
  const key = Buffer.from(out, "base64");
  if (key.length !== 32) throw new Error(`DPAPI 返回密钥长度异常：${key.length}`);
  return key;
}

function readMacKeychainPassword(opts = {}) {
  const execFileSync = opts.execFileSync || childProcess.execFileSync;
  const services = unique(opts.serviceNames);
  const accounts = unique(opts.accountNames);
  if (!services.length) return null;
  for (const service of services) {
    const accountList = accounts.length ? [...accounts, ""] : [""];
    for (const account of accountList) {
      const args = ["find-generic-password", "-s", service];
      if (account) args.push("-a", account);
      args.push("-w");
      const password = writeThrough(execFileSync, "security", args, { optional: true, timeoutMs: opts.timeoutMs });
      if (password) return { password, source: `keychain:${service}` };
    }
  }
  return null;
}

function defaultSecretAttributes(appNames) {
  const apps = unique(["chrome", "chromium", ...(Array.isArray(appNames) ? appNames : [])]);
  const out = [];
  for (const app of apps) {
    out.push({ "xdg:schema": "chrome_libsecret_os_crypt_password_v2", application: app });
  }
  for (const app of apps) out.push({ application: app });
  return out;
}

function readLinuxSecretPassword(opts = {}) {
  const execFileSync = opts.execFileSync || childProcess.execFileSync;
  const candidates = Array.isArray(opts.attributeCandidates) && opts.attributeCandidates.length
    ? opts.attributeCandidates
    : defaultSecretAttributes(opts.appNames);
  for (const attrs of candidates) {
    if (!attrs || typeof attrs !== "object") continue;
    const args = ["lookup"];
    for (const [key, value] of Object.entries(attrs)) {
      if (key && value != null && String(value)) args.push(key, String(value));
    }
    if (args.length === 1) continue;
    const password = writeThrough(execFileSync, "secret-tool", args, { optional: true, timeoutMs: opts.timeoutMs });
    if (password) return { password, source: `secret-service:${JSON.stringify(attrs)}` };
  }
  return null;
}

/**
 * 解析客户端可用密钥材料。
 * opts:
 *   platform, encryptedKeyB64, serviceNames, accountNames, appNames,
 *   attributeCandidates, allowBasicText, execFileSync
 */
function resolveMaterial(opts = {}) {
  const name = platformName(opts.platform || process.platform);
  if (name === "unknown") throw new Error(`未知平台：${opts.platform}`);

  if (name === "win32") {
    if (!opts.encryptedKeyB64) throw new Error("Local State 缺少 os_crypt.encrypted_key");
    return materialFromKey(dpapiUnprotectKey(opts.encryptedKeyB64, { execFileSync: opts.execFileSync, timeoutMs: opts.timeoutMs }), "gcm", "dpapi");
  }

  let passwordResult = null;
  if (name === "darwin") {
    passwordResult = readMacKeychainPassword(opts);
  } else {
    passwordResult = readLinuxSecretPassword(opts);
    if (!passwordResult && opts.allowBasicText) {
      passwordResult = { password: BASIC_TEXT_PASSWORD, source: "linux-basic-text" };
    }
  }
  if (!passwordResult) {
    throw new Error(name === "darwin"
      ? "无法从 macOS Keychain 读取客户端 Safe Storage 口令"
      : "无法从 Linux Secret Service 读取客户端 Safe Storage 口令（可显式允许 basic-text）");
  }
  return materialFromPassword(passwordResult.password, passwordResult.source);
}

function decryptV10Auto(blob, materialOrKey) {
  const material = Buffer.isBuffer(materialOrKey)
    ? materialFromKey(materialOrKey, materialOrKey.length === 16 ? "cbc" : "gcm")
    : materialOrKey;
  return decryptAuto(blob, material);
}

function encryptV10Auto(plain, materialOrKey, preferredMode) {
  const material = Buffer.isBuffer(materialOrKey)
    ? materialFromKey(materialOrKey, materialOrKey.length === 16 ? "cbc" : "gcm")
    : materialOrKey;
  return encryptAuto(plain, material, preferredMode);
}

module.exports = {
  V10_MAGIC,
  PBKDF2_SALT,
  PBKDF2_ITERATIONS,
  CBC_IV,
  BASIC_TEXT_PASSWORD,
  deriveKey,
  decryptGcm,
  encryptGcm,
  decryptCbc,
  encryptCbc,
  materialFromPassword,
  materialFromKey,
  decryptAuto,
  encryptAuto,
  decodeEncryptedKey,
  dpapiUnprotectKey,
  readMacKeychainPassword,
  readLinuxSecretPassword,
  defaultSecretAttributes,
  resolveMaterial,
  decryptV10Auto,
  encryptV10Auto,
};
