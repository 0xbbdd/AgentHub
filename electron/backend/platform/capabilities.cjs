/**
 * 平台能力矩阵：后端与前端判断“某能力在当前平台是否可用”的唯一事实源。
 *
 * 状态含义：
 *   supported      已在目标平台实现并纳入验收
 *   compatible     已有实现，但尚未完成目标平台真机验收
 *   fallback       有产品级替代路径，行为或范围与主平台不同
 *   blocked        当前平台不可用，必须向用户解释原因
 *   not-applicable 该平台没有这个能力概念
 */
"use strict";

const { platformName } = require("./paths.cjs");

const SCHEMA = 1;
const PLATFORMS = Object.freeze(["win32", "darwin", "linux"]);
const STATUSES = Object.freeze(["supported", "compatible", "fallback", "blocked", "not-applicable"]);

function cap(win32, darwin, linux, reasons = {}) {
  return {
    win32: win32 || "compatible",
    darwin: darwin || "compatible",
    linux: linux || "compatible",
    reasons: { ...reasons },
  };
}

function notApplicable() {
  return cap("not-applicable", "not-applicable", "not-applicable");
}

function reasonFor(spec, platform) {
  if (!spec || !spec.reasons) return "";
  return String(spec.reasons[platform] || spec.reasons.default || "");
}

function statusEntry(spec, platform) {
  if (!spec) return { status: "not-applicable", reason: "" };
  return {
    status: spec[platform] || "blocked",
    reason: reasonFor(spec, platform),
  };
}

const FEATURES = Object.freeze({
  "app.shell": {
    label: "桌面主框架",
    support: cap("supported", "compatible", "compatible", {
      darwin: "桌面壳与打包产物 GUI E2E 已纳入 CI/Release，仍待在 macOS runner 实测",
      linux: "桌面壳与打包产物 GUI E2E 已纳入 CI/Release，仍需覆盖更多发行版与桌面环境",
    }),
  },
  "secure-storage": {
    label: "系统级安全存储",
    support: cap("supported", "compatible", "fallback", {
      darwin: "使用 Electron safeStorage/Keychain，待签名应用内验收",
      linux: "依赖 Secret Service/KWallet 或 AGENTHUB_SECRET_KEY；生产包不可用时会拒绝凭据写入",
    }),
  },
  "desktop.tray": {
    label: "系统托盘",
    support: cap("supported", "compatible", "compatible", {
      darwin: "需要模板图标与 Dock 行为验收",
      linux: "运行时检测托盘创建结果；失败时关闭窗口将直接退出，避免无入口后台进程",
    }),
  },
  "desktop.autostart": {
    label: "开机自启",
    support: cap("supported", "compatible", "compatible"),
  },
  "desktop.global-shortcut": {
    label: "全局快捷键",
    support: cap("supported", "compatible", "compatible", {
      linux: "Wayland 已启用 GlobalShortcutsPortal，实际可用性由桌面合成器授权决定",
    }),
  },
  "updater.in-app": {
    label: "应用内自动更新",
    support: cap("supported", "blocked", "fallback", {
      darwin: "未配置 Developer ID 签名与公证，生产更新链未闭环",
      linux: "仅 AppImage 适合应用内更新；DEB 应由包管理器升级",
    }),
  },
  "release.code-signing": {
    label: "发布制品签名",
    support: cap("blocked", "blocked", "blocked", {
      default: "现有发布流水线尚未配置签名、公证或制品证明",
    }),
  },
  "credentials.chromium-os-crypt": {
    label: "Chromium/Electron 系统凭据解密",
    support: cap("supported", "compatible", "compatible", {
      darwin: "已实现 Keychain + v10 CBC 适配，待真实客户端版本验收",
      linux: "已实现 Secret Service + v10 CBC 适配，待桌面环境与真实客户端验收",
    }),
  },
});

