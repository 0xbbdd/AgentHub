// AgentHub 反代网关 · Docker headless 形态入口
// 与桌面版共享同一份 proxy/*.cjs 核心代码，通过平台适配层抹平环境差异。
"use strict";

const path = require("node:path");
const fs = require("node:fs");

// 项目根目录（gateway/src 的上两级）
const PROJECT_ROOT = path.join(__dirname, "..", "..");
const PROXY_DIR = path.join(PROJECT_ROOT, "electron", "backend", "proxy");
const BACKEND_DIR = path.join(PROJECT_ROOT, "electron", "backend");

// 确保 proxy 模块能被找到
process.env.NODE_PATH = [PROXY_DIR, BACKEND_DIR, path.join(PROJECT_ROOT, "node_modules")].join(path.delimiter);
require("module").Module._initPaths();

const express = require("express");

// 设置数据目录（必须在 require config 之前）
process.env.AGENTHUB_DATA_DIR = process.env.AGENTHUB_DATA_DIR || path.join(process.cwd(), "data");
fs.mkdirSync(process.env.AGENTHUB_DATA_DIR, { recursive: true });

// 初始化平台适配层（Node 形态）
const platform = require(path.join(PROXY_DIR, "platform", "index.cjs"));

// 加载共享核心模块
const config = require(path.join(BACKEND_DIR, "config.cjs"));
const store = require(path.join(PROXY_DIR, "store.cjs"));
const server = require(path.join(PROXY_DIR, "server.cjs"));
const pool = require(path.join(PROXY_DIR, "pool.cjs"));
const credits = require(path.join(PROXY_DIR, "credits.cjs"));
const poolsched = require(path.join(PROXY_DIR, "poolsched.cjs"));
const rules = require(path.join(PROXY_DIR, "rules.cjs"));
const adapters = require(path.join(PROXY_DIR, "adapters.cjs"));

// 环境变量
const PORT = Number(process.env.AGENTHUB_PROXY_PORT) || 9527;
const BIND = process.env.AGENTHUB_HOST || "0.0.0.0";
const ADMIN_PORT = Number(process.env.AGENTHUB_ADMIN_PORT) || 9528;

// 启动状态
let gatewayRunning = false;
let checkinTimer = null;

