/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 计费扩展：外部价格源导入（LiteLLM / OpenRouter）+ 价格表 WebDAV 多设备同步
// 网络策略：Electron 运行时用 net.fetch 走独立 session（代理设置只影响导入请求，不污染主会话）；
// 纯 Node 测试环境退化为原生 fetch 直连（解析逻辑用本地 fixture 测，不发真网）。
"use strict";
const crypto = require("node:crypto");
const db = require("./db.cjs");
const webdav = require("./webdav.cjs");

let electron = null;
try {
  electron = require("electron");
  if (typeof electron !== "object" || !electron.net) electron = null;
} catch {
  /* 非 Electron 环境 */
}

// jsdelivr 镜像在前（国内通常可直连），GitHub raw 兜底
const LITELLM_URLS = [
  "https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json",
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
];
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 20000;
const PRICES_FILE = "usage-tracker/prices.json";

// 远程价格源默认地址（pricing.remote_url / hash_url，LiteLLM 兼容格式）
const REMOTE_PRICING_DEFAULTS = {
  url: "https://raw.githubusercontent.com/Wei-Shaw/model-price-repo/main/model_prices_and_context_window.json",
  hashUrl: "https://raw.githubusercontent.com/Wei-Shaw/model-price-repo/main/model_prices_and_context_window.sha256",
  intervalHours: 24,
};

// ===== 网络 =====

async function doFetch(url, proxy, headers) {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const init = headers && Object.keys(headers).length ? { signal, headers } : { signal };
  if (electron && electron.session && electron.net) {
    const session = electron.session.fromPartition("billing-import", { cache: false });
    await session.setProxy(proxy ? { mode: "fixed_servers", proxyRules: proxy } : { mode: "system" });
    return electron.net.fetch(url, { ...init, session });
  }
  return fetch(url, init);
}

/** 依次尝试多个地址，返回首个成功的 { url, text } */
async function fetchText(urls, proxy, headers) {
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await doFetch(url, proxy, headers);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { url, text: await res.text() };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`价格源拉取失败：${lastErr ? lastErr.message : "全部地址不可达"}`);
}

// ===== 解析（纯函数，测试可注入 fixture）=====

/** LiteLLM 价格表 JSON → Map<modelId, 价目行>（USD/百万 token；仅保留 chat/completion 类） */
function parseLiteLLM(text) {
  const data = JSON.parse(text);
  const out = new Map();
  for (const [key, m] of Object.entries(data || {})) {
    if (!m || typeof m !== "object") continue;
    if (m.mode && m.mode !== "chat" && m.mode !== "completion") continue;
    const inC = Number(m.input_cost_per_token);
    const outC = Number(m.output_cost_per_token);
    if (!isFinite(inC) || !isFinite(outC) || inC < 0 || outC < 0) continue;
    out.set(key, {
      modelId: key,
      inputPerM: inC * 1e6,
      outputPerM: outC * 1e6,
      cacheReadPerM: (Number(m.cache_read_input_token_cost) * 1e6) || 0,
      cacheWritePerM: (Number(m.cache_creation_input_token_cost) * 1e6) || 0,
      currency: "USD",
    });
  }
  return out;
}

/** OpenRouter /models JSON → Map<modelId, 价目行>（id 取 "vendor/" 后缀；免费模型单价为 0） */
function parseOpenRouter(text) {
  const data = JSON.parse(text);
  const out = new Map();
  for (const m of (data && data.data) || []) {
    if (!m || !m.id || !m.pricing) continue;
    const inC = Number(m.pricing.prompt);
    const outC = Number(m.pricing.completion);
    if (!isFinite(inC) || !isFinite(outC) || inC < 0 || outC < 0) continue;
    const modelId = m.id.includes("/") ? m.id.split("/").slice(1).join("/") : m.id;
    out.set(modelId, {
      modelId,
      inputPerM: inC * 1e6,
      outputPerM: outC * 1e6,
      cacheReadPerM: (Number(m.pricing.input_cache_read) * 1e6) || 0,
      cacheWritePerM: 0,
      currency: "USD",
    });
  }
  return out;
}

// ===== 导入预览与写入 =====

