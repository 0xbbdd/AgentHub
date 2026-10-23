<!--
  ============================================================
   作者：沐晖
   日期：2026-10-22
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<!-- 沐晖制作：AgentHub Agent中控台入口 -->
<script setup lang="ts">
import zhCn from "element-plus/es/locale/lang/zh-cn";
import { ElConfigProvider } from "element-plus";
import { defineAsyncComponent, onMounted, onUnmounted, ref, watch } from "vue";
import { useAppStore } from "./stores/app";
import { useSyncStore } from "./stores/sync";
import { useUsageStore } from "./stores/usage";
import Sidebar from "./components/Sidebar.vue";
import PageTabs from "./components/PageTabs.vue";
import SettingsDialog from "./components/config/SettingsDialog.vue";
import ConfigSkillsSection from "./components/config/ConfigSkillsSection.vue";
import ConfigUsageSection from "./components/config/ConfigUsageSection.vue";
import ConfigProxySection from "./components/config/ConfigProxySection.vue";
import SkillsHelpDialog from "./components/SkillsHelpDialog.vue";
// 页面视图按需拆包：v-if 负责首次访问才挂载，异步组件进一步避免启动时解析全部页面代码。
// Vite 会为每个 import() 生成独立 chunk；浏览器缓存保证再次挂载无需重复下载。
const asyncView = (loader: () => Promise<unknown>) => defineAsyncComponent(loader as () => Promise<{ default: object }>);

const SkillsDashboardView = asyncView(() => import("./views/skills/SkillsDashboardView.vue"));
const SkillsLibraryView = asyncView(() => import("./views/skills/SkillsLibraryView.vue"));
const SkillsDedupView = asyncView(() => import("./views/skills/SkillsDedupView.vue"));
const SkillsSyncView = asyncView(() => import("./views/skills/SkillsSyncView.vue"));
const SkillsWebdavView = asyncView(() => import("./views/skills/SkillsWebdavView.vue"));
const SkillsSkillDetailView = asyncView(() => import("./views/skills/SkillsSkillDetailView.vue"));
const SyncOverviewView = asyncView(() => import("./views/sync/OverviewView.vue"));
const SyncDetailView = asyncView(() => import("./views/sync/DetailView.vue"));
const SyncCostsView = asyncView(() => import("./views/sync/CostsView.vue"));
const SyncBillingRulesView = asyncView(() => import("./views/sync/BillingRulesView.vue"));
const SyncLogView = asyncView(() => import("./views/sync/LogView.vue"));
const ProxyHomeView = asyncView(() => import("./views/proxy/ProxyHomeView.vue"));
const ProxyKeysView = asyncView(() => import("./views/proxy/ProxyKeysView.vue"));
const ProxyProvidersView = asyncView(() => import("./views/proxy/ProxyProvidersView.vue"));
const ProxyAgentsView = asyncView(() => import("./views/proxy/ProxyAgentsView.vue"));
const ProxyExpiryView = asyncView(() => import("./views/proxy/ProxyExpiryView.vue"));
const ProxyModelsView = asyncView(() => import("./views/proxy/ProxyModelsView.vue"));
const ProxyStatsView = asyncView(() => import("./views/proxy/ProxyStatsView.vue"));
const ProxyPoolSyncView = asyncView(() => import("./views/proxy/ProxyPoolSyncView.vue"));
const ProxyCcSwitchView = asyncView(() => import("./views/proxy/ProxyCcSwitchView.vue"));
const ProxyLogView = asyncView(() => import("./views/proxy/ProxyLogView.vue"));
const ProxyNetworkView = asyncView(() => import("./views/proxy/ProxyNetworkView.vue"));
const MemoryDashboardView = asyncView(() => import("./views/memory/DashboardView.vue"));
const MemoryBrowseView = asyncView(() => import("./views/memory/BrowseView.vue"));
const MemoryProjectsView = asyncView(() => import("./views/memory/ProjectsView.vue"));
const MemoryProfileView = asyncView(() => import("./views/memory/ProfileView.vue"));
const MemoryAgentsView = asyncView(() => import("./views/memory/AgentsView.vue"));
const MemoryIndexView = asyncView(() => import("./views/memory/IndexView.vue"));
const MemoryAutoView = asyncView(() => import("./views/memory/AutoView.vue"));
const MemoryImportView = asyncView(() => import("./views/memory/ImportView.vue"));
const MemorySyncView = asyncView(() => import("./views/memory/SyncView.vue"));

import { useMemoryStore } from "./stores/memory";
import * as api from "./api/ipc";
import type { UpdateEvent } from "./types";

const app = useAppStore();
const usage = useSyncStore();
const memory = useMemoryStore();

/** 记忆中枢默认页签：ui.defaultTab（只在首次进入该模块时生效，之后记住用户点过的页） */
let memoryDefaultApplied = false;
const usageData = useUsageStore();

let dispose: (() => void)[] = [];