async function main() {
  console.log("[AgentHub Gateway] 启动中...");
  console.log(`[AgentHub Gateway] 数据目录: ${process.env.AGENTHUB_DATA_DIR}`);
  console.log(`[AgentHub Gateway] 平台形态: ${platform.isElectron ? "Electron" : "Node (Docker)"}`);

  // 初始化配置
  const cfg = config.loadConfig();
  cfg.proxy.port = PORT;
  cfg.proxy.bind = BIND;
  cfg.proxy.restoreOnLaunch = true; // Docker 版启动即开网关
  config.saveConfig(cfg);

  // 初始化规则与数据库
  rules.init();
  store.open();
  console.log("[AgentHub Gateway] 数据库已就绪");

  // 启动额度刷新调度
  credits.startScheduler(() => config.loadConfig().proxy.creditsRefreshMin);
  console.log("[AgentHub Gateway] 额度刷新调度已启动");

  // 启动定时签到（简化版：Docker 无 jitter）
  const CHECKIN_TICK_MS = 60000;
  const checkinAutoTick = () => {
    try {
      const rules = config.loadConfig().proxy.checkinAutoRules || {};
      const now = new Date();
      for (const [channel, rule] of Object.entries(rules)) {
        if (!rule || !rule.enabled) continue;
        const [h, m] = String(rule.time || "09:00").split(":").map(Number);
        if (now.getHours() === h && now.getMinutes() === m) {
          console.log(`[AgentHub Gateway] 定时签到触发: ${channel}`);
        }
      }
    } catch { /* 下轮再试 */ }
  };
  checkinTimer = setInterval(checkinAutoTick, CHECKIN_TICK_MS);
  console.log("[AgentHub Gateway] 定时签到调度已启动");

  // 启动号池定时同步
  poolsched.start();
  console.log("[AgentHub Gateway] 号池同步调度已启动");

  // 启动反代 HTTP 服务
  const proxyResult = await server.start(() => config.loadConfig().proxy);
  if (!proxyResult.ok) {
    console.error("[AgentHub Gateway] 网关启动失败:", proxyResult.message);
    process.exit(1);
  }
  gatewayRunning = true;
  console.log(`✅ [AgentHub Gateway] 反代网关已启动: http://${BIND}:${PORT}/v1`);
  console.log(`   - POST /v1/chat/completions  (OpenAI)`);
  console.log(`   - POST /v1/messages          (Anthropic)`);
  console.log(`   - POST /v1/responses         (Responses)`);
  console.log(`   - GET  /v1/models            (模型目录)`);
  console.log(`   - GET  /healthz              (健康检查)`);

  // ===== 管理 API（独立端口） =====
  const adminApp = express();
  adminApp.use(express.json());

  // 状态
  adminApp.get("/api/status", (req, res) => {
    res.json({
      ok: true,
      gateway: { running: gatewayRunning, port: PORT, bind: BIND },
      platform: "node",
      version: require(path.join(PROJECT_ROOT, "package.json")).version,
      dataDir: process.env.AGENTHUB_DATA_DIR,
    });
  });

  // 健康检查
  adminApp.get("/api/health", (req, res) => {
    const healthy = store.CHANNELS.some(c => {
      try {
        return adapters.channelOn(c.id) && pool.poolSummary(c.id).onlineCount > 0;
      } catch { return false; }
    });
    res.status(healthy ? 200 : 503).json({ ok: healthy });
  });

  // API Key 管理
  adminApp.get("/api/keys", (req, res) => {
    try {
      const keys = store.listKeys().map(k => ({ ...k, secret: undefined }));
      res.json({ ok: true, keys });
    } catch (e) {
      res.status(500).json({ ok: false, message: String(e.message || e) });
    }
  });

  adminApp.post("/api/keys", (req, res) => {
    try {
      const { name, route, routeOrder, dailyQuota, rateLimit } = req.body || {};
      const r = store.createKey({ name, route, routeOrder, dailyQuota, rateLimit });
      res.json({ ok: true, id: r.id, secret: r.secret });
    } catch (e) {
      res.status(500).json({ ok: false, message: String(e.message || e) });
    }
  });

  // 账号管理
  adminApp.get("/api/accounts", (req, res) => {
    try {
      const accounts = store.listAccounts();
      res.json({ ok: true, accounts });
    } catch (e) {
      res.status(500).json({ ok: false, message: String(e.message || e) });
    }
  });

  // 渠道列表
  adminApp.get("/api/channels", (req, res) => {
    try {
      const channels = store.CHANNELS.map(c => ({
        id: c.id,
        display: c.display,
        domain: c.domain,
        costTier: c.costTier || "",
        enabled: adapters.channelOn(c.id),
        pool: pool.poolSummary(c.id),
      }));
      res.json({ ok: true, channels });
    } catch (e) {
      res.status(500).json({ ok: false, message: String(e.message || e) });
    }
  });

  // 模型目录
  adminApp.get("/api/models", (req, res) => {
    try {
      const models = adapters.listableModels(config.loadConfig().proxy);
      res.json({ ok: true, models });
    } catch (e) {
      res.status(500).json({ ok: false, message: String(e.message || e) });
    }
  });

  // 配置查询
  adminApp.get("/api/config", (req, res) => {
    try {
      const cfg = config.loadConfig();
      // 脱敏：不回传密码
      const masked = JSON.parse(JSON.stringify(cfg));
      if (masked.webdavShared) {
        masked.webdavShared.password = masked.webdavShared.password ? "••••••••" : "";
        masked.webdavShared.encryptionPassphrase = masked.webdavShared.encryptionPassphrase ? "••••••••" : "";
      }
      res.json({ ok: true, config: masked.proxy });
    } catch (e) {
      res.status(500).json({ ok: false, message: String(e.message || e) });
    }
  });

  adminApp.listen(ADMIN_PORT, BIND, () => {
    console.log(`✅ [AgentHub Gateway] 管理 API 已启动: http://${BIND}:${ADMIN_PORT}/api`);
  });

  // 优雅停机
  const shutdown = () => {
    console.log("[AgentHub Gateway] 正在停机...");
    gatewayRunning = false;
    if (checkinTimer) clearInterval(checkinTimer);
    credits.stopScheduler();
    poolsched.stop();
    server.stop();
    try { store.close(); } catch { /* 忽略 */ }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch(e => {
  console.error("[AgentHub Gateway] 启动失败:", e);
  process.exit(1);
});
