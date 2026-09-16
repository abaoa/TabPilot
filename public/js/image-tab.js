/* ==========================================================================
 * image-tab.js — 图片谱跟随（image-tab.html 的业务脚本）
 *
 * 为什么图片谱需要校准：
 *   JPG/PNG 只有像素，没有"小节坐标"这类结构化信息。因此流程是
 *     ① 载入谱图（支持同一首歌多张图片 = 多页）
 *     ② 识别谱行（水平投影找六线谱线簇 → 聚类成行，并检测竖直小节线求每行小节数）
 *     ③ 按 BPM × 每行小节数展开时间轴，行内小节均分推进
 *     ④ 行内高亮当前小节框 + 扫描线，右下放大镜光栅放大当前小节
 *
 * 多页模型：
 *   pages[i] = { img, src, w, h, bands:[...] }
 *   `bands` 始终指向「当前页」的谱行数组（pages[curPage].bands 的引用），
 *   识别 / 列表 / 绘制等原有逻辑因此无需改动即可作用于当前页。
 *   全曲时间轴 = 所有页的 bands 依次拼接；跟到当前页末行末小节时自动翻到下一页。
 *
 * 关键坐标约定：bands 中的 y0/y1/x0/x1 均为"图片原始像素"坐标；
 * 显示缩放由 #imgWrap 的 zoom 统一处理，覆盖层作为其子元素自动跟随，
 * 因此所有计算都可以用原始像素，无需关心当前缩放比例。
 * ========================================================================== */
'use strict';

/** 简写：按 id 取元素 */
const $ = (id) => document.getElementById(id);

const stage = $('stage');
const imgWrap = $('imgWrap');
const tabImg = $('tabImg');
const barBox = $('barBox');
const scanline = $('scanline');

/* ------------------------------------------------------------------ 状态 */
/** 谱行集合：{ y0, y1, x0, x1, bars, sTop, sBot }（图片原始像素） */
let bands = [];
/**
 * 多页支持：pages[i] = { img, src, w, h, bands:[...] }
 * `bands` 始终指向「当前页」的谱行数组（pages[curPage].bands 的引用），
 * 这样识别/列表/绘制等原有逻辑无需改动即可作用于当前页。
 */
let pages = [];
let curPage = 0;
/** 文件导入模式：'replace' 清空后载入，'append' 追加到现有页之后 */
let loadMode = 'replace';
/** 手动框行模式与已点击的边界点 */
let manualMode = false;
let manualPts = [];
/** 播放状态 */
let playing = false;
let paused = false;
/** 暂停前累计的音乐时间（ms） */
let elapsedBase = 0;
/** 本次恢复播放的 wallclock 起点 */
let t0 = 0;
/** 播放倍速 */
let rate = 1.0;
/** 帧推进定时器 */
let timer = null;
/** 当前行 / 当前小节索引（页内） */
let curBand = -1;
let curBar = -1;
/** 图片显示缩放（双击在 100% ↔ 放大间切换） */
let zoomLevel = 1.0;
/** 放大镜开关 */
let magOn = true;
/** 节拍器状态与音频上下文 */
let metro = false;
let ac = null;
let lastBeat = -1;
/** 练习：A/B 区间循环 */
let loopOn = false;
let loopA = null;   // 循环起点（音乐时间 ms）
let loopB = null;   // 循环终点（音乐时间 ms）
/**
 * 视图模式：
 *   'flip'   翻页 —— 一次只显示一页，跨页时自动翻页（原行为）
 *   'scroll' 滚动 —— 把所有页纵向拼成一条长图，连续自动滚动跟随
 */
let viewMode = 'flip';
/** 滚动模式下每页的覆盖层容器 / 顶部偏移 / 显示缩放（由 buildScrollView 维护） */
let pageOv = [];
let pageTop = [];
let pageScale = [];
/**
 * 段落标记：{ page, band, name, color }
 * 存的是「页 + 行」而不是时间 —— 改 BPM / 改每行小节数后段落位置依然正确。
 */
let marks = [];
/** 段落配色轮转 */
const SEC_COLORS = ['#2f6fed', '#e11d48', '#f59e0b', '#10b981', '#8b5cf6', '#06b6d4'];
/** 练习记录：本次会话累计时长 / 本段起点 / 循环次数 */
let sessMs = 0;
let sessStart = 0;
let sessLoops = 0;

/* ---------------------------------------------------------------- 工具函数 */

/** 设置状态灯与模式文字 */
function setLed(cls, text) {
  $('led').className = 'led' + (cls ? ' ' + cls : '');
  $('modeText').textContent = text;
}

/** 设置底部提示文字（受"显示操作提示"设置控制可见性） */
function setHint(t) {
  $('hint').textContent = t;
}

/** HTML 转义：段落名等用户输入在拼 innerHTML 前必须过一遍 */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ------------------------------------------------------------------ 节拍器 */

/** 切换节拍器；首次开启时懒创建 AudioContext（浏览器要求用户手势后才能播放） */
$('btnMetro').onclick = () => {
  metro = !metro;
  $('btnMetro').classList.toggle('active', metro);
  if (metro) {
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
  }
};

/** 发出一声节拍点击；accent 为真时是重拍（更高更响） */
function clickTick(accent) {
  if (!metro || !ac) return;
  try {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.frequency.value = accent ? 1200 : 750;
    g.gain.setValueAtTime(0.0001, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(accent ? 0.45 : 0.28, ac.currentTime + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.07);
    o.connect(g);
    g.connect(ac.destination);
    o.start();
    o.stop(ac.currentTime + 0.09);
  } catch (e) { /* 音频被策略拦截：忽略，不影响跟随 */ }
}

/* ---------------------------------------------------------------- 图片加载 */

$('btnLoad').onclick = () => { loadMode = 'replace'; $('fileInput').click(); };
$('btnAdd').onclick = () => { loadMode = 'append'; $('fileInput').click(); };

/** 是不是 PDF（扩展名或 MIME 任一命中即可，某些系统给不出 MIME） */
function isPdfFile(f) {
  return /\.pdf$/i.test(f.name || '') || f.type === 'application/pdf';
}

/** 懒加载 pdf.js：只有真正导入 PDF 时才拉取这 1.3MB 的库 */
let pdfLibPromise = null;
function loadPdfLib() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (pdfLibPromise) return pdfLibPromise;
  pdfLibPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/pdf.min.js';
    s.onload = () => {
      if (!window.pdfjsLib) { reject(new Error('pdf.js 未正确加载')); return; }
      try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js'; } catch (e) { /* 无 Worker 时 pdf.js 会退回主线程 */ }
      resolve(window.pdfjsLib);
    };
    s.onerror = () => { pdfLibPromise = null; reject(new Error('无法加载 PDF 解析库')); };
    document.head.appendChild(s);
  });
  return pdfLibPromise;
}

/**
 * 导入 PDF：每一页渲染成一张谱图（≈1600px 宽），按顺序追加成多页。
 * 渲染分辨率取「够看清六线谱」与「别把内存吃光」的折中。
 */
async function importPdf(file, makeFirstCurrent) {
  setLed('', '正在解析 PDF：' + file.name);
  const lib = await loadPdfLib();
  const buf = await file.arrayBuffer();
  const doc = await lib.getDocument({ data: buf }).promise;
  const n = doc.numPages;

  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.max(1, Math.min(2, 1600 / base.width));
    const vp = page.getViewport({ scale });
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.floor(vp.width));
    cv.height = Math.max(1, Math.floor(vp.height));
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    setHint('正在渲染 PDF：第 ' + i + ' / ' + n + ' 页');
    loadImageData(cv.toDataURL('image/jpeg', 0.92), !!makeFirstCurrent && i === 1, file.name + ' 第' + i + '页');
    try { page.cleanup(); } catch (e) { /* 旧版本没有 cleanup */ }
  }
  setLed('ok', 'PDF 已导入（' + n + ' 页）');
  setHint('PDF 导入完成，共 ' + n + ' 页。点「🤖 自动识别谱行」逐页识别（识别只作用于当前页）。');
  return n;
}

$('fileInput').onchange = async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  const isAppend = loadMode === 'append';
  if (!isAppend) { pages = []; curPage = 0; bands = []; stop(); }

  const imgs = files.filter((f) => !isPdfFile(f));
  const pdfs = files.filter(isPdfFile);
  const before = pages.length;

  imgs.forEach((f, idx) => {
    const r = new FileReader();
    // 替换模式：只把第一张设为当前显示页；追加模式：全部追加，不切换显示
    const makeCurrent = !isAppend && idx === 0;
    r.onload = () => loadImageData(r.result, makeCurrent, f.name);
    r.onerror = () => setHint('读取文件失败：' + f.name);
    r.readAsDataURL(f);
  });
  if (isAppend && before) {
    setHint('正在追加 ' + files.length + ' 页…追加完成后共 ' + (before + files.length) + ' 页');
  }

  // PDF 走异步逐页渲染，必须串行，否则页序会乱
  const pdfFirst = !isAppend && imgs.length === 0;
  for (let i = 0; i < pdfs.length; i++) {
    try {
      await importPdf(pdfs[i], pdfFirst && i === 0);
    } catch (err) {
      setHint('PDF 导入失败：' + pdfs[i].name + '（' + ((err && err.message) || err) + '）');
    }
  }
  e.target.value = '';   // 允许重复选择同一个文件
};

$('btnDemo').onclick = () => {
  pages = []; curPage = 0; bands = []; stop();
  loadImageData('assets/demo-xihn.jpg', true);
};

/**
 * 载入一张谱图：预加载到 Image 对象，作为新的一页加入 pages。
 *
 * 页对象在调用时同步入栈（而不是等 onload），这样一次多选多张图片时
 * 页序稳定 —— 若等到 onload 才入栈，解码快慢不同会导致页序错乱。
 *
 * @param {string}  src         图片地址（DataURL 或相对路径）
 * @param {boolean} current     是否立即设为当前显示页
 * @param {string}  [name]      原始文件名（仅用于失败提示）
 * @param {Array}   [preset]    预设谱行（打开工程文件时用它免去重新框选）
 */
