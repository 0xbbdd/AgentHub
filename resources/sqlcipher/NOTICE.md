# SQLCipher 原生库来源说明

AgentHub 在读取 Trae / Trae CN / TRAE SOLO / TRAE SOLO CN 的加密数据库时，通过
`koffi` 加载本目录下的 SQLCipher 动态库。三平台库统一为 SQLCipher 4.6.1
（SQLite 3.46.1 community）；macOS / Linux 使用 OpenSSL 3.3.1，Windows 沿用
既有的 OpenSSL 1.1.1 x64 DLL。

## 文件与校验

逐文件 SHA256 见 `manifest.json`。可直接运行：

```bash
npm run native:verify
npm run native:verify -- --strict
```

`native:verify` 用于本地检查；`--strict` 供发布流程阻断不完整资源。

## 来源

macOS 与 Linux 库取自 Homebrew 官方 bottle（OCI 镜像 `ghcr.io/homebrew/core/sqlcipher`），
下载日期 2026-10-26：

| 平台 | SQLCipher bottle | OpenSSL bottle |
| --- | --- | --- |
| macOS x64 | `4.6.1.monterey` · `sha256:69a4c545…` | `3.3.1.monterey` · `sha256:06e6ff16…` |
| macOS arm64 | `4.6.1.arm64_monterey` · `sha256:99ceb412…` | `3.3.1.arm64_monterey` · `sha256:0d88c67b…` |
| Linux x64 | `4.6.1.x86_64_linux` · `sha256:1b698c95…` | `3.3.1.x86_64_linux` · `sha256:d84029bf…` |

完整 digest 与文件哈希见 `manifest.json`。SQLCipher 上游：
<https://github.com/sqlcipher/sqlcipher>（v4.6.1）。OpenSSL 上游：
<https://github.com/openssl/openssl>（3.3.1）。

Windows DLL 为仓库既有的 x64 构建，运行时 `PRAGMA cipher_version` 实测为
`4.6.1 community`、`sqlite_version()` 为 `3.46.1`，与另外两平台一致。

## 对二进制所做的修改

- macOS：将 `LC_ID_DYLIB` 改为 `@loader_path/libsqlcipher.dylib` /
  `@loader_path/libcrypto.3.dylib`，将 libcrypto 依赖改为
  `@loader_path/libcrypto.3.dylib`；移除 Homebrew 原签名后用
  `rcodesign 0.29.0` 做 ad-hoc 签名。未修改任何代码段。
- Linux：用 `patchelf 0.18.0` 将 `RUNPATH` 改为 `$ORIGIN`，只依赖同目录的
  `libcrypto.so.3`。未修改任何代码段。
- Windows：未修改 DLL。

## 兼容性

- macOS：最低 12.0（bottle 的 deployment target）。
- Linux：编译时使用 glibc 2.34 符号；建议 Ubuntu 22.04 / Debian 12 或更新版本。
- Windows：10 / 11 x64。

## 许可证

- SQLCipher：BSD-3-Clause，全文见 `licenses/SQLCipher-LICENSE.md`。
- OpenSSL：Apache-2.0，全文见 `licenses/OpenSSL-LICENSE.txt`。

这些第三方库不改变 AgentHub 自身代码的授权；随安装包分发时保留本说明与许可证即可。
