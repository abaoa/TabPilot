# 网页版部署 · Web Deployment

> 线上地址：**https://www.abaoa.cn/tabpilot/**
> 承载站点：[abaoa/abaoa-cn](https://github.com/abaoa/abaoa-cn)（React + Vite，部署在 Vercel）

## 1. 部署原理

`public/` 是一个**自包含的纯静态前端**：无构建步骤、无 npm 依赖，直接整目录拷到任意站点的子路径下即可运行。

```
本仓库 public/  ──导出脚本──▶  abaoa-cn/public/tabpilot/  ──Vite 构建──▶  dist/tabpilot/  ──▶  abaoa.cn/tabpilot/
```

导出时由 [`scripts/export-web.mjs`](../scripts/export-web.mjs) 做三件事：

1. **全量拷贝** —— 先清空目标目录，避免旧文件残留；跳过 `assets/preview-*.png`、`_probe*.html` 等调试产物。
2. **manifest.json 改写** —— `start_url` / `scope` / `icons[].src` 统一加上站点前缀 `/tabpilot/`，否则 PWA 在子路径下会解析到站点根目录。
3. **注入主站入口** —— 在模式切换导航里插入 `<a href="/" data-site-home>🏠 主站</a>`，幂等（靠 `data-site-home` 标记，重复执行不会叠加）。

导出逻辑只有这一份实现，CI 与本地手动同步都调用它。

## 2. 自动同步（推荐）

TabPilot 推送到 `main` 后，[`.github/workflows/sync-site.yml`](../.github/workflows/sync-site.yml) 会：

1. 检出本仓库与 `abaoa/abaoa-cn`；
2. 执行导出脚本，输出到 `site/public/tabpilot/`；
3. 若内容有变化则提交推送到 `abaoa-cn` 的 `master`（提交信息含本仓库 commit SHA）；
4. Vercel 检测到主站仓库变更，自动构建部署。

触发条件：`push` 到 `main` 且 `public/**`、`scripts/export-web.mjs` 或 workflow 自身有变动；也可在 GitHub → Actions 手动 `Run workflow`。

### 配置一次令牌

workflow 需要写 abaoa-cn 的权限。创建 **fine-grained** Personal Access Token：

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
2. Token name：`tabpilot-site-sync`；Expiration：按需（建议 ≤ 1 年）
3. **Repository access**：*Only select repositories* → 选 `abaoa-cn`
4. **Permissions**：*Contents* → **Read and write**（Metadata 默认 Read-only 即可）
5. 生成后复制 token
6. 打开 **TabPilot** 仓库 → **Settings → Secrets and variables → Actions → New repository secret**
   - Name：`SITE_SYNC_TOKEN`
   - Secret：粘贴上一步的 token

未配置该 secret 时，workflow 会**打印警告并跳过**（不会标红失败），方便先合并代码再补配置。

> ⚠️ PAT 过期后同步会失败（认证错误而非跳过），续期后更新同名 secret 即可。

## 3. 手动同步

在本仓库执行（需要本地存在 abaoa-cn 目录）：

```bash
# 输出到默认位置 ../abaoa-cn/public/tabpilot
npm run export:web

# 或显式指定
node scripts/export-web.mjs --out ../abaoa-cn/public/tabpilot --base /tabpilot
```

在主站仓库执行（薄封装，内部调用同一脚本）：

```bash
cd ../abaoa-cn
npm run sync:tabpilot
# TabPilot 不在默认位置时：
TABPILOT_REPO=D:/code/TabPilot npm run sync:tabpilot
```

之后仍需提交 `public/tabpilot/` —— 它是生成物，但**必须进 Git**：Vercel 构建时拉取的是主站仓库，拿不到本仓库源码，因此不能写进 `.gitignore`。

## 4. 为什么不用 git submodule

| 方案 | 问题 |
| --- | --- |
| submodule 挂到 `public/tabpilot` | submodule 只能挂载**整个仓库**。TabPilot 是 Tauri 项目，会把 `src-tauri/`（Rust 源码）等一并暴露到公网，且入口变成 `/tabpilot/public/index.html` |
| submodule 挂到 `vendor/` + 构建时复制 | 可行，但 Vercel 只拉取**公开且走 HTTP(S)** 的 submodule，私有或 SSH 一定在 Build 阶段失败；同时版本同步变成"更新指针 + 提交"两步，忘记更新会让线上静默停在旧版 |
| **GitHub Actions 自动同步（当前）** | Vercel 零改动、构建无额外依赖、可追溯每次同步对应的 commit |

## 5. 排错

| 现象 | 原因与处理 |
| --- | --- |
| `/tabpilot/` 404，但其它页面正常 | 主站未重新部署：确认 abaoa-cn 的 `public/tabpilot/` 已提交，且 `vercel.json` 中 `/tabpilot/(.*)` 的 rewrite 排在 SPA 兜底 `/(.*)` **之前** |
| 页面能开，PWA 安装后打不开 | manifest 前缀未改写：确认导出时 `--base /tabpilot`，检查线上 `manifest.json` 的 `start_url` |
| 子路径下资源 404 | 检查导出是否完整（`vendor/`、`css/`、`js/`、`assets/` 均需存在），Vercel 侧未忽略这些目录 |
| Actions 报 `Repository not found` 或认证失败 | `SITE_SYNC_TOKEN` 未配置、已过期，或 PAT 未授权 `abaoa-cn` 的 Contents 写权限 |
| Actions 显示跳过 | 正常：未配置 secret，或本次提交未改动 `public/` |
