# AgentHub 平台支持契约

本文是 AgentHub 三平台能力、验收边界和发布门禁的事实源。能力矩阵的代码事实源为
`electron/backend/platform/capabilities.cjs`，修改平台能力时必须同步更新两者。

## 1. 支持目标

| 平台 | 架构 | 安装形态 | 当前定位 |
| --- | --- | --- | --- |
| Windows 10/11 | x64 | NSIS | 全功能参考平台 |
| macOS | x64 / arm64 | DMG / ZIP | 桌面兼容平台，生产发布待签名与公证 |
| Linux | x64 | AppImage / DEB | 桌面兼容平台，发行版验收进行中 |

Windows ARM64、Linux ARM64 目前不是正式构建目标。

## 2. 状态定义

| 状态 | 含义 |
| --- | --- |
| `supported` | 已在目标平台实现并纳入验收 |
| `compatible` | 已有实现，但尚未完成目标平台真机验收 |
| `fallback` | 有产品级替代路径，行为或范围与主平台不同 |
| `blocked` | 当前平台不可用，UI 必须解释原因 |
| `not-applicable` | 该平台不存在这个能力概念 |

`compatible` 不等于“正式支持”。只有完成对应 E2E、安装升级和安全验收后，才能升级为
`supported`。

## 3. 功能能力

| 能力 | Windows | macOS | Linux | 备注 |
| --- | --- | --- | --- | --- |
| 桌面主框架 | supported | compatible | compatible | 三平台打包产物 GUI E2E 已接入 CI/Release；macOS runner 待实测，Linux 待扩大发行版覆盖 |
| 系统安全存储 | supported | compatible | fallback | Linux 依赖 Secret Service/KWallet 或 AGENTHUB_SECRET_KEY；生产包无后端时 fail-closed |
| 系统托盘 | supported | compatible | compatible | 运行时检测创建结果；失败时关窗直接退出，避免无入口后台进程 |
| 开机自启 | supported | compatible | compatible | 三平台分别使用 Login Item / XDG autostart |
| 全局快捷键 | supported | compatible | compatible | Wayland 启用 GlobalShortcutsPortal，最终由合成器授权 |
| 应用内更新 | supported | blocked | fallback | macOS 未签名公证；DEB 应走包管理器 |
| 发布制品签名 | blocked | blocked | blocked | 发布流水线尚未配置签名/公证 |
| SQLCipher | win32-x64 | darwin-x64/arm64 | linux-x64 | 其他架构会禁用 Trae 系数据源 |

## 4. 用量数据源

能力矩阵登记了当前 21 个用量数据源。Windows 为参考平台；macOS/Linux 默认标记为
`compatible`，表示路径或实现已存在但仍需真实客户端样本验收。

已知硬阻塞：

- `antigravity-legacy`：依赖 `language_server.exe` 与 Windows 进程能力，macOS/Linux 标记为
  `blocked`。
- 上游客户端本身不提供 macOS/Linux 版本时，本机数据采集不能由 AgentHub 单独补齐；产品必须
  提供文件导入、历史数据导入或明确标记不可用。

## 5. 代理渠道

能力矩阵登记了当前 18 个代理渠道，并分别记录：

- `inference`：账号凭据存在时能否完成协议转发；
- `localImport`：能否从本机客户端读取登录态；
- `ideSwitch`：能否把号池账号切回本机客户端。

已知硬阻塞：

- Qoder / Qoder International：每请求签名依赖本机 Qoder 客户端，当前安装定位与运行时资源仍是
  Windows 链，因此 macOS/Linux 的 `inference` 为 `blocked`。本机登录态读取已具备 Keychain /
  Secret Service + `v10` CBC 适配，macOS/Linux 的 `localImport` 标记为 `compatible`，待真实
  客户端版本验收。
- AutoClaw：本机登录态读取已具备 Keychain / Secret Service + `v10` CBC 适配，macOS/Linux
  的 `localImport` 为 `compatible`，待真实客户端版本验收；`ideSwitch` 仍为 `blocked`。
- WorkBuddy / 小浣熊：客户端关闭、重启和安装定位依赖 Windows 进程、注册表或 `.exe`，
  macOS/Linux 的 `ideSwitch` 为 `blocked`。
