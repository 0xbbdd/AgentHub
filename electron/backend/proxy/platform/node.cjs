// 反代网关 · 平台适配层 · 纯 Node 实现（Docker headless 形态）
// 无 Electron 环境时，所有 GUI/系统级能力降级为日志提示或空实现，保证核心转发链路可用。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

// Docker 版数据目录：环境变量优先，默认 /data（容器内）或 ./data（本地直跑）
const DATA_DIR = process.env.AGENTHUB_DATA_DIR || path.join(process.cwd(), "data");

// 凭据加密密钥：生产必须设置，否则明文降级（开发/自测用）
const ENC_KEY = process.env.AGENTHUB_SECRET_KEY || "";
const ENC_PREFIX = "enc:v2:";

if (!ENC_KEY) {
  console.warn("⚠️  AGENTHUB_SECRET_KEY 未设置，凭据将明文存储（仅限开发环境）");
}

function getKey() {
  if (!ENC_KEY) return null;
  return crypto.createHash("sha256").update(ENC_KEY).digest();
}

module.exports = {
  // ===== 事件广播：Node 版打日志（后续可扩展为 SSE/WebSocket） =====
  emit(payload) {
    const t = payload && payload.type;
    if (!t) return;
    // 高流量事件采样输出，避免刷屏
    if (t === "request") {
      if (Math.random() < 0.05) {
        console.log(`[gateway] ${t}: ${payload.count || 1} requests`);
      }
    } else {
      console.log(`[gateway] ${t}`, JSON.stringify(payload).slice(0, 300));
    }
  },

  // ===== 本机软件导入扫描：Docker 无客户端，返回空 =====
  async scanLocalAccounts() {
    return [];
  },

  // ===== IDE 切号：Docker 无客户端，诚实拒绝 =====
  async switchIdeAccount() {
    return { ok: false, message: "Docker 版不支持 IDE 切号（无本机客户端），请通过 JSON 导入或 OAuth 登录添加账号" };
  },

  // ===== 人机校验：Docker 无法弹窗，返回 needCaptcha 走人工 =====
  async solveCaptcha() {
    return { ok: false, needCaptcha: true, message: "Docker 环境无法自动过人机校验，请到桌面版号池页手动领取" };
  },

  // ===== 凭据加解密：AES-256-GCM（替代 DPAPI） =====
  encryptSecret(plain) {
    const s = String(plain || "");
    if (!s || s.startsWith(ENC_PREFIX)) return s;
    const key = getKey();
    if (!key) return s; // 明文降级
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
    const text = Buffer.concat([cipher.update(s, "utf8"), cipher.final()]);
    return ENC_PREFIX + [nonce, cipher.getAuthTag(), text].map(b => b.toString("base64url")).join(".");
  },

  decryptSecret(stored) {
    const s = String(stored || "");
    if (!s.startsWith(ENC_PREFIX)) return s; // 明文或旧格式直接返回
    const key = getKey();
    if (!key) return "";
    try {
      const parts = s.slice(ENC_PREFIX.length).split(".");
      if (parts.length !== 3) return "";
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parts[0], "base64url"));
      decipher.setAuthTag(Buffer.from(parts[1], "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(parts[2], "base64url")), decipher.final()]).toString("utf8");
    } catch {
      return "";
    }
  },

  // ===== 数据目录 =====
  getDataDir() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    return DATA_DIR;
  },

  // ===== 休眠唤醒守卫：Docker 不休眠，恒允许 =====
  wakeGuard: {
    noteTick: () => {},
    checkinAllowed: () => true,
  },
};
