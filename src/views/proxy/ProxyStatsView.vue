<!-- 反代网关 · 用量统计：指标卡 + 近 7 日趋势 + TOP 排行（渠道/模型/Key/账号）+ 明细分页（方案 §7 stats.html）
     口径：不设日聚合冗余表，全部由 usage_requests 流水直查 GROUP BY；流水保留期可配
     （设置 · 反代网关「余额历史 / 请求流水保留」，默认 90 天），本页「清理」按当前值立即删一轮 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import * as api from "../../api/ipc";
import type { ProxyStatsOverview, ProxyStatsDetail } from "../../types";
import { useAppStore } from "../../stores/app";
import { fmtInt, fmtK, fmtMs, fmtTime, fmtDate, channelName, statusCls } from "./format";
import { coalesceAsync } from "../../utils/timing";
import { toast as ElMessage } from "../../utils/toast";

const app = useAppStore();

const DAYS = 7;
const ov = ref<ProxyStatsOverview | null>(null);
const detail = ref<ProxyStatsDetail | null>(null);
const page = ref(1);
const pageSize = 10;
const dim = ref<"channel" | "model" | "key" | "account">("channel");
const err = ref("");

const DIMS = [
  { value: "channel" as const, label: "渠道" },
  { value: "model" as const, label: "模型" },
  { value: "key" as const, label: "Key" },
  { value: "account" as const, label: "账号" },
];

const topRows = computed(() => {
  const rows = ov.value?.tops[dim.value] || [];
  const total = rows.reduce((s, r) => s + r.req, 0) || 1;
  return rows.map((r) => ({ ...r, label: dim.value === "channel" ? channelName(r.name) : r.name, pct: Math.round((r.req / total) * 100) }));
});

const totalPages = computed(() => Math.max(1, Math.ceil((detail.value?.total || 0) / pageSize)));

