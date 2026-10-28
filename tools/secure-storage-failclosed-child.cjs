/** 安全存储 fail-closed 子进程探针：无系统钥匙串、无 AGENTHUB_SECRET_KEY 时验证拒绝明文。 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

try {
  const config = require("../electron/backend/config.cjs");
  fs.writeFileSync(config.configPath(), JSON.stringify({
    theme: "dark",
    webdav: { password: "strict-framework-password" },
    webdavShared: { endpoint: "https://dav.example.com", username: "strict", password: "strict-shared-password" },
    remoteTargets: [{ id: "strict", tokenEnc: "strict-remote-token" }],
  }, null, 2), "utf8");
  const migration = config.protectSensitiveDataAtRest();
  assert.equal(migration.dropped, 3);
  const raw = fs.readFileSync(config.configPath(), "utf8");
  assert.ok(!raw.includes("strict-framework-password"));
  assert.ok(!raw.includes("strict-shared-password"));
  assert.ok(!raw.includes("strict-remote-token"));
  const proxyStore = require("../electron/backend/proxy/store.cjs");
  assert.equal(config.secureStorageStatus().backend, "plaintext-fallback");
  assert.equal(config.secureStorageStatus().policy.failClosed, true);
  proxyStore.open();
  proxyStore.close();
  assert.throws(
    () => config.saveSharedWebdav({ endpoint: "https://dav.example.com", username: "strict", password: "must-not-write", roots: {} }),
    /生产环境拒绝明文落盘/,
  );

  const { MemoryConfig } = require("../electron/backend/memory/config.cjs");
  const { ProviderStore } = require("../electron/backend/memory/providers.cjs");
  const memRoot = require("node:path").join(process.env.AGENTHUB_DATA_DIR, "memory");
  const memCfg = new MemoryConfig(memRoot);
  memCfg.set({
    "models.providers": [{
      id: "prov_strict",
      name: "Strict Legacy",
      kind: "custom",
      baseUrl: "https://strict.example.com/v1",
      apiFormat: "chat_completions",
      apiKeyRef: "strict-memory-api-key",
      enabled: true,
    }],
  }, { local: true });
  const providers = new ProviderStore({
    memCfg,
    service: {
      flat: () => ({
        "models.providers": memCfg.get("models.providers") || [],
        "models.models": memCfg.get("models.models") || [],
      }),
    },
    emit: () => {},
    gatewayResolver: () => ({}),
  });
  assert.match(providers.secretMigrationError, /安全存储|safeStorage/);
  assert.ok(!fs.readFileSync(memCfg.localFile, "utf8").includes("strict-memory-api-key"));
  console.log("strict child ok");
} catch (error) {
  console.error((error && error.stack) || error);
  process.exit(1);
}
