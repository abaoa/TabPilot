/**
 * scripts/export-web.mjs — 将网页版前端导出到静态站点的子目录
 *
 * 用途
 *   TabPilot 的 public/ 是一个自包含的纯静态前端（无构建步骤），
 *   把它整目录拷到任意站点的子路径下即可直接访问。本脚本负责这次"落地"，
 *   并处理子路径部署必须改写的内容。
 *
 * 用法
 *   node scripts/export-web.mjs --out <目标目录> [--base <URL 前缀>]
 *   npm run export:web
 *
 * 参数
 *   --out <dir>    目标目录（例如 ../abaoa-cn/public/tabpilot）。
 *                  缺省取环境变量 TABPILOT_OUT，再缺省为 ../abaoa-cn/public/tabpilot。
 *   --base <path>  站点上的 URL 前缀，默认 /tabpilot。
 *                  部署在域名根目录时用 --base ""。
 *
 * 导出时做的三件事
 *   1. 全量拷贝（先清空目标目录，避免旧文件残留）
 *   2. manifest.json 改写为站点绝对前缀，让 PWA 的 start_url / scope / icons
 *      在子路径下解析正确
 *   3. 在模式切换导航里注入「主站」入口（幂等，重复执行不会叠加）
 *
 * 说明
 *   · 本脚本是同步逻辑的唯一实现，CI（.github/workflows/sync-site.yml）与
 *     本地手动同步都调用它，避免两处逻辑漂移。
 *   · 仅依赖 Node 内置模块，无需 npm install。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.join(__dirname, '..');
/** 源：本仓库的网页版前端目录 */
const SRC = path.join(REPO_ROOT, 'public');
/** 默认输出：兄弟目录中的个人站点 */
const DEFAULT_OUT = path.join(REPO_ROOT, '..', 'abaoa-cn', 'public', 'tabpilot');

/** 解析命令行参数（--key value 形式） */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      args[key.slice(2)] = true;
    } else {
      args[key.slice(2)] = value;
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const BASE = typeof args.base === 'string' ? args.base.replace(/\/+$/, '') : '/tabpilot';
const OUT = path.resolve(
  typeof args.out === 'string' ? args.out : process.env.TABPILOT_OUT || DEFAULT_OUT
);

/** 不参与导出的文件（README 预览图、调试用临时页、系统垃圾文件） */
const EXCLUDE = [
  /assets[\\/]preview-.*\.png$/,
  /_probe.*\.html$/,
  /(^|[\\/])(\.DS_Store|Thumbs\.db)$/,
];

const isExcluded = (rel) => EXCLUDE.some((re) => re.test(rel));

/** 递归拷贝，返回文件数与总字节数 */
function copyTree(from, to) {
  let count = 0;
  let bytes = 0;

  const walk = (srcDir, dstDir) => {
    fs.mkdirSync(dstDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath = path.join(srcDir, entry.name);
      const dstPath = path.join(dstDir, entry.name);
      const rel = path.relative(SRC, srcPath).split(path.sep).join('/');

      if (entry.isDirectory()) {
        walk(srcPath, dstPath);
      } else if (entry.isFile()) {
        if (isExcluded(rel)) {
          console.log(`- 跳过 ${rel}`);
          continue;
        }
        fs.mkdirSync(path.dirname(dstPath), { recursive: true });
        fs.copyFileSync(srcPath, dstPath);
        count += 1;
        bytes += fs.statSync(dstPath).size;
        console.log(`+ ${rel}`);
      }
    }
  };

  walk(from, to);
  return { count, bytes };
}

/** 拼接站点绝对前缀：BASE 为空时保持原样 */
const withBase = (p) => (BASE ? `${BASE}/${String(p).replace(/^\.?\//, '')}` : String(p));

/** manifest.json：改写为站点绝对前缀 */
function adaptManifest() {
  const file = path.join(OUT, 'manifest.json');
  if (!fs.existsSync(file)) return;

  const m = JSON.parse(fs.readFileSync(file, 'utf-8'));
  m.start_url = withBase('index.html');
  m.scope = BASE ? `${BASE}/` : '/';
  if (Array.isArray(m.icons)) {
    m.icons = m.icons.map((it) => ({ ...it, src: withBase(it.src) }));
  }
  fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n', 'utf-8');
  console.log(`~ manifest.json -> start_url=${m.start_url} scope=${m.scope}`);
}

/** HTML：在模式切换导航里注入「主站」入口 */
function injectHomeLink() {
  for (const name of ['index.html', 'image-tab.html']) {
    const file = path.join(OUT, name);
    if (!fs.existsSync(file)) continue;

    let html = fs.readFileSync(file, 'utf-8');
    if (html.includes('data-site-home')) {
      console.log(`- ${name} 已包含主站入口`);
      continue;
    }
    if (!html.includes('</nav>')) {
      console.warn(`! ${name} 未找到 </nav>，跳过主站入口注入`);
      continue;
    }
    html = html.replace('</nav>', '      <a href="/" data-site-home>🏠 主站</a>\n    </nav>');
    fs.writeFileSync(file, html, 'utf-8');
    console.log(`~ ${name} 注入主站入口`);
  }
}

function main() {
  console.log(`源目录 : ${SRC}`);
  console.log(`目标   : ${OUT}`);
  console.log(`URL前缀: ${BASE || '(根目录)'}\n`);

  if (!fs.existsSync(path.join(SRC, 'index.html'))) {
    console.error(`x 源目录无效（未找到 index.html）：${SRC}`);
    process.exit(1);
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  const { count, bytes } = copyTree(SRC, OUT);
  adaptManifest();
  injectHomeLink();

  console.log(`\n导出完成：${count} 个文件，${(bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`访问路径：<站点域名>${BASE}/`);
}

main();