const SOURCES = Object.freeze({
  zcode: { label: "ZCode" },
  raccoon: { label: "商汤小浣熊" },
  mimo: { label: "Xiaomi MiMo" },
  codex: { label: "Codex" },
  dsh: { label: "DeepSeek Harness" },
  workbuddy: { label: "WorkBuddy" },
  "workbuddy-ai": { label: "WorkBuddy AI" },
  reasonix: { label: "Reasonix" },
  codebuddy: { label: "CodeBuddy" },
  qoder: { label: "Qoder" },
  "qoder-cn": { label: "Qoder CN" },
  antigravity: { label: "Antigravity" },
  "antigravity-ide": { label: "Antigravity IDE" },
  "antigravity-legacy": {
    label: "Antigravity 老数据恢复",
    support: cap("supported", "blocked", "blocked", {
      darwin: "恢复链依赖 language_server.exe 与 Windows 进程能力",
      linux: "恢复链依赖 language_server.exe 与 Windows 进程能力",
    }),
  },
  trae: { label: "Trae" },
  "trae-cn": { label: "Trae CN" },
  "trae-solo": { label: "TRAE SOLO" },
  "trae-solo-cn": { label: "TRAE SOLO CN" },
  opensquilla: { label: "OpenSquilla" },
  grok: { label: "Grok" },
  autoclaw: { label: "AutoClaw" },
});

// Windows 是当前参考平台；macOS/Linux 的统一默认是“代码路径存在但未完成真机验收”。
// 个别数据源有已知硬阻塞时在 SOURCES 中单独覆盖。
const DEFAULT_SOURCE_SUPPORT = cap("supported", "compatible", "compatible", {
  darwin: "已有跨平台路径或原生库，待真实客户端样本验收",
  linux: "已有跨平台路径或原生库，待真实客户端样本验收",
});

function sourceEntry(id, def, platform) {
  return {
    id,
    label: def.label,
    ...statusEntry(def.support || DEFAULT_SOURCE_SUPPORT, platform),
    localClient: def.localClient !== false,
  };
}

const cloudOnly = { localClient: false };
const localClient = { localClient: true };

const CHANNELS = Object.freeze({
  accio: { label: "Accio 国际版", ...cloudOnly },
  accio_cn: { label: "Accio 国内版", ...cloudOnly },
  autoclaw: {
    label: "AutoClaw",
    ...localClient,
    credentialDependency: true,
    localImport: cap("supported", "compatible", "compatible", {
      darwin: "已实现 Keychain + v10 CBC 读取，待真实 AutoClaw 客户端版本验收",
      linux: "已实现 Secret Service + v10 CBC 读取，待真实 AutoClaw 客户端版本验收",
    }),
    ideSwitch: cap("supported", "blocked", "blocked", {
      default: "切换链依赖 Windows 客户端与进程能力",
    }),
  },
  autoclaw_intl: {
    label: "AutoClaw 国际版",
    ...localClient,
    credentialDependency: true,
    localImport: cap("supported", "compatible", "compatible", {
      darwin: "已实现 Keychain + v10 CBC 读取，待真实 AutoClaw 国际版验收",
      linux: "已实现 Secret Service + v10 CBC 读取，待真实 AutoClaw 国际版验收",
    }),
    ideSwitch: cap("supported", "blocked", "blocked", {
      default: "切换链依赖 Windows 客户端与进程能力",
    }),
  },
  catpaw: { label: "CatPaw", ...localClient },
  cline_free: { label: "Cline Free", ...localClient },
  cline_pass: { label: "Cline Pass", ...localClient },
  codearts: { label: "CodeArts", ...cloudOnly },
  lobster: { label: "LobsterAI", ...cloudOnly },
  loomy: { label: "Loomy", ...cloudOnly },
  modelscope: { label: "ModelScope", ...cloudOnly },
  qoder: {
    label: "Qoder CN",
    ...localClient,
    credentialDependency: true,
    inference: cap("supported", "blocked", "blocked", {
      darwin: "每请求签名来自本机 Qoder 客户端；当前定位与运行时资源仍是 Windows 链",
      linux: "每请求签名来自本机 Qoder 客户端；当前定位与运行时资源仍是 Windows 链",
    }),
    localImport: cap("supported", "compatible", "compatible", {
      darwin: "已实现 Keychain + v10 CBC 读取，待真实 Qoder 客户端版本验收",
      linux: "已实现 Secret Service + v10 CBC 读取，待真实 Qoder 客户端版本验收",
    }),
    ideSwitch: cap("supported", "blocked", "blocked", {
      default: "切换链依赖 Windows 客户端安装目录与注册表",
    }),
  },
  qoder_intl: {
    label: "Qoder International",
    ...localClient,
    credentialDependency: true,
    inference: cap("supported", "blocked", "blocked", {
      default: "每请求签名依赖本机 Qoder 客户端",
    }),
    localImport: cap("supported", "compatible", "compatible", {
      darwin: "已实现 Keychain + v10 CBC 读取，待真实 Qoder 国际版验收",
      linux: "已实现 Secret Service + v10 CBC 读取，待真实 Qoder 国际版验收",
    }),
    ideSwitch: cap("supported", "blocked", "blocked", {
      default: "切换链依赖 Windows 客户端安装目录与注册表",
    }),
  },
  raccoon: {
    label: "商汤小浣熊",
    ...localClient,
    localImport: cap("supported", "compatible", "compatible"),
    ideSwitch: cap("supported", "blocked", "blocked", {
      default: "客户端保护依赖 Windows tasklist/taskkill/注册表",
    }),
  },
  trae: { label: "Trae", ...localClient },
  workbuddy: {
    label: "WorkBuddy",
    ...localClient,
    ideSwitch: cap("supported", "blocked", "blocked", {
      default: "客户端保护依赖 Windows 进程、注册表与 .exe 定位",
    }),
  },
  workbuddy_ai: {
    label: "WorkBuddy AI",
    ...localClient,
    ideSwitch: cap("supported", "blocked", "blocked", {
      default: "客户端保护依赖 Windows 进程、注册表与 .exe 定位",
    }),
  },
  zcode: {
    label: "ZCode",
    ...localClient,
    localImport: cap("supported", "compatible", "compatible"),
    ideSwitch: cap("supported", "compatible", "compatible"),
  },
});