const samePrice = (a, b) =>
  ["inputPerM", "outputPerM", "cacheReadPerM", "cacheWritePerM"].every(
    (k) => Math.abs((Number(a[k]) || 0) - (Number(b[k]) || 0)) < 1e-9
  ) && a.currency === b.currency;

/**
 * 拉取价格源并与本地比对，生成导入预览：
 * - additions：本地有用量但未配置价格的模型，价格源有 → 建议新增
 * - changes：已配置模型价格与价格源不同 → 建议更新（可能含币种变化，由用户勾选决断）
 * - missing：本地未配置且价格源未收录 → 需手动填写
 * 返回 { sourceName, resolvedUrl, additions, changes, missing }
 */
async function previewImport(source, proxy) {
  let remote, fetched;
  if (source === "openrouter") {
    fetched = await fetchText([OPENROUTER_URL], proxy);
    remote = parseOpenRouter(fetched.text);
  } else {
    fetched = await fetchText(LITELLM_URLS, proxy);
    remote = parseLiteLLM(fetched.text);
  }
  const sourceName = source === "openrouter" ? "OpenRouter" : "LiteLLM";

  const current = new Map(
    db.listCurrentPrices().map((p) => [`${p.providerId || ""}|${p.modelId}`, p])
  );
  // 本地出现过的全部模型（含已配置），从用量聚合取，避免硬编码漏项
  const usedModels = new Set(db.getAggregate("full", "model", null, null, null).map((r) => r.key));

  const additions = [];
  const changes = [];
  const missing = [];
  for (const modelId of usedModels) {
    const hit = remote.get(modelId);
    const existing = current.get(`|${modelId}`);
    if (existing) {
      if (hit && !samePrice(existing, hit)) {
        changes.push({ ...hit, providerId: existing.providerId, prev: existing });
      }
      continue;
    }
    if (hit) additions.push({ ...hit, providerId: null });
    else missing.push({ modelId });
  }
  return { sourceName, resolvedUrl: fetched.url, additions, changes, missing };
}

/** 应用导入（仅写用户勾选的条目）；沿用既有行的供应商维度，避免精确价被通配导入架空 */
function applyImport(items, effectiveFrom, updatedBy) {
  let n = 0;
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || !it.modelId) continue;
    db.savePrice(
      {
        providerId: it.providerId ?? null,
        modelId: it.modelId,
        inputPerM: it.inputPerM,
        outputPerM: it.outputPerM,
        cacheReadPerM: it.cacheReadPerM,
        cacheWritePerM: it.cacheWritePerM,
        currency: it.currency,
        effectiveFrom: (effectiveFrom == null || effectiveFrom === "" || !Number.isFinite(Number(effectiveFrom)) || Number(effectiveFrom) < 1) ? Date.now() : Number(effectiveFrom),
      },
      updatedBy
    );
    n++;
  }
  return n;
}

// ===== 价格表 WebDAV 多设备同步（LWW 整文件）=====

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

/** 本地价格时钟（meta 记账，增删改都推进；下载替换时保留远端时钟防乒乓） */
function localPricesUpdatedAt() {
  return Number(db.getMeta("prices_local_updated") || 0);
}

/**
 * 与远端 prices.json 对齐：远端新 → 整表替换本地；本地新/远端缺失 → 上传；
 * 内容一致（hash 记账）→ 跳过。任何异常由调用方兜底记日志，不中断数据同步。
 */
