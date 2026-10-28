/**
 * 跨平台凭据后端诊断。默认只做文件与命令存在性检查；--attempt 才访问钥匙串/Secret Service。
 * 输出绝不包含 token、refreshToken、Keychain 口令或 Secret Service secret。
 *
 * 用法：
 *   node tools/platform-credential-diagnose.cjs
 *   node tools/platform-credential-diagnose.cjs --attempt
 *   node tools/platform-credential-diagnose.cjs --attempt --json
 */
"use strict";

const fs = require("node:fs");
const hostPlatform = require("../electron/backend/platform/index.cjs");
const chromiumCrypto = require("../electron/backend/platform/chromium-crypto.cjs");
const qoderAuth = require("../electron/backend/proxy/qoderAuth.cjs");
const qoderInstall = require("../electron/backend/proxy/qoderInstall.cjs");
const autoclawCredentials = require("../electron/backend/proxy/autoclaw/credentials.cjs");

const json = process.argv.includes("--json");
const attempt = process.argv.includes("--attempt");
const mask = (value) => {
  const text = String(value || "");
  if (!text) return "";
  return text.length <= 4 ? "***" : `${text.slice(0, 3)}***${text.slice(-2)}`;
};
const exists = (file) => {
  try { return !!file && fs.existsSync(file); } catch { return false; }
};

function qoderReport() {
  const out = [];
  for (const product of Object.keys(qoderAuth.PRODUCTS)) {
    const p = qoderAuth.pathsOf(product);
    const item = {
      product,
      label: qoderAuth.PRODUCTS[product].label,
      appData: p.appData,
      authFile: { path: p.authFile, exists: exists(p.authFile) },
      localState: { path: p.localState, exists: exists(p.localState) },
      resources: qoderInstall.findResources(product) || "",
      runtimeInfo: qoderInstall.runtimeInfoPath(product) || "",
      decrypted: null,
      error: "",
    };
    if (attempt && item.authFile.exists) {
      try {
        const cred = qoderAuth.readCredentials(product);
        item.decrypted = {
          mode: "auto",
          hasToken: !!cred.token,
          hasRefreshToken: !!cred.refreshToken,
          uid: mask((cred.user && cred.user.id) || ""),
          expiresAt: cred.expiresAt || 0,
          machineId: mask(cred.machineId),
        };
      } catch (error) {
        item.error = String((error && error.message) || error).slice(0, 180);
      }
    }
    out.push(item);
  }
  return out;
}

function autoclawReport() {
  const out = [];
  for (const product of Object.keys(autoclawCredentials.PRODUCTS)) {
    const p = autoclawCredentials.desktopPaths(product);
    const item = {
      product,
      label: autoclawCredentials.PRODUCTS[product],
      officialDir: p.officialDir,
      officialDirExists: exists(p.officialDir),
      localState: { path: p.localState, exists: exists(p.localState) },
      activeAccountFile: { path: p.activeAccountFile, exists: exists(p.activeAccountFile) },
      accountsDir: { path: p.accountsDir, exists: exists(p.accountsDir) },
      decrypted: null,
      error: "",
    };
    if (attempt) {
      try {
        const login = autoclawCredentials.readOfficialLogin(product);
        if (login && login.ok) {
          item.decrypted = {
            hasToken: !!login.token,
            hasRefreshToken: !!login.refreshToken,
            uid: mask(login.uid),
            source: login.source || "",
          };
        }
      } catch (error) {
        item.error = String((error && error.message) || error).slice(0, 180);
      }
    }
    out.push(item);
  }
  return out;
}

const credentialCommand = hostPlatform.isMac() ? "security" : hostPlatform.isLinux() ? "secret-tool" : "powershell.exe";
const credentialCommandPath = hostPlatform.process.which(credentialCommand);
const runtime = {
  secureStorage: hostPlatform.secureStore.status(),
  credentialBackend: {
    command: credentialCommand,
    path: credentialCommandPath,
    available: !!credentialCommandPath,
    reason: credentialCommandPath ? "" : `未找到系统凭据命令 ${credentialCommand}`,
  },
};
const capabilitySnapshot = hostPlatform.capabilities.snapshot({ runtime });
const result = {
  platform: hostPlatform.current(),
  secureStore: runtime.secureStorage,
  credentialBackend: {
    feature: capabilitySnapshot.features["credentials.chromium-os-crypt"],
    command: credentialCommand,
    commandPath: credentialCommandPath,
    available: runtime.credentialBackend.available,
    supportedModes: hostPlatform.isWindows() ? ["AES-256-GCM/DPAPI"] : ["AES-128-CBC/Keychain-or-Secret-Service"],
    basicTextAllowed: false,
  },
  attempt,
  qoder: qoderReport(),
  autoclaw: autoclawReport(),
  cryptoPrimitives: {
    pbkdf2Iterations: chromiumCrypto.PBKDF2_ITERATIONS,
    salt: chromiumCrypto.PBKDF2_SALT.toString("ascii"),
  },
};

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`平台：${result.platform.label} ${result.platform.arch}`);
  console.log(`凭据后端：${result.credentialBackend.command} ${result.credentialBackend.commandPath || "(未找到)"}`);
  console.log(`能力状态：${result.credentialBackend.feature.status}${result.credentialBackend.feature.reason ? ` · ${result.credentialBackend.feature.reason}` : ""}`);
  console.log(`安全存储：${result.secureStore.backend}${result.secureStore.encrypted ? "（已加密）" : "（未加密）"}`);
  console.log("\nQoder:");
  for (const item of result.qoder) {
    console.log(`  ${item.label}: 凭据=${item.authFile.exists ? "有" : "无"} resources=${item.resources || "未找到"} runtime=${item.runtimeInfo || "未找到"}`);
    if (item.error) console.log(`    解密失败：${item.error}`);
    if (item.decrypted) console.log(`    已解密：uid=${item.decrypted.uid} token=${item.decrypted.hasToken} refresh=${item.decrypted.hasRefreshToken}`);
  }
  console.log("\nAutoClaw:");
  for (const item of result.autoclaw) {
    console.log(`  ${item.label}: 目录=${item.officialDirExists ? "有" : "无"} LocalState=${item.localState.exists ? "有" : "无"} accounts=${item.accountsDir.exists ? "有" : "无"}`);
    if (item.error) console.log(`    解密失败：${item.error}`);
    if (item.decrypted) console.log(`    已解密：uid=${item.decrypted.uid} token=${item.decrypted.hasToken} refresh=${item.decrypted.hasRefreshToken}`);
  }
  if (!attempt) console.log("\n提示：加 --attempt 才会访问系统钥匙串/Secret Service 并验证解密。");
}
