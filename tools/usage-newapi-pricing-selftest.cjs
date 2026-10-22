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
// New API 价格源回归守卫（不联网，全部用本地 fixture）
//
// 锁四件事：
//   A. 倍率换算口径与 new-api 一致：base = model_ratio × 2 × 分组倍率（USD/1M）
//   B. 三类必须跳过的脏数据：按次计费 / 阶梯表达式 / 倍率未配置（37.5 兜底）
//   C. 价格来源优先级：手动 > New API > 远程 > 内置，且低优先级段保留不删
//   D. 托底：空响应不删已有段、同价幂等、旧版客户端整表覆盖后锚点被清（下轮自愈）
//
// 全部在沙箱数据目录内运行，带安全闸门，绝不触碰真实用量库。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "ah-newapi-"));
process.env.USERPROFILE = SANDBOX; // os.homedir() 在 Windows 上取 USERPROFILE，用量库随之进沙箱
process.env.APPDATA = path.join(SANDBOX, "appdata"); // 隔离真实 %APPDATA%

let pass = 0, fail = 0; const bad = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; bad.push(name + (extra ? "  <- " + extra : "")); console.log("  FAIL " + name + (extra ? "   <- " + extra : "")); }
}
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;

const syncConfig = require("../electron/backend/sync-config.cjs");
const dbPath = syncConfig.dbPath();
console.log("=== 安全闸门 ===");
console.log("  沙箱 = " + SANDBOX);
console.log("  用量库 = " + dbPath);
ok("用量库路径在沙箱内（绝不写真实库）",
  path.resolve(dbPath).toLowerCase().startsWith(path.resolve(SANDBOX).toLowerCase()));
if (!path.resolve(dbPath).toLowerCase().startsWith(path.resolve(SANDBOX).toLowerCase())) {
  console.error("拒绝运行：用量库路径不在沙箱内"); process.exit(2);
}

const db = require("../electron/backend/db.cjs");
const billing = require("../electron/backend/billing.cjs");

// ===== fixture：贴近 /api/pricing 真实返回（含各类需要跳过的脏数据）=====
const FIXTURE = {
  success: true,
  data: [
    { model_name: "gpt-4o", quota_type: 0, model_ratio: 1.25, completion_ratio: 4, cache_ratio: 0.5, create_cache_ratio: 1.25, enable_groups: ["default"] },
    { model_name: "claude-3-5-sonnet-20241022", quota_type: 0, model_ratio: 1.5, completion_ratio: 5, enable_groups: ["default"] },
    { model_name: "vendor/qwen3-max", quota_type: 0, model_ratio: 1, completion_ratio: 2, enable_groups: ["default"] },
    { model_name: "mj_imagine", quota_type: 1, model_price: 0.1, model_ratio: 0, enable_groups: ["default"] },
    { model_name: "tiered-model", quota_type: 0, model_ratio: 2, billing_mode: "tiered_expr" },
    { model_name: "no-ratio-model", quota_type: 0, model_ratio: 37.5, completion_ratio: 1 },
    { model_name: "zero-ratio", quota_type: 0, model_ratio: 0 },
  ],
  group_ratio: { default: 1, vip: 0.8 },
  usable_group: { default: "默认分组", vip: "VIP" },
};

console.log("");
console.log("=== A. 倍率换算口径（base = ratio × 2 × 分组倍率）===");
const p1 = billing.parseNewApi(JSON.stringify(FIXTURE));
const gpt = p1.prices.get("gpt-4o");
ok("输入价 = 1.25 × 2 × 1 = 2.5", gpt && near(gpt.inputPerM, 2.5), JSON.stringify(gpt));
ok("输出价 = 2.5 × 4 = 10", gpt && near(gpt.outputPerM, 10), JSON.stringify(gpt));
ok("缓存读 = 2.5 × 0.5 = 1.25", gpt && near(gpt.cacheReadPerM, 1.25), JSON.stringify(gpt));
ok("缓存写 = 2.5 × 1.25 = 3.125", gpt && near(gpt.cacheWritePerM, 3.125), JSON.stringify(gpt));
ok("币种固定 USD", gpt && gpt.currency === "USD");

