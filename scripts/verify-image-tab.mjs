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
    if (k === 'createImageData') {
      return (w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255), width: w, height: h });
    }
    return () => {};
  },
  set() { return true; },
});
win.HTMLCanvasElement.prototype.getContext = () => fakeCtx;
// jsdom 未实现 canvas 导出（需要 node-canvas），修图/导出会用到，这里桩掉
win.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,ZmFrZQ==';

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

        // ===== 新增：滚动 / 翻页双模式 =====
        window.TPSettings.set('viewMode', 'scroll');
        ok('滚动模式：scrollView 显示', getComputedStyle(document.getElementById('scrollView')).display !== 'none');
        ok('滚动模式：imgWrap 隐藏', getComputedStyle(document.getElementById('imgWrap')).display === 'none');
        var sp = document.querySelectorAll('#scrollView .scrollPage');
        ok('滚动模式：两页纵向拼接出 2 个 scrollPage', sp.length === 2, 'n=' + sp.length);
        ok('滚动模式：两页谱行(3+2=5)全部绘出 .band',
          document.querySelectorAll('#scrollView .ov .band').length === 5,
          'n=' + document.querySelectorAll('#scrollView .ov .band').length);

        gotoPage(1);
        var ph = document.getElementById('barBox').parentNode;
        ok('滚动模式：跳页后播放头移入第 2 页覆盖层',
          ph.classList.contains('ov') && ph.dataset.page === '1',
          'page=' + (ph.dataset && ph.dataset.page));
        ok('滚动模式：跳页后 curPage=1', curPage === 1, 'curPage=' + curPage);

        window.TPSettings.set('viewMode', 'flip');
        ok('翻页模式：imgWrap 恢复显示', getComputedStyle(document.getElementById('imgWrap')).display !== 'none');
        ok('翻页模式：scrollView 隐藏', getComputedStyle(document.getElementById('scrollView')).display === 'none');

        // ===== 新增：工程文件导入 / 导出 =====
        var proj = {
          app: 'TabPilot', version: 1,
          settings: { bpm: 90, bpb: 3, startMeasure: 2, rate: 80 },
          pages: [
            { src: 'pa.jpg', bands: [
              { x0: 0, y0: 0, x1: 800, y1: 100, bars: 3 },
              { x0: 0, y0: 120, x1: 800, y1: 220, bars: 4 },
            ] },
            { src: 'pb.jpg', bands: [{ x0: 0, y0: 0, x1: 800, y1: 100, bars: 2 }] },
          ],
        };
        applyProject(proj);
        win.setTimeout(function () {
          ok('工程导入：载入 2 页', pages.length === 2, 'pages=' + pages.length);
          ok('工程导入：第 1 页恢复 2 行', pages[0].bands.length === 2, 'n=' + pages[0].bands.length);
          ok('工程导入：第 2 页恢复 1 行', pages[1].bands.length === 1, 'n=' + pages[1].bands.length);
          ok('工程导入：起始小节生效', window.TPSettings.get('startMeasure') === 2,
            'sm=' + window.TPSettings.get('startMeasure'));
          ok('工程导入：BPM 生效', parseInt(document.getElementById('bpm').value, 10) === 90,
            'bpm=' + document.getElementById('bpm').value);

          var out = buildProject();
          ok('工程导出：带 app 标识', !!out && out.app === 'TabPilot');
          ok('工程导出：2 页且谱行被序列化',
            out.pages.length === 2 && out.pages[0].bands.length === 2 && out.pages[1].bands.length === 1,
            'p=' + out.pages.length);
          ok('工程导出：谱行字段完整(x0/y0/x1/y1/bars)',
            out.pages[0].bands[0].x0 === 0 && out.pages[0].bands[0].y1 === 100 && out.pages[0].bands[0].bars === 3);

          // ===== 新增：段落标记 =====
          addMarkAt(0, 0, '主歌');
          addMarkAt(1, 0, '副歌');
          ok('段落标记：成功添加 2 个', marks.length === 2, 'n=' + marks.length);
          ok('段落标记：按 (page,band) 升序存放',
            marks[0].page === 0 && marks[0].band === 0 && marks[1].page === 1);
          ok('段落时间：第 1 段起点 = 0', markTime(marks[0]) === 0, 't=' + markTime(marks[0]));
          var pg0Dur = bandDur(pages[0].bands[0]) + bandDur(pages[0].bands[1]);
          ok('段落时间：第 2 段起点 = 第 1 页总时长',
            Math.abs(markTime(marks[1]) - pg0Dur) < 1,
            't=' + markTime(marks[1]).toFixed(1) + ' 期望=' + pg0Dur.toFixed(1));
          ok('段落时间：末段终点 = 全曲时长', Math.abs(markEnd(1) - totalDur()) < 1, 'end=' + markEnd(1).toFixed(1));
          var mm0 = markMeasures(0);
          ok('段落小节区间：第 1 段 m2–m8（startMeasure=2，第1页 3+4 小节）',
            mm0[0] === 2 && mm0[1] === 8, JSON.stringify(mm0));
          ok('段落归属：sectionOfPos(0,1) = 主歌', sectionOfPos(0, 1) === '主歌', String(sectionOfPos(0, 1)));
          ok('段落归属：sectionOfPos(1,0) = 副歌', sectionOfPos(1, 0) === '副歌', String(sectionOfPos(1, 0)));
          ok('段落归属：起点之前无段落', sectionOfPos(0, 0) === '主歌');

          renderSections();
          var secHtml = document.getElementById('sectionList').innerHTML;
          ok('段落列表：渲染 2 项', document.querySelectorAll('#sectionList .secItem').length === 2,
            'n=' + document.querySelectorAll('#sectionList .secItem').length);
          ok('段落列表：含名称与小节区间', /主歌/.test(secHtml) && /m2/.test(secHtml));
          drawBands();
          ok('段落标记绘制到当前页覆盖层（只画当前页）',
            document.querySelectorAll('#imgWrap .secTag').length === 1,
            'n=' + document.querySelectorAll('#imgWrap .secTag').length);

          loopMark(1);
          ok('段落循环：A/B 设成该段区间并开启',
            loopOn === true && loopA === markTime(marks[1]) && Math.abs(loopB - totalDur()) < 1,
            'A=' + (loopA / 1000).toFixed(1) + 's B=' + (loopB / 1000).toFixed(1) + 's');
          loopOn = false;

          addMarkAt(0, 0, '前奏');
          ok('同位置重复打标记 = 改名，不新增', marks.length === 2 && marks[0].name === '前奏',
            'n=' + marks.length + ' name=' + marks[0].name);

          // ===== 新增：练习记录 =====
          try { localStorage.removeItem('tabpilot.practiceLog'); } catch (e) {}
          sessMs = 0; sessStart = 0; sessLoops = 0;
          sessMs = 42000; sessLoops = 3; curPage = 0; curBand = 0; curBar = 1;
          finishPractice();
          var lg = loadLog();
          ok('练习记录：超过 5 秒写入一条', lg.length === 1, 'n=' + lg.length);
          ok('练习记录：时长与循环次数正确',
            !!lg[0] && lg[0].ms === 42000 && lg[0].loops === 3, lg[0] && JSON.stringify(lg[0]));
          ok('练习记录：写入后会话归零', sessMs === 0 && sessLoops === 0);
          sessMs = 1200; finishPractice();
          ok('练习记录：不足 5 秒不计入', loadLog().length === 1, 'n=' + loadLog().length);

          openPractice();
          ok('练习面板：打开后可见', getComputedStyle(document.getElementById('practiceModal')).display !== 'none');
          ok('练习面板：4 张统计卡', document.querySelectorAll('#pmStats .pm-stat').length === 4,
            'n=' + document.querySelectorAll('#pmStats .pm-stat').length);
          ok('练习面板：近 7 天柱状图 7 根', document.querySelectorAll('#pmChart .pm-col').length === 7,
            'n=' + document.querySelectorAll('#pmChart .pm-col').length);
          ok('练习面板：最近记录至少 1 条', document.querySelectorAll('#pmList .pm-row').length >= 1,
            'n=' + document.querySelectorAll('#pmList .pm-row').length);
          var csvOk = true;
          try { exportPracticeCsv(); } catch (e) { csvOk = false; }
          ok('练习记录：导出 CSV 不抛异常', csvOk);
          closePractice();
          ok('练习面板：关闭后隐藏', getComputedStyle(document.getElementById('practiceModal')).display === 'none');

          // ===== 新增：渐进提速训练 =====
          loopOn = false; loopA = null; loopB = null; trainOn = false; trainCount = 0;
          document.getElementById('btnTrain').click();
          ok('提速：没设循环区间时不启动', trainOn === false);
          loopOn = true; loopA = 0; loopB = 1000;
          document.getElementById('trainFrom').value = '60';
          document.getElementById('trainStep').value = '5';
          document.getElementById('trainTo').value = '100';
          document.getElementById('btnTrain').click();
          ok('提速：设好循环后可启动', trainOn === true);
          ok('提速：启动即回到起始速度 60%', window.TPSettings.get('rate') === 60,
            'rate=' + window.TPSettings.get('rate'));
          stepTrain();
          ok('提速：完成一轮后 +5% → 65%', window.TPSettings.get('rate') === 65,
            'rate=' + window.TPSettings.get('rate'));
          stepTrain(); stepTrain();
          ok('提速：三轮后 → 75%', window.TPSettings.get('rate') === 75,
            'rate=' + window.TPSettings.get('rate'));
          for (var ti = 0; ti < 10; ti++) { stepTrain(); }
          ok('提速：到目标 100% 后不再往上超', window.TPSettings.get('rate') === 100,
            'rate=' + window.TPSettings.get('rate'));
          ok('提速：到达目标后自动关闭', trainOn === false);
          ok('提速：结束后底部芯片隐藏', getComputedStyle(document.getElementById('trainChip')).display === 'none');
          document.getElementById('trainFrom').value = '300';
          document.getElementById('trainStep').value = '99';
          document.getElementById('trainTo').value = '40';
          var tpBad = trainParams();
          ok('提速：参数越界被夹紧（from≤100、step≤20、to≥from）',
            tpBad.from === 100 && tpBad.step === 20 && tpBad.to === 100, JSON.stringify(tpBad));
          document.getElementById('trainFrom').value = '60';
          document.getElementById('trainStep').value = '5';
          document.getElementById('trainTo').value = '100';
          window.TPSettings.set('rate', 100);
          updateTrainUI();
          loopOn = false;

          // ===== 新增：PDF 导入（真实渲染需二进制 PDF，这里只测类型分发） =====
          ok('PDF 识别：.pdf 扩展名', isPdfFile({ name: 'a.pdf', type: '' }) === true);
          ok('PDF 识别：application/pdf 的 MIME', isPdfFile({ name: 'x', type: 'application/pdf' }) === true);
          ok('PDF 识别：.PDF 大写扩展名', isPdfFile({ name: 'B.PDF', type: '' }) === true);
          ok('PDF 识别：jpg 不算 PDF', isPdfFile({ name: 'a.jpg', type: 'image/jpeg' }) === false);
          ok('PDF 识别：无扩展名不算 PDF', isPdfFile({ name: 'a', type: '' }) === false);
          ok('PDF 导入入口存在且是异步函数', typeof importPdf === 'function' && importPdf.constructor.name === 'AsyncFunction');

          // ===== 新增：图片预处理（修图） =====
          var srcBefore = pages[0].src;
          document.getElementById('btnPrep').click();
          ok('修图面板：打开后可见', getComputedStyle(document.getElementById('prepModal')).display !== 'none');
          ok('修图面板：初始无操作', prep.rot === 0 && !prep.flip && !prep.crop && !prep.enhance);
          document.getElementById('prepRotR').click();
          ok('修图：右转 90°', prep.rot === 90, 'rot=' + prep.rot);
          document.getElementById('prepRotL').click();
          document.getElementById('prepRotL').click();
          ok('修图：左转两次 = -90°', prep.rot === -90, 'rot=' + prep.rot);
          document.getElementById('prepFlip').click();
          document.getElementById('prepCrop').click();
          document.getElementById('prepEnh').click();
          ok('修图：镜像 / 裁边 / 增强三个开关都生效',
            prep.flip === true && prep.crop === true && prep.enhance === true);
          // ---- 透视矫正（四点拉正）----
          var H = quadHomography([[10, 20], [210, 30], [200, 130], [20, 120]]);
          function mapPt(u, v) { return homographyMap(H, u, v); }
          function near(a, b) { return Math.abs(a - b) < 0.01; }
          var m00 = mapPt(0, 0), m10 = mapPt(1, 0), m11 = mapPt(1, 1), m01 = mapPt(0, 1);
          ok('透视：单应矩阵把 (0,0) 映射到左上角', near(m00[0], 10) && near(m00[1], 20), JSON.stringify(m00));
          ok('透视：把 (1,0) 映射到右上角', near(m10[0], 210) && near(m10[1], 30), JSON.stringify(m10));
          ok('透视：把 (1,1) 映射到右下角', near(m11[0], 200) && near(m11[1], 130), JSON.stringify(m11));
          ok('透视：把 (0,1) 映射到左下角', near(m01[0], 20) && near(m01[1], 120), JSON.stringify(m01));
          ok('透视：矩形四点是纯仿射（g=h=0）', quadHomography([[0, 0], [100, 0], [100, 50], [0, 50]]).g === 0);
          ok('validQuad：正常四边形为 true', validQuad([[0, 0], [100, 0], [100, 50], [0, 50]]) === true);
          ok('validQuad：退化成直线为 false', validQuad([[0, 0], [100, 0], [50, 0], [25, 0]]) === false);
          ok('validQuad：点不足 / 含 NaN 为 false',
            validQuad([[0, 0], [1, 1]]) === false && validQuad([[0, 0], [1, NaN], [1, 1], [0, 1]]) === false);
          var warped = warpPerspective(pages[0].img, [[0, 0], [100, 0], [110, 90], [0, 90]], 0);
          ok('透视：输出尺寸取对边较大值（宽 110 / 高 91）',
            !!warped && warped.width === 110 && warped.height === 91,
            warped ? warped.width + 'x' + warped.height : 'null');

          document.getElementById('prepPersp').click();
          ok('透视：开关打开后置 persp=true、容器加 .persp',
            prep.persp === true && document.getElementById('prepBox').classList.contains('persp'));
          ok('透视：默认四点贴合四角且 validQuad 为真', validQuad(prep.pts) === true, JSON.stringify(prep.pts));
          var pgcP = prepCanvas(pages[0], prep, 900);
          ok('透视：开启后生成的是拉正后的矩形 canvas', !!pgcP && pgcP.width > 0 && pgcP.height > 0,
            pgcP ? pgcP.width + 'x' + pgcP.height : 'null');
          document.getElementById('prepPersp').click();
          ok('透视：再次点击可关闭', prep.persp === false);

          var pgc = prepCanvas(pages[0], prep);
          ok('修图：旋转 90° 后 canvas 宽高互换（1000×1400 → 1400×1000）',
            pgc.width === 1400 && pgc.height === 1000, pgc.width + 'x' + pgc.height);
          ok('修图：全白桩图裁边判定为「没得裁」，不抛异常', cropWhite(pgc) === null);

          document.getElementById('prepApply').click();
          ok('修图：点应用后面板关闭', getComputedStyle(document.getElementById('prepModal')).display === 'none');
          win.setTimeout(function () {
            ok('修图：应用后当前页换成处理后的 dataURL',
              pages[0].src !== srcBefore && /^data:image/.test(pages[0].src), pages[0].src.slice(0, 24));
            ok('修图：应用后该页谱行作废（坐标已变）', pages[0].bands.length === 0, 'n=' + pages[0].bands.length);
            ok('修图：应用后清掉该页段落标记（其它页保留）',
              marks.every(function (m) { return m.page !== 0; }), 'marks=' + marks.length);

            openPrep();
            document.getElementById('prepReset').click();
            win.setTimeout(function () {
              ok('修图：还原原图回到载入时的 src', pages[0].src === srcBefore, String(pages[0].src).slice(0, 24));
              closePrep();

              document.getElementById('btnClear').click();
              ok('清空后回到空态引导', pages.length === 0 && getComputedStyle(document.getElementById('stageEmpty')).display !== 'none');
              ok('清空后滚动视图无残留页', document.querySelectorAll('#scrollView .scrollPage').length === 0);
              ok('清空后段落标记一并清除', marks.length === 0 && document.querySelectorAll('#sectionList .secItem').length === 0,
                'marks=' + marks.length);

              var pre = document.createElement('pre');
              pre.id = 'VERIFY';
              pre.textContent = R.join('\\n');
              document.body.appendChild(pre);
            }, 60);
          }, 60);
        }, 80);
      }, 350);
    }, 900);
  });
});
`;
win.eval(test);

// 等待页面跑完异步断言链。透视矫正在 jsdom 里是纯 JS 逐像素重采样（无 GPU），
// 单次百万级像素耗时较长，预算给到 9 秒。
await new Promise((r) => setTimeout(r, 9000));
const pre = win.document.getElementById('VERIFY');
const report = pre ? pre.textContent : '(未生成报告 —— 页面可能有异常)';
console.log(report);
const pass = report.split('\n').filter((l) => l.startsWith('PASS')).length;
const fail = report.split('\n').filter((l) => l.startsWith('FAIL')).length;
console.log(`\n=== 断言汇总：${pass} 通过 / ${fail} 失败 ===`);
dom.window.close();
process.exit(fail ? 1 : 0);