function loadImageData(src, current, name, preset) {
  const pg = {
    img: new Image(),
    src,
    orig: src,          // 载入时的原始图，供「修图 → 还原原图」回退
    w: 0,
    h: 0,
    bands: Array.isArray(preset) ? preset.map((b) => ({
      x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, bars: b.bars,
    })) : [],
  };
  pages.push(pg);
  const idx = pages.length - 1;

  pg.img.onload = () => {
    pg.w = pg.img.naturalWidth;
    pg.h = pg.img.naturalHeight;
    if (viewMode === 'scroll') buildScrollView();   // 滚动视图需要重排
    if (current || idx === 0) switchPageDisplay(idx);
    renderPageNav();
    setLed('', '图片已加载（共 ' + pages.length + ' 页）');
    setHint('点「🤖 自动识别谱行」识别当前页谱行，或「✌️ 手动框行」逐行框选');
  };
  pg.img.onerror = () => {
    renderPageNav();
    setHint('图片加载失败（格式可能不受支持，请用 JPG/PNG）：' + (name || String(src).slice(0, 40)));
  };
  pg.img.src = src;
}

/** 打开工程文件用：带着已保存的谱行识别结果载页 */
function loadProjectPage(src, presetBands, current) {
  return loadImageData(src, current, null, presetBands);
}

/**
 * 切换显示到指定页：更新当前页引用并重建覆盖层。
 * 翻页模式：换 #tabImg 的源；滚动模式：全页都在 DOM 里，只滚动到该页并移动播放头。
 */
function switchPageDisplay(pi) {
  if (pi < 0 || pi >= pages.length) return;
  curPage = pi;
  bands = pages[pi].bands;

  if (viewMode === 'scroll') {
    attachPlayhead(pageOv[pi]);
    drawBandsScroll();
    renderBandList();
    scrollToPage(pi);
    if (!playing && bands.length) showPosition(0, 0);
    renderPageNav();
    return;
  }

  tabImg.onload = () => {
    layout();
    drawBands();
    renderBandList();
    if (!playing && pages[curPage].bands.length) showPosition(0, 0);   // 停播时给个预览高亮
  };
  tabImg.src = pages[pi].src;
  renderPageNav();
}

/* ------------------------------------------------- 滚动模式：整谱纵向长图 */

/** 滚动视图的可用内容宽度（jsdom 等无布局环境下也能拿到合理值） */
function scrollContentWidth() {
  const sv = $('scrollView');
  const w = sv.clientWidth || (stage.clientWidth - 16) || 800;
  return Math.max(120, w);
}

/**
 * 重建滚动视图：把所有页纵向拼接成一条长图。
 * 同时记录每页的覆盖层容器、纵向偏移与显示缩放，供绘制与自动滚动使用。
 */
function buildScrollView() {
  const sv = $('scrollView');
  sv.innerHTML = '';
  pageOv = [];
  pageTop = [];
  pageScale = [];
  if (!pages.length) return;

  const cw = scrollContentWidth();
  const GAP = 14;                      // 页间距
  let top = 0;
  pages.forEach((pg, i) => {
    const nw = pg.w || 1000;
    const nh = pg.h || 1400;
    const scale = cw / nw;
    const dispH = nh * scale;

    const wrap = document.createElement('div');
    wrap.className = 'scrollPage';
    wrap.dataset.page = i;
    wrap.style.height = dispH + 'px';

    const im = document.createElement('img');
    im.src = pg.src;
    im.alt = '第 ' + (i + 1) + ' 页';
    wrap.appendChild(im);

    const ov = document.createElement('div');
    ov.className = 'ov';
    ov.dataset.page = i;                 // 播放头移入后据此判断它当前落在哪一页
    ov.style.width = cw + 'px';
    ov.style.height = dispH + 'px';
    wrap.appendChild(ov);

    sv.appendChild(wrap);
    pageOv[i] = ov;
    pageTop[i] = top;
    pageScale[i] = scale;
    top += dispH + GAP;
  });
  sv.style.minHeight = top + 'px';
  // 整块重建后把播放头挂回当前页（resize、追加页等都会走到这里）
  if (pageOv[curPage]) attachPlayhead(pageOv[curPage]);
}

/**
 * 滚动模式下的谱行绘制：所有页的行都画出来（整谱长图），
 * 覆盖层坐标按各页显示缩放换算（bands 里存的是图片原始像素）。
 */
function drawBandsScroll() {
  pages.forEach((pg, pi) => {
    const ov = pageOv[pi];
    if (!ov) return;
    // 只清谱行/标注，不清播放头（barBox 等已被移到本覆盖层内）
    ov.querySelectorAll('.band, .measureTag, .secTag, .secBar').forEach((n) => n.remove());
    const s = pageScale[pi] || 1;
    pg.bands.forEach((b, i) => {
      const d = document.createElement('div');
      d.className = 'band';
      d.dataset.page = pi;
      d.dataset.band = i;
      d.style.top = (b.y0 * s) + 'px';
      d.style.left = (b.x0 * s) + 'px';
      d.style.width = ((b.x1 - b.x0) * s) + 'px';
      d.style.height = ((b.y1 - b.y0) * s) + 'px';
      ov.appendChild(d);

      const m0 = measureStartAt(pi, i) + 1;
      const m1 = m0 + b.bars - 1;
      const tag = document.createElement('div');
      tag.className = 'measureTag';
      tag.style.left = (b.x0 * s) + 'px';
      tag.style.top = (b.y0 * s) + 'px';
      tag.textContent = b.bars > 1 ? ('m' + m0 + '–' + m1) : ('m' + m0);
      ov.appendChild(tag);
    });

    // 滚动模式整谱长图，所有页的段落标记都画
    marks.forEach((m, mi) => { if (m.page === pi) drawSection(m, mi, ov, s); });
  });
}

/** 滚动到指定页的页首 */
function scrollToPage(pi) {
  if (viewMode !== 'scroll') return;
  stage.scrollTo({ top: Math.max(0, (pageTop[pi] || 0) - 8), behavior: 'smooth' });
}

/** 把播放头（小节框 / 扫描线 / 浮动小节号）挂到指定覆盖层里 */
function attachPlayhead(target) {
  if (!target) return;
  target.appendChild(barBox);
  target.appendChild(scanline);
  target.appendChild($('measureLabel'));
}

/** 视图模式切换后的 DOM 处理：显隐、重建、恢复当前页 */
function applyViewModeDom() {
  const flip = viewMode === 'flip';
  // 显式赋值：#scrollView 的 CSS 默认 display:none，置空会回落到 none
  $('imgWrap').style.display = flip ? 'block' : 'none';
  $('scrollView').style.display = flip ? 'none' : 'block';
  if (flip) {
    attachPlayhead(imgWrap);
    if (pages.length) {
      tabImg.src = pages[curPage].src;
      drawBands();
      if (!playing && bands.length) showPosition(0, 0);
    }
  } else {
    buildScrollView();
    if (pages.length) {
      attachPlayhead(pageOv[curPage]);
      drawBands();
      if (!playing && bands.length) showPosition(0, 0);
    }
  }
}

/** 同步视图切换按钮的高亮 */
function setViewModeUI() {
  $('viewFlip').classList.toggle('on', viewMode === 'flip');
  $('viewScroll').classList.toggle('on', viewMode === 'scroll');
}

/**
 * 重新计算图片显示尺寸：先按容器宽度自适应，再叠加用户缩放。
 * 缩放使用 CSS zoom，覆盖层作为 #imgWrap 子元素会自动跟随，无需重算坐标。
 * 滚动模式下改由 buildScrollView() 负责排版。
 */
function layout() {
  // 滚动模式：重建长图后要重绘谱行，否则 innerHTML 清空后行框会消失
  if (viewMode === 'scroll') {
    buildScrollView();
    if (pages.length) drawBands();
    return;
  }
  if (!tabImg.naturalWidth) return;
  const w = stage.clientWidth - 16;
  const scale = Math.min(1, w / tabImg.naturalWidth) * zoomLevel;
  imgWrap.style.zoom = scale;
  imgWrap.style.width = tabImg.naturalWidth + 'px';
}

window.addEventListener('resize', layout);

/* ------------------------------------------------------- 谱行识别（投影法） */

$('btnDetect').onclick = () => {
  if (!pages[curPage] || !pages[curPage].img.naturalWidth) { setHint('请先加载谱图'); return; }
  pages[curPage].bands = detectBands();
  bands = pages[curPage].bands;
  pruneMarks();
  renderSections();
  renderBandList();
  setLed('ok', '已识别 ' + bands.length + ' 行（第 ' + (curPage + 1) + ' 页）');
  setHint('检查右侧行列表：可删除误检行、修改每行小节数，然后点「▶ 开始跟随」');
};

/**
 * 自动识别谱行。
 * 思路：把图片降采样到 700px 宽做水平投影 → 找出"横贯画面的实线"→ 按间距
 * 把六线谱的 6 条线聚类成一个谱行系统 → 再逐行检测竖直小节线求小节数。
 */