- ZCode 已具备跨平台进程与路径分支，但仍需 macOS/Linux 真机验收。

## 6. 平台服务层

- `platform/paths.cjs`：三平台标准目录；
- `platform/secure-store.cjs`：safeStorage 与 AES-GCM 信封；Linux `basic_text` 弱后端不算安全存储。打包后的生产应用在无安全后端时拒绝明文写入，开发环境才保留历史兼容；
- `platform/log-redact.cjs`：crash.log 落盘前统一脱敏 Bearer/JWT/token/cookie/password/API Key；
- `platform/chromium-crypto.cjs`：Chromium/Electron `v10` GCM/CBC 解密、DPAPI、Keychain、Secret Service；
  Linux 本机导入依赖 `secret-tool`（`libsecret-tools`），缺失时运行时能力自动降为 `blocked`；
- Qoder 客户端资源定位已覆盖 Windows 默认/launcher/注册表、macOS `.app/Contents/Resources` 与 Linux
  `/opt`、`/usr/lib`、`/usr/share`、`~/.local/share` 候选；
- `platform/desktop.cjs`：桌面会话事实；Linux 区分 X11/Wayland，Wayland 启用 GlobalShortcutsPortal；
- `platform/runtime-state.cjs`：把托盘创建、全局快捷键注册能力等运行时结果反哺能力矩阵；
- `platform/process.cjs`：进程探测、关闭、子进程清理与启动；
  - Windows 使用参数化 `tasklist/taskkill`；
  - macOS/Linux 使用 `pgrep`（缺失时回退 `ps`）与系统 signal；
  - 不再在业务模块中拼接 `taskkill/pkill` shell 字符串。

## 7. 前端能力门控

渲染层通过 `get_platform_capabilities` 在启动时加载能力矩阵：

- `blocked` / `not-applicable` 的本机导入入口会隐藏；
- 不支持的“切换本机客户端”按钮会禁用并展示具体原因；
- `compatible` 的兼容实现保留入口，但在操作前提示尚未完成真机验收；
- 安全存储若处于 `plaintext-fallback`，添加凭据弹窗会直接告警；生产环境同时将能力降为 `blocked`，后端拒绝明文保存；
- 托盘创建失败或全局快捷键后端不可用时，设置页禁用对应开关并展示具体理由；托盘失败时关窗直接退出，不留无入口后台进程。

## 8. 验证命令

```bash
npm run verify:platform   # 平台边界 + 能力矩阵完整性 + 三平台纯逻辑自测
npm run platform:matrix   # 输出三平台完整能力矩阵 JSON
npm run platform:credential-check  # 真实机器诊断 Keychain/Secret Service 与 Qoder/AutoClaw 解密
npm run platform:qoder-signer-check # 构建/加载 Qoder WASM 签名器并检查 runtime-info
npm run e2e:electron     # 启动打包产物，验证四模块切换、设置弹窗与渲染层异常
npm run e2e:window-mode  # 真实 Electron 验证关窗释放/唤回/位置恢复/托盘语义
npm run e2e:window-mode:main # 启动真实 main.cjs，验证二次启动唤回与几何持久化
npm run e2e:secure-storage # 真实 Electron safeStorage/Keychain/Secret Service 往返与 enc:v1 落盘
npm run security:storage-check # 验证四类本地凭据均为 enc:v2，且 fail-closed/日志脱敏生效
npm run native:verify    # 三平台 SQLCipher 资源与校验和
npm run build            # 上述平台门禁 + 类型检查 + 前端构建
```

## 9. 生产发布门禁

一个平台只有在以下条件全部满足后才可标记为生产支持：

1. 安装包在干净系统安装、启动、升级、卸载成功；
2. 打包产物的 Electron GUI E2E 与轻量模式桌面 E2E 通过（四模块、设置弹窗、关窗释放/唤回、几何恢复）；
3. 安全存储、日志、崩溃包中不存在明文凭据；
4. Windows Authenticode、macOS Developer ID + notarization、Linux 制品校验均通过；
5. `latest.yml`、`latest-mac.yml`、`latest-linux.yml` 与版本、校验和一致；
6. 能力矩阵中不存在未解释的 `compatible` 或 `blocked` 项。