const claude = p1.prices.get("claude-3-5-sonnet-20241022");
ok("缺省 cache_ratio 按 1.0（new-api DefaultCacheRatio）", claude && near(claude.cacheReadPerM, 3), JSON.stringify(claude));
ok("缺省 create_cache_ratio 按 1.25", claude && near(claude.cacheWritePerM, 3.75), JSON.stringify(claude));
ok("输出价 = 3 × 5 = 15", claude && near(claude.outputPerM, 15), JSON.stringify(claude));

const qwen = p1.prices.get("vendor/qwen3-max");
ok("供应商前缀原样保留（匹配阶段再归一化）", qwen && near(qwen.inputPerM, 2), JSON.stringify(qwen));

const pVip = billing.parseNewApi(JSON.stringify(FIXTURE), { group: "vip" });
ok("指定分组 vip ×0.8 → 输入 2.0", near(pVip.prices.get("gpt-4o").inputPerM, 2), JSON.stringify(pVip.prices.get("gpt-4o")));
ok("分组与倍率回传正确", pVip.group === "vip" && near(pVip.groupRatio, 0.8), `${pVip.group}/${pVip.groupRatio}`);
ok("未指定分组时回落到 default", p1.group === "default" && near(p1.groupRatio, 1), `${p1.group}/${p1.groupRatio}`);

console.log("");
console.log("=== B. 三类脏数据必须跳过（留给下层来源兜底）===");
ok("按次计费 quota_type=1 跳过", p1.skipped.request.includes("mj_imagine"), JSON.stringify(p1.skipped.request));
ok("阶梯表达式计费跳过", p1.skipped.tiered.includes("tiered-model"), JSON.stringify(p1.skipped.tiered));
ok("倍率未配置（37.5 兜底）跳过", p1.skipped.suspect.some((s) => s.modelId === "no-ratio-model"), JSON.stringify(p1.skipped.suspect));
ok("倍率无效（0）跳过", p1.skipped.invalid.includes("zero-ratio"), JSON.stringify(p1.skipped.invalid));
ok("被跳过的模型不进价目表", !p1.prices.has("no-ratio-model") && !p1.prices.has("mj_imagine") && !p1.prices.has("tiered-model"));
ok("可用模型共 3 个", p1.prices.size === 3, String(p1.prices.size));

console.log("");
console.log("=== C. 模型名归一化（只收敛明显同义写法，不做模糊相似）===");
const nm = billing.normalizeModelName;
ok("去供应商前缀", nm("openai/gpt-4o") === "gpt-4o");
ok("小写化", nm("GPT-4O") === "gpt-4o");
ok("去日期后缀（紧凑）", nm("claude-3-5-sonnet-20241022") === "claude-3-5-sonnet", nm("claude-3-5-sonnet-20241022"));
ok("去日期后缀（带横线）", nm("gpt-4o-2024-08-06") === "gpt-4o", nm("gpt-4o-2024-08-06"));
ok("去 @ 版本后缀", nm("glm-4@20250807") === "glm-4", nm("glm-4@20250807"));
ok("去 :free 变体", nm("deepseek-chat:free") === "deepseek-chat");
ok("去 -latest", nm("gpt-4o-latest") === "gpt-4o");
ok("不误剥 -mini（关键：否则 gpt-4o-mini 会被算成 gpt-4o 的价）", nm("gpt-4o-mini") === "gpt-4o-mini");
ok("不误剥 -pro", nm("o1-pro") === "o1-pro");
ok("不误剥小数点版本", nm("glm-4.6") === "glm-4.6");

