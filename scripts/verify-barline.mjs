/* ==========================================================================
 * verify-barline.mjs — 图片谱小节线检测核心(barline-core.js)单测
 *
 * 直接以 Function 方式加载 barline-core.js（UMD：无 window 时落到 globalThis），
 * 取回 BarlineCore 的各纯函数验证。覆盖：
 *   · columnProjection：合成 RGBA 上的列暗像素覆盖率
 *   · smooth：箱式平滑（常量不变、尖峰摊开）
 *   · localMaxima：局部极大值（平台取中点、minVal/minGap 抑制）
 *   · linesFromMask：候选列 → 竖线中心（过宽丢文字块、过近合并）
 *   · barBounds：竖线 + 行端点 → 小节边界（端点吸附、过窄过滤）
 *   · barBoundsAt：取第 N 小节范围（越界夹取、不足返回 null）
 *   · 端到端：合成「一行 4 小节」的投影 → 检出 3 条内部竖线 → 4 个小节
 * ========================================================================== */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'public', 'js', 'barline-core.js');

const src = readFileSync(SRC, 'utf8');
const BC = new Function(src + '\nreturn globalThis.BarlineCore;')();
const { columnProjection, smooth, localMaxima, linesFromMask, barBounds, barBoundsAt } = BC;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

/** 造一张 w×h 的全白 RGBA 图（可再涂黑若干列） */
function makeImg(w, h, darkCols, darkRows) {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (const x of darkCols || []) {
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      data[i] = 0; data[i + 1] = 0; data[i + 2] = 0;
    }
  }
  // 只涂黑部分行的列（用于测「部分覆盖」）
  for (const c of darkRows || []) {
    for (let y = c.y0; y < c.y1; y++) {
      const i = (y * w + c.x) * 4;
      data[i] = 0; data[i + 1] = 0; data[i + 2] = 0;
    }
  }
  return data;
}

console.log('=== 图片谱小节线检测核心检验 ===');

// ---- 1) columnProjection ----
{
  const w = 20, h = 10;
  const data = makeImg(w, h, [5, 6], [{ x: 9, y0: 0, y1: 5 }]);   // 5、6 列全黑；9 列上半黑
  const cov = columnProjection(data, w, h, { x0: 0, y0: 0, x1: w, y1: h }, 170);
  ok('投影长度 = 区域宽度', cov.length === w, 'len=' + cov.length);
  ok('贯穿竖线列覆盖率 = 1', near(cov[5], 1, 1e-9) && near(cov[6], 1, 1e-9),
    cov[5] + ',' + cov[6]);
  ok('空白列覆盖率 = 0', cov[0] === 0 && cov[19] === 0);
  ok('半高竖线覆盖率 = 0.5', near(cov[9], 0.5, 1e-9), 'v=' + cov[9]);

  // 子区域：只算中间 4 列
  const sub = columnProjection(data, w, h, { x0: 5, y0: 0, x1: 7, y1: h }, 170);
  ok('子区域投影只覆盖选定列', sub.length === 2 && near(sub[0], 1, 1e-9) && near(sub[1], 1, 1e-9));

  // 越界裁剪
  const clip = columnProjection(data, w, h, { x0: 18, y0: 0, x1: 99, y1: h }, 170);
  ok('越界 rect 被裁剪到图像内', clip.length === 2, 'len=' + clip.length);
  ok('空区域返回空数组', columnProjection(data, w, h, { x0: 5, y0: 0, x1: 5, y1: h }, 170).length === 0);
  ok('无数据入参返回空数组', columnProjection(null, w, h, { x0: 0, y0: 0, x1: w, y1: h }, 170).length === 0);
}