async function syncPrices(wd, deviceName) {
  if (!wd || !wd.endpoint) return { action: "skipped", reason: "未配置 WebDAV" };
  const url = webdav.joinUrl(wd.endpoint, wd.root, PRICES_FILE);
  // 注意：远端缺失（404 → null）才允许本地上传覆盖；网络错误/5xx 必须向上抛出，
  // 由调用方记日志并跳过本轮价格同步——若把读失败当缺失处理，本地旧时钟的
  // 价格表会反向覆盖远端较新的表（LWW 失效）。
  const text = await webdav.getText(url, wd);
  let remote = null;
  if (text) {
    try {
      remote = JSON.parse(text);
      if (!remote || typeof remote !== "object") remote = null;
    } catch {
      remote = null; // 损坏文件按缺失处理，本地覆盖上传自愈
    }
  }
  const remoteUpdated = remote ? Number(remote.updatedAt) || 0 : 0;
  const localUpdated = localPricesUpdatedAt();

  // LWW 依赖各设备墙钟：远端时间戳明显领先本地时钟时提示（说明对端或本机时间不准，
  // 可能导致后改的配置因时钟偏慢而输掉 LWW），不阻断同步
  if (remote && remoteUpdated > Date.now() + 5 * 60 * 1000) {
    db.addLog("merge", "warn", "远端价格表时间戳明显领先本机时钟，请检查各设备系统时间是否准确（时间偏差会影响价格表新旧判定）");
  }

  if (remote && remoteUpdated > localUpdated) {
    const count = Array.isArray(remote.prices) ? remote.prices.length : 0;
    db.replacePrices(remote.prices, remoteUpdated, remote.aliases);
    return { action: "downloaded", count, remoteBy: remote.updatedBy || "其他设备" };
  }
  if (!remote || localUpdated > remoteUpdated) {
    const payload = JSON.stringify({
      v: 1,
      updatedAt: localUpdated || Date.now(),
      updatedBy: deviceName || "",
      prices: db.listAllPrices(),
      aliases: db.listAliases(),
    });
    const hashKey = `prices_uploaded:${wd.endpoint}${wd.root || ""}`;
    if (db.getMeta(hashKey) !== sha1(payload)) {
      await webdav.put(url, wd, payload);
      db.setMeta(hashKey, sha1(payload));
      return { action: remote ? "uploaded" : "created" };
    }
    return { action: "unchanged" };
  }
  return { action: "unchanged" };
}

// ===== 远程价格源自动拉取（来源 remote，PricingService）=====

/** 上次拉取状态（meta 记账） */
function getRemotePricingStatus() {
  return {
    lastAt: Number(db.getMeta("remote_pricing_at") || 0) || null,
    lastHash: db.getMeta("remote_pricing_hash") || null,
    lastModels: Number(db.getMeta("remote_pricing_models") || 0) || null,
  };
}

/**
 * 从远程价格源拉取并应用（来源 remote）：
 * 哈希比对短路由（远程没变就拉个哈希文件，省流量）→ 全量下载解析 →
 * 只对「本地真实出现过用量」的模型入库（交集）→ 同价跳过 / 异价关旧段开新段。
 * 任何失败向上抛出，由调用方记日志兜底（不影响数据同步）。
 */
async function pullRemotePricing(opts = {}) {
  const url = String(opts.url || REMOTE_PRICING_DEFAULTS.url).trim();
  const hashUrl = String(opts.hashUrl || "").trim();
  if (!url) return { action: "skipped", reason: "未配置拉取网址" };

  // 1. 哈希短路（force 时跳过，用于手动「立即拉取」）
  let remoteHash = null;
  if (hashUrl && !opts.force) {
    try {
      remoteHash = (await fetchText([hashUrl], opts.proxy)).text.trim();
      if (remoteHash && remoteHash === db.getMeta("remote_pricing_hash")) {
        return { action: "unchanged", hash: remoteHash };
      }
    } catch {
      remoteHash = null; // 哈希拉取失败不阻断，直接尝试数据文件
    }
  }

  // 2. 全量拉取 + 解析（LiteLLM 格式，USD/token）
  const { text } = await fetchText([url], opts.proxy);
  const parsed = parseLiteLLM(text);

  // 3. 只取本地真实出现过用量的模型（交集），避免把数千个无关模型写进价格表
  const usedModels = db.getAggregate("full", "model", null, null, null).map((r) => r.key);
  const candidates = [];
  for (const modelId of usedModels) {
    const hit = parsed.get(modelId);
    if (hit) candidates.push({ ...hit, providerId: null });
  }

  // 4. 应用（remote 来源，同价跳过 / 异价关旧段开新段）
  const applied = db.applyRemotePricing(candidates);

  // 5. 记账（哈希作为同步锚点；远程无哈希文件时退化为数据自身哈希）
  const syncHash = remoteHash || crypto.createHash("sha256").update(text).digest("hex");
  db.setMeta("remote_pricing_hash", syncHash);
  db.setMeta("remote_pricing_at", String(Date.now()));
  db.setMeta("remote_pricing_models", String(candidates.length));
  return { action: "updated", total: parsed.size, ...applied, models: candidates.length, hash: syncHash };
}