const DEFAULT_CHANNEL_INFERENCE = cap("supported", "compatible", "compatible", {
  darwin: "协议转发链路平台无关，账号来源与运行时依赖仍需逐渠道验收",
  linux: "协议转发链路平台无关，账号来源与运行时依赖仍需逐渠道验收",
});
const DEFAULT_CHANNEL_LOCAL_IMPORT = cap("supported", "compatible", "compatible", {
  darwin: "已有本机凭据扫描路径，待目标客户端真机验收",
  linux: "已有本机凭据扫描路径，待目标客户端真机验收",
});

function channelEntry(id, def, platform) {
  const entry = {
    id,
    label: def.label,
    localClient: !!def.localClient,
    credentialDependency: !!def.credentialDependency,
    inference: statusEntry(def.inference || DEFAULT_CHANNEL_INFERENCE, platform),
  };
  entry.localImport = def.localClient
    ? statusEntry(def.localImport || DEFAULT_CHANNEL_LOCAL_IMPORT, platform)
    : null;
  entry.ideSwitch = def.ideSwitch ? statusEntry(def.ideSwitch, platform) : null;
  return entry;
}

const SQLCIPHER_PLATFORMS = new Set(["win32-x64", "darwin-x64", "darwin-arm64", "linux-x64"]);

function sqlcipherSupport(platform, arch) {
  if (SQLCIPHER_PLATFORMS.has(`${platform}-${arch}`)) {
    return { status: "supported", reason: "" };
  }
  return { status: "blocked", reason: `未附带 ${platform}-${arch} SQLCipher 原生库` };
}

function assertPlatform(value) {
  const name = platformName(value);
  if (!PLATFORMS.includes(name)) throw new Error(`未知平台：${value || "(empty)"}`);
  return name;
}

