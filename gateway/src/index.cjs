// AgentHub 反代网关 · Docker headless 形态入口
//
// 与桌面版共享同一份 proxy/*.cjs：装配直接复用 proxy/index.cjs 的 boot()——规则热加载、
// 数据库、额度刷新调度、真实签到 tick、号池定时同步、deviceMid 自愈迁移、remoteMid 云端
// 兜底全部随 boot 走；桌面版日后新增装配项这里自动继承，不需要维护第二份装配清单。
// 本入口只处理形态差异：进程内覆盖监听端口（不回写 config）、管理 REST API、停机序列。
//
// 数据目录与桌面版相互独立（各自的 config.json 与 stats.db）：桌面凭据是 safeStorage
// 密文，容器解不开；号池经 WebDAV/S3 的"口令信封"通道同步（导出侧本机解密为明文进加密包、
// 导入侧用本机机制重新封信），这是两种形态之间唯一正确的凭据通道。
"use strict";

const path = require("node:path");
const crypto = require("node:crypto");

const PROJECT_ROOT = path.join(__dirname, "..", "..");
const PROXY_DIR = path.join(PROJECT_ROOT, "electron", "backend", "proxy");
const BACKEND_DIR = path.join(PROJECT_ROOT, "electron", "backend");

// 数据目录先行：config.cjs 的 dataDir() 以 AGENTHUB_DATA_DIR 优先，本进程的一切读写都落在它下面
process.env.AGENTHUB_DATA_DIR = process.env.AGENTHUB_DATA_DIR || path.join(process.cwd(), "data");

// 生产安全门：容器里没有 safeStorage，凭据加密的唯一来源是 AGENTHUB_SECRET_KEY。
// 未设置又未显式放行时拒绝启动——比"静默明文落库"更早暴露问题；逃生门只给本地调试
if (!process.env.AGENTHUB_SECRET_KEY && process.env.AGENTHUB_ALLOW_PLAINTEXT !== "1") {
  console.error("[AgentHub Gateway] 拒绝启动：未设置 AGENTHUB_SECRET_KEY，凭据无法加密落盘。");
  console.error("  生产部署：AGENTHUB_SECRET_KEY=$(openssl rand -base64 32)");
  console.error("  仅本地调试需要明文：设 AGENTHUB_ALLOW_PLAINTEXT=1");
  process.exit(1);
}

const express = require("express");
const config = require(path.join(BACKEND_DIR, "config.cjs"));
const platform = require(path.join(PROXY_DIR, "platform", "index.cjs"));
const store = require(path.join(PROXY_DIR, "store.cjs"));
const server = require(path.join(PROXY_DIR, "server.cjs"));
const pool = require(path.join(PROXY_DIR, "pool.cjs"));
const adapters = require(path.join(PROXY_DIR, "adapters.cjs"));
const discovery = require(path.join(PROXY_DIR, "discovery.cjs"));
const poolsync = require(path.join(PROXY_DIR, "poolsync.cjs"));
const proxyIndex = require(path.join(PROXY_DIR, "index.cjs"));

const PORT = Number(process.env.AGENTHUB_PROXY_PORT) || 9527;
const BIND = process.env.AGENTHUB_HOST || "0.0.0.0";
const ADMIN_PORT = Number(process.env.AGENTHUB_ADMIN_PORT) || 9528;
const ADMIN_TOKEN = String(process.env.AGENTHUB_ADMIN_TOKEN || "");
// 管理面默认不进外网：未设 token 时只绑回环（容器外不可达）——反代 Key 与管理 token 是两套凭据
const ADMIN_BIND = process.env.AGENTHUB_ADMIN_HOST || (ADMIN_TOKEN ? "0.0.0.0" : "127.0.0.1");

let adminServer = null;

