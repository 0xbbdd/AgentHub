// 积分包到期数据层闸
//  ① util.normalizeExpiryMs：秒/毫秒判别、纯日期补 23:59:59、远未来脏值→长期(0)
//  ② pool.deriveAccountCredits：Σ未过期剩余、最近到期取 remaining>0、不限哨兵、无包→null
//  ③ store 包集整体替换：DELETE+INSERT 原子替换、-1 保留、负值归 0、ord 排序、删号清包
//  ④ pool.decoratePackageStates：expired/expiringSoon 的边界（时间态每次出视图重算，不落库）
//  ⑤ store.listAllCreditPackages：一次全量分桶，与逐账号读逐字段等价（号池视图走这条）
//  ⑥ 端到端一条链：落包 → 全量读 → 时间态 → 派生账号额度
//  ⑦ 静态接线：建表 / 刷新链路落包并派生 / poolView 附包集
// 纯 Node、临时沙箱、零副作用（不开真库、不联网）
// 跑法（store.cjs 用 node:sqlite，系统 node 没有这个内建模块）：
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/dev-credit-packages-test.cjs
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-credpkg-"));
process.env.APPDATA = path.join(WORK, "appdata");
process.env.AGENT_SKILLS_HOME = path.join(WORK, "hub");
fs.mkdirSync(process.env.APPDATA, { recursive: true });

const util = require(path.join(ROOT, "electron", "backend", "proxy", "util.cjs"));
const pool = require(path.join(ROOT, "electron", "backend", "proxy", "pool.cjs"));
const store = require(path.join(ROOT, "electron", "backend", "proxy", "store.cjs"));

// 断言抛出时结尾的 store.close() 就跑不到：库句柄留在进程里，父进程等管道会等不到头。
// 挂 exit 钩子，让「失败退出」和「成功退出」放句柄的路径一致。
process.on("exit", () => { try { store.close(); } catch { /* 已经在报错退出，关不掉不影响结论 */ } });

let n = 0;
const pass = (m) => { n++; console.log(`  ${String(n).padStart(2)}. ${m}`); };
const DAY = 86400000;

// ===== ① normalizeExpiryMs 归一 =====
{
  const ms = Date.now() + 50 * DAY;
  assert.strictEqual(util.normalizeExpiryMs(ms), ms, "① 毫秒时间戳应原样返回");
  const sec = Math.floor((Date.now() + 50 * DAY) / 1000);
  assert.strictEqual(util.normalizeExpiryMs(sec), sec * 1000, "① 秒级时间戳应 ×1000");
  const ds = new Date(Date.now() + 100 * DAY).toISOString().slice(0, 10);
  assert.strictEqual(util.normalizeExpiryMs(ds), Date.parse(ds + "T23:59:59"),
    "① 纯日期串应补到当天 23:59:59（否则取到 00:00 会被误判提前一天过期）");
  const far = new Date(Date.now() + 8 * 365 * DAY).toISOString().slice(0, 10);
  assert.strictEqual(util.normalizeExpiryMs(far), 0, "① 远未来脏值（>5 年）应归 0=长期有效");
  assert.strictEqual(util.normalizeExpiryMs(""), 0, "① 空串→0");
  assert.strictEqual(util.normalizeExpiryMs(null), 0, "① null→0");
  pass("① normalizeExpiryMs：秒/毫秒判别、纯日期补 23:59:59、远未来→0、空→0");
}

