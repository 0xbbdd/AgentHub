/**
 * 平台能力 Store：启动时拉取主进程能力矩阵，供页面按平台门控入口。
 *
 * 未加载或加载失败时保持 fail-open，避免网络/IPC 抖动把原有功能整体锁死；
 * 只有后端明确返回 blocked / not-applicable 时才禁用。
 */
import { defineStore } from "pinia";
import {
  getPlatformCapabilities,
  isElectron,
  type PlatformCapabilitySnapshot,
  type PlatformChannelCapability,
  type PlatformCapabilityStatus,
} from "../api/ipc";
import { isWebTransport } from "../api/caps";

export type ChannelCapabilityAction = "inference" | "localImport" | "ideSwitch";

export interface CapabilityState {
  status: PlatformCapabilityStatus;
  reason: string;
}

export const usePlatformStore = defineStore("platform", {
  state: () => ({
    snapshot: null as PlatformCapabilitySnapshot | null,
    loading: false,
    error: "",
  }),
  getters: {
    ready: (s) => !!s.snapshot,
    platformName: (s) => s.snapshot?.platform?.name || "",
    platformLabel: (s) => {
      const name = s.snapshot?.platform?.name;
      if (name === "win32") return "Windows";
      if (name === "darwin") return "macOS";
      if (name === "linux") return "Linux";
      return "";
    },
    secureStorage: (s) => s.snapshot?.runtime?.secureStorage || null,
    channel: (s) => (id: string): PlatformChannelCapability | null =>
      (s.snapshot?.channels || []).find((item) => item.id === id) || null,
    source: (s) => (id: string) => (s.snapshot?.sources || []).find((item) => item.id === id) || null,
    feature: (s) => (id: string) => s.snapshot?.features?.[id] || null,
  },
  actions: {
    async load(force = false) {
      if (this.loading || (this.snapshot && !force)) return this.snapshot;
      // Web 网关形态的能力面由 /api/capabilities 管理，桌面本地命令不应每轮启动都触发一次 deny。
      if (!isElectron() && isWebTransport()) return null;
      this.loading = true;
      this.error = "";
      try {
        this.snapshot = await getPlatformCapabilities();
        return this.snapshot;
      } catch (error) {
        this.error = String((error as Error)?.message || error);
        return this.snapshot;
      } finally {
        this.loading = false;
      }
    },

    capability(channelId: string, action: ChannelCapabilityAction): CapabilityState | null {
      const channel = this.channel(channelId);
      if (!channel) return null;
      const value = channel[action];
      if (!value) return null;
      return { status: value.status, reason: value.reason || "" };
    },

    /** 只有明确 blocked / not-applicable 才禁用；unknown、compatible、fallback 保持可用。 */
    blocked(channelId: string, action: ChannelCapabilityAction): boolean {
      const cap = this.capability(channelId, action);
      return !!cap && (cap.status === "blocked" || cap.status === "not-applicable");
    },

    reason(channelId: string, action: ChannelCapabilityAction): string {
      return this.capability(channelId, action)?.reason || "";
    },

    /** 兼容模式需要 UI 提示，但不能阻止用户使用。 */
    warning(channelId: string, action: ChannelCapabilityAction): string {
      const cap = this.capability(channelId, action);
      if (!cap) return "";
      if (cap.status === "compatible") return cap.reason || "当前平台为兼容实现，尚未完成真机验收";
      if (cap.status === "fallback") return cap.reason || "当前平台使用降级替代路径";
      return "";
    },

    sourceBlocked(sourceId: string): boolean {
      const item = this.source(sourceId);
      return !!item && (item.status === "blocked" || item.status === "not-applicable");
    },

    sourceReason(sourceId: string): string {
      return this.source(sourceId)?.reason || "";
    },

    sourceWarning(sourceId: string): string {
      const item = this.source(sourceId);
      if (!item) return "";
      if (item.status === "compatible") return item.reason || "当前平台为兼容实现，尚未完成真机验收";
      if (item.status === "fallback") return item.reason || "当前平台使用降级替代路径";
      return "";
    },
  },
});