// 近 7 日趋势：零依赖 SVG 折线（对齐设计稿 charts.js 的 line）
const trendPath = computed(() => {
  const t = ov.value?.trend || [];
  if (!t.length) return { line: "", area: "", max: 0 };
  const w = 560;
  const h = 96;
  const max = Math.max(...t.map((x) => x.req), 1);
  const pts = t.map((x, i) => [((i + 0.5) / t.length) * w, h - 8 - (x.req / max) * (h - 20)] as const);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${h} L${pts[0][0].toFixed(1)},${h} Z`;
  return { line, area, max };
});

async function refresh() {
  try {
    ov.value = await api.proxyStatsOverview(DAYS);
    err.value = "";
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

async function loadDetail() {
  try {
    detail.value = await api.proxyStatsDetail({ page: page.value, pageSize });
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

function goPage(p: number) {
  page.value = Math.min(totalPages.value, Math.max(1, p));
  loadDetail();
}

// ===== 清理流水：范围二选一（仅超期=按设置页保留期删旧 / 全部=清空整表），不可恢复所以先问一道 =====
const cleanOpen = ref(false);
const cleanScope = ref<"expired" | "all">("expired");
const cleaning = ref(false);
function openClean() {
  cleanScope.value = "expired"; // 每次打开回默认档，防上次选的「全部」被顺手确认
  cleanOpen.value = true;
}
async function doCleanup() {
  cleaning.value = true;
  try {
    const all = cleanScope.value === "all";
    const r = await api.proxyStatsCleanup(undefined, all);
    ElMessage.success(
      all
        ? `已清空全部流水 ${fmtInt(r.deleted)} 条`
        : `已清理保留期（${app.config.proxy.usageRetentionDays} 天）之前的流水 ${fmtInt(r.deleted)} 条`,
    );
    cleanOpen.value = false;
    page.value = 1;
    await Promise.all([refresh(), loadDetail()]);
  } catch (e) {
    err.value = String((e as Error).message || e);
  } finally {
    cleaning.value = false;
  }
}

/** 本页是否处于前台：页面经 v-show 保活，事件刷新只在激活时跑，切走即停 */
const active = computed(() => app.activeModule === "proxy" && app.activePage === "stats");

// 事件合流：概览 + 明细一起拉，1s 窗口合并防重入；明细保持当前页码（最新记录在最前）
const scheduleRefresh = coalesceAsync(() => Promise.all([refresh(), loadDetail()]), 1000);

watch(active, (on) => {
  if (on) scheduleRefresh();
  else scheduleRefresh.cancel();
});

let offEvent: (() => void) | undefined;

onMounted(() => {
  refresh();
  loadDetail();
  // 请求流水变化（后端已节流为每 2s 至多一条）驱动本页刷新，无需轮询；
  // 明细/趋势/TOP 全部实时直查 usage_requests 流水，事件即变更信号
  offEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string };
    if (p.event !== "proxy" || p.type !== "request") return;
    if (!active.value) return;
    scheduleRefresh();
  });
});

onUnmounted(() => {
  scheduleRefresh.cancel();
  if (offEvent) offEvent();
});
</script>

<template>
  <section class="page">
    <div class="page-body">
      <div v-if="err" class="card err-card"><div class="set-desc err-text">{{ err }}</div></div>
      <div class="kpis">
        <div class="kpi"><span>今日请求</span><b class="acc">{{ fmtInt(ov?.today.req || 0) }}</b></div>
        <div class="kpi"><span>今日 Token</span><b>{{ fmtK(ov?.today.tokens || 0) }}</b></div>
        <div class="kpi"><span>成功率</span><b>{{ (ov?.today.successRate ?? 100).toFixed(1) }}%</b></div>
        <div class="kpi"><span>TTFT 均值</span><b>{{ fmtMs(ov?.today.ttftAvg || 0) }}</b></div>
      </div>

      <div class="card" style="margin-top: 12px">
        <div class="card-title">近 {{ DAYS }} 日请求趋势 <span class="right">峰值 {{ fmtInt(trendPath.max) }} / 日</span></div>
        <svg viewBox="0 0 560 96" class="trend" preserveAspectRatio="none">
          <path v-if="trendPath.area" :d="trendPath.area" class="trend-area" />
          <path v-if="trendPath.line" :d="trendPath.line" class="trend-line" />
        </svg>
        <div class="trend-days">
          <span v-for="t in ov?.trend || []" :key="t.day">{{ t.day.slice(5) }}</span>
        </div>
      </div>

      <div class="card" style="margin-top: 12px">
        <div class="card-title">
          用量占比 TOP
          <div class="chips" style="margin-left: 8px">
            <button v-for="d in DIMS" :key="d.value" class="chip" :class="{ active: dim === d.value }" @click="dim = d.value">{{ d.label }}</button>
          </div>
        </div>
        <div class="rows">
          <div v-for="r in topRows" :key="r.name" class="row">
            <div class="grow"><div class="name">{{ r.label }}</div></div>
            <div class="ratio" style="flex: 1">
              <div class="ratio-track"><div class="ratio-fill" :style="{ width: r.pct + '%' }"></div></div>
              <span class="num">{{ r.pct }}% · {{ fmtInt(r.req) }} 次 · {{ fmtK(r.tokens) }}</span>
            </div>
          </div>
          <div v-if="!topRows.length" class="set-desc" style="padding: 8px 0">近 {{ DAYS }} 日暂无请求数据</div>
        </div>
      </div>

      <div class="card" style="margin-top: 12px">
        <div class="card-title">
          请求明细
          <span class="right">{{ fmtInt(detail?.total || 0) }} 条 · 第 {{ page }}/{{ totalPages }} 页
            <button class="btn btn-sm" style="margin-left: 8px" @click="openClean"><i class="ph ph-broom"></i> 清理</button>
          </span>
        </div>
        <div class="tbl-wrap">
          <table class="tbl">
            <tbody>
              <tr><th>时间</th><th>模型</th><th>渠道</th><th>KEY</th><th>账号</th><th>状态</th><th>请求 Tok</th><th>缓存命中</th><th>响应 Tok</th><th>TTFT</th><th>耗时</th></tr>
              <tr v-for="r in detail?.rows || []" :key="r.id">
                <td class="mono">
                  <el-tooltip :content="fmtDate(r.ts)" placement="top">
                    <span>{{ fmtTime(r.ts) }}</span>
                  </el-tooltip>
                </td>
                <td class="mono">{{ r.model || "-" }}</td>
                <td>{{ channelName(r.channel) }}</td>
                <td class="mono">{{ r.keyName || "-" }}</td>
                <td>{{ r.accountName || "-" }}</td>
                <td>
                  <el-tooltip :content="r.error" :disabled="!r.error" placement="top">
                    <span class="tag" :class="statusCls(r.status)">{{ r.status || "-" }}</span>
                  </el-tooltip>
                </td>
                <td class="mono">{{ fmtInt(r.promptTokens) }}</td>
                <td class="mono">
                  <el-tooltip v-if="r.cacheReadTokens" :content="`缓存读 ${fmtInt(r.cacheReadTokens)} / 输入 ${fmtInt(r.promptTokens)}${r.cacheCreationTokens ? ` / 缓存写 ${fmtInt(r.cacheCreationTokens)}` : ''}`" placement="top">
                    <span>{{ r.promptTokens ? Math.round((r.cacheReadTokens / r.promptTokens) * 100) + "%" : "-" }}</span>
                  </el-tooltip>
                  <span v-else>-</span>
                </td>
                <td class="mono">{{ fmtInt(r.completionTokens) }}</td>
                <td class="mono">{{ fmtMs(r.ttftMs) }}</td>
                <td class="mono">{{ fmtMs(r.latencyMs) }}</td>
              </tr>
              <tr v-if="!(detail?.rows || []).length">
                <td colspan="11" style="text-align: center; color: var(--text-3); padding: 18px">暂无请求明细</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="pager">
          <button class="btn btn-sm" :disabled="page <= 1" @click="goPage(page - 1)">上一页</button>
          <button class="btn btn-sm" :disabled="page >= totalPages" @click="goPage(page + 1)">下一页</button>
        </div>
      </div>
      <!-- 清理确认弹窗：删的是不可恢复的历史，范围与后果都写明白 -->
      <Teleport to="body">
        <div v-if="cleanOpen" class="p-mask" @click.self="cleanOpen = false">
          <div class="p-dlg glass">
            <div class="p-title">清理请求流水</div>
            <div class="chips" style="margin-bottom: 8px">
              <button class="chip" :class="{ active: cleanScope === 'expired' }" @click="cleanScope = 'expired'">仅超期流水</button>
              <button class="chip" :class="{ active: cleanScope === 'all' }" @click="cleanScope = 'all'">全部流水</button>
            </div>
            <div class="set-desc">
              <template v-if="cleanScope === 'expired'">
                将删除保留期（设置页当前为 {{ app.config.proxy.usageRetentionDays }} 天）之前的全部请求流水，此操作不可恢复。
              </template>
              <template v-else>
                将清空<b>整张请求流水表</b>（含当前筛选范围之外的历史记录），此操作不可恢复。
              </template>
            </div>
            <div class="p-actions">
              <button class="btn" @click="cleanOpen = false">取消</button>
              <button class="btn btn-primary danger-solid" :disabled="cleaning" @click="doCleanup">{{ cleaning ? "清理中…" : cleanScope === "all" ? "全部清空" : "确认清理" }}</button>
            </div>
          </div>
        </div>
      </Teleport>
    </div>
  </section>
</template>

<style scoped>
/* 页头标题化已去除：入口按钮与统计范围贴正文顶部右侧 */
.toolbar {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}
.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.err-text {
  color: var(--err, #e05555);
}
.trend {
  width: 100%;
  height: 96px;
  display: block;
}
.trend-line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.5;
}
.trend-area {
  fill: var(--accent-dim, rgba(68, 224, 127, 0.12));
  stroke: none;
}
.trend-days {
  display: flex;
  justify-content: space-around;
  font-size: 10px;
  color: var(--text-3);
  font-family: var(--font-mono);
}
.pager {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
</style>
