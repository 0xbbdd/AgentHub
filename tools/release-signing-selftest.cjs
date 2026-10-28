// 发布签名配置自测：不访问 Apple/Windows，只验证凭据解析与跳过逻辑。
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const notarizeHook = require("../build/notarize.cjs");

(async () => {
  assert.throws(() => notarizeHook.resolveCredentials({}), /公证凭据缺失/);
  assert.throws(() => notarizeHook.resolveCredentials({ APPLE_ID: "a@example.com" }), /APPLE_APP_SPECIFIC_PASSWORD/);
  const apple = notarizeHook.resolveCredentials({
    APPLE_ID: "a@example.com",
    APPLE_APP_SPECIFIC_PASSWORD: "app-password",
    APPLE_TEAM_ID: "TEAMID1234",
  });
  assert.equal(apple.mode, "apple-id");
  assert.equal(apple.options.teamId, "TEAMID1234");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-notary-key-"));
  const key = path.join(tmp, "AuthKey.p8");
  fs.writeFileSync(key, "fixture", "utf8");
  try {
    const api = notarizeHook.resolveCredentials({
      APPLE_API_KEY: key,
      APPLE_API_KEY_ID: "KEYID123",
      APPLE_API_ISSUER: "issuer",
      APPLE_TEAM_ID: "TEAMID1234",
    });
    assert.equal(api.mode, "api-key");
    assert.equal(api.options.appleApiKey, key);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const keychain = notarizeHook.resolveCredentials({ APPLE_KEYCHAIN_PROFILE: "agenthub-notary" });
  assert.equal(keychain.mode, "keychain");
  assert.equal(keychain.options.keychainProfile, "agenthub-notary");

  await notarizeHook({ electronPlatformName: "linux", appOutDir: "/tmp" });
  const old = process.env.SKIP_NOTARIZE;
  process.env.SKIP_NOTARIZE = "1";
  try {
    await notarizeHook({ electronPlatformName: "darwin", appOutDir: "/tmp", packager: { appInfo: { productFilename: "AgentHub" } } });
  } finally {
    if (old == null) delete process.env.SKIP_NOTARIZE; else process.env.SKIP_NOTARIZE = old;
  }
  console.log("发布签名配置自测通过");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
