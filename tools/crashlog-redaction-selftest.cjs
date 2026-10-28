/** crash.log 敏感信息脱敏自测：Bearer/JWT/token/cookie/password/API Key 不得落明文。 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-crashlog-redact-"));
process.env.AGENTHUB_CRASHLOG_DIR = dir;
try {
  const crashlog = require("../electron/backend/crashlog.cjs");
  const secrets = [
    "Bearer abcdefghijklmnopqrstuvwxyz",
    "eyJabcdefgh.abcdefghijklmnop.abcdefgh",
    "refreshToken=refresh-secret-value",
    '"access_token":"access-secret-value"',
    "cookie: session-secret-value",
    "password=pass-secret-value",
    "sk-1234567890abcdefghijklmnop",
    "token 1234567890abcdef",
  ];
  crashlog.write("redaction-test", `upstream failed: ${secrets.join(" ")}`);
  const raw = fs.readFileSync(path.join(dir, "crash.log"), "utf8");
  for (const secret of ["abcdefghijklmnopqrstuvwxyz", "eyJabcdefgh", "refresh-secret-value", "access-secret-value", "session-secret-value", "pass-secret-value", "sk-1234567890abcdefghijklmnop", "1234567890abcdef"]) {
    assert.ok(!raw.includes(secret), `crash.log 泄漏凭据片段：${secret}`);
  }
  assert.match(raw, /<redacted/);
  console.log("崩溃日志脱敏自测通过：Bearer/JWT/token/cookie/password/API Key 均已打码");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
