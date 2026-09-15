// 谱领航 TabPilot — Tauri 2 壳
//
// 相比原 Electron 版 main.js 的变化：
//  1. 自定义 app:// 协议 + MIME 手工分发 → 由 Tauri 资产协议（tauri://）接管，
//     它本身就是安全上下文，因此麦克风 getUserMedia 依然可用。
//  2. disableHardwareAcceleration + in-process-gpu 等 Electron 专有 hack 已移除，
//     Windows 上 Tauri 使用 WebView2（Chromium 内核），无需这些兜底。
//  3. 窗口参数（1280x860 / min 360x500 / 标题 / 背景色）移到 tauri.conf.json。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
