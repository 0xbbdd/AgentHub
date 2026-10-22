/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
import { createApp } from "vue";
import { createPinia } from "pinia";
import { isElectron } from "./api/ipc";
import { probeCaps } from "./api/caps";
import { refreshRemoteState } from "./api/remote";
import { getToken } from "./api/web-transport";
// 服务式 API 不经模板渲染，插件接管不到它们的样式：全库只用到这两个（② 段重数）。
// 中文 locale 的注入点随全量注册一起没了，改由 App.vue 的 <el-config-provider> 承接。
import "element-plus/es/components/message/style/css";
import "element-plus/es/components/message-box/style/css";
// dark css-vars 绑定 html.dark，须在 element.css 之前引入，让项目主题变量赢
import "element-plus/theme-chalk/dark/css-vars.css";
import App from "./App.vue";
// Phosphor 子集：只保留全库真正用到的 98 条字形规则（全量 1530 条 / 82 KB）
// 图标增删后重跑 node tools/gen-phosphor-subset.cjs 再生成
import "./assets/phosphor/phosphor-used.css";
import "./styles/global.css";
import "./styles/skills.css";
import "./styles/sync.css";
import "./styles/memory.css";
import "./styles/element.css";
import "./styles/auditor-theme.css";

const app = createApp(App);
app.use(createPinia());

// 启动形态三选一：Electron 直接挂载（IPC）；浏览器先探测网关托管（有后端走 RPC，
// 无令牌先挂登录页）；纯静态预览（dev:web）回落挂载走 mock
async function bootstrap() {
  if (isElectron()) {
    void refreshRemoteState(); // 远程目标状态：目标切换 chip 与 call() 的远程分支都靠它
    app.mount("#app");
    return;
  }
  const caps = await probeCaps();
  if (caps && !getToken()) {
    const { default: WebLogin } = await import("./views/WebLogin.vue");
    createApp(WebLogin).mount("#app");
    return;
  }
  app.mount("#app");
}
void bootstrap();