function detectBands() {
  const img = pages[curPage].img;                        // 识别对象始终是「当前页」的图片
  const NW = img.naturalWidth;
  const NH = img.naturalHeight;
  const SW = 700;                                        // 降采样宽度（速度与精度折中）
  const s = SW / NW;                                     // 采样比例
  const sh = Math.round(NH * s);

  const cv = document.createElement('canvas');
  cv.width = SW;
  cv.height = sh;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, SW, sh);
  const d = ctx.getImageData(0, 0, SW, sh).data;

  // 逐行统计暗像素占比
  const dark = new Float32Array(sh);
  for (let y = 0; y < sh; y++) {
    let c = 0;
    for (let x = 0; x < SW; x++) {
      const i = (y * SW + x) * 4;
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum < 170) c++;
    }
    dark[y] = c / SW;
  }

  // ① 只取高置信"谱线行"：覆盖 >50% 宽度的连续暗行（文字/和弦图达不到）
  const LINE_TH = 0.5;
  const segs = [];
  let start = -1;
  for (let y = 0; y < sh; y++) {
    if (dark[y] > LINE_TH) {
      if (start < 0) start = y;
    } else if (start >= 0) {
      segs.push([start, y]);
      start = -1;
    }
  }
  if (start >= 0) segs.push([start, sh]);

  // ② 近邻谱线聚类成谱行系统：六线谱线间距 << 系统间距
  const GAP = 22 / s;
  const clusters = [];
  for (const sg of segs) {
    const last = clusters[clusters.length - 1];
    if (last && sg[0] - last[1] < GAP) {
      last[1] = sg[1];
      last[2]++;
    } else {
      clusters.push([sg[0], sg[1], 1]);
    }
  }

  // ③ 过滤噪声簇（谱行至少 3 条线）并向外扩边，覆盖上下方的数字与符号
  const out = [];
  const PAD_TOP = 40 / s;
  const PAD_BOT = 62 / s;
  for (const [a, b, n] of clusters) {
    if (n < 3 || (b - a) > 90 / s) continue;
    const y0 = Math.max(0, Math.round(a / s - PAD_TOP));
    const y1 = Math.min(NH, Math.round(b / s + PAD_BOT));
    const ext = xExtent(Math.round(a / s), Math.round(b / s), img);
    out.push({
      y0, y1,
      x0: ext[0], x1: ext[1],
      bars: 4,
      sTop: Math.round(a / s),   // 谱线实际上下边界（小节线检测用）
      sBot: Math.round(b / s),
    });
  }

  // ④ 合并重叠簇（扩边后可能相交）
  const fin = [];
  for (const b of out) {
    const last = fin[fin.length - 1];
    if (last && b.y0 < last.y1 - 10) last.y1 = Math.max(last.y1, b.y1);
    else fin.push(b);
  }

  // ⑤ 逐行检测小节数
  for (const b of fin) b.bars = detectBarCount(b, img);
  return fin;
}

/**
 * 检测某一行的小节数：在谱线高度范围内做垂直投影找竖线。
 * 判据：列暗像素覆盖 ≥88% 谱线高度，且谱线下沿外延伸 ≤9px
 * （音符符杆会明显伸出谱线外，小节线不会；据此排除符杆误检）。
 */
function detectBarCount(b, img) {
  const top = b.sTop;
  const bot = b.sBot;
  const h = bot - top + 1;
  if (h < 10) return 4;

  const cv = document.createElement('canvas');
  const m = 8;                                          // 上下留边，便于检测"延伸"
  cv.width = img.naturalWidth;
  cv.height = h + m * 2;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, top - m, img.naturalWidth, cv.height, 0, 0, cv.width, cv.height);
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;

  // 每列在谱线范围内的暗像素覆盖率
  const cov = new Float32Array(cv.width);
  for (let x = 0; x < cv.width; x++) {
    let c = 0;
    for (let y = m; y < m + h; y++) {
      const i = (y * cv.width + x) * 4;
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum < 170) c++;
    }
    cov[x] = c / h;
  }

  // 亮度取值（越界按白处理）
  const LUM = (x, y) => {
    if (x < 0 || x >= cv.width || y < 0 || y >= cv.height) return 255;
    const i = (y * cv.width + x) * 4;
    return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  };

  // 候选列：谱线内高覆盖且下方无明显延伸
  const cand = new Uint8Array(cv.width);
  for (let x = 0; x < cv.width; x++) {
    if (cov[x] < 0.88) continue;
    let tail = 0;
    for (let y = m + h + 1; y < m + h + 42; y++) {
      if (LUM(x - 1, y) < 170 || LUM(x, y) < 170 || LUM(x + 1, y) < 170) tail++;
      else break;
    }
    if (tail <= 9) cand[x] = 1;
  }

  // 相邻候选列归为一根竖线；宽度 >5 的视为文字块，丢弃
  const raw = [];
  let x0 = -1;
  for (let x = 0; x <= cv.width; x++) {
    if (x < cv.width && cand[x]) {
      if (x0 < 0) x0 = x;
    } else if (x0 >= 0) {
      if (x - x0 <= 5) raw.push(Math.round((x0 + x - 1) / 2));
      x0 = -1;
    }
  }

  // 合并 <20px 的相邻竖线（谱首括线、反复双竖线算一个边界）
  const lines = [];
  for (const x of raw) {
    if (lines.length && x - lines[lines.length - 1] < 20) {
      lines[lines.length - 1] = Math.round((lines[lines.length - 1] + x) / 2);
    } else {
      lines.push(x);
    }
  }

  const inRange = lines.filter((x) => x >= b.x0 - 6 && x <= b.x1 + 6);
  const bars = inRange.length - 1;                       // n 条边界线 → n-1 个小节
  return bars >= 1 && bars <= 16 ? bars : 4;
}

/** 求某行区域内暗像素的水平范围（即谱线左右边界） */
function xExtent(y0, y1, img) {
  const s = 700 / img.naturalWidth;
  const cv = document.createElement('canvas');
  cv.width = 700;
  cv.height = Math.max(1, Math.round((y1 - y0) * s));
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, y0, img.naturalWidth, y1 - y0, 0, 0, 700, cv.height);
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;

  let minX = cv.width;
  let maxX = 0;
  for (let y = 0; y < cv.height; y++) {
    for (let x = 0; x < cv.width; x++) {
      const i = (y * cv.width + x) * 4;
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum < 170) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  // 兜底：整行全白（或全黑）时取 6%–94% 宽度
  if (minX >= maxX) {
    return [Math.round(img.naturalWidth * 0.06), Math.round(img.naturalWidth * 0.94)];
  }
  return [Math.round(minX / s), Math.round(maxX / s)];
}

/* ---------------------------------------------------------------- 手动框行 */

$('btnManual').onclick = () => {
  // 滚动模式下点图是「跳到该行」，与逐行框选冲突，因此框行仅限翻页模式
  if (viewMode === 'scroll') {
    setHint('手动框行仅在「🔀 翻页」模式下可用（滚动模式下点谱行即可跳转）');
    return;
  }
  manualMode = !manualMode;
  manualPts = [];
  $('btnManual').classList.toggle('active', manualMode);
  $('tipManual').style.display = manualMode ? 'block' : 'none';
  $('manualStep').textContent = '1';
};

tabImg.addEventListener('click', (e) => {
  const r = tabImg.getBoundingClientRect();
  const y = ((e.clientY - r.top) / r.height) * tabImg.naturalHeight;

  if (manualMode) {
    manualPts.push(y);
    $('manualStep').textContent = String(manualPts.length + 1);
    if (manualPts.length === 2) {
      const [a, b] = manualPts.sort((p, q) => p - q);
      const ext = xExtent(Math.round(a), Math.round(b), tabImg);
      bands.push({ y0: Math.round(a), y1: Math.round(b), x0: ext[0], x1: ext[1], bars: 4 });
      bands.sort((p, q) => p.y0 - q.y0);
      manualPts = [];
      $('manualStep').textContent = '1';
      renderBandList();
    }
    return;
  }

  // 非框行模式：点击谱行 = 从该行开始
  if (bands.length) {
    const bi = bands.findIndex((b) => y >= b.y0 && y <= b.y1);
    if (bi >= 0) seekBand(bi);
  }
});

/* -------------------------------------------------------------- 谱行列表 UI */

/** 渲染右侧谱行列表（可改小节数、删除、点击跳转） */
function renderBandList() {
  const el = $('bandList');
  if (!bands.length) {
    el.innerHTML = '<div class="tip">加载图片后点「🤖 自动识别谱行」，或用「✌️ 手动框行」在图上依次点击行的上、下边界。</div>';
    drawBands();
    return;
  }

  el.innerHTML = bands.map((b, i) => {
    const m0 = measureStartAt(curPage, i) + 1;
    const m1 = m0 + b.bars - 1;
    const mtxt = b.bars > 1 ? ('m' + m0 + '–' + m1) : ('m' + m0);
    return '<div class="bandItem" data-i="' + i + '">' +
      '<b>行 ' + (i + 1) + '</b>' +
      '<span class="mlbl">' + mtxt + '</span>' +
      '<span class="lbl">小节</span><input type="number" min="1" max="16" value="' + b.bars + '" data-bars="' + i + '" aria-label="第 ' + (i + 1) + ' 行小节数">' +
      '<button class="del" data-del="' + i + '" title="删除该行" aria-label="删除第 ' + (i + 1) + ' 行">✕</button>' +
      '</div>';
  }).join('');

  el.querySelectorAll('[data-bars]').forEach((inp) => {
    inp.onchange = () => {
      bands[+inp.dataset.bars].bars = Math.max(1, Math.min(16, +inp.value || 4));
      drawBands();
    };
  });

  el.querySelectorAll('[data-del]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      bands.splice(+btn.dataset.del, 1);
      pruneMarks();
      renderBandList();
    };
  });

  el.querySelectorAll('.bandItem').forEach((it) => {
    it.onclick = () => seekBand(+it.dataset.i);
  });

  drawBands();
}

/** 在图上绘制谱行覆盖层（半透明框，便于核对识别结果） */
function drawBands() {
  if (viewMode === 'scroll') { drawBandsScroll(); return; }
  imgWrap.querySelectorAll('.band, .measureTag, .secTag, .secBar').forEach((n) => n.remove());
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    const d = document.createElement('div');
    d.className = 'band';
    d.style.top = b.y0 + 'px';
    d.style.left = b.x0 + 'px';
    d.style.width = (b.x1 - b.x0) + 'px';
    d.style.height = (b.y1 - b.y0) + 'px';
    imgWrap.appendChild(d);

    // 行左侧的小节标注药丸：显示该行的起始/结束小节号（全局编号）
    const m0 = measureStartAt(curPage, i) + 1;
    const m1 = m0 + b.bars - 1;
    const tag = document.createElement('div');
    tag.className = 'measureTag';
    tag.style.left = b.x0 + 'px';
    tag.style.top = b.y0 + 'px';
    tag.textContent = b.bars > 1 ? ('m' + m0 + '–' + m1) : ('m' + m0);
    imgWrap.appendChild(tag);
  }

  // 段落标记只画「当前页」的（翻页模式一次只显示一页）
  marks.forEach((m, i) => { if (m.page === curPage) drawSection(m, i, imgWrap, 1); });
}

