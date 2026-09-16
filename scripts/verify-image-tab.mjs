/* ==========================================================================
 * verify-image-tab.mjs — 图片谱「多页」回归测试（在 jsdom 里跑真实页面）
 *
 * 为什么需要它：
 *   图片谱模式的多页逻辑（pages[]、跨页时间轴、自动翻页、胶片条）都跑在浏览器里，
 *   而本机没有可用的无头浏览器；jsdom 能加载真实的 image-tab.html + js/image-tab.js，
 *   只把 canvas / Image 打桩，就能把"载入多页 → 拼接时间轴 → 播到页末自动翻页"
 *   整条链路跑一遍，避免再出现"改了没人加载的文件"这类回归。
 *
 * 用法：npm run verify:image
 * ========================================================================== */
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

let html = readFileSync('public/image-tab.html', 'utf8');
const settingsJs = readFileSync('public/js/settings.js', 'utf8');
const tabJs = readFileSync('public/js/image-tab.js', 'utf8');
const themeJs = readFileSync('public/js/theme.js', 'utf8');

// 脚本改为内联注入，避免 jsdom 的外链资源加载差异
html = html.replace(/<script src="js\/[^"]+"><\/script>/g, '');
html = html.replace('</body>', `<script>${themeJs}</script><script>${settingsJs}</script><script>${tabJs}</script></body>`);

const vc = new VirtualConsole();
vc.on('jsdomError', (e) => console.log('[页面异常] ' + (e && e.message ? e.message : e)));
vc.on('error', (...a) => console.log('[console.error]', ...a));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://localhost/image-tab.html',
  virtualConsole: vc,
});
const win = dom.window;

/* ------------------------------------------------ 桩件：canvas 与 Image */
const fakeCtx = new Proxy({}, {
  get(_t, k) {
    if (k === 'getImageData') {
      // 返回全白像素 → 投影识别得到 0 行（本用例不测识别算法）
      return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255), width: w, height: h });
    }
    if (k === 'canvas') return { width: 800, height: 380 };
    return () => {};
  },
  set() { return true; },
});
win.HTMLCanvasElement.prototype.getContext = () => fakeCtx;

class FakeImage {
  constructor() { this.naturalWidth = 0; this.naturalHeight = 0; this._src = ''; }
  set src(v) {
    this._src = v;
    this.naturalWidth = 1000;
    this.naturalHeight = 1400;
    win.setTimeout(() => this.onload && this.onload(), 0);
  }
  get src() { return this._src; }
}
win.Image = FakeImage;