// ===== ② deriveAccountCredits 派生 =====
{
  const T = Date.now();
  const pkgs = [
    { remaining: 100, total: 100, expiresAt: T + 10 * DAY },
    { remaining: 50, total: 50, expiresAt: T + 5 * DAY },
    { remaining: 200, total: 200, expiresAt: T - 1 * DAY }, // 已过期，不计
  ];
  const d = pool.deriveAccountCredits(pkgs, T);
  assert.strictEqual(d.credits, 150, "② 剩余=Σ未过期包剩余（100+50，过期的 200 不计）");
  assert.strictEqual(d.expiresAt, T + 5 * DAY, "② 最近到期=min(剩余>0 且未过期 的包到期)");

  const unl = pool.deriveAccountCredits([...pkgs, { remaining: -1, total: -1, expiresAt: 0 }], T);
  assert.strictEqual(unl.credits, -1, "② 任一包不限(remaining=-1) ⇒ credits=-1 哨兵");

  // total=-1 是「上游不给这一包的总额」，不是「额度无限」。混为一谈时，只缺面值的包会把
  // 整号余额派生成无限，并绕开 cost-first 路由。
  const noTotal = pool.deriveAccountCredits(
    [{ remaining: 500, total: -1, expiresAt: 0 }, { remaining: 100, total: 100, expiresAt: T + 3 * DAY }], T);
  assert.strictEqual(noTotal.credits, 600, "② total=-1（不给总额）不得派生成不限：剩余照常累加");
  assert.strictEqual(noTotal.expiresAt, T + 3 * DAY, "② 无面值包无到期(0) ⇒ 最近到期只看有到期的包");

  const withPerpetual = pool.deriveAccountCredits(
    [{ remaining: 30, total: 30, expiresAt: 0 }, { remaining: 50, total: 50, expiresAt: T + 5 * DAY }], T);
  assert.strictEqual(withPerpetual.credits, 80, "② 无到期(0)包剩余计入余额");
  assert.strictEqual(withPerpetual.expiresAt, T + 5 * DAY, "② 最近到期忽略无到期(0)的包");

  const noRemain = pool.deriveAccountCredits(
    [{ remaining: 0, total: 100, expiresAt: T + 2 * DAY }, { remaining: 0, total: 10, expiresAt: 0 }], T);
  assert.strictEqual(noRemain.credits, 0, "② 全无剩余 ⇒ credits=0");
  assert.strictEqual(noRemain.expiresAt, 0, "② 无 remaining>0 的包 ⇒ 最近到期=0");

  assert.strictEqual(pool.deriveAccountCredits([], T), null, "② 空包集 ⇒ null（调用方保留既有聚合值）");
  assert.strictEqual(pool.deriveAccountCredits(undefined, T), null, "② 非数组 ⇒ null");
  pass("② deriveAccountCredits：Σ未过期剩余 / 最近到期取 remaining>0 / 不限哨兵只认 remaining / 空→null");
}