onMounted(() => {
  app.load();
  usage.load(); // 用量同步：加载配置/数据源/进度快照；仅任务运行期间轮询
  usageData.startDayWatcher(); // 跨天换日守护：过 0 点自动把「今日/本月」口径的数据换到新一天
  app.refreshUpdateStatus(); // 启动拉一次更新状态，维护设置齿轮红点
  // 更新事件全局唯一监听：focus-update 打开设置弹窗 · 通用并自增信号（滚动高亮由
  // ConfigGeneralSection 据 configFocusUpdate 执行）；state 回流顺带维护红点（浏览器预览无桥接返回 undefined）
  const offFocusUpdate = api.onUpdateEvent((e) => {
    const ev = e as UpdateEvent;
    if (ev.event === "focus-update") {
      app.openSettings("general");
      app.configFocusUpdate++;
      return;
    }
    if (ev.event === "usage-local-synced") {
      // 后台半小时本地统计完成：静默重拉总览数据（在途请求/失败都已在 store 内兜底）
      usageData.refreshQuietly();
      return;
    }
    if (ev.event === "usage-sync-finished") {
      // 空闲状态不再永久轮询；主进程完成事件拉取最终进度，并触发各用量页既有的 running true→false 刷新。
      void usage.refreshProgress();
      return;
    }
    // 记忆中枢事件分流：store.onEvent 维护新记忆高亮/索引进度/统计重拉
    if ((ev as { event?: string }).event === "memory") {
      memory.onEvent(ev as unknown as Parameters<typeof memory.onEvent>[0]);
      return;
    }
    // main 侧托盘等直写配置后的广播：重拉内存快照，防设置页旧快照把新值冲掉
    if ((ev as { event?: string }).event === "config-changed") {
      app.refreshConfig();
      return;
    }
    app.updateAvailable = ev.status === "available" || ev.status === "downloaded";
  });
  if (offFocusUpdate) dispose.push(offFocusUpdate);
});
onUnmounted(() => {
  dispose.forEach((fn) => fn());
  dispose = [];
});

/** 记忆中枢默认页签：ui.defaultTab（首次进入该模块时落到配置页签，之后记住用户点过的页） */
watch(
  () => app.activeModule,
  (m) => {
    if (m !== "memory" || memoryDefaultApplied) return;
    memoryDefaultApplied = true;
    void memory.loadAll().then(() => {
      const def = memory.cfg("ui.defaultTab", "dashboard");
      if (typeof def === "string" && app.pagesOf.some((p) => p.id === def)) app.activePage = def;
    });
  }
);

/** 当前是否停在某模块某页（v-show 条件） */
const on = (mod: string, page: string) => app.activeModule === mod && app.activePage === page;

/** 懒挂载：页面首次进入才挂载（数据加载走各自的 onMounted），之后 v-show 保活不切状态。
    避免启动时就把十几个页面的扫描/探测 IPC 全打一遍。
    首键要等 load() 定下启动板块（自定义排序第一个）再记：loaded 翻真前的初始默认值
    不能抢先挂载，否则启动板块在别的模块时技能仓库仪表盘会被白白拉起一遍 */
const visited = ref<Record<string, boolean>>({});
watch(
  [() => app.loaded, () => `${app.activeModule}/${app.activePage}`],
  ([loaded, k]) => {
    if (loaded) {
      visited.value[k] = true;
      // 同一处顺带镜像「上次停留的页面」：轻量模式销毁界面后唤回时据此回到原处
      // （loaded 翻真前的默认值不记，否则会把恢复出来的真实位置冲掉）
      app.mirrorActivePage();
    }
  },
  { immediate: true }
);
const seen = (mod: string, page: string) => !!visited.value[`${mod}/${page}`];
</script>