/* -------------------------------------------------------------- 段落标记 */

/** 全曲总小节数（用于算最后一段的结束小节号） */
function totalMeasures() {
  let n = 0;
  for (const p of pages) for (const b of p.bands) n += b.bars;
  return n;
}

/** 段落起点时间（ms）= 该页之前累计 + 该页本行之前各行时长 */
function markTime(m) {
  const pg = pages[m.page];
  if (!pg) return 0;
  const bs = pg.bands;
  let t = durBeforePage(m.page);
  for (let i = 0; i < Math.min(m.band, bs.length); i++) t += bandDur(bs[i]);
  return t;
}

/** 段落终点时间（ms）= 下一个段落起点，最后一个段落取全曲末尾 */
function markEnd(i) {
  const nx = marks[i + 1];
  return nx ? markTime(nx) : totalDur();
}

/** 段落覆盖的小节区间 [起, 止]（显示用，1 基） */
function markMeasures(i) {
  const m = marks[i];
  if (!m) return [1, 1];
  const a = measureStartAt(m.page, m.band) + 1;
  const nx = marks[i + 1];
  const bEnd = nx
    ? measureStartAt(nx.page, nx.band)                         // 下一段起点前一小节
    : ((window.TPSettings.get('startMeasure') || 1) - 1 + totalMeasures());
  return [a, Math.max(a, bEnd)];
}

/** 当前位置属于哪个段落（按页 + 行比较，marks 已按 (page,band) 升序） */
function sectionOfPos(pi, bi) {
  let name = null;
  for (const m of marks) {
    if (m.page < pi || (m.page === pi && m.band <= bi)) name = m.name;
    else break;
  }
  return name;
}

/** 当前音乐时间落在哪个段落（写练习记录时用） */
function sectionAt(t) {
  let name = null;
  for (const m of marks) if (t >= markTime(m)) name = m.name;
  return name;
}

/** 刷新底部「段落」芯片 */
function updateSecChip(pi, bi) {
  const chip = $('secChip');
  if (!chip) return;
  const nm = marks.length ? sectionOfPos(pi, bi) : null;
  chip.style.display = nm ? '' : 'none';
  $('secName').textContent = nm || '-';
}

/**
 * 给某一页某一行打段落标记（同位置重复打 = 改名）。
 * @param {number} pi 页索引
 * @param {number} bi 行索引
 * @param {string} [name] 段落名，空则自动命名
 */
function addMarkAt(pi, bi, name) {
  const pg = pages[pi];
  if (!pg || !pg.bands[bi]) { setHint('先识别谱行，再把某一行标成段落起点'); return; }
  const nm = String(name || '').trim() || ('段落 ' + (marks.length + 1));
  const ex = marks.findIndex((m) => m.page === pi && m.band === bi);
  if (ex >= 0) {
    marks[ex].name = nm;
  } else {
    marks.push({ page: pi, band: bi, name: nm, color: SEC_COLORS[marks.length % SEC_COLORS.length] });
    marks.sort((a, b) => (a.page - b.page) || (a.band - b.band));
  }
  renderSections();
  drawBands();
  setHint('已标记「' + nm + '」→ 第 ' + (pi + 1) + ' 页第 ' + (bi + 1) + ' 行');
}

/**
 * 清理失效的段落标记：删行 / 重新识别后行数变少，
 * 越界的标记会让「跳段」跳到不存在的行，直接丢掉（保守但不会错跳）。
 */
function pruneMarks() {
  marks = marks.filter((m) => {
    const pg = pages[m.page];
    return pg && m.band < pg.bands.length;
  });
}

/** 跳到段落起点 */
function seekMark(i) {
  const m = marks[i];
  if (!m) return;
  if (m.page !== curPage) switchPageDisplay(m.page);
  seekBand(m.band);
}

/** 把 A/B 循环设成该段落并开启循环 */
function loopMark(i) {
  const m = marks[i];
  if (!m) return;
  loopA = markTime(m);
  loopB = markEnd(i);
  loopOn = (loopB > loopA);
  updateLoopUI();
  if (loopOn && (playing || paused)) startAtTime(loopA);
  setHint(loopOn
    ? ('循环段落「' + m.name + '」：' + (loopA / 1000).toFixed(1) + 's → ' + (loopB / 1000).toFixed(1) + 's')
    : '该段落时长为 0，无法循环（检查后面是否还有段落）');
}

/** 渲染侧栏段落列表 */
function renderSections() {
  const el = $('sectionList');
  if (!el) return;
  if (!marks.length) {
    el.innerHTML = '<div class="secTip">还没有段落。跳到某一行后填名字点「＋」，即可把该行标成段落起点。</div>';
    updateSecChip(curPage, curBand);
    return;
  }
  el.innerHTML = marks.map((m, i) => {
    const [a, b] = markMeasures(i);
    const sec = (markEnd(i) - markTime(m)) / 1000;
    return '<div class="secItem" data-i="' + i + '">' +
      '<span class="dot" style="background:' + m.color + '"></span>' +
      '<span class="nm">' + esc(m.name) + '</span>' +
      '<span class="rng">m' + a + (b > a ? '–' + b : '') + ' · ' + sec.toFixed(1) + 's</span>' +
      '<button class="mini" data-loop="' + i + '" title="循环该段" aria-label="循环' + esc(m.name) + '">⟳</button>' +
      '<button class="mini" data-rm="' + i + '" title="删除该标记" aria-label="删除' + esc(m.name) + '">✕</button>' +
      '</div>';
  }).join('');

  el.querySelectorAll('.secItem').forEach((it) => {
    it.onclick = () => seekMark(+it.dataset.i);
  });
  el.querySelectorAll('[data-loop]').forEach((btn) => {
    btn.onclick = (e) => { e.stopPropagation(); loopMark(+btn.dataset.loop); };
  });
  el.querySelectorAll('[data-rm]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      marks.splice(+btn.dataset.rm, 1);
      renderSections();
      drawBands();
    };
  });
  updateSecChip(curPage, curBand);
}

/**
 * 在覆盖层上画一个段落标记：行右上角的彩色药丸 + 段首左侧色条。
 * @param {number} s 显示缩放（翻页模式为 1，滚动模式为各页 pageScale）
 */
function drawSection(m, idx, host, s) {
  const pg = pages[m.page];
  const b = pg && pg.bands[m.band];
  if (!b) return;

  const tag = document.createElement('div');
  tag.className = 'secTag';
  tag.textContent = m.name;
  tag.style.left = (b.x1 * s) + 'px';
  tag.style.top = (b.y0 * s) + 'px';
  tag.style.background = m.color;
  tag.style.setProperty('--sc', m.color);   // ::after 小箭头取同一颜色
  host.appendChild(tag);

  // 段首左侧色条：从本段起点画到下一段起点（同页内），同页无下一段则画到页底
  let endY = pg.h || b.y1;
  for (let j = idx + 1; j < marks.length; j++) {
    if (marks[j].page !== m.page) continue;
    const nb = pages[m.page].bands[marks[j].band];
    if (nb) endY = nb.y0;
    break;
  }
  const bar = document.createElement('div');
  bar.className = 'secBar';
  bar.style.left = Math.max(0, b.x0 * s - 10) + 'px';
  bar.style.top = (b.y0 * s) + 'px';
  bar.style.width = '3px';
  bar.style.height = Math.max(0, (endY - b.y0) * s) + 'px';
  bar.style.background = m.color;
  bar.style.opacity = '.7';
  host.appendChild(bar);
}

/* -------------------------------------------------------------- 页导航 UI */

/**
 * 渲染页导航：页码、上/下一页按钮状态、缩略图条。
 * 缩略图用各页已加载 Image 绘制到小 canvas；点击 = 跳到该页。
 */
function renderPageNav() {
  const total = pages.length;
  $('pageTotal').textContent = total;
  $('pageNum').textContent = total ? (curPage + 1) : 0;
  $('btnPrevPage').disabled = curPage <= 0;
  $('btnNextPage').disabled = curPage >= total - 1;

  // 空态：没有页时不显示空胶片条，改为舞台居中引导
  const empty = $('stageEmpty');
  if (empty) empty.style.display = total ? 'none' : '';

  const strip = $('filmstrip');
  if (!strip) return;
  strip.style.display = total ? '' : 'none';
  strip.innerHTML = '';
  if (!total) return;
  pages.forEach((pg, i) => {
    const b = document.createElement('button');
    b.className = 'thumb' + (i === curPage ? ' cur' : '');
    b.title = '第 ' + (i + 1) + ' 页（点击切换）';
    const im = document.createElement('img');
    im.src = pg.src;
    im.alt = '第 ' + (i + 1) + ' 页';
    b.appendChild(im);
    const tag = document.createElement('span');
    tag.textContent = (i + 1);
    b.appendChild(tag);
    b.onclick = () => gotoPage(i);
    strip.appendChild(b);
  });
}

/* ------------------------------------------------------------------ 时间轴 */

/** 某一行的时长（ms）= 小节数 × 每小节拍数 × 一拍时长 */
function bandDur(b) {
  return (b.bars * parseInt($('bpb').value, 10) * 60000) / parseInt($('bpm').value, 10);
}

/** 单页总时长（ms） */
function pageDur(p) {
  return p.bands.reduce((s, b) => s + bandDur(b), 0);
}

/** 全曲总时长（ms）= 所有页之和 */
function totalDur() {
  return pages.reduce((s, p) => s + pageDur(p), 0);
}

/** 第 pi 页之前的累计时长（ms） */
function durBeforePage(pi) {
  let s = 0;
  for (let i = 0; i < pi; i++) s += pageDur(pages[i]);
  return s;
}