// ===== ③ store 包集整体替换 =====
{
  const T = Date.now();
  const id = store.addAccount({ channel: "trae", uid: "u-pkg", name: "包测账号", token: "tk", refreshToken: "", source: "paste" });
  assert.deepStrictEqual(store.listCreditPackages(id), [], "③ 新账号包集应为空");

  store.setCreditPackages(id, "trae", [
    { code: "b", name: "包B", total: 200, used: 50, remaining: 150, expiresAt: T + 5 * DAY, ord: 1 },
    { code: "a", name: "包A", total: 100, used: 10, remaining: 90, expiresAt: T + 2 * DAY, ord: 0 },
    { code: "u", name: "不限包", total: -1, used: 0, remaining: -1, expiresAt: 0, ord: 2 },
    { code: "neg", name: "脏值包", total: -5, used: -3, remaining: -9, expiresAt: 0, ord: 3 },
  ]);
  const list = store.listCreditPackages(id);
  assert.strictEqual(list.length, 4, "③ 应落 4 个包");
  assert.deepStrictEqual(list.map((p) => p.code), ["a", "b", "u", "neg"], "③ 应按 ord 升序");
  assert.strictEqual(list[2].remaining, -1, "③ -1 不限哨兵应保留");
  assert.strictEqual(list[2].total, -1, "③ -1 总额哨兵应保留");
  assert.strictEqual(list[3].remaining, 0, "③ 小于 -1 的负值应归 0");
  assert.strictEqual(list[3].total, 0, "③ 负总额应归 0");

  // 整体替换：换一个更小的集合，旧包必须全部消失（不是 upsert 叠加）
  store.setCreditPackages(id, "trae", [{ code: "only", name: "唯一包", total: 10, used: 1, remaining: 9, expiresAt: T + DAY }]);
  const list2 = store.listCreditPackages(id);
  assert.strictEqual(list2.length, 1, "③ 整体替换后只剩新集合（不残留旧包）");
  assert.strictEqual(list2[0].code, "only", "③ 新集合内容正确");

  // 传空数组 = 清空
  store.setCreditPackages(id, "trae", []);
  assert.deepStrictEqual(store.listCreditPackages(id), [], "③ 传空数组应清空包集");

  // 非数组入参：不得抛，也不得残留旧包（producer 给 null 时整条刷新链路要能继续）
  store.setCreditPackages(id, "trae", [{ code: "k", name: "k", total: 1, used: 0, remaining: 1, expiresAt: 0 }]);
  store.setCreditPackages(id, "trae", null);
  assert.deepStrictEqual(store.listCreditPackages(id), [], "③ 非数组入参按空处理：不残留旧包、不抛");

  // 删号必须连带清包（防孤儿行）
  store.setCreditPackages(id, "trae", [{ code: "x", name: "x", total: 1, used: 0, remaining: 1, expiresAt: 0 }]);
  store.removeAccount(id);
  assert.deepStrictEqual(store.listCreditPackages(id), [], "③ 删号后包集应被清除");
  assert.strictEqual(store.listAllCreditPackages().get(id), undefined, "③ 删号后全量读里也不该再有这个账号");
  pass("③ store 整体替换：ord 排序 / -1 保留 / 负值归 0 / 换集不残留 / 空与非数组清空 / 删号清包");
}

// ===== ④ decoratePackageStates：时间态的边界 =====
{
  const T = 1700000000000; // 钉死时钟，断言与脚本运行时刻无关
  const st = (expiresAt, now) => pool.decoratePackageStates(
    [{ code: "c", name: "n", total: 10, used: 0, remaining: 10, expiresAt }], now)[0];

  const forever = st(0, T);
  assert.strictEqual(forever.expired, false, "④ expiresAt=0 是长期有效，不得判成已过期");
  assert.strictEqual(forever.expiringSoon, false, "④ expiresAt=0 不得判成即将到期（0 距 now 是个巨大负数）");

  assert.strictEqual(st(T - 1, T).expired, true, "④ 过期 1ms ⇒ expired");
  assert.strictEqual(st(T, T).expired, true, "④ 正好到此刻 ⇒ expired（<= 边界含等号）");
  assert.strictEqual(st(T + 1, T).expired, false, "④ 晚 1ms ⇒ 未过期");

  assert.strictEqual(st(T + DAY - 1, T).expiringSoon, true, "④ 窗口内差 1ms ⇒ expiringSoon");
  assert.strictEqual(st(T + DAY, T).expiringSoon, false, "④ 恰好一天 ⇒ 不算即将到期");
  assert.strictEqual(st(T + DAY + 1, T).expiringSoon, false, "④ 窗口外 ⇒ 不算即将到期");

  // 两态必须互斥：同时为真会让「已过期」和「即将到期」两个标记一起点亮
  for (const e of [0, T - DAY, T - 1, T, T + 1, T + DAY - 1, T + DAY, T + DAY + 1]) {
    const s = st(e, T);
    assert.ok(!(s.expired && s.expiringSoon), `④ 同一包不得既 expired 又 expiringSoon（expiresAt=${e}）`);
  }

  // 入参不得被改写：同一批包对象还会流向派生与导出，原地附加会让别处拿到脏对象
  const src = [{ code: "c", name: "n", total: 10, used: 0, remaining: 10, expiresAt: T + 5 * DAY }];
  const out = pool.decoratePackageStates(src, T);
  assert.strictEqual(src.expired, undefined, "④ 入参包对象不应被附上时间态");
  assert.notStrictEqual(out[0], src[0], "④ 出的是新对象");
  assert.strictEqual(out[0].code, "c", "④ 原有字段照常带出");

  assert.deepStrictEqual(pool.decoratePackageStates(undefined, T), [], "④ 非数组 ⇒ 空数组，不抛");
  pass("④ decoratePackageStates：长期(0)不误判 / 三处边界 / 两态互斥 / 不改入参 / 非数组→[]");
}