/** 进程内覆盖监听参数，不回写 config.json——与桌面版共享宿主配置或卷时绝不篡改对方的 bind */
function gatewaySettings() {
  return Object.assign({}, config.loadConfig().proxy, { port: PORT, bind: BIND });
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

async function main() {
  console.log(`[AgentHub Gateway] 启动中 platform=${platform.form()} version=${platform.version()}`);
  console.log(`[AgentHub Gateway] 数据目录 ${process.env.AGENTHUB_DATA_DIR}`);
  console.log(`[AgentHub Gateway] 凭据加密 ${process.env.AGENTHUB_SECRET_KEY ? "AES-256-GCM (AGENTHUB_SECRET_KEY)" : "无（AGENTHUB_ALLOW_PLAINTEXT=1 已放行明文）"}`);

  // 首启修正自己的 config：restoreOnLaunch 维持 false（server 由本入口显式启动，避免 boot()
  // 拿着磁盘里的旧端口抢先监听）；qoder 双区需要本机客户端 wasm 签名与 DPAPI，容器里必然失败，
  // 失败的 503 不罚账号但每个请求都白撞一次，默认关掉
  const cfg = config.loadConfig();
  const needFix =
    cfg.proxy.restoreOnLaunch ||
    cfg.proxy.channelEnabled.qoder !== false ||
    cfg.proxy.channelEnabled.qoder_intl !== false;
  if (needFix) {
    cfg.proxy.restoreOnLaunch = false;
    cfg.proxy.channelEnabled = Object.assign({}, cfg.proxy.channelEnabled, { qoder: false, qoder_intl: false });
    config.saveConfig(cfg);
  }

  await proxyIndex.boot();

  const started = await server.start(gatewaySettings);
  if (!started.ok) {
    console.error("[AgentHub Gateway] 反代网关启动失败:", started.message);
    process.exit(1);
  }
  console.log(`✅ [AgentHub Gateway] 反代网关已监听 ${BIND}:${PORT}/v1（chat/completions · messages · responses · models）`);

  adminServer = startAdmin();
  console.log(`✅ [AgentHub Gateway] 管理 API 已监听 ${ADMIN_BIND}:${ADMIN_PORT}（${ADMIN_TOKEN ? "Bearer token 鉴权" : "未设 token，仅回环可达"}）`);
}

function startAdmin() {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.use((req, res, next) => {
    if (!ADMIN_TOKEN) return next();
    const hdr = String(req.headers.authorization || "");
    const bearer = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
    const token = bearer || String(req.headers["x-admin-token"] || "");
    if (token && timingSafeEqual(token, ADMIN_TOKEN)) return next();
    res.status(401).json({ ok: false, message: "管理 token 缺失或错误（Authorization: Bearer <AGENTHUB_ADMIN_TOKEN>）" });
  });

  // 存活：进程活着就 200。容器 HEALTHCHECK 挂这里——账号池是否为空是业务状态，不是健康状态
  app.get("/api/livez", (req, res) => res.json({ ok: true }));

  // 就绪：至少一个已启用渠道有在线账号。供负载均衡/告警用，空池返回 503 属预期
  app.get("/api/readyz", (req, res) => {
    let ready = false;
    try {
      ready = store.CHANNELS.some((c) => adapters.channelOn(c.id) && pool.poolSummary(c.id).onlineCount > 0);
    } catch { /* 库异常按未就绪 */ }
    res.status(ready ? 200 : 503).json({ ok: ready });
  });

  app.get("/api/status", (req, res) => {
    res.json({
      ok: true,
      gateway: server.status(),
      platform: platform.form(),
      version: platform.version(),
      dataDir: process.env.AGENTHUB_DATA_DIR,
      encryption: process.env.AGENTHUB_SECRET_KEY ? "aes-256-gcm" : "plaintext",
      adminAuth: ADMIN_TOKEN ? "token" : "loopback-only",
    });
  });

  // ===== Key 管理（发给下游客户端；与 AGENTHUB_ADMIN_TOKEN 是两套独立凭据）=====
  app.get("/api/keys", (req, res) => {
    try {
      res.json({ ok: true, keys: store.listKeys().map((k) => Object.assign({}, k, { secret: undefined })) });
    } catch (e) {
      res.status(500).json({ ok: false, message: String((e && e.message) || e) });
    }
  });

  app.post("/api/keys", (req, res) => {
    try {
      const { name, route, routeOrder, dailyQuota, rateLimit } = req.body || {};
      const r = store.createKey({ name, route, routeOrder, dailyQuota, rateLimit });
      res.status(201).json({ ok: true, id: r.id, secret: r.secret });
    } catch (e) {
      res.status(400).json({ ok: false, message: String((e && e.message) || e) });
    }
  });

  // ===== 号池 =====
  app.get("/api/accounts", (req, res) => {
    try {
      res.json({ ok: true, accounts: store.listAccounts() });
    } catch (e) {
      res.status(500).json({ ok: false, message: String((e && e.message) || e) });
    }
  });

  // JSON 导入（桌面导出的号池快照 / 手工粘贴凭据）：body 为候选数组或 { channel, accounts:[...] }
  app.post("/api/accounts/import", (req, res) => {
    try {
      const body = req.body || {};
      const list = Array.isArray(body) ? body : Array.isArray(body.accounts) ? body.accounts : [body.candidate || body];
      const channel = Array.isArray(body) ? "" : String(body.channel || "");
      const results = list.map((c) => {
        try {
          const r = discovery.importCandidate(c, channel || undefined);
          return { ok: true, id: r.id, updated: !!r.updated };
        } catch (e) {
          return { ok: false, message: String((e && e.message) || e) };
        }
      });
      const okCount = results.filter((r) => r.ok).length;
      res.status(okCount ? 200 : 400).json({ ok: okCount > 0, imported: okCount, total: list.length, results });
    } catch (e) {
      res.status(500).json({ ok: false, message: String((e && e.message) || e) });
    }
  });

  app.get("/api/channels", (req, res) => {
    try {
      const channels = store.CHANNELS.map((c) => ({
        id: c.id,
        display: c.display,
        domain: c.domain || "",
        costTier: c.costTier || "",
        enabled: adapters.channelOn(c.id),
        pool: pool.poolSummary(c.id),
      }));
      res.json({ ok: true, channels });
    } catch (e) {
      res.status(500).json({ ok: false, message: String((e && e.message) || e) });
    }
  });

  app.get("/api/models", (req, res) => {
    try {
      res.json({ ok: true, models: adapters.listableModels(config.loadConfig().proxy) });
    } catch (e) {
      res.status(500).json({ ok: false, message: String((e && e.message) || e) });
    }
  });

  // ===== 配置（webdav 段是 Docker 拿账号的关键：号池同步靠它）=====
  app.get("/api/config", (req, res) => {
    try {
      res.json({ ok: true, config: JSON.parse(JSON.stringify(config.loadConfig().proxy)) });
    } catch (e) {
      res.status(500).json({ ok: false, message: String((e && e.message) || e) });
    }
  });

  app.get("/api/config/webdav", (req, res) => {
    try {
      res.json({ ok: true, webdav: config.maskedSharedWebdav() });
    } catch (e) {
      res.status(500).json({ ok: false, message: String((e && e.message) || e) });
    }
  });

  // 写统一 WebDAV/S3 配置：与桌面版设置页同一条落盘路径（掩码密码 = 保留原值）
  app.put("/api/config/webdav", (req, res) => {
    try {
      const r = config.saveSharedWebdav(req.body || {});
      res.status(r.ok ? 200 : 400).json(r.ok ? { ok: true, webdav: config.maskedSharedWebdav() } : r);
    } catch (e) {
      res.status(500).json({ ok: false, message: String((e && e.message) || e) });
    }
  });

  const srv = app.listen(ADMIN_PORT, ADMIN_BIND);
  // 监听失败必须显式收口：否则 unhandled 'error' 事件直接崩掉整个进程（含在跑的反代网关）
  srv.on("error", (e) => {
    console.error(`[AgentHub Gateway] 管理 API 监听 ${ADMIN_BIND}:${ADMIN_PORT} 失败:`, e.message);
    process.exit(1);
  });
  return srv;
}

// ===== 停机（docker stop / compose down 的 SIGTERM）=====
let stopping = false;
async function shutdown(signal) {
  if (stopping) return; // 幂等闸：重复信号不重入（最终由 docker 的 kill 超时兜底）
  stopping = true;
  console.log(`[AgentHub Gateway] 收到 ${signal}，开始停机…`);
  try { if (adminServer) adminServer.close(); } catch { /* 已关 */ }
  try { proxyIndex.stopTimers(); } catch { /* 未装配 */ }
  try { await poolsync.cancel(); } catch { /* 在途同步收尾 */ }
  const drained = await server.drainAndStop({ timeoutMs: 15000 });
  console.log(`[AgentHub Gateway] 反代网关已停（在途 ${drained.active}，${drained.drained ? "已排空" : "超时强断"}）`);
  try { store.close(); } catch { /* 句柄随进程退出 */ }
  process.exit(0);
}
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });

main().catch((e) => {
  console.error("[AgentHub Gateway] 启动失败:", (e && e.stack) || e);
  process.exit(1);
});
