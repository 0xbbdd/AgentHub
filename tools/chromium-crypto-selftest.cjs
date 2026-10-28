/**
 * Chromium/Electron 凭据解密自测：GCM、CBC、DPAPI、macOS Keychain、Linux Secret Service。
 * 全部使用注入执行器，不访问真实钥匙串、不读取用户凭据。
 * 用法：node tools/chromium-crypto-selftest.cjs
 */
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const cc = require("../electron/backend/platform/chromium-crypto.cjs");

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

console.log("\nChromium 凭据解密自测");

test("PBKDF2 参数固定为 saltysalt / 1003 / SHA1 / 16B", () => {
  const key = cc.deriveKey("test-password");
  assert.equal(key.length, 16);
  assert.equal(key.toString("hex"), crypto.pbkdf2Sync("test-password", "saltysalt", 1003, 16, "sha1").toString("hex"));
  assert.notEqual(key.toString("hex"), cc.deriveKey("another-password").toString("hex"));
});

test("Windows AES-256-GCM v10 往返", () => {
  const key = crypto.randomBytes(32);
  const plain = Buffer.from('{"token":"dt-test"}', "utf8");
  const blob = cc.encryptGcm(plain, key);
  assert.equal(blob.subarray(0, 3).toString("ascii"), "v10");
  assert.deepEqual(cc.decryptGcm(blob, key), plain);
  assert.throws(() => cc.decryptGcm(blob, crypto.randomBytes(32)), /解密失败|bad decrypt|unable/i);
});

test("macOS/Linux AES-128-CBC v10 往返", () => {
  const material = cc.materialFromPassword("keychain-password", "test");
  const plain = Buffer.from('{"token":"dt-cbc"}', "utf8");
  const blob = cc.encryptCbc(plain, material.key);
  assert.equal(blob.subarray(0, 3).toString("ascii"), "v10");
  assert.deepEqual(cc.decryptCbc(blob, material.key), plain);
  const auto = cc.decryptV10Auto(blob, material);
  assert.equal(auto.mode, "cbc");
  assert.deepEqual(auto.plain, plain);
});

test("自动解密会依次尝试首选模式", () => {
  const gcmKey = crypto.randomBytes(32);
  const cbcMaterial = cc.materialFromPassword("password", "test");
  const payload = Buffer.from("payload", "utf8");
  assert.equal(cc.decryptV10Auto(cc.encryptGcm(payload, gcmKey), cc.materialFromKey(gcmKey, "gcm")).mode, "gcm");
  const cbcBlob = cc.encryptCbc(payload, cbcMaterial.key);
  assert.equal(cc.decryptV10Auto(cbcBlob, cbcMaterial).mode, "cbc");
});

test("Windows DPAPI 使用参数化 PowerShell 并校验 32B key", () => {
  const key = crypto.randomBytes(32);
  const wrapped = crypto.randomBytes(64);
  const encryptedKey = Buffer.concat([Buffer.from("DPAPI", "ascii"), wrapped]).toString("base64");
  let seen = null;
  const out = cc.dpapiUnprotectKey(encryptedKey, {
    execFileSync(file, args) {
      seen = { file, args };
      return key.toString("base64");
    },
  });
  assert.deepEqual(out, key);
  assert.equal(seen.file, "powershell.exe");
  assert.ok(seen.args.includes("-NonInteractive"));
});

test("macOS Keychain 口令可解析为 CBC 材料", () => {
  const calls = [];
  const material = cc.resolveMaterial({
    platform: "darwin",
    serviceNames: ["Qoder Safe Storage"],
    accountNames: ["Qoder"],
    execFileSync(file, args) {
      calls.push({ file, args });
      if (file === "security" && args.includes("-w")) return "mac-password\n";
      throw new Error("unexpected");
    },
  });
  assert.equal(material.mode, "cbc");
  assert.equal(material.key.toString("hex"), cc.deriveKey("mac-password").toString("hex"));
  assert.ok(calls.some((call) => call.file === "security" && call.args[0] === "find-generic-password"));
});

test("Linux Secret Service 口令可解析为 CBC 材料", () => {
  const calls = [];
  const material = cc.resolveMaterial({
    platform: "linux",
    appNames: ["qoder"],
    execFileSync(file, args) {
      calls.push({ file, args });
      if (file === "secret-tool" && args[0] === "lookup") return "linux-password\n";
      throw new Error("unexpected");
    },
  });
  assert.equal(material.mode, "cbc");
  assert.equal(material.key.toString("hex"), cc.deriveKey("linux-password").toString("hex"));
  assert.ok(calls.some((call) => call.file === "secret-tool" && call.args.includes("application")));
});

test("Linux basic-text 只有在显式允许时使用 peanuts", () => {
  const unavailable = {
    execFileSync() { throw new Error("secret service unavailable"); },
  };
  assert.throws(() => cc.resolveMaterial({ platform: "linux", ...unavailable }), /Secret Service/);
  const material = cc.resolveMaterial({ platform: "linux", allowBasicText: true, ...unavailable });
  assert.equal(material.mode, "cbc");
  assert.equal(material.password, cc.BASIC_TEXT_PASSWORD);
  assert.equal(material.source, "linux-basic-text");
});

test("os_crypt 前缀解析严格区分 DPAPI 与 v10", () => {
  assert.equal(cc.decodeEncryptedKey(Buffer.concat([Buffer.from("DPAPI"), crypto.randomBytes(8)]).toString("base64")).type, "dpapi");
  assert.equal(cc.decodeEncryptedKey(Buffer.concat([Buffer.from("v10"), crypto.randomBytes(8)]).toString("base64")).type, "v10");
  assert.throws(() => cc.decodeEncryptedKey(crypto.randomBytes(8).toString("base64")), /前缀异常/);
});

console.log(`\nChromium 凭据解密自测通过：${pass} 项`);