// ===== ⑤ listAllCreditPackages：一次全量分桶 == 逐账号读 =====
{
  const T = Date.now();
  const a1 = store.addAccount({ channel: "trae", uid: "u-all-1", name: "全量1", token: "tk", refreshToken: "", source: "paste" });
  const a2 = store.addAccount({ channel: "zcode", uid: "u-all-2", name: "全量2", token: "tk", refreshToken: "", source: "paste" });
  store.setCreditPackages(a1, "trae", [
    { code: "z", name: "z包", total: 3, used: 0, remaining: 3, expiresAt: T + 9 * DAY, ord: 2 },
    { code: "y", name: "y包", total: 2, used: 0, remaining: 2, expiresAt: T + 8 * DAY, ord: 1 },
  ]);
  store.setCreditPackages(a2, "zcode", [
    { code: "x", name: "x包", total: 1, used: 0, remaining: 1, expiresAt: T + 7 * DAY, ord: 0 },
  ]);

  const all = store.listAllCreditPackages();
  assert.deepStrictEqual(all.get(a1).map((p) => p.code), ["y", "z"],
    "⑤ 分桶内顺序与逐账号读一致（ord 升序，不靠 SQL 返回顺序碰巧）");
  assert.deepStrictEqual(all.get(a2).map((p) => p.code), ["x"], "⑤ 另一账号只出它自己的包（不串号）");
  assert.deepStrictEqual(all.get(a1), store.listCreditPackages(a1),
    "⑤ 全量读与逐账号读逐字段等价——两条路必须同口径，否则号池视图和账号详情会给出不同数字");
  assert.strictEqual(all.get("不存在的账号"), undefined, "⑤ 无包的账号不进 Map（调用方按 || [] 兜底）");
  assert.ok(!(all.get(a1) || []).some((p) => "accountId" in p), "⑤ accountId 只做分桶键，不漏进对外包对象");
  store.removeAccount(a1);
  store.removeAccount(a2);
  pass("⑤ listAllCreditPackages：一次全量按账号分桶，与逐账号读逐字段等价且顺序一致");
}

