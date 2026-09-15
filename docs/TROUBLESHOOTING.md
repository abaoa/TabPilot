# 故障排查 · Troubleshooting

本文件记录已经定位过的运行时故障、根因与处理办法。新增故障请按同样格式追加。

---

## 1. 界面出现 `{"error":"Request","message":"找不到任何可成功连接的IP（tauri.localhost:80）"}`

### 现象
桌面版运行时，页面或某个内嵌预览区**直接显示一段 JSON 文本**，而不是应用界面：

```
{"error":"Request","message":"找不到任何可成功连接的IP（tauri.localhost:80）"}
```

### 根因（三条链路叠加）

1. **`tauri.localhost` 是 Tauri 的内部资产域**
   桌面版的前端资源（HTML/CSS/JS）由 Tauri 自带的资产协议提供，页面来源即
   `http://tauri.localhost/`。正常情况下这些请求**全部**由 Tauri 内部截获，不产生真实网络流量。

2. **Chromium 会把 `*.localhost` 解析到回环地址**
   WebView2 与 Edge/Chrome 同源，按 RFC 6761 处理特殊域名：`tauri.localhost` → `127.0.0.1`。
   于是一旦某个请求**绕过了 Tauri 的资产协议拦截**，它不会被 DNS 拒绝，而是直连本机 80 端口。

3. **本机 80 端口常被"加速/代理"类工具占用**
   例如 FastGithub（随其 UI 常驻，监听 `127.0.0.1:80`、`[::1]:80`、`443`、`22`、`9418`）。
   这类工具会对收到的域名做「IP 优选」，对 `tauri.localhost` 当然找不到可用 IP，
   于是返回上面这段 JSON 错误体 —— 若该响应被当作文档渲染，就表现为"界面变成了一段 JSON"。

> 快速自查：
> ```powershell
> Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq 80 |
>   ForEach-Object { Get-Process -Id $_.OwningProcess | Select-Object Id, Name, Path }
> Resolve-DnsName tauri.localhost      # 预期：名称不存在（说明只有浏览器会把它送回环回地址）
> ```

### 代码侧的真实诱因：桌面壳内的 Service Worker

**Tauri 壳里不应存在 Service Worker。** Service Worker 的请求走独立网络上下文，
并不经过 Tauri 为页面注册的资产协议处理器，属于典型的"漏到真实网络"路径。
本项目历史版本曾在桌面壳内注册 `sw.js`，其 WebView2 用户数据目录
（`%LOCALAPPDATA%\com.workbuddy.tabpilot\EBWebView`）中因此残留：

- 已注册的 SW：`http://tauri.localhost/sw.js`
- 旧版本缓存（SHELL 里仍写着 `imageTab.html`、`../src/app.js` 等**已不存在的路径**）
- 被错误缓存的响应体（例如 `/src/app.js`、`/favicon.ico` 因资产协议回退而被缓存成 `index.html`）

这些残留会跨版本长期生效，造成"界面是旧版""资源取到 HTML"等诡异现象。

### 修复

1. **前端不在桌面壳内注册 SW**：`index.html` / `image-tab.html` 中判断运行环境，
   若为 `tauri://` 或 `*.tauri.localhost`，则**只做清理**（`unregister()` + 删缓存），不注册；
   仅在真正的 `http(s)` 部署（PWA / GitHub Pages）下注册。
2. **清理已被污染的 profile**（应用未运行时执行）：

   ```powershell
   $d = "$env:LOCALAPPDATA\com.workbuddy.tabpilot\EBWebView\Default"
   Remove-Item "$d\Service Worker", "$d\Cache", "$d\Code Cache" -Recurse -Force
   ```
   WebView2 会在下次启动时自动重建这些目录，不影响用户设置（`localStorage` 等保持不变）。

3. **彻底避免本机干扰**：不需要 GitHub 加速时退出 FastGithub 等工具，
   它们释放 80/443 端口后，即使请求漏到网络也只会得到连接被拒绝，而不会被注入错误页。

### 相关文件
- `public/index.html`、`public/image-tab.html` —— SW 注册与清理逻辑
- `public/sw.js` —— PWA 缓存策略（仅用于 Web 部署）
- `src-tauri/tauri.conf.json` —— 桌面壳窗口与打包配置

---

## 2. `npm run tauri build` 打包 NSIS 失败：`http status: 502`

### 现象
```
Downloading .../nsis-3.11/nsis-3.11.zip → http status: 502
failed to bundle project
```
exe 与 MSI 已生成，仅 NSIS 安装包失败。

### 处理
NSIS 相关资源从 GitHub 下载，国内网络下易失败（属环境问题，与代码无关）。
`src-tauri/tauri.conf.json` 中 `bundle.targets` 已固定为 `["msi"]`；
网络正常时可改回 `"all"` 以同时产出 NSIS。

---

## 3. 首次构建 Rust 依赖极慢 / rustup 安装失败

- `static.rust-lang.org` 与 crates.io 在国内直连常超时：改用 **rsproxy.cn** 镜像
  （`RUSTUP_DIST_SERVER` / `RUSTUP_UPDATE_ROOT`，以及 `~/.cargo/config.toml` 的
  `[source.crates-io] replace-with`）。
- 首次 `tauri build` 需要编译 `windows` / `wry` / `webview2` / `tao` 等大型 crate，
  15 分钟以上属正常；依赖编译完成后增量重建只需 2～3 分钟。
