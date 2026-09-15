# 代码与命名规范 · Style Guide

> 目标：让新增代码"看起来就像原来的人写的"。以下为本项目现行约定。

---

## 1. 目录职责

| 目录 | 只允许放 |
| --- | --- |
| `public/css/` | 样式表，按 `base → layout → components` 三层组织 |
| `public/js/` | 页面脚本与共享模块 |
| `public/vendor/` | 第三方前端依赖（alphaTab、Bravura、sf3），不修改 |
| `public/assets/` | 页面运行时需要的静态资源（示例谱图） |
| `public/icons/` | PWA 与页面图标 |
| `src-tauri/` | Rust 桌面 / 移动壳 |
| `docs/` | 项目文档（架构、构建、规范） |
| `assets/`（根） | 仅 README 用的预览截图，不进打包 |

规则：Tauri 的 `frontendDist` 指向 `public/`，因此**页面引用的任何资源都必须在
`public/` 内**，不允许出现 `../` 反向引用，否则打包后路径会断。

---

## 2. 文件命名

- 一律 **kebab-case**（小写 + 连字符）：`image-tab.html`、`image-tab.js`。
- 页面入口直接用功能名，不加前缀：`index.html`、`image-tab.html`。
- Rust 侧遵循 Rust 惯例：`snake_case` 文件名、`snake_case` 函数、`CamelCase` 类型。
- 文档用大写 `ARCHITECTURE.md` / `BUILD.md` / `STYLE.md`。

---

## 3. CSS 约定

- 颜色、圆角、阴影一律走 `base.css` 里的设计令牌，**禁止在组件里写死颜色**，
  否则深色主题会漏改。
- 三层结构：`base.css`（令牌与重置）→ `layout.css`（骨架）→ `components.css`（控件）。
- 类名用语义命名（`.app-header`、`.field`、`.magnifier`），不用外观命名（`.red-box`）。
- 状态类用 `on` / `active` / `cur`，由 JS 切换。
- 媒体查询统一在各自文件末尾，断点只用 `900px` 一个（桌面 / 移动端两档）。

---

## 4. JavaScript 约定

- 全部脚本使用 `'use strict';`，兼容 WebView 的保守语法，不使用可选链等新特性。
- 常量用 `UPPER_SNAKE`（`TPQ`、`DUR_TICKS`），其余用 `camelCase`；类名用 `CamelCase`。
- 全局模块挂到 `window.TP*` 命名空间（`TPTheme`、`TPSettings`）。
- 注释语言：中文；格式统一为：

```js
/* ==========================================================================
 * 文件级说明：这个模块做什么、为什么这样设计
 * ========================================================================== */

/* ---------------------------------------------------------- 分节标题 */

/** 单行 JSDoc：说明这个函数做什么、参数与返回值 */
function foo(bar) { ... }
```

- 每个 JS 文件顶部必须有文件级说明；每个"分节"前用分隔注释；
  非自明的算法要写清**思路与判据依据**（如谱行识别的阈值为什么取 0.5）。
- 禁止留下调试用的 `console.log`、临时日志面板或 `?autotest` 之类的开关。
  （本项目已移除早期的自检代码，新代码不要重新引入。）

---

## 5. Git 提交

- 采用 Conventional Commits：`feat:`、`fix:`、`refactor:`、`docs:`、`chore:`。
- 一次提交只做一件事；正文用 `-` 列出要点，解释「为什么」而不是复述 diff。
- 提交前确认：`src-tauri/target/`、`node_modules/` 不会被误加入（已 gitignore）。

---

## 6. 版本同步清单

版本号出现在以下**四处**，升级时必须同时修改：

1. `package.json` → `version`
2. `src-tauri/tauri.conf.json` → `version`
3. `src-tauri/Cargo.toml` → `version`
4. `public/js/settings.js` → `APP_VERSION`（同时页面顶栏的 `vX.Y.Z` 也要改）