<template>
  <el-config-provider :locale="zhCn">
  <!-- 全库唯一的 locale 注入点：按需注册后没有 app.use(ElementPlus, { locale }) 了，
       el-date-picker 面板的月份/星期等内置文案全靠这里，删掉会静默回退英文。
       provider 自身不渲染 DOM 节点（config-provider 直接 renderSlot default），
       包一层不改变结构与 .app 的背景层叠。 -->
  <div class="app">
    <Sidebar />
    <PageTabs />
    <main class="main glass">
      <!-- 用量统计模块的数据源顶栏（原应用 AppBar）：仅「用量统计 · 总览」页显示；样式作用域在组件根上 -->
      <SyncTopBar v-if="on('sync', 'overview')" />
      <div class="pages">
        <SkillsDashboardView v-if="seen('skills', 'dashboard')" v-show="on('skills', 'dashboard')" />
        <SkillsLibraryView v-if="seen('skills', 'library')" v-show="on('skills', 'library')" />
        <SkillsDedupView v-if="seen('skills', 'dedup')" v-show="on('skills', 'dedup')" />
        <SkillsSyncView v-if="seen('skills', 'sync')" v-show="on('skills', 'sync')" />
        <SkillsWebdavView v-if="seen('skills', 'webdav')" v-show="on('skills', 'webdav')" />
        <SkillsSkillDetailView v-if="seen('skills', 'skill-detail')" v-show="on('skills', 'skill-detail')" />
        <!-- 用量统计五页：.sync-page 的样式作用域要求自身同时带 .sync-scope（见 styles/sync.css） -->
        <SyncOverviewView v-if="seen('sync', 'overview')" v-show="on('sync', 'overview')" class="sync-scope" />
        <SyncDetailView v-if="seen('sync', 'detail')" v-show="on('sync', 'detail')" class="sync-scope" />
        <SyncCostsView v-if="seen('sync', 'costs')" v-show="on('sync', 'costs')" class="sync-scope" />
        <SyncBillingRulesView v-if="seen('sync', 'billing')" v-show="on('sync', 'billing')" class="sync-scope" />
        <SyncLogView v-if="seen('sync', 'log')" v-show="on('sync', 'log')" class="sync-scope" />
        <ProxyHomeView v-if="seen('proxy', 'home')" v-show="on('proxy', 'home')" />
        <ProxyKeysView v-if="seen('proxy', 'keys')" v-show="on('proxy', 'keys')" />
        <ProxyProvidersView v-if="seen('proxy', 'providers')" v-show="on('proxy', 'providers')" />
        <ProxyAgentsView v-if="seen('proxy', 'agents')" v-show="on('proxy', 'agents')" />
        <ProxyExpiryView v-if="seen('proxy', 'expiry')" v-show="on('proxy', 'expiry')" />
        <ProxyModelsView v-if="seen('proxy', 'models')" v-show="on('proxy', 'models')" />
        <ProxyStatsView v-if="seen('proxy', 'stats')" v-show="on('proxy', 'stats')" />
        <ProxyPoolSyncView v-if="seen('proxy', 'poolsync')" v-show="on('proxy', 'poolsync')" />
        <ProxyCcSwitchView v-if="seen('proxy', 'ccswitch')" v-show="on('proxy', 'ccswitch')" />
        <ProxyLogView v-if="seen('proxy', 'proxylog')" v-show="on('proxy', 'proxylog')" />
        <ProxyNetworkView v-if="seen('proxy', 'netproxy')" v-show="on('proxy', 'netproxy')" />
        <!-- 记忆中枢九页：各页自带 .memory-scope 容器（样式作用域见 styles/memory.css）；
             模型与网关已并入配置页子板块，调用统计并入仪表盘；待确认并入记忆浏览 -->
        <MemoryDashboardView v-if="seen('memory', 'dashboard')" v-show="on('memory', 'dashboard')" class="page" />
        <MemoryBrowseView v-if="seen('memory', 'browse')" v-show="on('memory', 'browse')" class="page" />
        <MemoryProjectsView v-if="seen('memory', 'projects')" v-show="on('memory', 'projects')" class="page" />
        <MemoryProfileView v-if="seen('memory', 'profile')" v-show="on('memory', 'profile')" class="page" />
        <MemoryAgentsView v-if="seen('memory', 'agents')" v-show="on('memory', 'agents')" class="page" />
        <MemoryIndexView v-if="seen('memory', 'index')" v-show="on('memory', 'index')" class="page" />
        <MemoryAutoView v-if="seen('memory', 'auto')" v-show="on('memory', 'auto')" class="page" />
        <MemoryImportView v-if="seen('memory', 'import')" v-show="on('memory', 'import')" class="page" />
        <MemorySyncView v-if="seen('memory', 'sync')" v-show="on('memory', 'sync')" class="page" />
        <!-- 各模块的配置页：右上「配置」按钮切换到这里的页面（page + cfg-body 组合出页壳与留白）；
             配置页内部的二级子板块 tab 由各 section 自己渲染 -->
        <div v-if="seen('skills', 'config')" v-show="on('skills', 'config')" class="page cfg-body">
          <ConfigSkillsSection />
        </div>
        <div v-if="seen('sync', 'config')" v-show="on('sync', 'config')" class="page cfg-body">
          <ConfigUsageSection />
        </div>
        <div v-if="seen('proxy', 'config')" v-show="on('proxy', 'config')" class="page cfg-body">
          <ConfigProxySection />
        </div>
        <div v-if="seen('memory', 'config')" v-show="on('memory', 'config')" class="page cfg-body">
          <ConfigMemorySection />
        </div>
      </div>
    </main>
    <!-- 常驻挂载：显隐交给 el-dialog 自己管，进场动画才不会在 v-if 挂载时被跳过 -->
    <SyncDialog />
    <SkillsHelpDialog />
    <SettingsDialog />
    <MemoryDetailDrawer
      :show="memory.detailDrawerOpen"
      :id="memory.detailDrawerId"
      @close="memory.closeDetail"
      @changed="memory.onMemoryUpdated"
    />
  </div>
  </el-config-provider>
</template>
