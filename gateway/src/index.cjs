// AgentHub 反代网关 · Docker headless 形态入口
//
// 装配复用 proxy/index.cjs 的 boot()（规则/数据库/额度刷新/真实签到 tick/号池同步/
// deviceMid 自愈/锚点兜底），桌面版日后新增装配项这里自动继承；本入口只处理形态差异：
// 进程内覆盖监听参数（不回写 config）、管理 REST API、停机序列。
//
// 数据目录与桌面版相互独立：桌面凭据是 safeStorage 密文、容器解不开，两种形态之间
// 传号只走号池同步（poolsync 的口令信封通道）。
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROJECT_ROOT = path.join(__dirname, "..", "..");
const PROXY_DIR = path.join(PROJECT_ROOT, "electron", "backend", "proxy");
const BACKEND_DIR = path.join(PROJECT_ROOT, "electron", "backend");

// 数据目录先行：config.cjs 的 dataDir() 以 AGENTHUB_DATA_DIR 优先
process.env.AGENTHUB_DATA_DIR = process.env.AGENTHUB_DATA_DIR || path.join(process.cwd(), "data");

// 容器里没有 safeStorage，凭据加密唯一来源是 AGENTHUB_SECRET_KEY；未设置又未显式放行时
// 拒绝启动，比"静默明文落库"更早暴露问题（逃生门只给本地调试）
if (!process.env.AGENTHUB_SECRET_KEY && process.env.AGENTHUB_ALLOW_PLAINTEXT !== "1") {
  console.error("[AgentHub Gateway] 拒绝启动：未设置 AGENTHUB_SECRET_KEY，凭据无法加密落盘。");
  console.error("  生产部署：AGENTHUB_SECRET_KEY=$(openssl rand -base64 32)");
  console.error("  仅本地调试需要明文：设 AGENTHUB_ALLOW_PLAINTEXT=1");
  process.exit(1);
}

const express = require("express");
const config = require(path.join(BACKEND_DIR, "config.cjs"));
const { collectCommands, modeOf, DENY } = require("./commands.cjs");
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
// 管理面默认不进网络：未设 token 时只绑回环（反代 Key 与管理 token 是两套凭据）
const ADMIN_BIND = process.env.AGENTHUB_ADMIN_HOST || (ADMIN_TOKEN ? "0.0.0.0" : "127.0.0.1");
// 免凭据路径：探针（Dockerfile 的 HEALTHCHECK 与编排器 probe 都不带 token）与能力清单
// （Web 端登录页要据此判断"这是网关托管的 Web UI 还是纯前端预览"，必须无凭据可读）
const PUBLIC_PATHS = new Set(["/api/livez", "/api/readyz", "/api/capabilities"]);
const BODY_LIMIT = "4mb";
const DRAIN_TIMEOUT_MS = 15000;

let adminServer = null;
let lockFile = null;
let commandTable = null; // boot() 之后由 collectCommands() 填充（register 首行副作用需要配置已可读）

/** 进程内覆盖监听参数，不回写 config.json——与桌面版共享宿主配置或卷时绝不篡改对方的 bind */
function gatewaySettings() {
  return Object.assign({}, config.loadConfig().proxy, { port: PORT, bind: BIND });
}

/** 管理 token 校验：双方先 SHA-256 成等长再恒定时间比较（token 长度不进时序） */
function adminTokenOk(token) {
  const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();
  return crypto.timingSafeEqual(digest(token), digest(ADMIN_TOKEN));
}

/** 单实例锁：同一数据目录只允许一个网关进程（本机直跑与容器、或两个容器共卷双写会把
 *  冷却表/签到/号池同步互相踩烂）。同 host 且 pid 存活 → 拒绝；异 host 无法探活，接管并
 *  继续——跨机共用数据卷属误配置，部署文档明确不支持 */
function acquireLock() {
  const file = path.join(process.env.AGENTHUB_DATA_DIR, "gateway.lock");
  try {
    if (fs.existsSync(file)) {
      const [host, pidStr] = String(fs.readFileSync(file, "utf8")).trim().split(":");
      const pid = Number(pidStr);
      if (host === os.hostname() && Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        let alive = false;
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (e) {
          alive = e.code !== "ESRCH"; // 除"不存在"外一律按存活保守处理：误接管=双写，代价最大
        }
        if (alive) {
          console.error(`[AgentHub Gateway] 拒绝启动：数据目录已被本机 pid ${pid} 占用（${file}）`);
          process.exit(1);
        }
      }
    }
    fs.writeFileSync(file, `${os.hostname()}:${process.pid}`);
    return file;
  } catch (e) {
    platform.log("warn", "[gateway] 锁文件不可用，跳过单实例检查", { message: String((e && e.message) || e) });
    return null;
  }
}

