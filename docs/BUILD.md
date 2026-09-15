# 构建说明 · Build Guide

---

## 1. 环境准备

| 依赖 | 版本要求 | 说明 |
| --- | --- | --- |
| Rust | ≥ 1.77.2 | 通过 [rustup](https://rustup.rs/) 安装 stable 工具链 |
| Node.js | ≥ 18 | 仅用于运行 Tauri CLI |
| MSVC Build Tools | VS 2022 生成工具 | Windows 链接 Rust 与资源编译器所需 |
| WebView2 Runtime | 已随系统或单独安装 | Windows 端渲染内核 |

国内网络建议配置镜像（若已配置可跳过）：

```toml
# ~/.cargo/config.toml
[source.crates-io]
replace-with = "rsproxy-sparse"

[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"

[registries.rsproxy-sparse]
index = "sparse+https://rsproxy.cn/index/"
```

```bash
# 安装 Rust（走 rsproxy 镜像）
$env:RUSTUP_DIST_SERVER = "https://rsproxy.cn"
$env:RUSTUP_UPDATE_ROOT = "https://rsproxy.cn/rustup"
.\rustup-init.exe -y --default-toolchain stable --profile minimal
```

```bash
npm install --registry=https://registry.npmmirror.com
```

---

## 2. 常用命令

```bash
npm run dev      # 开发模式（带热重载）
npm run build    # 生产构建
```

---

## 3. 产物路径

| 产物 | 路径 |
| --- | --- |
| 可执行文件 | `src-tauri/target/release/TabPilot.exe` |
| MSI 安装包 | `src-tauri/target/release/bundle/msi/TabPilot_1.0.0_x64_en-US.msi` |

参考体积：exe ≈ 5 MB，MSI ≈ 3.8 MB（对比原 Electron 版本 188 MB）。

---

## 4. Windows 版本资源（exe 属性）

`tauri-build` 会在 Windows 构建时自动生成 `.rc` 并编译进 exe。
字段来源全部在 `src-tauri/tauri.conf.json` 中，**不需要手写 rc 文件**：

| exe 属性 | 来源 | 当前值 |
| --- | --- | --- |
| 文件版本 FileVersion | `version` | 1.0.0 |
| 产品版本 ProductVersion | `version` | 1.0.0 |
| 产品名称 ProductName | `productName` | TabPilot |
| 文件说明 FileDescription | `productName` | TabPilot |
| 公司 CompanyName | `bundle.publisher` | abaoa |
| 版权 LegalCopyright | `bundle.copyright` | Copyright © 2026 abaoa. Licensed under the MIT License. |
| 文件名 | `mainBinaryName` | TabPilot.exe |

验证方式（PowerShell）：

```powershell
(Get-Item "src-tauri\target\release\TabPilot.exe").VersionInfo |
  Select-Object ProductName, FileDescription, CompanyName, LegalCopyright, FileVersion
```

⚠️ 不要尝试用 `append_rc_content` 重复定义 `VS_VERSION_INFO`，会导致资源编译冲突。

---

## 5. 打包目标

`tauri.conf.json` 当前 `targets: ["msi"]`。

- **MSI**：稳定可用（首次构建会下载 WiX 工具链）。
- **NSIS**：构建器需要访问 GitHub Releases 下载 `nsis-*.zip`，
  在受限网络下可能返回 502。若你的网络可访问，可把 targets 改为 `["msi", "nsis"]`。
- **macOS / Linux**：需在对应平台构建（`.app` / `.dmg` / `.deb` / `.AppImage`）。

---

## 6. 移动端

```bash
npm run android:init   # 初始化 Android 工程（需 Android SDK cmdline-tools + NDK + JDK）
npm run android:dev    # 调试运行
npm run ios:init       # 初始化 iOS 工程（需 macOS + Xcode）
```

麦克风权限（跟随功能必需）：

- iOS：`Info.plist` 增加 `NSMicrophoneUsageDescription`
- Android：`AndroidManifest.xml` 增加 `RECORD_AUDIO`
- 两侧还需要 Tauri capability 授权

iOS 打包签名必须使用 macOS + Apple 开发者账号，Windows 上无法完成。

---

## 7. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| `failed to bundle project: http status: 502` | 打包器下载 WiX / NSIS 失败，重试或改用单一 target |
| `cargo: no default is configured` | Rust 工具链未装完，执行 `rustup default stable` |
| 图表/图标报 "Could not find icon" | 确认 `tauri.conf.json` 的 `bundle.icon` 路径相对于 `src-tauri/` |
| `git push` 卡住后返回 128 | 凭据管理器在无头环境弹不出浏览器，加 `GIT_TERMINAL_PROMPT=0` 重试 |
| 首次构建很慢（10 分钟以上） | 正常：需要编译 `windows`、`wry`、`tao` 等依赖，之后增量构建很快 |
