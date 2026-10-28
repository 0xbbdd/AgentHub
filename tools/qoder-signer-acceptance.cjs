/**
 * Qoder 签名器真机验收工具。
 * 默认只做结构诊断；--load-glue 才构建并加载客户端 WASM 胶水。
 *
 * 用法：
 *   node tools/qoder-signer-acceptance.cjs
 *   node tools/qoder-signer-acceptance.cjs --load-glue
 *   node tools/qoder-signer-acceptance.cjs --load-glue --require-installed --require-runtime
 *   node tools/qoder-signer-acceptance.cjs --json
 */
"use strict";

const signer = require("../electron/backend/proxy/qoderSigner.cjs");
const install = require("../electron/backend/proxy/qoderInstall.cjs");

const args = process.argv.slice(2);
const products = args.filter((arg) => !arg.startsWith("--"));
const list = products.length ? products : ["qoder", "qoder_intl"];
const json = args.includes("--json");
const loadGlue = args.includes("--load-glue");
const requireInstalled = args.includes("--require-installed");
const requireRuntime = args.includes("--require-runtime");
const ok = (v) => (v ? "✓" : "✗");

(async () => {
  const results = [];
  for (const product of list) {
    results.push(await signer.diagnose(product, { loadGlue }));
  }

  if (json) {
    console.log(JSON.stringify({ platform: process.platform, arch: process.arch, loadGlue, results }, null, 2));
  } else {
    console.log(`\nQoder 签名器验收 · ${process.platform}/${process.arch}`);
    for (const result of results) {
      const r = result.structural;
      console.log(`\n[${r.product}] ${install.EXE_LABELS[r.product] || ""}`);
      if (!r.installed) {
        console.log(`  ${ok(false)} 未定位到签名器：${r.message}`);
        continue;
      }
      console.log(`  ${ok(r.obfHealth && r.obfHealth.readable)} obf 可读  ${r.obfHealth && r.obfHealth.mode || "-"}`);
      console.log(`  ${ok(r.runtimeInfo && r.runtimeInfo.exists)} runtime-info 存在  ${r.runtimeInfo && r.runtimeInfo.path || "-"}`);
      console.log(`  ${ok(r.runtimeInfo && r.runtimeInfo.executable)} runtime-info 可执行  ${r.runtimeInfo && r.runtimeInfo.mode || "-"}`);
      console.log(`  ${ok(r.inlineWasm && r.inlineWasm.hit)} 内嵌 WASM  ${r.inlineWasm && r.inlineWasm.hit ? `@ ${r.inlineWasm.offset}` : "未命中"}`);
      console.log(`  提取路径：${r.path}`);
      console.log(`  缺失特征：${r.missing && r.missing.length ? r.missing.join(", ") : "无"}`);
      if (loadGlue && result.loaded) {
        console.log(`  ${ok(result.loaded.glueLoaded)} 签名胶水加载  exports=${result.loaded.exports || 0}`);
        if (result.loaded.glueError) console.log(`  glue error：${result.loaded.glueError}`);
      }
      if (result.loadError) console.log(`  load error：${result.loadError}`);
    }
    console.log("\n提示：真实推理签名验收需要已安装 Qoder 客户端；本工具不会输出账号 token。");
  }

  const installed = results.filter((result) => result.structural.installed);
  const glueOk = results.filter((result) => result.loaded && result.loaded.glueLoaded);
  const runtimeOk = results.filter((result) => result.structural.runtimeInfo && result.structural.runtimeInfo.exists && result.structural.runtimeInfo.executable);
  if (requireInstalled && !installed.length) process.exitCode = 2;
  if (loadGlue && installed.length && !glueOk.length) process.exitCode = 3;
  if (requireRuntime && (!runtimeOk.length || runtimeOk.length !== installed.length)) process.exitCode = 4;
})().catch((error) => {
  console.error("Qoder 签名器验收失败：", (error && error.stack) || error);
  process.exit(1);
});