const index = billing.buildPriceIndex(p1.prices);
ok("原名精确匹配", billing.matchModel(index, "gpt-4o").via === "exact");
ok("大小写匹配", billing.matchModel(index, "GPT-4O").via === "case");
ok("归一化匹配（带日期）", billing.matchModel(index, "gpt-4o-2024-08-06").via === "normalized");
ok("归一化匹配（带供应商前缀）", billing.matchModel(index, "openai/claude-3-5-sonnet").via === "normalized");
ok("无对应模型返回 null", billing.matchModel(index, "gpt-4o-mini") === null);

// 同名带后缀与不带后缀并存时，通用价（无后缀者）优先接管未知日期
const dual = new Map([
  ["gpt-4o", { modelId: "gpt-4o", inputPerM: 2.5, outputPerM: 10, cacheReadPerM: 0, cacheWritePerM: 0, currency: "USD" }],
  ["gpt-4o-2024-08-06", { modelId: "gpt-4o-2024-08-06", inputPerM: 3, outputPerM: 12, cacheReadPerM: 0, cacheWritePerM: 0, currency: "USD" }],
]);
const dualIndex = billing.buildPriceIndex(dual);
ok("精确命中自己的日期版本", dualIndex && billing.matchModel(dualIndex, "gpt-4o-2024-08-06").row.inputPerM === 3);
ok("未知日期版本回落到通用价", billing.matchModel(dualIndex, "gpt-4o-2025-01-01").row.inputPerM === 2.5);

console.log("");
console.log("=== D. 站点地址拼装（容忍用户多粘一段）===");
ok("根地址", billing.newApiPricingUrl("https://api.example.com") === "https://api.example.com/api/pricing");
ok("带尾斜杠", billing.newApiPricingUrl("https://api.example.com/") === "https://api.example.com/api/pricing");
ok("已含 /api", billing.newApiPricingUrl("https://api.example.com/api") === "https://api.example.com/api/pricing");
ok("已含完整路径", billing.newApiPricingUrl("https://api.example.com/api/pricing") === "https://api.example.com/api/pricing");
ok("空地址返回空", billing.newApiPricingUrl("") === "");

console.log("");
console.log("=== E. 来源优先级：手动 > New API > 远程 > 内置 ===");
const day = 24 * 60 * 60 * 1000;
function rec(id, model, provider, tokens, startedAt) {
  return {
    id, deviceId: "dev-a", deviceName: "测试机", source: "claude",
    providerId: provider, modelId: model,
    inputTokens: tokens, outputTokens: tokens, reasoningTokens: 0,
    cacheCreationTokens: 0, cacheReadTokens: 0,
    startedAt: startedAt ?? Date.now(), status: "success",
  };
}
const currentOf = (m) => db.listCurrentPrices().find((p) => p.modelId === m);

db.savePrice({ modelId: "prio-model", providerId: null, inputPerM: 11, outputPerM: 22, currency: "USD", effectiveFrom: 0 }, "自测");
db.applySourcePricing([{ modelId: "prio-model", inputPerM: 2.5, outputPerM: 10, cacheReadPerM: 1.25, cacheWritePerM: 3.125, currency: "USD" }], "newapi");
db.applySourcePricing([{ modelId: "prio-model", inputPerM: 3, outputPerM: 12, cacheReadPerM: 0.3, cacheWritePerM: 0, currency: "USD" }], "remote");

let cur = currentOf("prio-model");
ok("三段并存时取手动价", cur && cur.source === "manual" && near(cur.inputPerM, 11), JSON.stringify(cur));
ok("sources 列出全部三个来源", cur && cur.sources.slice().sort().join(",") === "manual,newapi,remote", JSON.stringify(cur && cur.sources));

db.get().prepare("DELETE FROM model_price WHERE model_id = 'prio-model' AND COALESCE(source,'manual') = 'manual'").run();
cur = currentOf("prio-model");
ok("删掉手动价 → New API 接管", cur && cur.source === "newapi" && near(cur.inputPerM, 2.5), JSON.stringify(cur));

db.get().prepare("DELETE FROM model_price WHERE model_id = 'prio-model' AND COALESCE(source,'manual') = 'newapi'").run();
cur = currentOf("prio-model");
ok("再删 New API → 远程价兜底", cur && cur.source === "remote" && near(cur.inputPerM, 3), JSON.stringify(cur));