/**
 * 第 pi 页第 bi 行「起始小节」的 0 基索引（全曲累加）。
 * 起始小节号来自设置 startMeasure（默认 1），其后按每行 bars 累加；
 * 多页时第 2 页的起点 = 第 1 页全部小节之后，自动续接。
 */
function measureStartAt(pi, bi) {
  let acc = (window.TPSettings.get('startMeasure') || 1) - 1;
  for (let p = 0; p < pi; p++) {
    const bs = pages[p].bands;
    for (let k = 0; k < bs.length; k++) acc += bs[k].bars;
  }
  const bs = pages[pi].bands;
  for (let k = 0; k < bi; k++) acc += bs[k].bars;
  return acc;
}

/**
 * 音乐时间(ms) → 位置信息（跨页）
 * @returns {{page:number, band:number, bar:number, p:number, g:number}|null}
 *   page 页索引、band 页内行索引、bar 行内小节索引、p 行内进度(0–1)、g 全曲进度(0–1)
 */
function locate(t) {
  let acc = 0;
  for (let pi = 0; pi < pages.length; pi++) {
    const pd = pageDur(pages[pi]);
    if (t < acc + pd || pi === pages.length - 1) {
      const bs = pages[pi].bands;
      let a2 = acc;
      for (let bi = 0; bi < bs.length; bi++) {
        const d = bandDur(bs[bi]);
        if (t < a2 + d || bi === bs.length - 1) {
          const p = Math.max(0, Math.min(1, (t - a2) / d));
          return {
            page: pi,
            band: bi,
            bar: Math.min(bs[bi].bars - 1, Math.floor(p * bs[bi].bars)),
            p,
            g: t / Math.max(1, totalDur()),
          };
        }
        a2 += d;
      }
    }
    acc += pd;
  }
  return null;
}

/** 当前音乐时间（ms）：暂停前的累计 + 本次恢复后按倍速推进的时间 */
function musicNow() {
  return elapsedBase + (performance.now() - t0) * rate;
}

/** 当前音乐时间（暂停或未播时取累计位置），供「设 A/B」取点 */
function curTime() {
  return (playing && !paused) ? musicNow() : elapsedBase;
}

/* -------------------------------------------------------------------- 播放 */

/** 开始/继续跟随 */
function play() {
  if (!pages.length || !pages.some((p) => p.bands.length)) {
    setHint('请先识别或手动框选谱行');
    return;
  }
  if (playing && !paused) return;
  if (paused) { resume(); return; }
  startAtTime(elapsedBase);   // 从当前位置（或起点）继续
}

/** 从指定音乐时间(ms)开始播放（跨页时间轴） */
function startAtTime(t0ms) {
  stop(false);
  if (metro) {
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
  }
  elapsedBase = t0ms;
  t0 = performance.now();
  lastBeat = -1;
  playing = true;
  paused = false;
  if (!sessStart) sessStart = Date.now();   // 开始计本次练习时长
  timer = setInterval(tick, 40);
  setLed('ok', '图片谱跟随中');
  setHint('跟随中：红色框 = 当前小节，右下放大镜实时放大。跨页时自动翻页，点击任意行可跳转。');
  $('btnPlay').textContent = '▶ 跟随中…';
}

/** 暂停（保留当前位置） */
function pause() {
  if (!playing || paused) return;
  elapsedBase = musicNow();
  paused = true;
  // 暂停也算练习时间，先结算本段（续播时重新起算）
  if (sessStart) { sessMs += Date.now() - sessStart; sessStart = 0; }
  setLed('warn', '已暂停');
}

/** 从暂停处继续 */
function resume() {
  paused = false;
  t0 = performance.now();
  sessStart = Date.now();
  setLed('ok', '图片谱跟随中');
}

/** 跳转到当前页的指定行；播放中则改从该行时间开始 */
function seekBand(bandIdx) {
  const bs = pages[curPage] ? pages[curPage].bands : [];
  if (!bs.length) return;
  bandIdx = Math.max(0, Math.min(bs.length - 1, bandIdx));
  const t = durBeforePage(curPage) + bs.slice(0, bandIdx).reduce((s, b) => s + bandDur(b), 0);
  if (playing || paused) { startAtTime(t); return; }
  showPosition(bandIdx, 0);
  elapsedBase = t;
  $('bandNum').textContent = (bandIdx + 1) + ' / ' + bs.length;
}

/** 跳转到指定页首行（页导航用） */
function gotoPage(pi) {
  if (pi < 0 || pi >= pages.length) return;
  switchPageDisplay(pi);
  const t = durBeforePage(pi);
  if (playing || paused) { startAtTime(t); }
  else {
    elapsedBase = t;
    if (pages[pi].bands.length) showPosition(0, 0);
    setLed('', '已跳到第 ' + (pi + 1) + ' 页');
  }
  renderPageNav();
}

/** 停止播放。reset 为 true 时回到起点并清空状态灯 */
function stop(reset = true) {
  // 结算练习记录要赶在 curBand/curBar 被清掉之前（需要记录练到哪一节）
  if (reset) finishPractice();
  if (timer) clearInterval(timer);
  timer = null;
  playing = false;
  paused = false;
  curBand = curBar = -1;
  barBox.style.display = 'none';
  scanline.style.display = 'none';
  $('measureLabel').style.display = 'none';
  $('btnPlay').textContent = '▶ 开始跟随';
  if (reset) {
    elapsedBase = 0;
    setLed('', '待机');
  }
}

$('btnPlay').onclick = play;
$('btnPause').onclick = pause;
$('btnStop').onclick = () => stop();
$('btnPrevPage').onclick = () => gotoPage(curPage - 1);
$('btnNextPage').onclick = () => gotoPage(curPage + 1);

/* 练习：A/B 区间循环 —— 把某段反复练，到 B 自动回 A */
$('btnLoop').onclick = () => {
  loopOn = !loopOn;
  $('btnLoop').classList.toggle('active', loopOn);
  updateLoopUI();
  if (loopOn) setHint('循环已开：播到 B 会无缝回到 A 反复练。还没设 A/B 就先点 ⓐ/ⓑ 取当前位置。');
  else setHint('循环已关');
};
$('btnLoopA').onclick = () => {
  loopA = curTime();
  updateLoopUI();
  setHint('循环起点 A = ' + (loopA / 1000).toFixed(1) + 's（当前位置）');
};
$('btnLoopB').onclick = () => {
  loopB = curTime();
  updateLoopUI();
  setHint('循环终点 B = ' + (loopB / 1000).toFixed(1) + 's（当前位置）');
};

/** 同步循环 UI：区间芯片显隐、范围文字、按钮高亮 */
function updateLoopUI() {
  const chip = $('loopChip');
  chip.style.display = (loopA != null || loopB != null) ? '' : 'none';
  $('loopRange').textContent = (loopA != null ? (loopA / 1000).toFixed(1) + 's' : '?') +
    ' → ' + (loopB != null ? (loopB / 1000).toFixed(1) + 's' : '?');
  $('btnLoop').classList.toggle('active', loopOn);
}

/* ---------------------------------------------------- 工程文件（导入/导出） */

/**
 * 生成工程对象：多页谱图 + 每页谱行识别结果 + 当前参数。
 * 本地导入的图存的是 dataURL，因此工程文件自包含，换台机器打开也能用。
 */
function buildProject() {
  return {
    app: 'TabPilot',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: {
      bpm: parseInt($('bpm').value, 10),
      bpb: parseInt($('bpb').value, 10),
      startMeasure: window.TPSettings.get('startMeasure') || 1,
      rate: window.TPSettings.get('rate'),
    },
    marks: marks.map((m) => ({ page: m.page, band: m.band, name: m.name, color: m.color })),
    pages: pages.map((p) => ({
      src: p.src,
      bands: p.bands.map((b) => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, bars: b.bars })),
    })),
  };
}

/** 导出并下载工程文件 */
function exportProject() {
  if (!pages.length) { setHint('还没有可导出的内容：先加载谱图'); return; }
  const proj = buildProject();
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  downloadText(JSON.stringify(proj, null, 2), 'tabpilot-' + ts + '.json', 'application/json');
  setHint('已导出工程文件（含谱图 + 谱行识别结果 + 段落标记），下次「打开工程」即可免重框');
}

/** 应用工程对象：恢复页、谱行与参数（供「打开工程」与测试复用） */
function applyProject(proj) {
  stop();
  pages = [];
  curPage = 0;
  bands = [];
  marks = Array.isArray(proj.marks)
    ? proj.marks
      .filter((m) => m && typeof m.page === 'number' && typeof m.band === 'number')
      .map((m) => ({
        page: m.page | 0,
        band: m.band | 0,
        name: String(m.name || '段落'),
        color: m.color || SEC_COLORS[0],
      }))
      .sort((a, b) => (a.page - b.page) || (a.band - b.band))
    : [];
  proj.pages.forEach((pg, idx) => loadProjectPage(pg.src, pg.bands || [], idx === 0));
  renderSections();

  const st = proj.settings || {};
  if (st.bpm) $('bpm').value = st.bpm;
  if (st.bpb) $('bpb').value = st.bpb;
  if (st.startMeasure) window.TPSettings.set('startMeasure', st.startMeasure);
  if (st.rate) window.TPSettings.set('rate', st.rate);
  if (viewMode === 'scroll') buildScrollView();
  setHint('工程已载入：' + proj.pages.length + ' 页，谱行识别结果已恢复，点「▶ 开始跟随」即可');
}

/** 读取工程文件并恢复 */
function importProjectFile(file) {
  const r = new FileReader();
  r.onload = () => {
    let proj = null;
    try {
      proj = JSON.parse(r.result);
    } catch (e) {
      setHint('打开工程失败：不是合法的 JSON');
      return;
    }
    if (!proj || proj.app !== 'TabPilot' || !Array.isArray(proj.pages)) {
      setHint('打开工程失败：不是 TabPilot 工程文件');
      return;
    }
    applyProject(proj);
  };
  r.onerror = () => setHint('读取工程文件失败');
  r.readAsText(file);
}

