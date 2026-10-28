/**
 * 能力矩阵完整性门禁：真实适配器集合中的每个数据源/代理渠道都必须有平台能力登记。
 * 用法：node tools/check-platform-capabilities.cjs
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-platform-check-"));
process.env.AGENTHUB_DATA_DIR = path.join(sandbox, "data");
process.env.AGENT_SKILLS_HOME = path.join(sandbox, "skills");
process.env.AGENTHUB_SECRET_KEY = "platform-check-only";

try {
  const caps = require("../electron/backend/platform/capabilities.cjs");
  const { sources } = require("../electron/backend/sync-adapter.cjs");
  const { ADAPTERS } = require("../electron/backend/proxy/adapters.cjs");

  const sourceIds = sources.map((item) => item.id);
  const channelIds = Object.keys(ADAPTERS);
  const problems = caps.audit({ sourceIds, channelIds });

  if (problems.length) {
    console.error(`[platform-capabilities] 发现 ${problems.length} 个矩阵问题：`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exitCode = 1;
  } else {
    console.log(`[platform-capabilities] ${sourceIds.length} 个用量源、${channelIds.length} 个代理渠道均有三平台能力登记`);
  }
} finally {
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* Windows 上数据库句柄可能尚未释放 */ }
}
