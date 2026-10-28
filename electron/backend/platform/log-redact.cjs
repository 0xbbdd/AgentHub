/**
 * 崩溃/诊断日志脱敏。所有进入 crash.log 的字符串都必须先经过这里，
 * 覆盖 Authorization/Bearer、JWT、常见 token/secret/password/cookie/session 键值对和常见 API Key 形态。
 */
"use strict";

const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g;
const BEARER_RE = /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const API_KEY_RE = /\b(?:sk|pk|rk|gh[pousr]|AKIA)[-_A-Za-z0-9]{12,}\b/g;
const KV_RE = /\b(access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|client[-_]?secret|clientSecret|device[-_]?token|machineToken|api[-_]?token|authorization|cookie|set-cookie|session|password|passwd|secret|token|jwt)(["']?)(\s*[:=]\s*["']?)([^\s,;"'}\]]{4,})/gi;
const BARE_RE = /\b(token|jwt|apikey|api[-_]key)\s+([A-Fa-f0-9]{12,})\b/g;

function redact(value) {
  const text = String(value == null ? "" : value);
  if (!text) return text;
  return text
    .replace(JWT_RE, "<redacted-jwt>")
    .replace(BEARER_RE, "$1 <redacted>")
    .replace(API_KEY_RE, "<redacted-api-key>")
    .replace(KV_RE, "$1$2$3<redacted>")
    .replace(BARE_RE, "$1 <redacted>");
}

module.exports = { redact };
