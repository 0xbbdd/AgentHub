# AgentHub 生产发布手册

发布由 `.github/workflows/release.yml` 手动触发。生产发布采用 **build matrix + 单发布者**：

```text
validate
  → Windows / macOS x64 / macOS arm64 / Linux 分别构建并上传 artifact
  → publish job 汇总
  → 合并 macOS 更新清单
  → 生成 SHA256SUMS
  → GPG 签名校验和
  → 创建草稿 Release
  → 校验三平台 latest*.yml
  → 发布
```

任一平台缺少签名凭据、产物不完整、更新清单引用失效或公证失败，流水线都会中止，不会发布。

## Dry Run

`workflow_dispatch` 的 `dry_run=true` 会完整执行：

- 三平台签名与公证构建；
- 三平台安装/升级 smoke；
- 三平台真实更新 E2E；
- 制品汇总、SHA-256/GPG、更新清单校验。

但不会创建 tag 或 GitHub Release，最终把 `release-assets/**` 作为
`agenthub-release-dry-run-<run_id>` workflow artifact 上传。Dry Run 跳过 tag 唯一性和版本递增检查，
但仍校验版本号、更新说明、签名和完整发布链路。

## 1. 发布前准备

1. 更新 `package.json` 的版本号。
2. 确保 `build/release-notes.md` 首行为 `# v<版本号>`。
3. 本地运行：

```bash
npm ci
npm run release:verify
npm run verify:platform
npm run native:verify -- --strict
npm run build
```

## 2. GitHub Secrets

### Windows Authenticode

| Secret | 说明 |
| --- | --- |
| `WIN_CSC_LINK` | Base64 编码的 `.pfx` 或 electron-builder 支持的证书链接 |
| `WIN_CSC_KEY_PASSWORD` | 证书密码 |
| `WIN_PUBLISHER_NAME` | 证书 Subject/Publisher 名称，写入 `app-update.yml` 供 electron-updater 校验更新包签名 |

构建后使用 `Get-AuthenticodeSignature` 验证，状态必须为 `Valid`。

### macOS Developer ID 与公证

代码签名：

| Secret | 说明 |
| --- | --- |
| `MAC_CSC_LINK` | Base64 编码的 Developer ID Application `.p12` |
| `MAC_CSC_KEY_PASSWORD` | `.p12` 密码 |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

公证二选一：

#### Apple ID

| Secret | 说明 |
| --- | --- |
| `APPLE_ID` | Apple Developer 账号 |
| `APPLE_APP_SPECIFIC_PASSWORD` | App 专用密码 |

#### App Store Connect API Key（推荐）

| Secret | 说明 |
| --- | --- |
| `APPLE_API_KEY_BASE64` | `.p8` 文件内容再 Base64 |
| `APPLE_API_KEY_ID` | API Key ID |
| `APPLE_API_ISSUER` | Issuer ID |

`build/notarize.cjs` 会调用 `notarytool`，完成后自动 staple。流水线随后执行：

```bash
codesign --verify --deep --strict
xcrun stapler validate
spctl --assess --type execute
hdiutil verify
```

### Linux 校验和签名

| Secret | 说明 |
| --- | --- |
| `LINUX_GPG_PRIVATE_KEY` | ASCII-armored 私钥再 Base64 |
| `LINUX_GPG_PASSPHRASE` | 私钥口令 |

发布 job 会生成：

- `SHA256SUMS.txt`
- `SHA256SUMS.txt.asc`
- `AgentHub-Linux-GPG-KEY.asc`

验证方式：

```bash
gpg --import AgentHub-Linux-GPG-KEY.asc
gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt
sha256sum -c SHA256SUMS.txt
```

## 3. 三平台更新清单

electron-builder 构建：

- Windows：`latest.yml`
- macOS：`latest-mac.yml`
- Linux：`latest-linux.yml`

macOS x64 与 arm64 在独立 runner 构建，由 `tools/assemble-release.cjs` 合并 `files[]`。发布前校验：

- 三份清单版本与 `package.json` 一致；
- `releaseNotes` 非空；
- `files[]` 非空；
- `latest-mac.yml` 同时包含 x64 与 arm64；
- 清单引用的二进制真实存在；
- 每个文件的 SHA-512 与 `size` 和实际文件一致；
- Windows `app-update.yml` 包含 `publisherName`，electron-updater 下载后会校验 EXE 发布者签名。

## 4. 构建产物

| 平台 | 产物 |
| --- | --- |
| Windows x64 | NSIS `.exe` + blockmap |
| macOS x64 | DMG + ZIP |
| macOS arm64 | DMG + ZIP |
| Linux x64 | AppImage + DEB |

`release-assets/` 最终包含三平台产物、更新清单、`SHA256SUMS.txt`、签名与 `RELEASE-MANIFEST.json`。

## 5. 安装级 smoke

每个平台在签名/公证验证后、上传 artifact 前执行：

