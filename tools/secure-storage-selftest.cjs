/**
 * 生产安全存储落盘自测：框架配置、用量同步配置、代理号池、记忆中枢供应商 Key
 * 必须在 AGENTHUB_SECRET_KEY 模式下全部写成 enc:v2 信封。
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-secure-store-"));
process.env.HOME = path.join(tmp, "home");
process.env.USERPROFILE = path.join(tmp, "home");
process.env.AGENTHUB_DATA_DIR = path.join(tmp, "app-data");
process.env.AGENT_SKILLS_HOME = path.join(tmp, "skills");
process.env.AGENTHUB_SECRET_KEY = "secure-storage-selftest-key";
fs.mkdirSync(process.env.HOME, { recursive: true });

let db = null;
try {
  const config = require("../electron/backend/config.cjs");
  const syncConfig = require("../electron/backend/sync-config.cjs");
  const proxyStore = require("../electron/backend/proxy/store.cjs");
  const { MemoryConfig } = require("../electron/backend/memory/config.cjs");
  const { ProviderStore } = require("../electron/backend/memory/providers.cjs");

  assert.equal(config.secureStorageStatus().backend, "aes-256-gcm");
  assert.equal(config.secureStorageStatus().policy.failClosed, false);

  const DAV_SECRET = "dav-secret-must-not-leak";
  const saved = config.saveSharedWebdav({
    endpoint: "https://dav.example.com/dav",
    username: "alice",
    password: DAV_SECRET,
    encryptionPassphrase: "pool-passphrase-must-not-leak",
    roots: {},
  });
  assert.equal(saved && saved.ok, true);
  const frameworkRaw = fs.readFileSync(config.configPath(), "utf8");
  const framework = JSON.parse(frameworkRaw);
  assert.match(framework.webdavShared.password, /^enc:v2:/);
  assert.match(framework.webdavShared.encryptionPassphrase, /^enc:v2:/);
  assert.ok(!frameworkRaw.includes(DAV_SECRET));
  assert.equal(config.loadSharedWebdav().password, DAV_SECRET);

  const legacyFramework = JSON.parse(frameworkRaw);
  legacyFramework.webdav.password = "legacy-webdav-password";
  legacyFramework.webdavShared.password = "legacy-shared-password";
  legacyFramework.webdavShared.encryptionPassphrase = "legacy-shared-passphrase";
  legacyFramework.remoteTargets = [{ id: "r1", alias: "remote", baseUrl: "https://remote.example.com", tokenEnc: "legacy-remote-token" }];
  fs.writeFileSync(config.configPath(), JSON.stringify(legacyFramework, null, 2), "utf8");
  const frameworkMigration = config.protectSensitiveDataAtRest();
  assert.equal(frameworkMigration.migrated, 4);
  const migratedFrameworkRaw = fs.readFileSync(config.configPath(), "utf8");
  assert.ok(!migratedFrameworkRaw.includes("legacy-webdav-password"));
  assert.ok(!migratedFrameworkRaw.includes("legacy-shared-password"));
  assert.ok(!migratedFrameworkRaw.includes("legacy-shared-passphrase"));
  assert.ok(!migratedFrameworkRaw.includes("legacy-remote-token"));

  const SYNC_SECRET = "newapi-token-must-not-leak";
  const syncCfg = syncConfig.defaultConfig();
  syncCfg.billing.newApi.token = SYNC_SECRET;
  syncConfig.saveConfig(syncCfg);
  const syncRaw = fs.readFileSync(syncConfig.configPath(), "utf8");
  const syncDisk = JSON.parse(syncRaw);
  assert.match(syncDisk.billing.newApi.token, /^enc:v2:/);
  assert.ok(!syncRaw.includes(SYNC_SECRET));
  syncDisk.webdav.password = "legacy-sync-password";
  syncDisk.billing.newApi.token = "legacy-sync-token";
  fs.writeFileSync(syncConfig.configPath(), JSON.stringify(syncDisk, null, 2), "utf8");
  const syncMigration = syncConfig.protectSensitiveDataAtRest();
  assert.equal(syncMigration.migrated, 2);
  const migratedSyncRaw = fs.readFileSync(syncConfig.configPath(), "utf8");
  assert.ok(!migratedSyncRaw.includes("legacy-sync-password"));
  assert.ok(!migratedSyncRaw.includes("legacy-sync-token"));

  const PROXY_TOKEN = "proxy-token-must-not-leak";
  const PROXY_REFRESH = "proxy-refresh-must-not-leak";
  const accountId = proxyStore.addAccount({
    channel: "trae",
    uid: "secure-test",
    name: "secure-test",
    token: PROXY_TOKEN,
    refreshToken: PROXY_REFRESH,
    meta: { msCookie: config.encryptSecret("cookie-must-not-leak") },
  });
  proxyStore.close();
  db = new (require("node:sqlite").DatabaseSync)(path.join(process.env.AGENTHUB_DATA_DIR, "proxy", "stats.db"));
  const row = db.prepare("SELECT token_enc, refresh_enc, meta FROM accounts WHERE id = ?").get(accountId);
  assert.match(row.token_enc, /^enc:v2:/);
  assert.match(row.refresh_enc, /^enc:v2:/);
  assert.ok(!row.token_enc.includes(PROXY_TOKEN));
  assert.ok(!row.refresh_enc.includes(PROXY_REFRESH));
  assert.ok(!row.meta.includes("cookie-must-not-leak"));
  db.close();
  db = null;

  const LEGACY_TOKEN = "legacy-proxy-token-must-not-leak";
  const LEGACY_COOKIE = "legacy-cookie-must-not-leak";
  const legacyId = "legacy-plaintext-account";
  db = new (require("node:sqlite").DatabaseSync)(path.join(process.env.AGENTHUB_DATA_DIR, "proxy", "stats.db"));
  db.prepare("INSERT INTO accounts (id, channel, uid, name, token_enc, refresh_enc, status, meta, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(legacyId, "trae", "legacy", "legacy", LEGACY_TOKEN, "legacy-refresh", "online", JSON.stringify({ msCookie: LEGACY_COOKIE }), Date.now());
  db.close();
  db = null;
  proxyStore.open();
  proxyStore.close();
  db = new (require("node:sqlite").DatabaseSync)(path.join(process.env.AGENTHUB_DATA_DIR, "proxy", "stats.db"));
  const migrated = db.prepare("SELECT token_enc, refresh_enc, meta FROM accounts WHERE id = ?").get(legacyId);
  assert.match(migrated.token_enc, /^enc:v2:/);
  assert.match(migrated.refresh_enc, /^enc:v2:/);
  assert.ok(!migrated.token_enc.includes(LEGACY_TOKEN));
  assert.ok(!migrated.meta.includes(LEGACY_COOKIE));
  assert.ok(!migrated.meta.includes("legacy-cookie") && JSON.parse(migrated.meta).msCookie.startsWith("enc:v2:"));
  db.close();
  db = null;

  const STRICT_TOKEN = "strict-plaintext-token-must-not-leak";
  const STRICT_COOKIE = "strict-plaintext-cookie-must-not-leak";
  const strictId = "strict-plaintext-account";
  db = new (require("node:sqlite").DatabaseSync)(path.join(process.env.AGENTHUB_DATA_DIR, "proxy", "stats.db"));
  db.prepare("INSERT INTO accounts (id, channel, uid, name, token_enc, refresh_enc, status, meta, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(strictId, "trae", "strict", "strict", STRICT_TOKEN, "strict-refresh", "online", JSON.stringify({ msCookie: STRICT_COOKIE }), Date.now());
  db.close();
  db = null;
  const childEnv = {
    ...process.env,
    AGENTHUB_SECURE_STORAGE_FAIL_CLOSED: "1",
  };
  delete childEnv.AGENTHUB_SECRET_KEY;
  const strictRun = spawnSync(process.execPath, [path.join(__dirname, "secure-storage-failclosed-child.cjs")], {
    cwd: path.join(__dirname, ".."),
    env: childEnv,
    encoding: "utf8",
  });
  assert.equal(strictRun.status, 0, `${strictRun.stdout}\n${strictRun.stderr}`);
  db = new (require("node:sqlite").DatabaseSync)(path.join(process.env.AGENTHUB_DATA_DIR, "proxy", "stats.db"));
  const scrubbed = db.prepare("SELECT token_enc, refresh_enc, status, cool_reason, meta FROM accounts WHERE id = ?").get(strictId);
  assert.equal(scrubbed.token_enc, "");
  assert.equal(scrubbed.refresh_enc, "");
  assert.equal(scrubbed.status, "relogin");
  assert.match(scrubbed.cool_reason, /历史明文凭据已清除/);
  assert.ok(!scrubbed.meta.includes(STRICT_COOKIE));
  db.close();
  db = null;

  const MEMORY_KEY = "memory-key-must-not-leak";
  const LEGACY_MEMORY_KEY = "legacy-memory-key-must-not-leak";
  const memRoot = path.join(tmp, "memory");
  const memCfg = new MemoryConfig(memRoot);
  const seeded = memCfg.set({
    "models.providers": [{
      id: "prov_legacy",
      name: "Legacy Provider",
      kind: "custom",
      baseUrl: "https://legacy.example.com/v1",
      apiFormat: "chat_completions",
      apiKeyRef: LEGACY_MEMORY_KEY,
      enabled: true,
    }],
  }, { local: true });
  assert.equal(seeded.ok, true);
  const providerStore = new ProviderStore({
    memCfg,
    service: {
      flat: () => ({
        "models.providers": memCfg.get("models.providers") || [],
        "models.models": memCfg.get("models.models") || [],
      }),
    },
    emit: () => {},
    gatewayResolver: () => ({ available: false, baseUrl: "", fallbackModel: "" }),
  });
  const migratedMemoryRaw = fs.readFileSync(memCfg.localFile, "utf8");
  assert.ok(!migratedMemoryRaw.includes(LEGACY_MEMORY_KEY));
  assert.match(JSON.parse(migratedMemoryRaw).models.providers[0].apiKeyRef, /^enc:v2:/);

  const providerResult = providerStore.save({
    name: "Secure Provider",
    baseUrl: "https://api.example.com/v1",
    apiFormat: "chat_completions",
    apiKey: MEMORY_KEY,
  });
  assert.equal(providerResult.ok, true);
  const memoryRaw = fs.readFileSync(memCfg.localFile, "utf8");
  const providers = JSON.parse(memoryRaw).models.providers;
  assert.ok(providers.every((provider) => !provider.apiKeyRef || provider.apiKeyRef.startsWith("enc:v2:")));
  assert.ok(!memoryRaw.includes(MEMORY_KEY));
  assert.ok(!JSON.stringify(providerStore.list()).includes(MEMORY_KEY));

  console.log("生产安全存储自测通过：四类凭据均 enc:v2；历史明文迁移与无后端 fail-closed 清理均生效");
} finally {
  try { if (db) db.close(); } catch { /* 已关闭 */ }
  try { require("../electron/backend/proxy/store.cjs").close(); } catch { /* 未打开 */ }
  fs.rmSync(tmp, { recursive: true, force: true });
}