$('btnSaveProj').onclick = exportProject;
$('btnOpenProj').onclick = () => $('projInput').click();
$('projInput').onchange = (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) importProjectFile(f);
  e.target.value = '';   // 允许重复选择同一个文件
};

/* ------------------------------------------------------------ 练习记录 */

const LOG_KEY = 'tabpilot.practiceLog';

/** 读取本地练习日志（localStorage；Tauri 里同样是浏览器 localStorage，够用） */
function loadLog() {
  try {
    const a = JSON.parse(localStorage.getItem(LOG_KEY));
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}

/** 写回本地练习日志（只保留最近 300 条，避免无限膨胀） */
function saveLog(arr) {
  try { localStorage.setItem(LOG_KEY, JSON.stringify(arr.slice(-300))); } catch (e) { /* 隐私模式等：忽略 */ }
}

/** 本地日期键 YYYY-MM-DD */
function dayKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** 毫秒 → "1h05m" / "12m30s" */
function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
}

/**
 * 结算并写入一条练习记录。
 * 只在 stop(true)（停止 / 播完 / 清空）时调用；startAtTime 用的是 stop(false)，
 * 所以拖动跳转、续播不会把一次练习切成好几条。
 */
function finishPractice() {
  if (sessStart) { sessMs += Date.now() - sessStart; sessStart = 0; }
  if (sessMs < 5000) { sessMs = 0; sessLoops = 0; return; }   // 短于 5 秒不计，避免噪声
  const meas = (curBand >= 0 && pages[curPage] && pages[curPage].bands[curBand])
    ? measureStartAt(curPage, curBand) + Math.max(0, curBar) + 1
    : null;
  const log = loadLog();
  log.push({
    d: Date.now(),
    ms: Math.round(sessMs),
    loops: sessLoops,
    rate: rate,
    sec: sectionAt(curTime()),
    meas,
  });
  saveLog(log);
  sessMs = 0;
  sessLoops = 0;
}

/** 打开练习记录面板 */
function openPractice() {
  $('morePop').classList.remove('open');
  $('practiceModal').style.display = 'flex';
  renderPractice();
}

function closePractice() {
  $('practiceModal').style.display = 'none';
}

/** 渲染统计：总览卡片 + 近 7 天柱状图 + 最近记录 */
function renderPractice() {
  const log = loadLog();
  const now = new Date();
  const today = dayKey(now);

  const byDay = {};
  let totalMs = 0;
  log.forEach((r) => {
    totalMs += r.ms || 0;
    const k = dayKey(new Date(r.d));
    byDay[k] = (byDay[k] || 0) + (r.ms || 0);
  });

  const days = [];
  let weekMs = 0;
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const k = dayKey(d);
    const v = byDay[k] || 0;
    weekMs += v;
    days.push({ v, lb: (d.getMonth() + 1) + '/' + d.getDate() });
  }

  // 连续天数：今天没练就从昨天往前数
  let streak = 0;
  for (let i = 0; i < 400; i++) {
    const k = dayKey(new Date(now.getTime() - i * 86400000));
    if (byDay[k]) streak++;
    else if (i > 0) break;
  }

  $('pmStats').innerHTML =
    '<div class="pm-stat"><b>' + fmtDur(byDay[today] || 0) + '</b><span>今日</span></div>' +
    '<div class="pm-stat"><b>' + fmtDur(weekMs) + '</b><span>近 7 天</span></div>' +
    '<div class="pm-stat"><b>' + streak + ' 天</b><span>连续练习</span></div>' +
    '<div class="pm-stat"><b>' + log.length + ' 次</b><span>累计次数</span></div>';

  const maxV = Math.max.apply(null, days.map((d) => d.v).concat([1]));
  $('pmChart').innerHTML = days.map((d) => {
    const h = Math.max(2, Math.round((d.v / maxV) * 62));
    return '<div class="pm-col">' +
      '<span class="vv">' + (d.v ? Math.round(d.v / 60000) : '') + '</span>' +
      '<div class="bar" style="height:' + h + 'px' + (d.v ? '' : ';opacity:.22') + '"></div>' +
      '<span class="lb">' + d.lb + '</span>' +
      '</div>';
  }).join('');

  const recent = log.slice(-12).reverse();
  $('pmList').innerHTML = recent.length
    ? recent.map((r) => {
      const dt = new Date(r.d);
      const ds = (dt.getMonth() + 1) + '/' + dt.getDate() + ' ' +
        String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
      const ex = [];
      if (r.loops) ex.push('循环 ' + r.loops + ' 次');
      if (r.rate && Math.abs(r.rate - 1) > 0.01) ex.push(r.rate.toFixed(2) + '×');
      if (r.sec) ex.push(r.sec);
      if (r.meas) ex.push('到 m' + r.meas);
      return '<div class="pm-row"><span class="dt">' + ds + '</span>' +
        '<span class="du">' + fmtDur(r.ms) + '</span>' +
        '<span class="ex">' + esc(ex.join(' · ')) + '</span></div>';
    }).join('')
    : '<div class="secTip">还没有记录。跟着谱跑一会儿（超过 5 秒）就会自动记一笔。</div>';
}

/**
 * 触发一个文本文件的下载。
 * 优先 Blob + createObjectURL；某些宿主（jsdom / 受限 webview）没有该 API，
 * 回落到 data URI，保证导出不会直接抛异常。
 */
function downloadText(text, filename, mime) {
  try {
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      const url = URL.createObjectURL(new Blob([text], { type: mime }));
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      return true;
    }
  } catch (e) { /* 落到下面的 data URI 兜底 */ }
  const a = document.createElement('a');
  a.href = 'data:' + mime + ',' + encodeURIComponent(text);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  return false;
}

/** 导出 CSV（带 BOM，Excel 直接打开不乱码） */
function exportPracticeCsv() {
  const log = loadLog();
  if (!log.length) { setHint('还没有练习记录可导出'); return; }
  const rows = [['时间', '时长(分钟)', '循环次数', '速度', '段落', '结束小节']];
  log.forEach((r) => {
    const dt = new Date(r.d);
    rows.push([
      dt.toLocaleString(),
      ((r.ms || 0) / 60000).toFixed(1),
      r.loops || 0,
      (r.rate || 1).toFixed(2) + 'x',
      r.sec || '',
      r.meas ? ('m' + r.meas) : '',
    ]);
  });
  const csv = '\ufeff' + rows.map((a) => a.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  downloadText(csv, 'tabpilot-practice-' + dayKey(new Date()) + '.csv', 'text/csv;charset=utf-8');
  setHint('已导出练习记录 CSV（' + log.length + ' 条）');
}

$('btnPractice').onclick = openPractice;
$('pmClose').onclick = closePractice;
$('practiceModal').onclick = (e) => { if (e.target.id === 'practiceModal') closePractice(); };
$('pmExport').onclick = exportPracticeCsv;
$('pmClear').onclick = () => {
  if (!loadLog().length) { setHint('本来就没有记录'); return; }
  saveLog([]);
  renderPractice();
  setHint('练习记录已清空');
};
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('practiceModal').style.display === 'flex') closePractice();
  else if ($('prepModal').style.display === 'flex') closePrep();
});

/* -------------------------------------------------------------- 图片预处理 */

/**
 * 预处理参数（每次打开修图面板重置，点「应用」才真正写回页面）。
 * 只记几何/增强开关，不缓存像素 —— 换页或改参数都重算一遍，逻辑最简单。
 */
let prep = { rot: 0, flip: false, crop: false, enhance: false, level: 55 };

/** 打开修图面板并预览当前页 */
function openPrep() {
  if (!pages[curPage] || !pages[curPage].img.naturalWidth) { setHint('请先加载谱图'); return; }
  $('morePop').classList.remove('open');
  prep = { rot: 0, flip: false, crop: false, enhance: false, level: parseInt($('prepLevel').value, 10) || 55 };
  $('prepPageNo').textContent = curPage + 1;
  syncPrepUI();
  $('prepModal').style.display = 'flex';
  renderPrep();
}

function closePrep() { $('prepModal').style.display = 'none'; }

/** 同步修图面板按钮高亮 */
function syncPrepUI() {
  $('prepFlip').classList.toggle('active', prep.flip);
  $('prepCrop').classList.toggle('active', prep.crop);
  $('prepEnh').classList.toggle('active', prep.enhance);
  $('prepLevel').value = prep.level;
  $('prepLevelVal').textContent = prep.level;
}

/**
 * 按当前 prep 参数生成一张处理好的全分辨率 canvas。
 * 顺序：几何（旋转/镜像）→ 裁白边 → 去阴影增强。
 */
function prepCanvas(pg, opt) {
  const src = pg.img;
  const nw = src.naturalWidth;
  const nh = src.naturalHeight;
  const r = ((opt.rot % 360) + 360) % 360;
  const swap = (r === 90 || r === 270);

  let cv = document.createElement('canvas');
  cv.width = swap ? nh : nw;
  cv.height = swap ? nw : nh;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.save();
  ctx.translate(cv.width / 2, cv.height / 2);
  ctx.rotate((r * Math.PI) / 180);
  if (opt.flip) ctx.scale(-1, 1);
  ctx.drawImage(src, -nw / 2, -nh / 2, nw, nh);
  ctx.restore();

  if (opt.crop) {
    const c2 = cropWhite(cv);
    if (c2) cv = c2;
  }
  if (opt.enhance && opt.level > 0) enhanceContrast(cv, opt.level);
  return cv;
}

/** 预览：把处理结果等比缩放到面板宽度 */
function renderPrep() {
  const pg = pages[curPage];
  if (!pg || !pg.img.naturalWidth) return;
  const cv = prepCanvas(pg, prep);
  const box = $('prepCanvas');
  const maxW = 760;
  const s = Math.min(1, maxW / cv.width);
  box.width = Math.max(1, Math.round(cv.width * s));
  box.height = Math.max(1, Math.round(cv.height * s));
  const bctx = box.getContext('2d');
  bctx.imageSmoothingEnabled = true;
  bctx.fillStyle = '#fff';
  bctx.fillRect(0, 0, box.width, box.height);
  bctx.drawImage(cv, 0, 0, box.width, box.height);
}