// ===== New API 站点价格源（来源 newapi：手动 > New API > 远程 > 内置）=====
// 口径来源：new-api 的 GET /api/pricing（controller/pricing.go），返回的是「倍率」不是金额。
// 换算依据 new-api 前端 web/src/features/pricing/lib/price.ts 的 calculateTokenPrice 与
// common/constants.go 的 QuotaPerUnit=500000：base = model_ratio × 2 × 分组倍率（USD/1M）。
// 该值就是「本人在该中转站实际付费」的单价，因此优先级高于公共价格表（LiteLLM/OpenRouter）。

const NEWAPI_DEFAULT_GROUP = "default";
// GetModelRatio 未命中时的兜底倍率 37.5（= $75/M）：是「没配倍率」的信号，不是真实价格
const NEWAPI_UNCONFIGURED_RATIO = 37.5;
const NEWAPI_DEFAULT_CACHE_RATIO = 1.0; // new-api DefaultCacheRatio（服务端计费口径）
const NEWAPI_DEFAULT_CREATE_CACHE_RATIO = 1.25; // new-api DefaultCreateCacheRatio
const NEWAPI_MAX_PRICE_PER_M = 2000; // USD/1M 上限，超过按异常值处理
const NEWAPI_RETRY_AFTER_FAIL_MS = 60 * 60 * 1000; // 失败后的冷却，避免每轮同步刷日志

const hasNum = (v) => v !== undefined && v !== null && isFinite(Number(v));

/**
 * 模型名归一化（兜底匹配用）：小写 → 去供应商前缀 → 去变体后缀 → 去日期/版本后缀。
 * 只收敛「明显同义」的写法，不做模糊相似度：宁可匹配不上留给用户归并，
 * 也不能把 gpt-4o-mini 算成 gpt-4o 的价。所以只剥纯数字/日期这类版本尾巴。
 */
function normalizeModelName(name) {
  let s = String(name || "").trim().toLowerCase();
  if (!s) return "";
  const slash = s.lastIndexOf("/");
  if (slash > 0 && slash < s.length - 1) s = s.slice(slash + 1);
  s = s.replace(/:(?:free|beta|extended|thinking|online)$/, "");
  s = s.replace(/[-@](?:\d{4}-?\d{2}-?\d{2}|v\d+(?:\.\d+)*|latest)$/, "");
  return s;
}

/**
 * New API 定价响应 → USD/1M 价目表（纯函数，测试可注入 fixture）。
 * 返回 { prices:Map<modelId,价目>, skipped:{request,tiered,invalid,suspect}, group, groupRatio, ... }
 * 三类跳过（不写库、留给下层来源兜底）：
 *   request  按次计费（quota_type=1），token 计费无法表达
 *   tiered   阶梯表达式计费（billing_mode=tiered_expr），金额与倍率无关
 *   suspect  倍率未配置（37.5 兜底）或单价离谱，写进去会严重高估费用
 */