// ---- 2) smooth ----
{
  const flat = smooth([2, 2, 2, 2], 1);
  ok('常量序列平滑后不变', flat.every((v) => v === 2), flat.join(','));
  const spike = smooth([0, 0, 3, 0, 0], 1);
  ok('尖峰被摊开到邻列', spike[1] === 1 && spike[2] === 1 && spike[3] === 1, spike.join(','));
  const same = smooth([0, 1, 2], 0);
  ok('radius=0 原样返回', same.join(',') === '0,1,2');
  ok('短数组（<3）直接返回', smooth([1, 2], 5).join(',') === '1,2');
}

// ---- 3) localMaxima ----
{
  const m = localMaxima([0, 1, 0, 2, 0]);
  ok('找出两个峰', m.length === 2 && m[0].i === 1 && m[1].i === 3, JSON.stringify(m));
  ok('峰值取值正确', m[0].v === 1 && m[1].v === 2);

  ok('minVal 过滤低峰', localMaxima([0, 1, 0, 2, 0], { minVal: 2 }).length === 1);
  const g = localMaxima([0, 1, 0, 2, 0], { minGap: 4 });
  ok('minGap 过近保留更高的峰', g.length === 1 && g[0].i === 3, JSON.stringify(g));

  const pl = localMaxima([0, 2, 2, 0]);
  ok('平台取中点', pl.length === 1 && pl[0].i === 1 && pl[0].v === 2, JSON.stringify(pl));
  ok('首元素可为峰', localMaxima([3, 0]).length === 1);
  ok('末元素可为峰', localMaxima([0, 3]).length === 1);
  ok('全等序列无峰（无严格极大）', localMaxima([1, 1, 1]).length === 0);
}

// ---- 4) linesFromMask ----
{
  const mask = [1, 1, 0, 0, 0, 1, 1, 1, 0];
  ok('两段候选 → 两根竖线(mergeGap=3)',
    JSON.stringify(linesFromMask(mask, { maxRun: 5, mergeGap: 3 })) === '[1,6]',
    JSON.stringify(linesFromMask(mask, { maxRun: 5, mergeGap: 3 })));
  ok('相邻过近则合并(mergeGap=20)',
    JSON.stringify(linesFromMask(mask, { maxRun: 5, mergeGap: 20 })) === '[4]',
    JSON.stringify(linesFromMask(mask, { maxRun: 5, mergeGap: 20 })));
  ok('过宽段视为文字块丢弃',
    linesFromMask([1, 1, 1, 1, 1, 1, 0], { maxRun: 5 }).length === 0);
  ok('恰好 maxRun 宽仍保留',
    JSON.stringify(linesFromMask([1, 1, 1, 1, 1, 0], { maxRun: 5 })) === '[2]');
  ok('空 mask → 空结果', linesFromMask([], {}).length === 0);
  ok('全 0 mask → 空结果', linesFromMask([0, 0, 0], {}).length === 0);
  ok('默认参数可用（maxRun=5,mergeGap=20）', linesFromMask([1, 1, 0]).length === 1);
}

// ---- 5) barBounds ----
{
  ok('三条内部线 → 4 个小节',
    JSON.stringify(barBounds([50, 150, 250], 0, 300, 0)) === '[0,50,150,250,300]',
    JSON.stringify(barBounds([50, 150, 250], 0, 300, 0)));
  ok('无内部线 → 整行 1 个小节',
    JSON.stringify(barBounds([], 0, 300, 0)) === '[0,300]');
  ok('贴端点的线被丢弃',
    JSON.stringify(barBounds([10, 290], 0, 300, 20)) === '[0,300]',
    JSON.stringify(barBounds([10, 290], 0, 300, 20)));
  ok('过窄间隔被过滤',
    JSON.stringify(barBounds([50, 150, 250], 0, 300, 120)) === '[0,150,300]',
    JSON.stringify(barBounds([50, 150, 250], 0, 300, 120)));
  ok('乱序输入会先排序',
    JSON.stringify(barBounds([250, 50], 0, 300, 0)) === '[0,50,250,300]',
    JSON.stringify(barBounds([250, 50], 0, 300, 0)));
  ok('x0 > x1 也能正常（自动换序）',
    JSON.stringify(barBounds([150], 300, 0, 0)) === '[0,150,300]');
}