/** 求内容（暗像素）包围盒；整幅全白时返回 null 表示「没什么可裁」 */
function contentBounds(cv) {
  const w = cv.width;
  const h = cv.height;
  const d = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y += 2) {
    let hit = false;
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 200) {
        hit = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
    if (hit) { if (y < minY) minY = y; maxY = y; }
  }
  if (maxX < 0 || maxY < 0) return null;
  return { x0: minX, y0: minY, x1: maxX, y1: maxY };
}

/** 裁掉四周空白（留 10px 边距） */
function cropWhite(cv) {
  const bb = contentBounds(cv);
  if (!bb) return null;
  const pad = 10;
  const x = Math.max(0, bb.x0 - pad);
  const y = Math.max(0, bb.y0 - pad);
  const w = Math.min(cv.width - x, bb.x1 - bb.x0 + 1 + pad * 2);
  const h = Math.min(cv.height - y, bb.y1 - bb.y0 + 1 + pad * 2);
  if (w <= 8 || h <= 8 || (w >= cv.width - 2 && h >= cv.height - 2)) return null;   // 没得裁
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(cv, -x, -y);
  return out;
}

/**
 * 去阴影 + 对比度拉伸（原地改写 canvas 像素）。
 * 手机拍谱最常见的问题：光照不均导致一侧发灰，投影识别会把整片灰当成谱行。
 * 做法：把图缩到 1/40 再放大回来当作「背景光照估计」，用 原图/背景 抵消明暗差异，
 *      再按 2%–98% 分位做直方图拉伸；level>70 时轻微推向二值，让谱线更"实"。
 */