function parseNewApi(text, opts = {}) {
  const payload = JSON.parse(text);
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.data)) {
    throw new Error("返回内容不是 New API 定价数据（缺少 data 数组）");
  }
  const ratioMap = payload.group_ratio && typeof payload.group_ratio === "object" ? payload.group_ratio : {};
  const usable = payload.usable_group && typeof payload.usable_group === "object" ? payload.usable_group : {};
  const wanted = String(opts.group || "").trim();
  let group = wanted;
  let groupRatio = 1;
  if (wanted && hasNum(ratioMap[wanted])) {
    groupRatio = Number(ratioMap[wanted]);
  } else if (!wanted) {
    // 未指定分组：取 default 组（new-api 的默认分组），站点没有该组时按 1 倍处理
    group = NEWAPI_DEFAULT_GROUP;
    if (hasNum(ratioMap[NEWAPI_DEFAULT_GROUP])) groupRatio = Number(ratioMap[NEWAPI_DEFAULT_GROUP]);
  }

  const prices = new Map();
  const skipped = { request: [], tiered: [], invalid: [], suspect: [] };
  for (const m of payload.data) {
    if (!m || typeof m !== "object") continue;
    const modelId = typeof m.model_name === "string" ? m.model_name.trim() : "";
    if (!modelId) continue;
    if (Number(m.quota_type) === 1) { skipped.request.push(modelId); continue; }
    if (m.billing_mode === "tiered_expr") { skipped.tiered.push(modelId); continue; }
    if (!hasNum(m.model_ratio) || Number(m.model_ratio) <= 0) { skipped.invalid.push(modelId); continue; }

    const base = Number(m.model_ratio) * 2 * groupRatio;
    const completion = hasNum(m.completion_ratio) && Number(m.completion_ratio) > 0 ? Number(m.completion_ratio) : 1;
    const cacheRead = hasNum(m.cache_ratio) ? Number(m.cache_ratio) : NEWAPI_DEFAULT_CACHE_RATIO;
    const cacheWrite = hasNum(m.create_cache_ratio) ? Number(m.create_cache_ratio) : NEWAPI_DEFAULT_CREATE_CACHE_RATIO;

    const reason = Number(m.model_ratio) === NEWAPI_UNCONFIGURED_RATIO
      ? "倍率未配置（站点兜底 37.5）"
      : base > NEWAPI_MAX_PRICE_PER_M ? `单价异常（$${base.toFixed(2)}/M）` : "";
    if (reason) { skipped.suspect.push({ modelId, reason, inputPerM: base }); continue; }

    prices.set(modelId, {
      modelId,
      inputPerM: base,
      outputPerM: base * completion,
      cacheReadPerM: base * cacheRead,
      cacheWritePerM: base * cacheWrite,
      currency: "USD",
    });
  }
  return {
    prices, skipped, group, groupRatio,
    groups: Object.keys(ratioMap),
    usableGroups: usable,
    total: payload.data.length,
  };
}

/** 建三级索引：原名 / 小写 / 归一化 */
function buildPriceIndex(prices) {
  const exact = new Map();
  const lower = new Map();
  const normalized = new Map();
  for (const [name, row] of prices) {
    exact.set(name, row);
    const lo = name.toLowerCase();
    if (!lower.has(lo)) lower.set(lo, row);
  }
  // 归一化索引分两遍：先占位，再让「本身没有后缀」的名字覆盖——
  // 同时存在 gpt-4o 与 gpt-4o-2024-08-06 时，前者才是通用价
  for (const [name, row] of prices) {
    const nk = normalizeModelName(name);
    if (nk && !normalized.has(nk)) normalized.set(nk, row);
  }
  for (const [name, row] of prices) {
    const nk = normalizeModelName(name);
    if (nk && nk === name.toLowerCase()) normalized.set(nk, row);
  }
  return { exact, lower, normalized };
}

/** 逐级匹配：原名 → 小写 → 归一化。返回 { row, via } 或 null */
function matchModel(index, modelId) {
  const raw = String(modelId || "");
  if (!raw) return null;
  if (index.exact.has(raw)) return { row: index.exact.get(raw), via: "exact" };
  const lo = raw.toLowerCase();
  if (index.lower.has(lo)) return { row: index.lower.get(lo), via: "case" };
  const nk = normalizeModelName(raw);
  if (nk && index.normalized.has(nk)) return { row: index.normalized.get(nk), via: "normalized" };
  return null;
}

/** 站点地址 → /api/pricing（容忍用户把 /api 或 /api/pricing 一起粘进来） */
function newApiPricingUrl(baseUrl) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  if (/\/api\/pricing$/i.test(base)) return base;
  if (/\/api$/i.test(base)) return `${base}/pricing`;
  return `${base}/api/pricing`;
}

/** 把 HTTP 状态翻译成「用户能照着修」的提示，而不是干巴巴的 HTTP 403 */
function explainNewApiError(status, body) {
  const text = String(body || "");
  if (status === 401) return "访问令牌无效或已过期：请在 New API「个人设置 → 生成系统访问令牌」后重新填写";
  if (status === 403) {
    if (/disabled/i.test(text)) return "该站点未开启「价格」页面：请在 New API 后台「设置 → 功能 → 侧边栏模块」中启用 pricing";
    return "站点拒绝了匿名访问：请填写 New API 的系统访问令牌（不是 sk- 开头的渠道密钥）";
  }
  if (status === 404) return "接口不存在：请填写站点根地址（如 https://api.example.com），不要带 /v1 或 /api";
  if (status >= 500) return `站点服务异常（HTTP ${status}），稍后会自动重试`;
  return `HTTP ${status}`;
}

