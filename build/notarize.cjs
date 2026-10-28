// electron-builder afterSign：macOS 公证 + staple。
// 非 macOS 直接跳过；CI 的未签名打包任务通过 SKIP_NOTARIZE=1 显式跳过。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { notarize } = require("@electron/notarize");

function resolveCredentials(env = process.env) {
  const teamId = String(env.APPLE_TEAM_ID || "").trim();
  if (env.APPLE_KEYCHAIN_PROFILE) {
    return {
      mode: "keychain",
      options: {
        tool: "notarytool",
        keychain: env.APPLE_KEYCHAIN || undefined,
        keychainProfile: env.APPLE_KEYCHAIN_PROFILE,
      },
    };
  }
  if (env.APPLE_API_KEY || env.APPLE_API_KEY_ID || env.APPLE_API_ISSUER) {
    for (const key of ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_TEAM_ID"]) {
      if (!env[key]) throw new Error(`macOS 公证缺少环境变量：${key}`);
    }
    if (!fs.existsSync(env.APPLE_API_KEY)) throw new Error(`APPLE_API_KEY 文件不存在：${env.APPLE_API_KEY}`);
    return {
      mode: "api-key",
      options: {
        tool: "notarytool",
        appleApiKey: env.APPLE_API_KEY,
        appleApiKeyId: env.APPLE_API_KEY_ID,
        appleApiIssuer: env.APPLE_API_ISSUER,
        teamId,
      },
    };
  }
  if (env.APPLE_ID || env.APPLE_APP_SPECIFIC_PASSWORD) {
    for (const key of ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]) {
      if (!env[key]) throw new Error(`macOS 公证缺少环境变量：${key}`);
    }
    return {
      mode: "apple-id",
      options: {
        tool: "notarytool",
        appleId: env.APPLE_ID,
        appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD,
        teamId,
      },
    };
  }
  throw new Error("macOS 公证凭据缺失：需要 Apple ID 或 App Store Connect API Key");
}

module.exports = async function afterSign(context) {
  if (!context || context.electronPlatformName !== "darwin") return;
  if (process.env.SKIP_NOTARIZE === "1") {
    console.log("[notarize] SKIP_NOTARIZE=1，跳过 macOS 公证（仅限非发布构建）");
    return;
  }
  const productFilename = context.packager && context.packager.appInfo && context.packager.appInfo.productFilename;
  if (!productFilename) throw new Error("无法确定 macOS 应用名称");
  const appPath = path.join(context.appOutDir, `${productFilename}.app`);
  if (!fs.existsSync(appPath)) throw new Error(`macOS 应用不存在：${appPath}`);
  const credentials = resolveCredentials(process.env);
  console.log(`[notarize] 开始 Apple notarytool 公证（${credentials.mode}）`);
  await notarize({ appPath, ...credentials.options });
  console.log("[notarize] 公证与 staple 完成");
};

module.exports.resolveCredentials = resolveCredentials;