/** 当前（或指定）平台的完整能力快照。 */
function snapshot(opts = {}) {
  const name = assertPlatform(opts.platform || process.platform);
  const arch = opts.arch || process.arch;
  const features = {};
  for (const [id, def] of Object.entries(FEATURES)) {
    features[id] = { id, label: def.label, ...statusEntry(def.support, name) };
  }
  features["native.sqlcipher"] = { id: "native.sqlcipher", label: "SQLCipher 原生库", ...sqlcipherSupport(name, arch) };

  const runtime = opts.runtime || null;
  const credentialAvailable = runtime && runtime.credentialBackend
    ? runtime.credentialBackend.available !== false
    : true;
  if (!credentialAvailable) {
    const reason = (runtime.credentialBackend && runtime.credentialBackend.reason)
      || "系统凭据后端不可用";
    features["credentials.chromium-os-crypt"] = {
      ...features["credentials.chromium-os-crypt"],
      status: "blocked",
      reason,
    };
  }
  const desktopRuntime = runtime && runtime.desktop;
  if (desktopRuntime && desktopRuntime.tray && desktopRuntime.tray.available === false) {
    features["desktop.tray"] = {
      ...features["desktop.tray"],
      status: "blocked",
      reason: desktopRuntime.tray.reason || "系统托盘创建失败",
    };
  } else if (desktopRuntime && desktopRuntime.tray && desktopRuntime.tray.reason) {
    features["desktop.tray"] = { ...features["desktop.tray"], reason: desktopRuntime.tray.reason };
  }
  if (desktopRuntime && desktopRuntime.globalShortcut && desktopRuntime.globalShortcut.available === false) {
    features["desktop.global-shortcut"] = {
      ...features["desktop.global-shortcut"],
      status: "blocked",
      reason: desktopRuntime.globalShortcut.reason || "当前桌面会话不支持全局快捷键",
    };
  } else if (desktopRuntime && desktopRuntime.globalShortcut && desktopRuntime.globalShortcut.reason) {
    features["desktop.global-shortcut"] = {
      ...features["desktop.global-shortcut"],
      reason: desktopRuntime.globalShortcut.reason,
    };
  }
  const secureStorage = runtime && runtime.secureStorage;
  if (secureStorage && secureStorage.encrypted === false && secureStorage.policy && secureStorage.policy.failClosed) {
    features["secure-storage"] = {
      ...features["secure-storage"],
      status: "blocked",
      reason: secureStorage.reason || "生产环境安全存储不可用，凭据写入已 fail-closed",
    };
  }
  const channels = Object.entries(CHANNELS).map(([id, def]) => channelEntry(id, def, name));
  if (!credentialAvailable) {
    for (const channel of channels) {
      if (!channel.credentialDependency || !channel.localImport) continue;
      channel.localImport = { status: "blocked", reason: (runtime.credentialBackend && runtime.credentialBackend.reason) || "系统凭据后端不可用" };
    }
  }

  return {
    schema: SCHEMA,
    platform: {
      name,
      arch,
      supported: true,
    },
    runtime,
    features,
    sources: Object.entries(SOURCES).map(([id, def]) => sourceEntry(id, def, name)),
    channels,
  };
}

/** 校验实际适配器集合与能力矩阵是否一致，防止新增源/渠道漏登记。 */
function audit({ sourceIds = [], channelIds = [] } = {}) {
  const problems = [];
  for (const id of sourceIds) if (!SOURCES[id]) problems.push(`用量数据源缺少能力登记：${id}`);
  for (const id of channelIds) if (!CHANNELS[id]) problems.push(`代理渠道缺少能力登记：${id}`);

  for (const [id, def] of Object.entries(SOURCES)) {
    const spec = def.support || DEFAULT_SOURCE_SUPPORT;
    for (const platform of PLATFORMS) {
      if (!STATUSES.includes(spec[platform])) problems.push(`数据源 ${id}/${platform} 状态非法：${spec[platform]}`);
    }
  }
  for (const [id, def] of Object.entries(CHANNELS)) {
    const localImport = def.localClient ? (def.localImport || DEFAULT_CHANNEL_LOCAL_IMPORT) : null;
    const specs = [def.inference || DEFAULT_CHANNEL_INFERENCE, localImport, def.ideSwitch].filter(Boolean);
    for (const spec of specs) {
      for (const platform of PLATFORMS) {
        if (!STATUSES.includes(spec[platform])) problems.push(`渠道 ${id}/${platform} 状态非法：${spec[platform]}`);
      }
    }
  }
  return problems;
}

module.exports = {
  SCHEMA,
  PLATFORMS,
  STATUSES,
  FEATURES,
  SOURCES,
  CHANNELS,
  statusEntry,
  sqlcipherSupport,
  snapshot,
  audit,
};