async function fetchNewApiText(baseUrl, proxy, token) {
  const url = newApiPricingUrl(baseUrl);
  if (!url) throw new Error("未配置 New API 站点地址");
  const headers = token ? { Authorization: `Bearer ${String(token).trim()}` } : undefined;
  const res = await doFetch(url, proxy, headers);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(explainNewApiError(res.status, body));
  }
  const text = await res.text();
  // 登录页/前端路由兜底页会以 200 返回 HTML：提前拦住，否则 JSON.parse 报「Unexpected token <」
  if (text.trimStart().slice(0, 1) !== "{") {
    throw new Error("返回的是网页而不是数据：站点可能要求登录，请填写系统访问令牌");
  }
  return { text, url };
}

/** 上次拉取状态（meta 记账） */
function getNewApiStatus() {
  return {
    lastAt: Number(db.getMeta("newapi_pricing_at") || 0) || null,
    lastHash: db.getMeta("newapi_pricing_hash") || null,
    lastModels: Number(db.getMeta("newapi_pricing_models") || 0) || null,
    lastTotal: Number(db.getMeta("newapi_pricing_total") || 0) || null,
    lastGroup: db.getMeta("newapi_pricing_group") || null,
    lastGroupRatio: db.getMeta("newapi_pricing_group_ratio") || null,
    lastError: db.getMeta("newapi_pricing_error") || null,
    lastErrorAt: Number(db.getMeta("newapi_pricing_error_at") || 0) || null,
  };
}

/** 失败冷却中？（自动触发用；手动「立即拉取」不看冷却） */
function newApiInCooldown() {
  const at = Number(db.getMeta("newapi_pricing_error_at") || 0);
  return at > 0 && Date.now() - at < NEWAPI_RETRY_AFTER_FAIL_MS;
}

/**
 * 拉取差异预览（只读，不写库）：把站点价与「本地真实用量模型」逐个比对。
 * additions 当前无价 / changes 有价但不同（带被覆盖来源）/ unchanged 同价 /
 * unmatched 站点没有 / fuzzy 靠归一化匹配上（提示核对）。
 */
async function previewNewApi(opts = {}) {
  const { text, url } = await fetchNewApiText(opts.baseUrl, opts.proxy, opts.token);
  const parsed = parseNewApi(text, { group: opts.group });
  const index = buildPriceIndex(parsed.prices);
  const current = new Map(db.listCurrentPrices().map((p) => [p.modelId, p]));
  const usedModels = db.getAggregate("full", "model", null, null, null).map((r) => r.key);

  const additions = [];
  const changes = [];
  const unchanged = [];
  const unmatched = [];
  const fuzzy = [];
  for (const modelId of usedModels) {
    const hit = matchModel(index, modelId);
    if (!hit) { unmatched.push({ modelId }); continue; }
    const row = { ...hit.row, modelId };
    if (hit.via === "normalized") fuzzy.push({ modelId, matchedFrom: hit.row.modelId });
    const cur = current.get(modelId);
    if (!cur) { additions.push(row); continue; }
    if (samePrice(cur, row)) { unchanged.push({ modelId }); continue; }
    // 当前生效行是手动价时，写入 New API 段也不会生效（手动 > New API）——
    // 必须标出来并默认不勾，否则用户会以为「点了应用却没变化」是 bug
    changes.push({ ...row, prev: cur, overriddenSource: cur.source, willApply: cur.source !== "manual" });
  }
  return {
    url,
    group: parsed.group,
    groupRatio: parsed.groupRatio,
    groups: parsed.groups,
    usableGroups: parsed.usableGroups,
    total: parsed.total,
    pricedCount: parsed.prices.size,
    additions, changes, unchanged, unmatched, fuzzy,
    skipped: parsed.skipped,
  };
}