console.log("");
console.log("=== F. 计费视图确实按 New API 价算钱 ===");
db.applySourcePricing([{ modelId: "cost-model", inputPerM: 2.5, outputPerM: 10, cacheReadPerM: 1.25, cacheWritePerM: 3.125, currency: "USD" }], "newapi");
db.insertRecords([rec("cm1", "cost-model", "claude", 1000000)]);
const cost = db.get().prepare("SELECT cost_native AS c, cost_currency AS cur, price_id AS pid FROM v_record_cost WHERE model_id = 'cost-model'").get();
ok("100 万输入 + 100 万输出 = 2.5 + 10 = 12.5", cost && near(cost.c, 12.5), JSON.stringify(cost));
ok("费用币种取价格行币种 USD", cost && cost.cur === "USD", JSON.stringify(cost));
ok("命中价格行（不是无价 0）", cost && cost.pid != null, JSON.stringify(cost));

console.log("");
console.log("=== G. 托底：空响应 / 幂等 / 旧版覆盖自愈 ===");
const beforeSeg = db.countSourcePrices("newapi");
db.applySourcePricing([], "newapi");
ok("空数组不删除已有 New API 段", db.countSourcePrices("newapi") === beforeSeg, `${beforeSeg} -> ${db.countSourcePrices("newapi")}`);

const same = [{ modelId: "cost-model", inputPerM: 2.5, outputPerM: 10, cacheReadPerM: 1.25, cacheWritePerM: 3.125, currency: "USD" }];
const again = db.applySourcePricing(same, "newapi");
ok("同价重复应用 → 全部跳过（不产生新版本）", again.added === 0 && again.updated === 0 && again.skipped === 1, JSON.stringify(again));
ok("价格段数量未变（没有开新段）", db.countSourcePrices("newapi") === beforeSeg, `${beforeSeg} -> ${db.countSourcePrices("newapi")}`);

// 旧版客户端（不认识 newapi 来源）上传的价格表：整表覆盖后段丢失，锚点必须被清，下轮才会重拉
db.setMeta("newapi_pricing_hash", "deadbeef");
db.setMeta("newapi_pricing_at", "12345");
const legacyPayload = db.listAllPrices().filter((p) => p.source !== "newapi");
db.replacePrices(legacyPayload, Date.now(), undefined);
ok("旧版 payload 整表替换后 New API 段消失", db.countSourcePrices("newapi") === 0, String(db.countSourcePrices("newapi")));
ok("拉取锚点被清（下轮同步强制重拉）", !db.getMeta("newapi_pricing_hash") && db.getMeta("newapi_pricing_at") === "0",
  `${JSON.stringify(db.getMeta("newapi_pricing_hash"))} / ${JSON.stringify(db.getMeta("newapi_pricing_at"))}`);

// 新版客户端上传（含 newapi 段）时锚点不该被动
db.applySourcePricing(same, "newapi");
db.setMeta("newapi_pricing_hash", "cafebabe");
db.replacePrices(db.listAllPrices(), Date.now(), undefined);
ok("新版 payload 含 New API 段 → 锚点保留", db.getMeta("newapi_pricing_hash") === "cafebabe", JSON.stringify(db.getMeta("newapi_pricing_hash")));

console.log("");
console.log("=== H. 配置层：New API 段默认值与归一化 ===");
const def = syncConfig.defaultConfig().billing;
ok("默认关闭", def.newApi && def.newApi.enabled === false);
ok("默认无站点地址", def.newApi.baseUrl === "");
ok("默认间隔 24 小时", def.newApi.intervalHours === 24);
ok("远程价格源仍在（两源并存）", !!def.remotePricing && !!def.remotePricing.url);

db.close();
console.log("");
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log("失败项：\n  - " + bad.join("\n  - ")); process.exit(1); }
console.log("全部通过");