/* ------------------------------------------------------- 页面内断言脚本 */
const test = `
window.__R = [];
var R = window.__R;
var win = window;
function ok(name, cond, extra) { R.push((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  [' + extra + ']' : '')); }
document.getElementById('stage').scrollTo = function () {};
// jsdom 不解码图片：给舞台 <img> 的固有尺寸打桩（等价于浏览器解码完成）
var tabImgEl = document.getElementById('tabImg');
Object.defineProperty(tabImgEl, 'naturalWidth', { get: function () { return 1000; } });
Object.defineProperty(tabImgEl, 'naturalHeight', { get: function () { return 1400; } });

function loadBoth(done) {
  loadImageData('page1.jpg', true);                       // 载入第 1 页并显示
  win.setTimeout(function () {
    loadImageData('page2.jpg', false);                    // 追加第 2 页，不抢显示
    win.setTimeout(done, 30);
  }, 30);
}

window.addEventListener('load', function () {
  loadBoth(function () {
    var thumbs = document.querySelectorAll('#filmstrip .thumb');
    ok('载入两页：pages.length=2', pages.length === 2, 'pages=' + pages.length);
    ok('胶片条渲染 2 个缩略图', thumbs.length === 2, 'thumbs=' + thumbs.length);
    ok('胶片条可见（不是空灰条）', getComputedStyle(document.getElementById('filmstrip')).display !== 'none');
    ok('空态引导已隐藏', getComputedStyle(document.getElementById('stageEmpty')).display === 'none');
    ok('追加页不抢显示（仍停在第 1 页）', curPage === 0 && /page1\\.jpg$/.test(tabImgEl.src), 'curPage=' + curPage);
    ok('bands 指向当前页数组', bands === pages[0].bands);

    // 伪造识别结果：第 1 页 3 行、第 2 页 2 行，每行 4 小节
    pages[0].bands = [1, 2, 3].map(function () { return { y0: 0, y1: 100, x0: 0, x1: 800, bars: 4 }; });
    pages[1].bands = [1, 2].map(function () { return { y0: 0, y1: 100, x0: 0, x1: 800, bars: 4 }; });
    switchPageDisplay(0);
    bands = pages[0].bands;

    var bandMs = 4 * 4 * 60000 / 72;                      // 4 小节 × 4 拍 × 60s/72bpm
    ok('单行时长 = 13333ms', Math.abs(bandDur(bands[0]) - bandMs) < 1, bandDur(bands[0]).toFixed(1));
    ok('全曲时长 = 5 行跨页拼接', Math.abs(totalDur() - bandMs * 5) < 1, totalDur().toFixed(1));

    var l1 = locate(bandMs * 3 + 100);
    ok('时间轴跨页定位（第 4 行 → 第 2 页第 1 行）', l1 && l1.page === 1 && l1.band === 0, JSON.stringify(l1 && { page: l1.page, band: l1.band }));
    var l2 = locate(bandMs * 4 + 100);
    ok('第 2 页第 2 行定位', l2 && l2.page === 1 && l2.band === 1, JSON.stringify(l2 && { page: l2.page, band: l2.band }));

    document.getElementById('btnNextPage').click();
    ok('「下一页」切到第 2 页并换图', curPage === 1 && /page2\\.jpg$/.test(tabImgEl.src), 'curPage=' + curPage);
    // 注意：胶片条在 renderPageNav() 里是整块重建的，断言时必须重新查询节点
    var liveThumbs = document.querySelectorAll('#filmstrip .thumb');
    ok('胶片条第 2 张高亮', liveThumbs[1].classList.contains('cur') && !liveThumbs[0].classList.contains('cur'));

    gotoPage(0);
    startAtTime(bandMs * 3 - 300);                        // 从第 1 页末行末段开始跟随
    win.setTimeout(function () {
      var bar = document.getElementById('barBox');
      ok('播到页末自动翻到第 2 页', curPage === 1, 'curPage=' + curPage + ', playing=' + playing);
      ok('小节高亮框已显示', bar.style.display === 'block', 'inline=' + bar.style.display + ' band=' + curBand + ' bars=' + bands.length);

      // ===== 新增：A/B 区间循环 =====
      loopOn = true; loopA = 0; loopB = 200; startAtTime(0);   // 只循环前 200ms
      win.setTimeout(function () {
        ok('循环：越过 B 后无缝回到 A（curTime ≤ loopB）', curTime() <= 201, 'curTime=' + curTime().toFixed(0));
        ok('循环：起点 A 已记录为 0', loopA === 0, 'A=' + loopA);
        ok('循环：终点 B 已记录', loopB === 200, 'B=' + loopB);
        ok('循环：开关已置 on', loopOn === true);
        stop();

        // ===== 新增：小节号标注 =====
        window.TPSettings.set('startMeasure', 5);
        gotoPage(0);
        drawBands();
        var tag0 = document.getElementById('imgWrap').querySelector('.measureTag');
        ok('小节标注：起始小节=5 时第 1 行标 m5', !!tag0 && /m5/.test(tag0.textContent), tag0 && tag0.textContent);
        ok('measureStartAt 含起始偏移 (0,0)=4', measureStartAt(0, 0) === 4, 'got=' + measureStartAt(0, 0));

        window.TPSettings.set('startMeasure', 1);
        gotoPage(0);
        drawBands();
        ok('measureStartAt(0,1)=4（前一行 4 小节累加）', measureStartAt(0, 1) === 4, 'got=' + measureStartAt(0, 1));
        ok('measureStartAt(0,2)=8（两行共 8 小节）', measureStartAt(0, 2) === 8, 'got=' + measureStartAt(0, 2));
        renderBandList();
        ok('行列表含小节区间文字 m1', /m1/.test(document.getElementById('bandList').innerHTML));

        document.getElementById('btnClear').click();
        ok('「清空」后回到空态引导', pages.length === 0 && getComputedStyle(document.getElementById('stageEmpty')).display !== 'none');

        var pre = document.createElement('pre');
        pre.id = 'VERIFY';
        pre.textContent = R.join('\\n');
        document.body.appendChild(pre);
      }, 350);
    }, 900);
  });
});
`;
win.eval(test);

await new Promise((r) => setTimeout(r, 2500));
const pre = win.document.getElementById('VERIFY');
const report = pre ? pre.textContent : '(未生成报告 —— 页面可能有异常)';
console.log(report);
const pass = report.split('\n').filter((l) => l.startsWith('PASS')).length;
const fail = report.split('\n').filter((l) => l.startsWith('FAIL')).length;
console.log(`\n=== 断言汇总：${pass} 通过 / ${fail} 失败 ===`);
dom.window.close();
process.exit(fail ? 1 : 0);
