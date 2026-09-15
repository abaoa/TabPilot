// build.rs — Tauri 构建脚本
//
// 职责：
//  1. 生成 Tauri 运行时所需的上下文（资源清单、能力校验、平台相关代码）
//  2. 在 Windows 上生成并编译 exe 的版本资源（.rc / VERSIONINFO）
//
// ── Windows 版本资源（rc 信息）字段来源 ────────────────────────────────────
// tauri-build 内部使用 tauri-winres 自动生成 .rc 并编译进 exe，字段映射如下：
//
//   FileVersion      ← tauri.conf.json 的 version
//   ProductVersion   ← tauri.conf.json 的 version
//   ProductName      ← tauri.conf.json 的 productName            → TabPilot
//   FileDescription  ← tauri.conf.json 的 productName            → TabPilot
//   CompanyName      ← tauri.conf.json 的 bundle.publisher       → abaoa
//   LegalCopyright   ← tauri.conf.json 的 bundle.copyright
//
// 因此要修改 exe 属性里的公司/版权信息，改 tauri.conf.json 即可，无需改这里。
// 若将来需要追加自定义资源（额外的 VERSIONINFO 字段、嵌入式资源等），
// 可通过 tauri_build::WindowsAttributes::append_rc_content 追加 .rc 片段：
//
//   tauri_build::try_build(
//     tauri_build::Attributes::new().windows_attributes(
//       tauri_build::WindowsAttributes::new()
//         .append_rc_content("/* 自定义 .rc 内容 */")
//     )
//   ).expect("tauri-build 执行失败");
//
// ⚠️ 注意：不要重复定义 VS_VERSION_INFO 资源块，否则资源编译会冲突。

fn main() {
    tauri_build::build()
}