async function main() {
  lockFile = acquireLock();
  console.log(`[AgentHub Gateway] 启动中 platform=${platform.form()} version=${platform.version()}`);
  console.log(`[AgentHub Gateway] 数据目录 ${process.env.AGENTHUB_DATA_DIR}`);
  console.log(`[AgentHub Gateway] 凭据加密 ${process.env.AGENTHUB_SECRET_KEY ? "AES-256-GCM (AGENTHUB_SECRET_KEY)" : "无（AGENTHUB_ALLOW_PLAINTEXT=1 已放行明文）"}`);

  // 首启修正自己的 config：server 由本入口显式启动（restoreOnLaunch 保持 false，避免
  // boot() 拿磁盘旧端口抢先监听）；qoder 双区需要本机客户端 wasm 签名，容器里必然失败
  const cfg = config.loadConfig();
  if (cfg.proxy.restoreOnLaunch || cfg.proxy.channelEnabled.qoder !== false || cfg.proxy.channelEnabled.qoder_intl !== false) {
    cfg.proxy.restoreOnLaunch = false;
    cfg.proxy.channelEnabled = Object.assign({}, cfg.proxy.channelEnabled, { qoder: false, qoder_intl: false });
    config.saveConfig(cfg);
  }

  await proxyIndex.boot();
  commandTable = collectCommands();

  const started = await server.start(gatewaySettings);
  if (!started.ok) {
    console.error("[AgentHub Gateway] 反代网关启动失败:", started.message);
    process.exit(1);
  }
  console.log(`✅ [AgentHub Gateway] 反代网关已监听 ${BIND}:${PORT}/v1（chat/completions · messages · responses · models）`);

  adminServer = startAdmin();
  console.log(`✅ [AgentHub Gateway] 管理 API 已监听 ${ADMIN_BIND}:${ADMIN_PORT}（${ADMIN_TOKEN ? "Bearer token 鉴权" : "未设 token，仅回环可达"}）`);
}

// ===== 管理 API =====

/** 路由包装：异常收敛为 JSON 错误（与桌面 IPC 层的 handle() 同款形状）。
 *  同步抛错与异步拒绝都兜住——async handler 的拒绝不会被 try 捕获，漏掉会变成
 *  unhandledRejection 且客户端永远等不到响应 */
function handle(fn) {
  const fail = (res, e) => {
    if (!res.headersSent) res.status(500).json({ ok: false, message: String((e && e.message) || e) });
  };
  return (req, res) => {
    try {
      const out = fn(req, res);
      if (out && typeof out.then === "function") out.catch((e) => fail(res, e));
      return out;
    } catch (e) {
      fail(res, e);
    }
  };
}

function adminAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (!ADMIN_TOKEN) return next();
  const hdr = String(req.headers.authorization || "");
  const bearer = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  const token = bearer || String(req.headers["x-admin-token"] || "");
  if (token && adminTokenOk(token)) return next();
  res.status(401).json({ ok: false, message: "管理 token 缺失或错误（Authorization: Bearer <AGENTHUB_ADMIN_TOKEN>）" });
}

function registerProbes(app) {
  // 存活：进程活着就 200（容器 HEALTHCHECK 挂这里）；就绪：至少一个启用渠道有在线账号
  app.get("/api/livez", (req, res) => res.json({ ok: true }));
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
}

function registerKeyRoutes(app) {
  app.get("/api/keys", handle((req, res) => {
    res.json({ ok: true, keys: store.listKeys().map((k) => Object.assign({}, k, { secret: undefined })) });
  }));
  app.post("/api/keys", (req, res) => {
    try {
      const { name, route, routeOrder, dailyQuota, rateLimit } = req.body || {};
      const r = store.createKey({ name, route, routeOrder, dailyQuota, rateLimit });
      res.status(201).json({ ok: true, id: r.id, secret: r.secret });
    } catch (e) {
      res.status(400).json({ ok: false, message: String((e && e.message) || e) }); // 参数非法 = 400
    }
  });
}