function enhanceContrast(cv, level) {
  const w = cv.width;
  const h = cv.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const p = img.data;

  // ① 灰度
  const g = new Uint8ClampedArray(w * h);
  for (let k = 0, i = 0; k < g.length; k++, i += 4) {
    g[k] = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
  }

  // ② 背景光照估计：降采样 → 放大回原尺寸
  const bw = Math.max(1, Math.round(w / 40));
  const bh = Math.max(1, Math.round(h / 40));
  const tmp = document.createElement('canvas');
  tmp.width = bw;
  tmp.height = bh;
  const tctx = tmp.getContext('2d');
  const small = tctx.createImageData ? tctx.createImageData(bw, bh)
    : { data: new Uint8ClampedArray(bw * bh * 4), width: bw, height: bh };
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const sx = Math.min(w - 1, Math.floor((bx * w) / bw));
      const sy = Math.min(h - 1, Math.floor((by * h) / bh));
      const v = g[sy * w + sx];
      const o = (by * bw + bx) * 4;
      small.data[o] = v; small.data[o + 1] = v; small.data[o + 2] = v; small.data[o + 3] = 255;
    }
  }
  tctx.putImageData(small, 0, 0);

  const bgCv = document.createElement('canvas');
  bgCv.width = w;
  bgCv.height = h;
  const bctx = bgCv.getContext('2d');
  bctx.imageSmoothingEnabled = true;
  bctx.drawImage(tmp, 0, 0, w, h);
  const bd = bctx.getImageData(0, 0, w, h).data;

  // ③ 除法去阴影 + 直方图统计
  const out = new Uint8ClampedArray(w * h);
  const hist = new Uint32Array(256);
  for (let k = 0; k < out.length; k++) {
    const b = Math.max(24, bd[k * 4]);          // 下限防止除出噪点
    const v = Math.min(255, Math.round((g[k] * 255) / b));
    out[k] = v;
    hist[v]++;
  }

  // ④ 2% / 98% 分位作为黑场白场
  const total = out.length;
  let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.02) { hi = v; break; } }
  const span = Math.max(1, hi - lo);

  // ⑤ 拉伸 +（可选）推向二值，最后按强度与原图混合
  const kk = level / 100;
  const push = level > 70 ? ((level - 70) / 30) * 60 : 0;
  for (let k = 0, i = 0; k < out.length; k++, i += 4) {
    let v = ((out[k] - lo) * 255) / span;
    if (push) v = v > 150 ? v + push : v - push;
    v = Math.max(0, Math.min(255, v));
    const fin = g[k] * (1 - kk) + v * kk;
    p[i] = p[i + 1] = p[i + 2] = fin;
    p[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** 把某页的图片整张换成新的 src（原图地址保留在 pg.orig，便于还原） */
function replacePageImage(pi, url, keepBands) {
  const pg = pages[pi];
  if (!pg) return;
  const im = new Image();
  im.onload = () => {
    pg.img = im;
    pg.src = url;
    pg.w = im.naturalWidth;
    pg.h = im.naturalHeight;
    if (!keepBands) { pg.bands = []; marks = marks.filter((m) => m.page !== pi); }
    if (viewMode === 'scroll') buildScrollView();
    switchPageDisplay(pi);
    renderPageNav();
    renderSections();
  };
  im.onerror = () => setHint('图片处理失败，请重试');
  im.src = url;
}

/** 应用预处理结果到当前页 */
function applyPrep() {
  const pg = pages[curPage];
  if (!pg || !pg.img.naturalWidth) return;
  if (!prep.rot && !prep.flip && !prep.crop && !prep.enhance) { setHint('没有做任何调整'); return; }
  const cv = prepCanvas(pg, prep);
  let url;
  try {
    url = cv.toDataURL('image/jpeg', 0.92);
  } catch (e) {
    setHint('图片导出失败（环境不支持 canvas 导出）');
    return;
  }
  replacePageImage(curPage, url, false);
  renderBandList();
  closePrep();
  setLed('', '已应用修图（第 ' + (curPage + 1) + ' 页）');
  setHint('已替换当前页；谱行坐标作废，请重新「🤖 自动识别」。需要撤销可用「🛠 修图 → ↩ 还原原图」。');
}

/** 还原到载入时的原始图片 */
function resetPageImage() {
  const pg = pages[curPage];
  if (!pg) return;
  const orig = pg.orig || pg.src;
  replacePageImage(curPage, orig, false);
  renderBandList();
  prep = { rot: 0, flip: false, crop: false, enhance: false, level: prep.level };
  syncPrepUI();
  renderPrep();
  setHint('已还原当前页原图，谱行需重新识别');
}

$('btnPrep').onclick = openPrep;
$('prepClose').onclick = closePrep;
$('prepModal').onclick = (e) => { if (e.target.id === 'prepModal') closePrep(); };
$('prepRotL').onclick = () => { prep.rot -= 90; renderPrep(); };
$('prepRotR').onclick = () => { prep.rot += 90; renderPrep(); };
$('prepFlip').onclick = () => { prep.flip = !prep.flip; syncPrepUI(); renderPrep(); };
$('prepCrop').onclick = () => { prep.crop = !prep.crop; syncPrepUI(); renderPrep(); };
$('prepEnh').onclick = () => { prep.enhance = !prep.enhance; syncPrepUI(); renderPrep(); };
$('prepLevel').oninput = (e) => {
  prep.level = parseInt(e.target.value, 10);
  $('prepLevelVal').textContent = prep.level;
  if (prep.enhance) renderPrep();
};
$('prepApply').onclick = applyPrep;
$('prepReset').onclick = resetPageImage;

/* 段落标记：在当前行打点（回车即可确认） */
$('btnAddMark').onclick = () => {
  addMarkAt(curPage, curBand >= 0 ? curBand : 0, $('markName').value);
  $('markName').value = '';
};
$('markName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('btnAddMark').click(); }
});

// 「更多」菜单：收纳低频操作（示例谱/节拍器/放大镜/行列表），降低工具栏密度
const morePop = $('morePop');
$('btnMore').onclick = (e) => {
  e.stopPropagation();
  const open = morePop.classList.toggle('open');
  $('btnMore').setAttribute('aria-expanded', open ? 'true' : 'false');
};
document.addEventListener('click', (e) => {
  if (!morePop.contains(e.target)) morePop.classList.remove('open');
});
$('btnClear').onclick = () => {
  pages = []; curPage = 0; bands = []; marks = [];
  renderSections();
  stop();
  tabImg.removeAttribute('src');   // 清掉图上内容，回到空态引导
  barBox.style.display = 'none';
  // 滚动模式下同时清掉长图内容，避免残留页
  $('scrollView').innerHTML = '';
  pageOv = []; pageTop = []; pageScale = [];
  renderBandList();
  renderPageNav();
  setLed('', '待机');
  setHint('已清空全部页与谱行，请重新加载谱图或识别谱行');
};

/* ------------------------------------------------------------ 视图与交互 */

/** 速度滑杆：写入设置，由设置模块统一分发 */
$('rate').oninput = (e) => {
  window.TPSettings.set('rate', parseInt(e.target.value, 10));
};

/** 起始小节号：写入设置；变更后重绘谱行标注 */
$('startMeasure').onchange = (e) => {
  window.TPSettings.set('startMeasure', Math.max(1, parseInt(e.target.value, 10) || 1));
};

/* 视图模式切换：写入设置后由 applySettings 统一应用（单一入口，避免两处状态不同步） */
$('viewFlip').onclick = () => window.TPSettings.set('viewMode', 'flip');
$('viewScroll').onclick = () => window.TPSettings.set('viewMode', 'scroll');

/**
 * 滚动模式的点击：点谱行覆盖层或谱图 = 跳到该行开始。
 * 与翻页模式不同，这里没有"整张 tabImg"，坐标要按被点击那一页换算。
 */
$('scrollView').addEventListener('click', (e) => {
  if (viewMode !== 'scroll' || manualMode) return;

  const bandEl = e.target.closest('.band');
  if (bandEl) {
    const pi = +bandEl.dataset.page;
    if (pi !== curPage) switchPageDisplay(pi);
    seekBand(+bandEl.dataset.band);
    return;
  }

  const pageEl = e.target.closest('.scrollPage');
  if (pageEl && e.target.tagName === 'IMG') {
    const pi = +pageEl.dataset.page;
    const r = e.target.getBoundingClientRect();
    const y = ((e.clientY - r.top) / Math.max(1, r.height)) * (pages[pi].h || 1400);
    if (pi !== curPage) switchPageDisplay(pi);
    const bi = pages[pi].bands.findIndex((b) => y >= b.y0 && y <= b.y1);
    if (bi >= 0) { bands = pages[pi].bands; seekBand(bi); }
  }
});

/** BPM / 拍号变化会改变时间轴，重绘覆盖层即可 */
$('bpm').onchange = drawBands;
$('bpb').onchange = drawBands;

$('btnMag').onclick = () => {
  magOn = !magOn;
  window.TPSettings.set('magnifier', magOn);
};

/** 双击图片：在适应宽度与放大之间切换 */
tabImg.addEventListener('dblclick', () => {
  zoomLevel = zoomLevel === 1.0 ? 1.6 : 1.0;
  layout();
  drawBands();
});

/* ------------------------------------------------------------ 每帧渲染 */

/** 定时器回调：计算当前位置并刷新界面 */
function tick() {
  if (!playing || paused) return;
  let t = musicNow();
  if (t >= totalDur()) {
    stop();
    setLed('ok', '已播完');
    return;
  }
  // A/B 循环：越过终点后无缝回到起点反复练
  if (loopOn && loopA != null && loopB != null && loopB > loopA && t >= loopB) {
    elapsedBase = loopA;
    t0 = performance.now();
    t = loopA;
    sessLoops++;   // 循环次数进练习记录
  }
  const loc = locate(t);
  if (!loc) return;
  if (loc.page !== curPage) switchPageDisplay(loc.page);   // 跨页自动翻页
  showPosition(loc.band, loc.bar, loc.p);
  $('elapsed').textContent = (t / 1000).toFixed(1) + 's';

  // 节拍器：稳定 BPM 下按全局拍号取模即可区分重拍
  const beatMs = 60000 / parseInt($('bpm').value, 10);
  const beat = Math.floor(t / beatMs);
  if (beat !== lastBeat) {
    lastBeat = beat;
    clickTick(beat % parseInt($('bpb').value, 10) === 0);
  }
}

/** 把当前位置绘制到界面上：小节框 + 扫描线 + 自动滚动 + 状态 + 放大镜 */
function showPosition(bandIdx, barIdx, p = 0) {
  const b = bands[bandIdx];
  if (!b) return;
  curBand = bandIdx;
  curBar = barIdx;
  updateSecChip(curPage, bandIdx);

  /* 滚动模式：整谱长图 + 连续自动滚动，不翻页。
     覆盖层坐标需按本页显示缩放 s 换算（bands 存的是原始像素）。 */
  if (viewMode === 'scroll') {
    const ov = pageOv[curPage];
    const s = pageScale[curPage] || 1;
    if (!ov) return;
    attachPlayhead(ov);

    const ws = (b.x1 - b.x0) / b.bars;
    const xs = b.x0 + barIdx * ws;

    barBox.style.display = 'block';
    barBox.style.left = (xs * s) + 'px';
    barBox.style.top = (b.y0 * s) + 'px';
    barBox.style.width = (ws * s) + 'px';
    barBox.style.height = ((b.y1 - b.y0) * s) + 'px';

    const mNum2 = measureStartAt(curPage, bandIdx) + barIdx + 1;
    const ml2 = $('measureLabel');
    ml2.style.display = 'block';
    ml2.style.left = ((xs + ws / 2) * s) + 'px';
    ml2.style.top = (b.y0 * s) + 'px';
    ml2.textContent = '♪ 第 ' + mNum2 + ' 小节';

    scanline.style.display = 'block';
    scanline.style.top = ((b.y1 - 2) * s) + 'px';
    scanline.style.left = (b.x0 * s) + 'px';
    scanline.style.width = ((b.x1 - b.x0) * s) + 'px';

    // 连续自动滚动：把当前行滚到视口上部
    const targetY = pageTop[curPage] + b.y0 * s - stage.clientHeight * 0.3;
    if (Math.abs(stage.scrollTop - targetY) > 8) {
      stage.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
    }

    $('bandNum').textContent = (bandIdx + 1) + ' / ' + bands.length;
    $('pageNum').textContent = (curPage + 1) + ' / ' + pages.length;
    $('barNum').textContent = mNum2;

    document.querySelectorAll('#scrollView .band').forEach((it) => {
      it.classList.toggle('cur', (+it.dataset.page === curPage && +it.dataset.band === bandIdx));
    });
    ov.querySelectorAll('.measureTag').forEach((tg, i) => tg.classList.toggle('cur', i === bandIdx));
    const ft2 = document.querySelectorAll('#filmstrip .thumb');
    ft2.forEach((it, i) => it.classList.toggle('cur', i === curPage));

    if (magOn) drawMag(xs, b.y0, ws, b.y1 - b.y0);   // 放大镜取源图像素，与显示缩放无关
    return;
  }

  if (!tabImg.naturalWidth) return;   // 正在翻页、图片尚未就绪时跳过本帧绘制

  // 小节框：行内按小节数均分
  const w = (b.x1 - b.x0) / b.bars;
  const x = b.x0 + barIdx * w;
  barBox.style.display = 'block';
  barBox.style.left = x + 'px';
  barBox.style.top = b.y0 + 'px';
  barBox.style.width = w + 'px';
  barBox.style.height = (b.y1 - b.y0) + 'px';

  // 当前小节的全局编号（跟「谱行旁标注」同一套计数）
  const mNum = measureStartAt(curPage, bandIdx) + barIdx + 1;
  const ml = $('measureLabel');
  ml.style.display = 'block';
  ml.style.left = (x + w / 2) + 'px';
  ml.style.top = b.y0 + 'px';
  ml.textContent = '♪ 第 ' + mNum + ' 小节';

  // 行内进度扫描线
  scanline.style.display = 'block';
  scanline.style.top = (b.y1 - 2) + 'px';
  scanline.style.left = b.x0 + 'px';
  scanline.style.width = (b.x1 - b.x0) + 'px';

  // 自动滚动：把当前行滚到视口中上部
  const scale = imgWrap.getBoundingClientRect().width / tabImg.naturalWidth;
  const targetY = (b.y0 * scale) - stage.clientHeight * 0.3;
  if (Math.abs(stage.scrollTop - targetY) > 8) {
    stage.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
  }

  $('bandNum').textContent = (bandIdx + 1) + ' / ' + bands.length;
  $('pageNum').textContent = (curPage + 1) + ' / ' + pages.length;
  $('barNum').textContent = mNum;

  document.querySelectorAll('.bandItem').forEach((it, i) => it.classList.toggle('cur', i === bandIdx));
  imgWrap.querySelectorAll('.measureTag').forEach((tg, i) => tg.classList.toggle('cur', i === bandIdx));
  const ft = document.querySelectorAll('#filmstrip .thumb');
  ft.forEach((it, i) => it.classList.toggle('cur', i === curPage));

  if (magOn) drawMag(x, b.y0, w, b.y1 - b.y0);
}

/* ------------------------------------------------------ 放大镜（光栅放大） */

/**
 * 把当前小节区域绘制到放大镜 canvas 上。
 * 图片没有矢量信息，直接按源区域缩放绘制（cover 适配，保持比例铺满）。
 */
function drawMag(x, y, w, h) {
  const img = pages[curPage] ? pages[curPage].img : null;
  const cv = $('magCanvas');
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  if (!img || !img.naturalWidth) return;

  const padY = h * 0.25;
  const sx = Math.max(0, x - w * 0.1);
  const sy = Math.max(0, y - padY);
  const sw = Math.min(img.naturalWidth - sx, w * 1.2);
  const sh = h + padY * 2;

  const sAsp = sw / sh;
  const cAsp = cv.width / cv.height;
  let dw, dh;
  if (sAsp > cAsp) { dw = cv.width; dh = cv.width / sAsp; }
  else { dh = cv.height; dw = cv.height * sAsp; }

  ctx.drawImage(img, sx, sy, sw, sh, (cv.width - dw) / 2, (cv.height - dh) / 2, dw, dh);

  // 中心参考线：提示当前推进位置
  ctx.strokeStyle = 'rgba(225,29,72,.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cv.width / 2, 0);
  ctx.lineTo(cv.width / 2, cv.height);
  ctx.stroke();
}

/* ------------------------------------------------------------------ 设置 */

/**
 * 应用设置到本页面。
 * 注意：修改倍速前要先用旧倍速结算音乐时间，否则会跳变。
 * @param {Object} s 完整设置对象
 */
function applySettings(s) {
  if (playing && !paused) {
    elapsedBase = musicNow();
    t0 = performance.now();
  }
  rate = s.rate / 100;
  $('rate').value = s.rate;
  $('rateVal').textContent = rate.toFixed(1) + 'x';

  const sm = s.startMeasure || 1;
  const smInput = $('startMeasure');
  if (smInput) smInput.value = sm;
  drawBands();   // 起始小节号变更 → 重绘谱行标注

  magOn = !!s.magnifier;
  $('btnMag').classList.toggle('active', magOn);
  $('magnifier').classList.toggle('on', magOn);

  $('hint').style.display = s.showHints ? '' : 'none';

  // 视图模式：只在真正变化时重建（默认翻页即为初始 DOM，首帧无需处理）
  const vm = s.viewMode || 'flip';
  if (vm !== viewMode) {
    viewMode = vm;
    setViewModeUI();
    applyViewModeDom();
  }
}

/* ---------------------------------------------------------------- 启动 */

window.addEventListener('DOMContentLoaded', () => {
  window.TPSettings.mount();
  window.TPSettings.onChange(applySettings);
  applySettings(window.TPSettings.all());
  layout();
  renderPageNav();
  renderSections();
});