- Windows：NSIS 静默安装 → 启动 10 秒 → 强制关闭进程树 → 静默卸载；
- macOS：挂载 DMG → 复制 `.app` 到临时目录 → 启动 10 秒；
- Linux：AppImage 提取运行 → DEB 系统安装 → 启动 → 卸载；

该步骤失败时不会进入制品汇总与发布。

### 凭据落盘安全门禁

`npm run release:verify` 会执行 `tools/secure-storage-selftest.cjs`，覆盖：

- 框架配置的 WebDAV 密码与号池口令；
- 用量同步模块的 WebDAV 密码与 New API Token；
- 代理号池的 access/refresh token、API Key 与账号 meta 中的 Cookie/Secret；
- 记忆中枢供应商 API Key；
- `crash.log` 中的 Bearer、JWT、token、cookie、password 与常见 API Key。

测试在 `AGENTHUB_SECRET_KEY` 模式下要求上述字段全部以 `enc:v2:` AES-256-GCM 信封落盘，且原始
明文不出现在 JSON/SQLite 中；同时验证历史明文代理凭据和框架/用量配置会在启动迁移时就地加密。
打包后的生产应用在既无系统钥匙串、也无 `AGENTHUB_SECRET_KEY` 时默认 fail-closed：拒绝新的明文
凭据写入，并在启动时清除无法保护的历史明文。

### 打包产物 GUI E2E

签名/公证验证后，每个平台直接启动本次构建的 unpacked Electron 产物，执行
`npm run e2e:electron`：

- 主窗口与 `.module-card` 正常加载；
- 技能仓库、用量统计、反代网关、记忆中枢四个模块可切换；
- 设置弹窗可打开，更新卡片与自动检查开关可见；
- 全程无渲染层 `pageerror`。

Linux 通过 `dbus-run-session` + `xvfb-run` 执行；Windows/macOS 直接启动。随后还会运行真实
系统安全存储 E2E（Linux 临时启动 gnome-keyring，验证 Secret Service 与 `enc:v1` 往返），以及两条
真实 Electron 桌面 E2E：

- `e2e:window-mode`：关窗释放渲染进程、托盘存活、唤回、位置/尺寸恢复和越界收敛；
- `e2e:window-mode:main`：启动真实 `main.cjs`，验证 lightweight-enter 日志、二次启动唤回和几何持久化。

失败时工作流上传 `gui-e2e-failure.png` 或 `window-mode-main-e2e-failure.png`。这些步骤与安装、
升级 smoke 一样是发布硬门禁，任一平台失败都不会进入汇总和发布。

### 升级与回滚 smoke

每个平台随后下载上一版 Release 对应安装包，执行：

1. 安装 N-1；
2. 启动并建立临时用户数据；
3. 覆盖安装 N；
4. 校验版本变化、启动成功、用户数据仍存在；
5. 回滚安装 N-1；
6. 再次校验启动与用户数据。

工作流输入：

- `upgrade_baseline_tag`：指定 N-1 tag；留空使用 latest Release；
- `allow_missing_upgrade_baseline`：首个跨平台版本或旧 Release 缺对应资产时，显式允许跳过。

默认不允许缺失基线，且升级 smoke 要求 N 的版本严格高于 N-1。仅脚本自测可设置
`AGENTHUB_ALLOW_SAME_VERSION=1`。

## 6. 真实更新 E2E

发布前还会在 Ubuntu 上构建 9.9.1 / 9.9.2 两个本地 AppImage，并启动本地更新服务器验证：

- electron-updater 发现新版本；
- 真实下载 AppImage；
- SHA-512 校验；
- AppImage 替换安装；
- 更新后启动版本为 9.9.2；
- 损坏包校验失败时旧 AppImage 保持不变；
- 只读安装目录导致替换失败时旧 AppImage 保持不变；
- 文件大小受限模拟磁盘不足时旧 AppImage 保持不变。

Windows 与 macOS 也会在各自 runner 上执行同样的真实更新 E2E：

- Windows：签名 NSIS 旧/新版安装、更新下载、签名与 SHA-512 校验、覆盖安装；
- macOS：签名 ZIP 旧/新版、更新下载、SHA-512 与 code signature 校验、替换 `.app`；
- 两端都验证损坏包不会替换旧版本。

任一平台更新 E2E 失败都不会发布 Release。

## 7. 发布验收

发布 job 在正式发布前创建 Draft Release、上传资产并重新下载 `latest*.yml` 校验。全部通过后才执行：

```bash
gh release edit v<version> --draft=false --latest
```

## 8. 当前未完成项

- 需在 GitHub 仓库配置上述 secrets 后，才具备真正的生产签名发布能力。
- Windows 证书、Apple Developer 证书与 Linux GPG 私钥不在仓库中，当前能力矩阵仍将 `release.code-signing` 标记为 `blocked`。
- 正式发布前仍需在目标系统完成安装、启动、升级、卸载 E2E。