// ===== ⑥ 端到端一条链：落包 → 全量读 → 时间态 → 派生账号额度 =====
{
  const T = Date.now();
  const id = store.addAccount({ channel: "trae", uid: "u-e2e", name: "端到端", token: "tk", refreshToken: "", source: "paste" });
  store.setCreditPackages(id, "trae", [
    { code: "ok", name: "在用", total: 100, used: 40, remaining: 60, expiresAt: T + 3 * DAY, ord: 0 },
    { code: "dead", name: "已过期", total: 500, used: 0, remaining: 500, expiresAt: T - 2 * DAY, ord: 1 },
    { code: "soon", name: "快到期", total: 20, used: 0, remaining: 20, expiresAt: T + 0.5 * DAY, ord: 2 },
  ]);

  const decorated = pool.decoratePackageStates(store.listAllCreditPackages().get(id) || [], T);
  assert.deepStrictEqual(decorated.map((p) => p.code), ["ok", "dead", "soon"],
    "⑥ 出包顺序按 ord（0/1/2 = ok/dead/soon），不按到期日重排——日历的排序是展示层的事");
  assert.deepStrictEqual(
    decorated.map((p) => [p.expired, p.expiringSoon]),
    [[false, false], [true, false], [false, true]],
    "⑥ 三个包的时间态各归各位");

  const derived = pool.deriveAccountCredits(decorated, T);
  assert.strictEqual(derived.credits, 80, "⑥ 派生剩余只算未过期包（60+20，已过期的 500 不计）");
  assert.strictEqual(derived.expiresAt, T + 0.5 * DAY, "⑥ 最近到期就是那个即将到期的包");

  // 同一条库记录、隔 3 天再读必须自动改态——这是「时间态不落库」的直接收益
  store.setCreditPackages(id, "trae", [{ code: "tom", name: "明天看", total: 10, used: 0, remaining: 10, expiresAt: T + 2 * DAY, ord: 0 }]);
  assert.strictEqual(pool.decoratePackageStates(store.listCreditPackages(id), T)[0].expired, false,
    "⑥ 写入当天读：未过期");
  assert.strictEqual(pool.decoratePackageStates(store.listCreditPackages(id), T + 3 * DAY)[0].expired, true,
    "⑥ 同一记录三天后再读：已过期（若把 expired 落库，这里会永远停在写入那天的 false）");
  store.removeAccount(id);
  pass("⑥ 端到端：落包→全量读→时间态→派生 80/3天，且同记录隔 3 天重读自动改态");
}

// ===== ⑦ 静态接线（不联网、不开真库网关） =====
{
  const read = (f) => fs.readFileSync(path.join(ROOT, "electron", "backend", "proxy", f), "utf8");
  assert.ok(/CREATE TABLE IF NOT EXISTS credit_packages/.test(read("store.cjs")),
    "⑦ store.cjs 必须建 credit_packages 表（不建表则首次 setCreditPackages 就炸）");

  const cred = read("credits.cjs");
  assert.ok(/setCreditPackages/.test(cred) && /deriveAccountCredits/.test(cred),
    "⑦ credits.cjs 刷新链路必须落包集并用 deriveAccountCredits 派生（否则包集永远不写、账号额度与逐包不同源）");

  // poolView 的包集来源必须是「一次全量读」，不是逐账号查。
  // 只 grep 文件里有没有 listAllCreditPackages 是抓不住的：把下面这行换回逐账号查，
  // 全量读那行仍然留在文件里，正则照样过——判据必须落到 packages: 这一行本身。
  const idx = read("index.cjs");
  const pkgLine = (idx.match(/^[ \t]*packages:[^\r\n]*/m) || ["(找不到 packages: 这一行)"])[0];
  assert.ok(/decoratePackageStates\(/.test(pkgLine), `⑦ poolView 的 packages: 必须过 decoratePackageStates 附时间态（实测: ${pkgLine.trim()}）`);
  assert.ok(!/store\.listCreditPackages\(/.test(pkgLine), `⑦ poolView 不得逐账号查包（N+1）（实测: ${pkgLine.trim()}）`);
  assert.ok(/listAllCreditPackages\(\)/.test(idx), "⑦ poolView 必须先做一次全量读，否则分桶 Map 没有来源");

  // 导出面：漏一个导出不是构建期错误，是运行期 undefined is not a function
  for (const fn of ["setCreditPackages", "listCreditPackages", "listAllCreditPackages"])
    assert.strictEqual(typeof store[fn], "function", `⑦ store 必须导出 ${fn}`);
  for (const fn of ["deriveAccountCredits", "decoratePackageStates"])
    assert.strictEqual(typeof pool[fn], "function", `⑦ pool 必须导出 ${fn}`);
  assert.strictEqual(typeof util.normalizeExpiryMs, "function", "⑦ util 必须导出 normalizeExpiryMs");
  pass("⑦ 静态接线：建表 / 刷新链路落包并派生 / packages: 行走全量读+时间态 / 六个导出齐全");
}

store.close();
try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* 清不掉不影响结论 */ }
console.log(`\nOK 积分包到期数据层闸全过（${n} 项）`);