// ---- 6) barBoundsAt ----
{
  const bounds = [0, 50, 150, 250, 300];
  const r = barBoundsAt(bounds, 2);
  ok('取第 3 小节（0 基 2）', r && r.a === 150 && r.b === 250, JSON.stringify(r));
  ok('返回小节总数', r && r.count === 4);
  ok('越界 barIdx 夹到最后一个', (() => {
    const t = barBoundsAt(bounds, 99);
    return t && t.a === 250 && t.b === 300 && t.index === 3;
  })());
  ok('负 barIdx 夹到第一个', (() => {
    const t = barBoundsAt(bounds, -5);
    return t && t.a === 0 && t.b === 50 && t.index === 0;
  })());
  ok('边界不足返回 null（让调用方回退均分）', barBoundsAt([0], 0) === null);
  ok('null 边界返回 null', barBoundsAt(null, 0) === null);
}

// ---- 7) 端到端：一行 4 小节 → 3 条内部竖线 ----
{
  const W = 400;
  const cov = new Array(W).fill(0.05);
  for (const x of [100, 200, 300]) {          // 每条竖线占 3 列
    cov[x] = 0.95; cov[x + 1] = 0.97; cov[x + 2] = 0.95;
  }
  const mask = cov.map((v) => (v >= 0.88 ? 1 : 0));
  const lines = linesFromMask(mask, { maxRun: 5, mergeGap: 20 });
  ok('端到端：检出 3 条内部竖线', lines.length === 3, JSON.stringify(lines));
  ok('端到端：竖线位置在 101/201/301',
    near(lines[0], 101, 1) && near(lines[1], 201, 1) && near(lines[2], 301, 1),
    JSON.stringify(lines));

  const bounds = barBounds(lines, 0, W, 0);
  ok('端到端：得到 4 个小节', bounds.length - 1 === 4, 'bars=' + (bounds.length - 1));
  const b2 = barBoundsAt(bounds, 2);
  ok('端到端：第 3 小节范围 ≈ [201,301]',
    b2 && near(b2.a, 201, 1) && near(b2.b, 301, 1), JSON.stringify(b2));
}

// ---- 8) 接线完整性：核心文件是否真的被页面/脚本接上 ----
{
  const PUB = join(__dirname, '..', 'public');
  const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
  const html = read(join(PUB, 'image-tab.html'));
  const js = read(join(PUB, 'js', 'image-tab.js'));
  const sw = read(join(PUB, 'sw.js'));

  ok('image-tab.html 引入 barline-core.js', html.indexOf('js/barline-core.js') >= 0);
  ok('image-tab.html 有「小节线」按钮', html.indexOf('id="btnBars"') >= 0);
  ok('image-tab.js 使用 BarlineCore 列投影', js.indexOf('BC.columnProjection') >= 0);
  ok('image-tab.js 使用 linesFromMask', js.indexOf('BC.linesFromMask') >= 0);
  ok('image-tab.js 使用 barBounds', js.indexOf('BC.barBounds') >= 0);
  ok('image-tab.js 跟随改用 barBoundsAt', (js.match(/barBoundsAt\(/g) || []).length >= 2,
    '出现 ' + (js.match(/barBoundsAt\(/g) || []).length + ' 次（翻页+滚动两处）');
  ok('image-tab.js 保留均分回退', js.indexOf('bounds: null') >= 0);
  ok('sw.js 缓存版本已升到 v16', sw.indexOf("tabpilot-v16") >= 0);
  ok('sw.js 预缓存含 js/barline-core.js', sw.indexOf("js/barline-core.js") >= 0);
  ok('sw.js 仍预缓存 js/timing-core.js', sw.indexOf("js/timing-core.js") >= 0);
}

console.log(`\n断言汇总：通过 ${pass} / 失败 ${fail}`);
if (fail > 0) { console.error('存在失败用例'); process.exit(1); }
console.log('全部通过 ✅');