function registerPoolRoutes(app) {
  app.get("/api/accounts", handle((req, res) => {
    res.json({ ok: true, accounts: store.listAccounts() });
  }));
  // JSON 导入：body 为候选数组或 { channel, accounts: [...] }
  app.post("/api/accounts/import", handle((req, res) => {
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
  }));
  app.get("/api/channels", handle((req, res) => {
    res.json({
      ok: true,
      channels: store.CHANNELS.map((c) => ({
        id: c.id,
        display: c.display,
        domain: c.domain || "",
        costTier: c.costTier || "",
        enabled: adapters.channelOn(c.id),
        pool: pool.poolSummary(c.id),
      })),
    });
  }));
  app.get("/api/models", handle((req, res) => {
    res.json({ ok: true, models: adapters.listableModels(config.loadConfig().proxy) });
  }));
}

function registerConfigRoutes(app) {
  app.get("/api/config", handle((req, res) => {
    res.json({ ok: true, config: JSON.parse(JSON.stringify(config.loadConfig().proxy)) });
  }));
  app.get("/api/config/webdav", handle((req, res) => {
    res.json({ ok: true, webdav: config.maskedSharedWebdav() });
  }));
  // 写统一 WebDAV/S3 配置：与桌面版设置页同一条落盘路径（掩码密码 = 保留原值）
  app.put("/api/config/webdav", handle((req, res) => {
    const r = config.saveSharedWebdav(req.body || {});
    res.status(r.ok ? 200 : 400).json(r.ok ? { ok: true, webdav: config.maskedSharedWebdav() } : r);
  }));
  // 备份：VACUUM INTO 一致性快照（WAL 下直接拷 stats.db 会丢最近事务）
  app.get("/api/backup", handle((req, res) => {
    const target = path.join(os.tmpdir(), `agenthub-stats-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.db`);
    try {
      store.vacuumInto(target);
      res.download(target, "stats.db", () => { try { fs.unlinkSync(target); } catch { /* 已清 */ } });
    } catch (e) {
      try { fs.unlinkSync(target); } catch { /* 不存在 */ }
      throw e; // 交给 handle 收敛为 500
    }
  }));
}

// 远程管理的统一命令通道：命令表经收集器取自桌面注册表，Web UI 与桌面远程模式共用同一契约。
// 前端拿到的信封与桌面 IPC 完全一致（{ok:true,...} / {ok:false,message}），错误处理零新增
function registerRpcRoutes(app) {
  app.get("/api/capabilities", (req, res) => {
    res.json({
      ok: true,
      platform: platform.form(),
      version: platform.version(),
      modules: ["proxy"],
      features: { serviceControl: false, sse: false, fileDialog: false },
      commands: Object.fromEntries([...commandTable.keys()].map((cmd) => [cmd, modeOf(cmd)])),
    });
  });

  app.post("/api/rpc", handle(async (req, res) => {
    const cmd = String((req.body || {}).cmd || "");
    const handler = commandTable.get(cmd);
    if (!handler) {
      res.status(404).json({ ok: false, message: `未知命令：${cmd || "(空)"}` });
      return;
    }
    if (modeOf(cmd) === "deny") {
      res.status(403).json({ ok: false, message: DENY[cmd] });
      return;
    }
    // 桌面 handler 统一形如 (event, args)，且全部不使用 event（实测 0 处），传 null 即可
    res.json(await handler(null, req.body.args || {}));
  }));
}

function startAdmin() {
  const app = express();
  app.use(express.json({ limit: BODY_LIMIT }));
  app.use(adminAuth);
  registerProbes(app);
  registerKeyRoutes(app);
  registerPoolRoutes(app);
  registerConfigRoutes(app);
  registerRpcRoutes(app);

  const srv = app.listen(ADMIN_PORT, ADMIN_BIND);
  // 监听失败必须显式收口：否则 unhandled 'error' 直接崩掉整个进程（含在跑的反代网关）
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
  const drained = await server.drainAndStop({ timeoutMs: DRAIN_TIMEOUT_MS });
  console.log(`[AgentHub Gateway] 反代网关已停（在途 ${drained.active}，${drained.drained ? "已排空" : "超时强断"}）`);
  try { store.close(); } catch { /* 句柄随进程退出 */ }
  if (lockFile) { try { fs.unlinkSync(lockFile); } catch { /* 已清 */ } }
  process.exit(0);
}
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });

main().catch((e) => {
  console.error("[AgentHub Gateway] 启动失败:", (e && e.stack) || e);
  process.exit(1);
});