/**
 * 拉取并应用（来源 newapi）。只对「本地真实出现过用量」的模型入库，
 * 与远程价格表各写各的价格段，谁生效由视图优先级决定。
 * 全部失败向上抛出，由调用方记日志兜底（不影响数据同步）。
 */
async function pullNewApiPricing(opts = {}) {
  const baseUrl = String(opts.baseUrl || "").trim();
  if (!baseUrl) return { action: "skipped", reason: "未配置 New API 站点地址" };
  const force = !!opts.force;
  // 段丢失自愈：本地一个 newapi 段都没有（首次拉取 / 被旧版客户端整表覆盖）时跳过哈希短路
  const hasSegments = db.countSourcePrices("newapi") > 0;

  const { text } = await fetchNewApiText(baseUrl, opts.proxy, opts.token);
  const parsed = parseNewApi(text, { group: opts.group });
  // 哈希必须带上分组：换分组后响应体一模一样，但换算结果全变——只比响应体会把「换组」当成无变化
  const hash = crypto.createHash("sha256").update(`${parsed.group}|${parsed.groupRatio}|${text}`).digest("hex");
  if (!force && hasSegments && hash === db.getMeta("newapi_pricing_hash")) {
    db.setMeta("newapi_pricing_at", String(Date.now()));
    db.setMeta("newapi_pricing_error", "");
    db.setMeta("newapi_pricing_error_at", "");
    return { action: "unchanged", hash };
  }

  const index = buildPriceIndex(parsed.prices);
  const usedModels = db.getAggregate("full", "model", null, null, null).map((r) => r.key);
  const candidates = [];
  let unmatched = 0;
  for (const modelId of usedModels) {
    const hit = matchModel(index, modelId);
    if (hit) candidates.push({ ...hit.row, modelId, providerId: null });
    else unmatched++;
  }

  // 空响应保护：一个都没匹配上时不动已有价格段——站点临时返回空 data 或全部被过滤时，
  // 清掉价格会让费用静默归零，比「这轮没更新」危险得多
  if (!candidates.length) {
    db.setMeta("newapi_pricing_error", "本次未匹配到任何本地模型，已保留原价格");
    db.setMeta("newapi_pricing_error_at", String(Date.now()));
    return { action: "empty", total: parsed.total, unmatched, skipped: parsed.skipped };
  }

  const applied = db.applySourcePricing(candidates, "newapi");
  // 有手动价的模型：New API 段写进去了但不会生效（手动 > New API）。数量报给调用方，
  // 免得用户看到「调价 N」却感觉费用没变。段保留，用户删掉手动价后会自动接管。
  const manualModels = new Set(
    db.listCurrentPrices().filter((p) => p.source === "manual").map((p) => p.modelId)
  );
  const shadowed = candidates.filter((c) => manualModels.has(c.modelId)).length;
  db.setMeta("newapi_pricing_hash", hash);
  db.setMeta("newapi_pricing_at", String(Date.now()));
  db.setMeta("newapi_pricing_models", String(candidates.length));
  db.setMeta("newapi_pricing_total", String(parsed.total));
  db.setMeta("newapi_pricing_group", parsed.group || "");
  db.setMeta("newapi_pricing_group_ratio", String(parsed.groupRatio));
  db.setMeta("newapi_pricing_error", "");
  db.setMeta("newapi_pricing_error_at", "");
  return {
    action: "updated",
    // 注意命名：same 是「同价跳过」的数量，skipped 是被规则过滤掉的模型明细，两者别混
    added: applied.added, updated: applied.updated, same: applied.skipped,
    models: candidates.length, total: parsed.total, hash,
    group: parsed.group, groupRatio: parsed.groupRatio,
    unmatched, shadowed, skipped: parsed.skipped,
  };
}

module.exports = {
  parseLiteLLM, parseOpenRouter, previewImport, applyImport, syncPrices, pullRemotePricing, getRemotePricingStatus,
  parseNewApi, normalizeModelName, buildPriceIndex, matchModel, newApiPricingUrl,
  previewNewApi, pullNewApiPricing, getNewApiStatus, newApiInCooldown,
  LITELLM_URLS, OPENROUTER_URL, PRICES_FILE, REMOTE_PRICING_DEFAULTS,
};
