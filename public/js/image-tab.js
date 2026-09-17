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
/** 渐进提速：开关与已完成的循环轮数 */
let trainOn = false;
let trainCount = 0;
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

/** 工程 / 打包文件（一次只开一个，它们代表整份还原，多选没有意义） */
function isProjFile(f) {
  return /\.(tabpilot|json)$/i.test(f.name || '');
}

/** 音频伴奏 */
function isAudioFile(f) {
  return /^audio\//i.test(f.type || '') || /\.(mp3|wav|m4a|aac|ogg|oga|flac)$/i.test(f.name || '');
}

function isImageFile(f) {
  return /^image\//i.test(f.type || '') || /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(f.name || '');
}

/**
 * 统一的素材入口：文件选择器和拖放都走这里。
 * 拖进来的东西什么都有 —— 谱图、PDF、伴奏、打包文件，所以要按类型分流。
 * @param {File[]} files
 * @param {'replace'|'append'} mode  replace 会先清空现有内容
 */
async function acceptFiles(files, mode) {
  if (!files || !files.length) return;
  const proj = files.filter(isProjFile);
  const aud = files.filter(isAudioFile);
  const pdfs = files.filter(isPdfFile);
  const imgs = files.filter((f) => isImageFile(f) && !isPdfFile(f));

  if (proj.length) { openProjFile(proj[0]); return; }

  const isAppend = mode === 'append';
  if (!isAppend) { pages = []; curPage = 0; bands = []; stop(); }

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
    setHint('正在追加 ' + imgs.length + ' 页…追加完成后共 ' + (before + imgs.length + pdfs.length) + ' 页');
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

  if (aud.length) loadAudioFile(aud[0]);
}

$('fileInput').onchange = (e) => {
  acceptFiles(Array.from(e.target.files || []), loadMode);
  e.target.value = '';   // 允许重复选择同一个文件
};

/* 拖放：把谱图 / PDF / 伴奏 / 打包文件直接拖进舞台 */
(function bindDrop() {
  let depth = 0;
  // 落在舞台之外也必须 preventDefault，否则浏览器会直接"打开"这个文件，页面被替换掉
  const stop = (e) => { if (e.dataTransfer) e.preventDefault(); };
  document.addEventListener('dragenter', (e) => { stop(e); depth++; stage.classList.add('dropOn'); });
  document.addEventListener('dragover', stop);
  document.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; stage.classList.remove('dropOn'); } });
  document.addEventListener('drop', (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    depth = 0;
    stage.classList.remove('dropOn');
    acceptFiles(Array.from(e.dataTransfer.files || []), 'replace');
  });
})();

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
      sTop: b.sTop, sBot: b.sBot,
      bounds: Array.isArray(b.bounds) ? b.bounds.slice() : null,
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
  // 乘 zoomLevel：滚动模式下双击/双指缩放靠重建长图的宽度实现，
  // pageScale 会随之重算，所以不能用 CSS zoom（那会让覆盖层错位）。
  return Math.max(120, w * zoomLevel);
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
  const hitBars = bands.filter((b) => b.bounds && b.bounds.length > 1).length;
  setLed('ok', '已识别 ' + bands.length + ' 行（第 ' + (curPage + 1) + ' 页）');
  setHint('检查右侧行列表：可删除误检行、修改每行小节数，然后点「▶ 开始跟随」'
    + (hitBars
      ? '；其中 ' + hitBars + ' 行已检到小节线，跟随按实际小节宽度'
      : '；未检到小节线的行按小节数均分，可点「🎼 小节线」重检'));
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

  // ⑤ 逐行检测小节线与小节边界
  for (const b of fin) {
    const r = detectBarBounds(b, img);
    b.bars = r.bars;
    b.bounds = r.bounds;                               // null 表示退回均分
  }
  return fin;
}

/**
 * 检测某一行的小节线，返回小节数与**真实像素边界**。
 * 判据：列暗像素覆盖 ≥88% 谱线高度，且谱线下沿外延伸 ≤9px
 * （音符符杆会明显伸出谱线外，小节线不会；据此排除符杆误检）。
 *
 * 候选列 → 竖线 → 边界 三步交给 BarlineCore（纯函数，可单测），
 * 这里只负责取像素、算覆盖率、以及"排除符杆"这类图像专属判据。
 *
 * @returns {{bars:number, bounds:Array<number>|null}}
 *   bounds 为升序边界数组（含行左右端点），小节数 = 长度 − 1；
 *   检测不可信时返回 { bars: 4, bounds: null }，调用方按均分回退。
 */
function detectBarBounds(b, img) {
  // 自动识别的行自带谱线上下沿；手动框的行只有行框，需先估出谱线范围
  const rg = (b.sTop != null && b.sBot != null)
    ? { top: b.sTop, bot: b.sBot }
    : estimateStaffRange(b, img);
  const top = rg.top;
  const bot = rg.bot;
  const h = bot - top + 1;
  if (h < 10) return { bars: b.bars || 4, bounds: null };

  const BC = window.BarlineCore;
  const cv = document.createElement('canvas');
  const m = 8;                                          // 上下留边，便于检测"延伸"
  cv.width = img.naturalWidth;
  cv.height = h + m * 2;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, top - m, img.naturalWidth, cv.height, 0, 0, cv.width, cv.height);
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const W = cv.width;

  // 每列在谱线范围内的暗像素覆盖率（列投影）
  const cov = BC
    ? BC.columnProjection(d, W, cv.height, { x0: 0, y0: m, x1: W, y1: m + h }, 170)
    : (function () {
      const a = new Array(W);
      for (let x = 0; x < W; x++) {
        let c = 0;
        for (let y = m; y < m + h; y++) {
          const i = (y * W + x) * 4;
          if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 170) c++;
        }
        a[x] = c / h;
      }
      return a;
    })();

  // 亮度取值（越界按白处理）
  const LUM = (x, y) => {
    if (x < 0 || x >= W || y < 0 || y >= cv.height) return 255;
    const i = (y * W + x) * 4;
    return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  };

  // 候选列：谱线内高覆盖且下方无明显延伸
  const cand = new Uint8Array(W);
  for (let x = 0; x < W; x++) {
    if (cov[x] < 0.88) continue;
    let tail = 0;
    for (let y = m + h + 1; y < m + h + 42; y++) {
      if (LUM(x - 1, y) < 170 || LUM(x, y) < 170 || LUM(x + 1, y) < 170) tail++;
      else break;
    }
    if (tail <= 9) cand[x] = 1;
  }

  // 竖线提取：过宽视为文字块，过近的合并（谱首括线/反复双竖线算一个边界）
  const lines = BC
    ? BC.linesFromMask(cand, { maxRun: 5, mergeGap: 20 })
    : (function () {
      const raw = [];
      let x0 = -1;
      for (let x = 0; x <= W; x++) {
        if (x < W && cand[x]) { if (x0 < 0) x0 = x; }
        else if (x0 >= 0) { if (x - x0 <= 5) raw.push(Math.round((x0 + x - 1) / 2)); x0 = -1; }
      }
      const o = [];
      for (const x of raw) {
        if (o.length && x - o[o.length - 1] < 20) o[o.length - 1] = Math.round((o[o.length - 1] + x) / 2);
        else o.push(x);
      }
      return o;
    })();

  const inRange = lines.filter((x) => x >= b.x0 - 6 && x <= b.x1 + 6);
  const bars = inRange.length - 1;                       // n 条边界线 → n-1 个小节
  if (!(bars >= 1 && bars <= 16)) return { bars: b.bars || 4, bounds: null };

  if (!BC) return { bars, bounds: null };
  // 最小小节宽度：行宽的 1/24，避免把符杆残留切成碎片小节
  const minW = Math.max(10, Math.round((b.x1 - b.x0) / 24));
  const bounds = BC.barBounds(inRange, b.x0, b.x1, minW);
  return (bounds && bounds.length >= 2) ? { bars: bounds.length - 1, bounds } : { bars, bounds: null };
}

/**
 * 手动框的行只有行框，没有谱线上下沿。这里在该行内做**行投影**，
 * 把覆盖 >50% 行宽的连续暗行（六线谱的谱线）找出来，取其上下沿。
 * 找不到时退回行框内缩 15%（避开数字与和弦符号的干扰）。
 */
function estimateStaffRange(b, img) {
  const y0 = Math.max(0, Math.round(b.y0));
  const y1 = Math.min(img.naturalHeight, Math.round(b.y1));
  const h = y1 - y0;
  if (h < 10) return { top: y0, bot: y1 };
  const W = Math.min(700, img.naturalWidth);
  const s = W / img.naturalWidth;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = Math.max(1, Math.round(h * s));
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, y0, img.naturalWidth, h, 0, 0, W, cv.height);
  const d = ctx.getImageData(0, 0, W, cv.height).data;

  let a = -1;
  let z = -1;
  for (let y = 0; y < cv.height; y++) {
    let c = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 170) c++;
    }
    if (c / W > 0.5) { if (a < 0) a = y; z = y; }
  }
  if (a < 0) return { top: y0 + Math.round(h * 0.15), bot: y1 - Math.round(h * 0.15) };
  return { top: y0 + Math.round(a / s), bot: y0 + Math.round(z / s) };
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

/* ------------------------------------------------------------ 小节线重检测 */

/**
 * 对当前页已框好的每一行重新检测小节线。
 * 用途：手动框的行、或自动识别后修过图的行，都能补上真实小节边界。
 * 检测到的边界会覆盖该行的小节数（行数不变，只改行内切分）。
 */
$('btnBars').onclick = () => {
  const pg = pages[curPage];
  if (!pg || !pg.img.naturalWidth) { setHint('请先加载谱图'); return; }
  if (!bands.length) { setHint('请先识别或手动框出谱行，再检测小节线'); return; }

  let hit = 0;
  for (const b of bands) {
    const r = detectBarBounds(b, pg.img);
    b.bars = r.bars;
    b.bounds = r.bounds;
    if (r.bounds) hit++;
  }
  renderBandList();
  setLed(hit ? 'ok' : '', hit
    ? ('小节线：' + hit + '/' + bands.length + ' 行按真实边界跟随')
    : '未检到小节线（仍按小节数均分）');
  setHint(hit
    ? '已检到 ' + hit + ' 行的小节线，跟随框宽度改用实际小节宽度；其余行仍按小节数均分。'
    : '没检到可信的小节线，已保留原小节数并继续按均分跟随。可先「🛠 修图」增强对比度再试。');
};

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
      const bb = bands[+inp.dataset.bars];
      bb.bars = Math.max(1, Math.min(16, +inp.value || 4));
      bb.bounds = null;                                  // 手改小节数 → 退回均分跟随
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
  if (metro) ensureAC();
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
  startAudioAt(elapsedBase);   // 伴奏跟着视觉时间走（有伴奏且未静音时才发声）
}

/** 暂停（保留当前位置） */
function pause() {
  if (!playing || paused) return;
  elapsedBase = musicNow();
  paused = true;
  stopAudio();   // 暂停时伴奏一起停（续播会从当前位置重新起播）
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
  startAudioAt(elapsedBase);
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
  stopAudio();   // 停止跟随的同时停掉伴奏
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

/* 练习：渐进提速 —— 每循环完一轮自动加一档，直到目标速度 */

/** 读取并夹紧训练参数：起速 / 每轮增量 / 目标 */
function trainParams() {
  const from = Math.max(40, Math.min(100, parseInt($('trainFrom').value, 10) || 60));
  const step = Math.max(1, Math.min(20, parseInt($('trainStep').value, 10) || 5));
  const to = Math.max(from, Math.min(150, parseInt($('trainTo').value, 10) || 100));
  return { from, step, to };
}

/** 开启 / 关闭渐进提速。提速必须有循环区间才有意义，否则提示先设 A/B */
function toggleTrain() {
  if (trainOn) {
    trainOn = false;
    updateTrainUI();
    setHint('渐进提速已关闭');
    return;
  }
  if (!loopOn || loopA == null || loopB == null || loopB <= loopA) {
    setHint('渐进提速需要一个循环区间：先按 ⓐ / ⓑ 取点，或点某个段落的 ⟳');
    return;
  }
  const { from } = trainParams();
  trainOn = true;
  trainCount = 0;
  window.TPSettings.set('rate', from);   // 从慢速起跑
  updateTrainUI();
  setHint('渐进提速开始：每循环完一轮自动加一档，到目标速度为止');
}

/** 每次循环回绕时调用：加一档速度 */
function stepTrain() {
  if (!trainOn) return;
  const { from, step, to } = trainParams();
  trainCount++;
  const nr = Math.min(to, from + step * trainCount);
  window.TPSettings.set('rate', nr);
  if (nr >= to) {
    trainOn = false;
    setHint('已练到目标速度 ' + to + '%，渐进提速结束');
  }
  updateTrainUI();
}

/** 同步提速按钮与底部芯片 */
function updateTrainUI() {
  const btn = $('btnTrain');
  if (!btn) return;
  btn.classList.toggle('active', trainOn);
  btn.textContent = trainOn ? '⏹ 停止' : '▶ 开始';
  const { from, step, to } = trainParams();
  const cur = Math.round(window.TPSettings.get('rate') || 100);
  $('trainChip').style.display = trainOn ? '' : 'none';
  $('trainRange').textContent = cur + '%  ← ' + from + '%（第 ' + trainCount + ' 轮，+' + step + '%/轮，目标 ' + to + '%）';
  $('trainTip').textContent = trainOn
    ? ('训练中：当前 ' + cur + '%，已完成 ' + trainCount + ' 轮，每轮 +' + step + '%，到 ' + to + '% 自动停。')
    : '设好 A/B 循环（ⓐⓑ 或段落的 ⟳）后开启，每循环一轮自动加一档，直到目标速度。';
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
      // 音画偏移（ms）。音频本身体积太大，不进工程文件，只存这个对齐量
      audioOffset: audioOffset || 0,
    },
    marks: marks.map((m) => ({ page: m.page, band: m.band, name: m.name, color: m.color })),
    pages: pages.map((p) => ({
      src: p.src,
      bands: p.bands.map((b) => ({
        x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, bars: b.bars,
        sTop: b.sTop, sBot: b.sBot,
        bounds: Array.isArray(b.bounds) ? b.bounds.slice() : null,
      })),
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
  if (st.audioOffset) {
    audioOffset = parseInt(st.audioOffset, 10) || 0;
    $('audioOffset').value = audioOffset;
  }
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

/* --------------------------------------- .tabpilot 单文件打包（自定义容器） */

const BUNDLE_MAGIC = 'TABPILOT/1';

/**
 * 打包成 .tabpilot 容器。
 *
 * 布局：<magic>\n<单行 JSON 头>\n<各段原始字节依次拼接>
 * JSON.stringify 不会输出裸换行，所以「第二个换行」就是头的结束位置；
 * 每段的长度写在头里，因此段与段之间不需要分隔符。
 *
 * 为什么不直接用 zip：仓库目前是零依赖（连 pdf.js 都是手动 vendor 进来的），
 * 而这里只需要"把两段字节拼起来"，为此引入一个压缩库不值。
 * 不压缩也不亏 —— 谱图本来就是 JPEG/PNG（已压缩），音频本身也是 mp3/ogg。
 *
 * 为什么不用 base64 内嵌 JSON：二进制原始存放比 base64 省 33% 体积，
 * 而且不用一次性把整个文件转成字符串再 JSON.parse。
 *
 * @param {{key:string, data:string|Uint8Array|ArrayBuffer, meta?:object}[]} parts
 */
function packBundle(parts) {
  const norm = parts.map((p) => {
    let bytes;
    if (typeof p.data === 'string') bytes = new TextEncoder().encode(p.data);
    else if (p.data instanceof Uint8Array) bytes = p.data;
    else bytes = new Uint8Array(p.data);
    return { key: p.key, meta: p.meta || {}, bytes };
  });
  const head = {
    app: 'TabPilot',
    format: 'tabpilot',
    version: 1,
    parts: norm.map((p) => Object.assign({ key: p.key, len: p.bytes.length }, p.meta)),
  };
  return { headText: BUNDLE_MAGIC + '\n' + JSON.stringify(head) + '\n', head, parts: norm };
}

/** 把容器拼成一个完整的字节序列（导出下载 / 测试往返都用它） */
function bundleBytes(packed) {
  const head = new TextEncoder().encode(packed.headText);
  const total = head.length + packed.parts.reduce((a, p) => a + p.bytes.length, 0);
  const out = new Uint8Array(total);
  out.set(head, 0);
  let off = head.length;
  packed.parts.forEach((p) => { out.set(p.bytes, off); off += p.bytes.length; });
  return out;
}

/** 判断一段字节是不是我们的容器（不看扩展名，扩展名在不同系统上报得五花八门） */
function isBundle(u8) {
  const m = new TextEncoder().encode(BUNDLE_MAGIC);
  if (u8.length < m.length) return false;
  for (let i = 0; i < m.length; i++) if (u8[i] !== m[i]) return false;
  return true;
}

/**
 * 解包：按头里记录的长度切出各段。
 * @returns {{head:object, parts:Object<string,{bytes:Uint8Array, meta:object}>}}
 * @throws 不是容器 / 版本不符 / 段越界
 */
function unpackBundle(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let nl1 = -1;
  let nl2 = -1;
  for (let i = 0; i < u8.length; i++) {
    if (u8[i] !== 0x0a) continue;
    if (nl1 < 0) nl1 = i; else { nl2 = i; break; }
  }
  if (nl2 < 0) throw new Error('不是 .tabpilot 打包文件');
  const dec = new TextDecoder();
  const magic = dec.decode(u8.subarray(0, nl1));
  if (magic !== BUNDLE_MAGIC) throw new Error('不是 .tabpilot 打包文件');
  const head = JSON.parse(dec.decode(u8.subarray(nl1 + 1, nl2)));
  if (!head || head.app !== 'TabPilot' || head.format !== 'tabpilot') throw new Error('不是 TabPilot 打包文件');
  if (head.version !== 1) throw new Error('不支持的容器版本：' + head.version + '（本版最多支持 v1）');
  let off = nl2 + 1;
  const parts = {};
  for (const p of head.parts) {
    if (!(p.len >= 0) || off + p.len > u8.length) throw new Error('打包文件已损坏（' + p.key + ' 段越界）');
    parts[p.key] = { bytes: u8.subarray(off, off + p.len), meta: p };
    off += p.len;
  }
  return { head, parts };
}

/** 导出 .tabpilot：谱图 + 谱行 + 段落标记 + 伴奏音频，一个文件全带走 */
function exportBundle() {
  if (!pages.length) { setHint('还没有可打包的内容：先加载谱图'); return; }
  const parts = [{ key: 'project', data: JSON.stringify(buildProject()), meta: { type: 'application/json' } }];
  let kb = 0;
  if (audioRaw && audioRaw.bytes && audioRaw.bytes.byteLength) {
    kb = audioRaw.bytes.byteLength / 1024;
    parts.push({
      key: 'audio',
      data: new Uint8Array(audioRaw.bytes),
      meta: { mime: audioRaw.mime, name: audioRaw.name, offset: audioOffset || 0 },
    });
  }
  const packed = packBundle(parts);
  const blob = new Blob([packed.headText].concat(packed.parts.map((p) => p.bytes)), { type: 'application/octet-stream' });
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  downloadBlob(blob, 'tabpilot-' + ts + '.tabpilot');
  setHint(kb
    ? ('已打包 .tabpilot（含伴奏 ' + Math.round(kb) + 'KB）：一个文件即可完整还原，便于分享/备份')
    : '已打包 .tabpilot（未含伴奏 —— 先在底部导入音频会一起被打进去）');
}

/** 还原打包文件的字节内容 */
function applyBundleBytes(u8) {
  let res;
  try { res = unpackBundle(u8); } catch (e) { setHint('打开打包文件失败：' + e.message); return; }
  const pj = res.parts.project;
  if (!pj) { setHint('打包文件里没有工程数据'); return; }
  let proj = null;
  try { proj = JSON.parse(new TextDecoder().decode(pj.bytes)); } catch (e) {
    setHint('打包文件里的工程数据不是合法 JSON'); return;
  }
  if (!proj || !Array.isArray(proj.pages)) { setHint('打包文件里的工程数据不完整'); return; }
  applyProject(proj);
  const au = res.parts.audio;
  if (au && au.bytes.length) loadAudioBytes(au.bytes, au.meta);
  else setHint('打包文件已载入：' + proj.pages.length + ' 页（不含伴奏）');
}

/**
 * 「打开工程」的统一入口：不靠扩展名区分格式，直接看字节。
 * 是容器就解包，否则按 JSON 工程解析 —— 这样 .tabpilot 和旧的 .json 都能打开。
 */
function openProjFile(file) {
  const r = new FileReader();
  r.onload = () => {
    const u8 = new Uint8Array(r.result);
    if (isBundle(u8)) { applyBundleBytes(u8); return; }
    try {
      const proj = JSON.parse(new TextDecoder().decode(u8));
      if (!proj || proj.app !== 'TabPilot' || !Array.isArray(proj.pages)) throw new Error('bad');
      applyProject(proj);
    } catch (e) {
      setHint('打开失败：既不是 .tabpilot 打包文件，也不是 TabPilot 工程 JSON');
    }
  };
  r.onerror = () => setHint('读取文件失败：' + file.name);
  r.readAsArrayBuffer(file);
}

/** 下载二进制 Blob；宿主没有 createObjectURL 时回落到 data URI */
function downloadBlob(blob, filename) {
  try {
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      const url = URL.createObjectURL(blob);
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
  const fr = new FileReader();
  fr.onload = () => {
    const a = document.createElement('a');
    a.href = fr.result;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  fr.readAsDataURL(blob);
  return false;
}

$('btnSaveProj').onclick = exportProject;
$('btnSaveBundle').onclick = exportBundle;
$('btnOpenProj').onclick = () => $('projInput').click();
$('projInput').onchange = (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) openProjFile(f);
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
$('btnTrain').onclick = toggleTrain;
['trainFrom', 'trainStep', 'trainTo'].forEach((id) => {
  $(id).addEventListener('change', updateTrainUI);
});
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
  else toggleFocus(false);
});

/* ====================================================== 演奏录音回放复盘 */

let recSession = null;      // { recorder, stream, t0, timer }；null = 未在录音
let lastTake = null;        // { url, env, dt, dur }；env 为 null 表示只能回放
let lastReview = null;      // 最近一次复盘结果，供「跳到最差拍」复用
let lastBeatStep = 0;       // 复盘时的每拍秒数（跳拍换算用）
const REVIEW_DT = 0.01;     // 包络帧长 10ms
const REVIEW_TOL = 0.05;    // ±50ms 内算弹准

function isRecording() { return !!recSession; }

/**
 * 参考包络：图片谱没有精确拍点，用 BPM 网格当基准。
 * 播放速度 rate ≠ 1 时，实际每拍时长要按 rate 折算。
 */
function buildRefEnv() {
  if (!pages.length) return null;
  const bpm = Math.max(20, parseFloat($('bpm').value) || 72);
  const step = (60 / bpm) / (rate || 1);
  const totalSec = (totalDur() || 0) / 1000;
  if (totalSec <= 0) return null;
  const n = Math.floor(totalSec / step);
  if (n < 2) return null;
  const beatSec = [];
  for (let i = 0; i < n; i++) beatSec.push(i * step);
  return {
    env: window.TimingCore.impulseEnv(beatSec, REVIEW_DT, totalSec + 1, 0.15),
    beatSec,
    step,
  };
}

/** 开始录音。只在用户点击时触发 */
async function startRecording() {
  if (isRecording()) return;
  if (!buildRefEnv()) { setHint('先载入谱图并识别谱行，复盘要用 BPM 网格当基准。'); return; }
  if (typeof MediaRecorder === 'undefined') { setHint('当前环境不支持录音。'); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    let recTimer = null;
    const chunks = [];
    const rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      if (recTimer) clearInterval(recTimer);
      finalizeTake(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
    };
    recSession = { recorder: rec, stream, t0: performance.now() };
    rec.start();

    $('recChip').style.display = '';
    const btn = $('btnRec');
    btn.classList.add('active');
    btn.textContent = '■ 停止录音';
    recTimer = setInterval(() => {
      if (recSession) $('recTime').textContent = ((performance.now() - recSession.t0) / 1000).toFixed(1) + 's';
    }, 100);
    recSession.timer = recTimer;
    setHint('录音中：正常弹完这一遍，再点「■ 停止录音」。');
  } catch (err) {
    setHint('麦克风打不开：' + (err && err.message ? err.message : err));
  }
}

/** 停止录音（收尾在 recorder.onstop 里异步完成） */
function stopRecording() {
  if (!recSession) return;
  if (recSession.timer) clearInterval(recSession.timer);
  try { recSession.recorder.stop(); } catch (e) { /* 已停止则忽略 */ }
  $('recChip').style.display = 'none';
  const btn = $('btnRec');
  btn.classList.remove('active');
  btn.textContent = '● 录音';
  recSession = null;
}

/** 录音落地：生成回放 URL，并解出 PCM 求能量包络 */
async function finalizeTake(blob) {
  const url = URL.createObjectURL(blob);
  let env = null;
  let dur = 0;
  let ctx = null;
  try {
    const ab = await blob.arrayBuffer();
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await ctx.decodeAudioData(ab.slice(0));   // decode 会 detach，传副本
    dur = buf.duration;
    const hop = Math.max(1, Math.round(buf.sampleRate * REVIEW_DT));
    env = window.TimingCore.normalizeEnv(
      window.TimingCore.envelopeFromPcm(buf.getChannelData(0), hop)
    );
  } catch (err) {
    console.warn('录音解码失败，只能回放不能分析', err);
  } finally {
    if (ctx && ctx.close) { try { ctx.close(); } catch (e) { /* 忽略 */ } }
  }
  if (lastTake && lastTake.url) URL.revokeObjectURL(lastTake.url);
  lastTake = { url, env, dt: REVIEW_DT, dur };
  $('btnReview').disabled = !env;
  setHint(env
    ? '录音已存下（' + dur.toFixed(1) + 's），点「📈 复盘」看逐拍节奏偏差。'
    : '录音已存下，但这种格式解不出 PCM，只能回放、做不了偏差分析。');
}

/** 复盘：把录音包络与 BPM 拍点对齐，给出每拍的抢/拖 */
function reviewTake() {
  if (!lastTake || !lastTake.env) { setHint('还没有能分析的录音，先点「● 录音」录一遍。'); return; }
  const r = buildRefEnv();
  if (!r) { setHint('谱图还没就绪，没法复盘。'); return; }

  const res = window.TimingCore.computeTimingDeviation(r.env, lastTake.env, r.beatSec, {
    dt: REVIEW_DT,
    toleranceSec: REVIEW_TOL,
    maxLagSec: 0.8,
    windowSec: 0.18,
  });
  lastReview = res;
  lastBeatStep = r.step;
  renderReview(res);
  $('reviewModal').style.display = 'flex';
  setHint('复盘完成：平均偏差 ' + (res.meanAbs * 1000).toFixed(0)
    + 'ms，准确率 ' + (res.accuracy * 100).toFixed(0) + '%。');
}

/** 渲染复盘面板 */
function renderReview(res) {
  const stats = $('rvStats');
  stats.innerHTML = '';
  [
    ['准确率', (res.accuracy * 100).toFixed(0) + '%'],
    ['平均偏差', (res.meanAbs * 1000).toFixed(0) + 'ms'],
    ['最大偏差', (res.maxAbs * 1000).toFixed(0) + 'ms'],
    ['整段偏移', (res.offset * 1000).toFixed(0) + 'ms'],
    ['有效拍', res.counted + '/' + res.beats.length],
  ].forEach((it) => {
    const d = document.createElement('div');
    d.className = 'pm-stat';
    const b = document.createElement('b');
    b.textContent = it[1];
    const s = document.createElement('span');
    s.textContent = it[0];
    d.appendChild(b);
    d.appendChild(s);
    stats.appendChild(d);
  });

  const chart = $('rvChart');
  chart.innerHTML = '';
  const scale = Math.max(res.maxAbs, REVIEW_TOL * 2);
  for (const b of res.beats) {
    const col = document.createElement('div');
    col.className = 'rv-col';
    col.title = '第 ' + (b.beat + 1) + ' 拍 · '
      + (b.missed ? '漏弹' : (b.deviation >= 0 ? '拖 ' : '抢 ') + Math.abs(b.deviation * 1000).toFixed(0) + 'ms');
    const base = document.createElement('div');
    base.className = 'rv-base';
    col.appendChild(base);

    const bar = document.createElement('i');
    if (b.missed) {
      bar.style.background = '#9aa5b8';
      bar.style.top = '48%';
      bar.style.height = '4%';
    } else {
      const ratio = Math.min(1, Math.abs(b.deviation) / scale);
      bar.style.height = Math.max(2, ratio * 48) + '%';
      bar.style.background = Math.abs(b.deviation) <= REVIEW_TOL
        ? '#10b981'
        : (b.deviation > 0 ? '#f59e0b' : '#378add');
      if (b.deviation >= 0) { bar.style.bottom = '50%'; bar.style.top = 'auto'; }
      else { bar.style.top = '50%'; bar.style.bottom = 'auto'; }
    }
    col.appendChild(bar);
    chart.appendChild(col);
  }

  const worst = $('rvWorst');
  if (res.worstBeat >= 0) {
    const b = res.beats[res.worstBeat];
    const ms = Math.abs((b ? b.deviation : 0) * 1000).toFixed(0);
    worst.textContent = '偏差最大的是第 ' + (res.worstBeat + 1) + ' 拍（'
      + (b && b.deviation > 0 ? '拖' : '抢') + ' ' + ms + 'ms），'
      + '大约在 ' + (res.worstBeat * lastBeatStep).toFixed(1) + 's 处。';
  } else {
    worst.textContent = '这一遍没抓到有效拍点，可能是录音太轻或全程静音。';
  }

  if (lastTake && lastTake.url) $('rvAudio').src = lastTake.url;
}

/** 关闭复盘面板（不清掉录音） */
function closeReview() {
  $('reviewModal').style.display = 'none';
  $('rvAudio').pause();
}

/** 找出某个音乐时间(ms)落在哪一页哪一行 */
function locateTime(ms) {
  for (let p = 0; p < pages.length; p++) {
    let t = durBeforePage(p);
    const bs = pages[p].bands;
    for (let i = 0; i < bs.length; i++) {
      const d = bandDur(bs[i]);
      if (ms < t + d) return { page: p, band: i };
      t += d;
    }
  }
  return { page: Math.max(0, pages.length - 1), band: 0 };
}

/** 把播放头跳到偏差最大的那一拍所在位置 */
function jumpToWorst() {
  if (!lastReview || lastReview.worstBeat < 0) { setHint('还没有最差拍可跳。'); return; }
  const ms = lastReview.worstBeat * lastBeatStep * 1000;
  const pos = locateTime(ms);
  const t = markTime(pos);
  if (pos.page !== curPage) switchPageDisplay(pos.page);
  if (playing || paused) startAtTime(t);
  else {
    elapsedBase = t;
    if (pages[pos.page] && pages[pos.page].bands.length) showPosition(pos.band, 0);
  }
  renderPageNav();
  closeReview();
  setHint('已跳到第 ' + (lastReview.worstBeat + 1) + ' 拍（' + (ms / 1000).toFixed(1) + 's），重点练这一下。');
}

$('btnRec').onclick = () => { if (isRecording()) stopRecording(); else startRecording(); };
$('btnReview').onclick = reviewTake;
$('btnReview').disabled = true;
$('rvClose').onclick = closeReview;
$('rvClose2').onclick = closeReview;
$('rvJump').onclick = jumpToWorst;
$('reviewModal').onclick = (e) => { if (e.target.id === 'reviewModal') closeReview(); };
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('reviewModal').style.display === 'flex') closeReview();
});

/* ============================================================ 伴奏音频 + 自动测速 */

let audioBuf = null;      // 解码后的音频（不进 .json 工程文件，只进 .tabpilot 打包）
let audioRaw = null;      // 原始音频字节 { bytes: ArrayBuffer, mime, name }，打包成 .tabpilot 时用
let audioPeaks = null;    // 波形峰值，每列一对 [min, max]
let audioName = '';       // 文件名，只用于显示
let audioSrc = null;      // 当前发声的 AudioBufferSourceNode
let audioPlaying = false;
let audioMuted = false;   // 用户主动关掉伴奏发声
let bpmGuess = 0;         // 自动测速结果
let audioOffset = 0;      // 音画偏移（ms）：正数 = 音频比视觉延后

/** 复用节拍器那个 AudioContext；没有实现时返回 null（测试环境） */
function ensureAC() {
  if (!ac) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    try { ac = new C(); } catch (e) { return null; }
  }
  if (ac.state === 'suspended' && ac.resume) { try { ac.resume(); } catch (e) {} }
  return ac;
}

/** 视觉时间(ms) → 音频位置(秒)。偏移用来补偿换气和起拍差异 */
function audioSecOf(tMs) {
  return Math.max(0, (tMs + audioOffset) / 1000);
}

/* ---- BPM 检测的核心：能量包络 → onset → 自相关 → 节拍相位打分 ---- */

/**
 * 计算短时能量的 onset 强度序列。
 * 流程：RMS → 对数压缩（贴近听觉）→ 一阶差分半波整流 → 减去局部均值。
 * 最后一步是关键：它把"整体变响了"的缓慢起伏滤掉，只留下突变。
 * @returns {{env:Float32Array, fps:number}}
 */
function onsetEnvelope(ch, sr, maxSec) {
  const FPS = 86;                                   // 包络帧率 ≈ 11.6ms 一帧
  const hop = Math.max(1, Math.round(sr / FPS));
  const end = Math.min(ch.length, Math.round(maxSec * sr));
  const n = Math.max(0, Math.floor((end - hop) / hop));
  const env = new Float32Array(n);
  let prev = 0;
  for (let f = 0; f < n; f++) {
    let s = 0;
    const i0 = f * hop;
    for (let j = 0; j < hop; j++) { const v = ch[i0 + j]; s += v * v; }
    let rms = Math.sqrt(s / hop);
    const db = Math.log10(rms + 1e-8);
    let d = db - prev;
    env[f] = d > 0 ? d : 0;                         // 半波整流
    prev = db;
  }
  // 归一化 + 局部自适应去噪（减去滑动窗均值）
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean = n ? mean / n : 0;
  let sd = 0;
  for (let i = 0; i < n; i++) { const d = env[i] - mean; sd += d * d; }
  sd = Math.sqrt(n ? sd / n : 0) || 1;
  // ⚠️ 必须先在副本上归一化：如果就地改写 env，滑窗均值会读到已被改写的前序值，
  // 结果就是素材前后半段被两套不同的"噪声基准"处理，包络不再稀疏，
  // 后续的周期打分会被虚假的中等值抬高，实测会把 72 BPM 误判成 143。
  const norm = new Float32Array(n);
  for (let i = 0; i < n; i++) norm[i] = (env[i] - mean) / sd;
  const win = 20;
  let hits = 0;
  for (let i = 0; i < n; i++) {
    let m = 0, c = 0;
    for (let k = Math.max(0, i - win); k < Math.min(n, i + win); k++) { m += norm[k]; c++; }
    const v = norm[i] - (c ? m / c : 0);
    // 阈值很关键：只保留明显高于局部噪声基底的帧。
    // 若把"超过局部均值"的都算 onset，白噪声会贡献大量零散的伪击点，
    // 而格点越密的候选(BPM 越高)越容易碰上它们 —— 打分会系统性偏爱倍频，
    // 实测不设阈值时 72 BPM 会被判成 144。norm 已按标准差归一，0.9 即 0.9σ。
    if (v > 0.9) { env[i] = v; hits++; } else { env[i] = 0; }
  }
  // 非极大抑制：一次击打通常横跨 3~4 帧，整段都记成 onset 会让"命中"过于廉价。
  // 每个连通段只保留最高那一帧。
  for (let i = 0; i < n; i++) {
    if (env[i] <= 0) continue;
    const lo = Math.max(0, i - 2);
    const hi = Math.min(n - 1, i + 2);
    let isMax = true;
    for (let k = lo; k <= hi; k++) {
      if (k === i) continue;
      if (env[k] > env[i] || (env[k] === env[i] && k < i)) { isMax = false; break; }
    }
    if (!isMax) env[i] = 0;
  }
  // 记下所有 onset 的位置：打分时要判断"有多少击点被节拍解释掉了"，
  // 预先抽出来可以省掉每次打分扫描整条包络。
  const onsets = [];
  for (let i = 0; i < n; i++) if (env[i] > 0) onsets.push(i);
  return { env, fps: sr / hop, onsets };
}

/**
 * 给定节拍周期（单位：帧），穷举起始相位，取最好相位下的 F 值。
 *
 * 判据是「精确率 × 召回率」的调和平均，而不是单纯的均值：
 *   · 精确率 precision —— 格点里有多少落在真正的击点上。
 *     半速（70 BPM）的格点也全都踩在拍上，所以单独比均值时它常常占优；
 *   · 召回率 recall —— 所有击点里有多少被这套格点解释掉了。
 *     这是关键：140 BPM 能解释每一拍，70 BPM 只能解释隔一拍的那些，
 *     漏掉的弱拍会把它拉下来。
 * 只比"落在拍上的能量均值"会被重拍结构误导 —— 实测 140 会被判成 70。
 *
 * @param {Float32Array} env 归一化后的 onset 包络
 * @param {number[]} onsets env 中非零帧的下标（预先抽出以省扫描）
 * @param {number} period 候选周期（帧，可为小数）
 * @param {number} spanFrames 参与打分的素材长度（帧）
 */
function scorePeriod(env, onsets, period, spanFrames) {
  if (!(period > 1)) return 0;
  const phases = Math.max(24, Math.min(120, Math.ceil(period / 1.2)));
  const tol = 2.5;        // 帧（≈29ms）：一个打击脉冲的有效半宽，落在这个范围内就算踩中
  // 相位搜索必须比容差细，否则正确的慢周期反而找不到对齐相位：
  // 固定 24 档对 71.6 帧的周期就有 3 帧步长，比 tol 还宽，会把 72 BPM 判成 143。
  // 另外要按「固定时长」而不是「固定点数」来取样本。
  // 否则快周期天然覆盖更多点，点数不公平，均值也就不具可比性。
  const span = Math.min(env.length, spanFrames || env.length);
  let best = 0;
  for (let p = 0; p < phases; p++) {
    const off = (period * p) / phases;
    const total = Math.min(span, off + period * 200);
    if (total < period * 4) continue;                // 素材里至少要有 4 拍

    // 精确率：格点附近窗口内能找到 onset 就算踩中
    let gridHit = 0, gridAll = 0;
    for (let x = off; x < total; x += period) {
      const i = Math.round(x);
      if (i >= env.length) break;
      gridAll++;
      let seen = false;
      for (let d = -tol; d <= tol && !seen; d++) {
        const j = i + Math.round(d);
        if (j >= 0 && j < env.length && env[j] > 0) seen = true;
      }
      if (seen) gridHit++;
    }
    if (gridAll < 4) continue;

    // 召回率：每个击点到最近格点的距离是否在容差内
    let hitOn = 0, allOn = 0;
    for (let q = 0; q < onsets.length; q++) {
      const i = onsets[q];
      if (i >= total) break;
      allOn++;
      const rel = ((i - off) % period + period) % period;
      if (Math.min(rel, period - rel) <= tol) hitOn++;
    }
    if (!allOn) continue;

    const P = gridHit / gridAll;
    const R = hitOn / allOn;
    const f = P + R > 0 ? (2 * P * R) / (P + R) : 0;
    if (f > best) best = f;
  }
  return best;
}

/**
 * 在候选 lag 的 ±1 帧邻域内精细搜索真实周期。
 *
 * 为什么必须有这一步：自相关只能给出整数帧的 lag，而真实拍间隔几乎不可能
 * 正好是整数帧（比如 128 BPM 在 86fps 下是 40.29 帧）。这点误差单独看微不足道，
 * 但 scorePeriod 要累加几十个周期，累积起来能到好几个帧 —— 比一个打击脉冲还宽，
 * 于是格点全部落空，真实 BPM 的得分反而低于"错半拍"的候选。
 * 实测不加这一步，128 BPM 会被判成 64。
 * @returns {{period:number, score:number}}
 */
function refinePeriod(env, onsets, lag, spanFrames) {
  let bestP = lag;
  let bestS = scorePeriod(env, onsets, lag, spanFrames);
  let step = 0.25;
  for (let pass = 0; pass < 4; pass++) {
    const lo = bestP - step * 2;
    const hi = bestP + step * 2;
    for (let p = lo; p <= hi; p += step) {
      if (p <= 1) continue;
      const s = scorePeriod(env, onsets, p, spanFrames);
      if (s > bestS) { bestS = s; bestP = p; }
    }
    step /= 4;                     // 逐轮收窄，最终精度约 0.004 帧
  }
  return { period: bestP, score: bestS };
}

/**
 * 自相关取候选周期：在 50–220 BPM 对应的 lag 范围内找局部峰值，按峰高排前 N。
 * @returns {number[]} 候选 lag（帧）
 */
function autocorrLags(env, fps) {
  const minLag = Math.max(2, Math.round((fps * 60) / 220));
  const maxLag = Math.min(env.length - 1, Math.round((fps * 60) / 50));
  if (maxLag <= minLag + 1) return [];
  const ac = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    const cnt = env.length - lag;
    for (let i = 0; i < cnt; i++) s += env[i] * env[i + lag];
    ac[lag] = s / Math.max(1, cnt);
  }
  let mx = 0;
  for (let lag = minLag; lag <= maxLag; lag++) if (ac[lag] > mx) mx = ac[lag];
  if (mx <= 0) return [];
  const peaks = [];
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1] && ac[lag] > mx * 0.25) {
      peaks.push({ lag, v: ac[lag] / mx });
    }
  }
  peaks.sort((a, b) => b.v - a.v);
  return peaks.slice(0, 6).map((p) => p.lag);
}

/**
 * 从单声道采样数据推算 BPM。
 * 候选 lag 换算成 BPM 后，连同它的 2 倍 / 一半一起用 scorePeriod 打分，
 * 再乘一个以 120 BPM 为中心的高斯先验 —— 这一步用来打破"60 与 120 同分"
 * 的平局（等间隔脉冲在两种划分下都能对齐）。
 * @param {Float32Array} ch 单声道采样
 * @param {number} sr 采样率
 * @param {number} maxSec 最多分析多少秒（长曲的前奏/主歌通常已足够）
 * @returns {number} 推算出的 BPM；找不到稳定节拍返回 0
 */
function detectBpmSamples(ch, sr, maxSec) {
  const { env, fps, onsets } = onsetEnvelope(ch, sr, maxSec || 60);
  if (env.length < fps * 4) return 0;              // 太短，没法判断周期
  const lags = autocorrLags(env, fps);
  if (!lags.length) return 0;

  // 各候选统一在同样 14 秒的素材上打分，慢/快周期才有可比性
  const span = Math.round(Math.min(env.length, fps * 14));

  // 每个候选 lag 连同它的两倍与半速一起作为起点，各自做周期精搜。
  // 周期信号在整数倍 lag 上自相关都很强，单看一个 lag 会漏掉正确的划分。
  const seeds = [];
  for (const lag of lags) seeds.push(lag, lag * 2, lag / 2);

  let best = 0, bestScore = 0;
  for (const seed of seeds) {
    if (!(seed > 1)) continue;
    const r = refinePeriod(env, onsets, seed, span);
    const bpm = (60 * fps) / r.period;
    if (!(bpm > 20 && bpm < 300)) continue;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 1.4, 2));
    const sc = r.score * prior;
    if (sc > bestScore) { bestScore = sc; best = bpm; }
  }
  if (!best) return 0;

  // 常见贝斯/鼓机把"半速""倍速"算成同一拍的情况很常见，
  // 最后统一折叠到大多数人认的速度区间再给出建议值。
  let out = best;
  while (out > 180) out /= 2;
  while (out < 70) out *= 2;
  return Math.round(out);
}

/** 从 AudioBuffer 推算 BPM（多声道下混、截取前若干秒） */
function detectBpmBuffer(buf, maxSec) {
  const ch = buf.getChannelData(0);
  return detectBpmSamples(ch, buf.sampleRate, maxSec);
}

/* ======================================================================
 * 音频对齐核心（纯函数，可在 jsdom/node 单测，不碰 DOM）
 *
 * 两个用途：
 *   1) 一键音画对齐（Feature 16）：把"伴奏真身"与"麦克风录到的房间回放"
 *      做互相关，求出系统回路延迟（喇叭→麦克风），自动写入 audioOffset。
 *   2) 麦克风实时跟奏（Feature 17）：把实时麦克风的包络小窗在伴奏包络上
 *      滑窗找最佳重合位置，从而把播放头锁到演奏者实际所在的小节。
 *
 * 为了能在不同采样率（伴奏 44.1k / 麦克风 48k）下比较，先统一降采样到
 * ALIGN_SR，再取 RMS 包络（对音色/房间染色比 onset 更稳），最后做互相关。
 * ====================================================================== */

const ALIGN_SR = 8000;        // 对齐用的统一降采样率（Hz）
const ALIGN_FRAME = 0.023;    // 包络帧长（秒）→ 约 43fps

/** 把信号降采样到 targetSr：每 targetSr/sr 个点取一次盒平均（抗混叠） */
function decimateRate(samples, sr, targetSr) {
  const ratio = sr / targetSr;
  const n = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let k = a; k < b; k++) s += samples[k];
    out[i] = s / Math.max(1, b - a);
  }
  return out;
}

/** 计算 RMS 包络：把信号切成 frameSec 长的帧，返回每帧均方根 */
function rmsEnvelope(samples, sr, frameSec) {
  const n = Math.max(1, Math.floor(sr * frameSec));
  const frames = Math.max(1, Math.floor(samples.length / n));
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    const a = f * n, b = Math.min(samples.length, a + n);
    for (let i = a; i < b; i++) { const v = samples[i]; s += v * v; }
    out[f] = Math.sqrt(s / Math.max(1, b - a));
  }
  return out;
}

/**
 * 对两段包络做互相关，返回使余弦相似度最高的整数帧偏移。
 * @returns {{lag:number, score:number}} score∈[-1,1]，越高越像
 */
function bestLag(a, b, maxLag) {
  let best = 0, bestScore = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < b.length; i++) {
      const j = i + lag;
      if (j < 0 || j >= a.length) continue;
      const av = a[j], bv = b[i];
      dot += av * bv; na += av * av; nb += bv * bv;
    }
    const denom = Math.sqrt(na * nb) || 1;
    const sc = dot / denom;
    if (sc > bestScore) { bestScore = sc; best = lag; }
  }
  return { lag: best, score: bestScore };
}

/**
 * 计算两路音频之间的延迟（秒）。ref 是"真身"，query 是延迟/带噪的副本。
 * 约定：query[i] ≈ ref[i + lag]，故 query 比 ref 延后时 lag 为负。
 * @returns {{lagSec:number, lagFrames:number, score:number}}
 */
function alignOffsetSeconds(ref, query, refSr, querySr, maxLagSec) {
  const r = decimateRate(ref, refSr, ALIGN_SR);
  const q = decimateRate(query, querySr, ALIGN_SR);
  const er = rmsEnvelope(r, ALIGN_SR, ALIGN_FRAME);
  const eq = rmsEnvelope(q, ALIGN_SR, ALIGN_FRAME);
  const maxLag = Math.max(1, Math.min(er.length - 1, eq.length - 1, Math.round(maxLagSec / ALIGN_FRAME)));
  const { lag, score } = bestLag(er, eq, maxLag);
  return { lagFrames: lag, lagSec: lag * ALIGN_FRAME, score };
}

/**
 * 在参考包络 ref 上，从 aroundIdx 附近 ±win 帧内找 query 小窗的最佳起点。
 * 用于实时跟奏：query 是最近一小段实时包络。
 * @returns {{pos:number, score:number}} pos 是 ref 中的帧索引
 */
function findPosition(ref, query, aroundIdx, win) {
  let best = aroundIdx, bestScore = -Infinity;
  const lo = Math.max(0, aroundIdx - win);
  const hi = Math.min(ref.length - query.length, aroundIdx + win);
  if (hi < lo) return { pos: aroundIdx, score: 0 };
  for (let p = lo; p <= hi; p++) {
    let dot = 0, nr = 0, nq = 0;
    for (let i = 0; i < query.length; i++) {
      const rv = ref[p + i], qv = query[i];
      dot += rv * qv; nr += rv * rv; nq += qv * qv;
    }
    const denom = Math.sqrt(nr * nq) || 1;
    const sc = dot / denom;
    if (sc > bestScore) { bestScore = sc; best = p; }
  }
  return { pos: best, score: bestScore };
}

/* ---- 波形 ---- */

/** 提取每列的 min/max 峰值。cols 取画布像素密度即可，多了只是浪费 */
function computePeaks(buf, cols) {
  const ch = buf.getChannelData(0);
  const n = ch.length;
  const per = Math.max(1, Math.floor(n / cols));
  const out = new Float32Array(cols * 2);
  for (let c = 0; c < cols; c++) {
    const s = c * per;
    const e = c === cols - 1 ? n : Math.min(n, s + per);
    let mn = 0, mx = 0;
    for (let i = s; i < e; i++) {
      const v = ch[i];
      if (v < mn) mn = v; else if (v > mx) mx = v;
    }
    out[c * 2] = mn;
    out[c * 2 + 1] = mx;
  }
  return out;
}

/** 画波形 + 已检测出的节拍格线 */
function drawWave() {
  const cv = $('waveCanvas');
  const box = $('waveBox');
  const ctx = cv.getContext && cv.getContext('2d');
  if (!ctx) return;
  const w = Math.max(120, (box && box.clientWidth) || 600);
  const h = Math.max(30, (box && box.clientHeight) || 56);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  if (ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!audioPeaks) return;

  const mid = h / 2;
  // 节拍格线：只画重拍（每小节第一拍），方便肉眼核对测速准不准
  if (bpmGuess > 0 && audioBuf) {
    const barSec = (60 / bpmGuess) * Math.max(1, parseInt($('bpb').value, 10) || 4);
    const xPer = w / audioBuf.duration;
    ctx.strokeStyle = 'rgba(47,111,237,.28)';
    ctx.lineWidth = 1;
    for (let t = 0; t <= audioBuf.duration; t += barSec) {
      const x = Math.round(t * xPer) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
  }

  const cols = audioPeaks.length / 2;
  const bw = w / cols;
  ctx.fillStyle = '#2f6fed';
  for (let i = 0; i < cols; i++) {
    const mn = audioPeaks[i * 2], mx = audioPeaks[i * 2 + 1];
    const top = mid - mx * (mid - 1);
    const bot = mid - mn * (mid - 1);
    ctx.fillRect(i * bw, top, Math.max(1, bw), Math.max(1, bot - top));
  }
  // 中轴线
  ctx.strokeStyle = 'rgba(0,0,0,.18)';
  ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
}

/* ---- 播放联动 ---- */

/** 从指定的视觉时间开始播伴奏；超出音频长度或静音时什么都不做 */
function startAudioAt(tMs) {
  if (!audioBuf || audioMuted) return;
  const ctx2 = ensureAC();
  if (!ctx2) return;
  const off = audioSecOf(tMs);
  if (off >= audioBuf.duration) { stopAudio(); updateAudioHead(tMs); return; }
  stopAudio();
  try {
    const src = ctx2.createBufferSource();
    src.buffer = audioBuf;
    if (src.playbackRate) src.playbackRate.value = rate;
    const g = ctx2.createGain();
    g.gain.value = 0.85;
    src.connect(g);
    g.connect(ctx2.destination);
    src.start(0, off);
    audioSrc = src;
    audioPlaying = true;
    updateAudioHead(tMs);
  } catch (e) {
    audioSrc = null;
    audioPlaying = false;
  }
  syncAudioBtn();
}

function stopAudio() {
  if (audioSrc) {
    try { audioSrc.stop(); } catch (e) {}
    try { audioSrc.disconnect(); } catch (e) {}
    audioSrc = null;
  }
  audioPlaying = false;
  syncAudioBtn();
}

/** 播放头游标跟着视觉时间走（用百分比定位，不必重画波形） */
function updateAudioHead(tMs) {
  const head = $('waveHead');
  if (!head) return;
  if (!audioBuf) { head.style.display = 'none'; return; }
  head.style.display = 'block';
  const pct = Math.min(100, (audioSecOf(tMs) / audioBuf.duration) * 100);
  head.style.left = pct + '%';
}

function syncAudioBtn() {
  const b = $('btnAudioPlay');
  if (!b) return;
  b.textContent = audioPlaying && !audioMuted ? '⏸' : '▶';
}

/** 倍速变了就让正在响的音源跟着变速（不重启，避免断音） */
function syncAudioRate() {
  if (audioSrc && audioSrc.playbackRate) {
    try { audioSrc.playbackRate.value = rate; } catch (e) {}
  }
}

/* ======================================================================
 * 麦克风对齐（Feature 16 / 17）
 * ====================================================================== */
const FOLLOW_TICK_MS = 100;   // 跟奏采样周期（ms）
const FOLLOW_LOCK = 0.4;      // 判定"跟上了"的匹配分阈值
const FOLLOW_DEGRADE_TICKS = 12;  // 连续 ~1.2s 低于阈值 → 切到节拍级兜底
const FOLLOW_RECOVER_TICKS = 5;   // 连续 ~0.5s 高于阈值 → 恢复跟奏

let aligning = false;         // 校准进行中
let followOn = false;         // 跟奏开关
let followStream = null;      // 麦克风 MediaStream
let followAnalyser = null;    // AnalyserNode
let followTimer = null;       // 轮询定时器
let liveEnv = [];             // 实时包络（每 tick 一个 RMS，约 100ms/点）
let followRef = null;         // 伴奏粗化包络（与 liveEnv 同分辨率）
let followGoodStreak = 0;     // 连续高匹配 tick 数
let followBadStreak = 0;      // 连续低匹配 tick 数
let followState = 'off';      // 'off' | 'track' | 'degrade'

/** 把伴奏降采样+包络，再粗化到 FOLLOW_TICK_MS 分辨率，作为跟奏的参考 */
function buildFollowRef() {
  if (!audioBuf) return null;
  const ch = audioBuf.getChannelData(0);
  const d = decimateRate(ch, audioBuf.sampleRate, ALIGN_SR);
  const fine = rmsEnvelope(d, ALIGN_SR, ALIGN_FRAME);
  const per = Math.max(1, Math.round((FOLLOW_TICK_MS / 1000) / ALIGN_FRAME));
  const coarse = [];
  for (let i = 0; i < fine.length; i += per) {
    let s = 0, c = 0;
    for (let k = i; k < Math.min(fine.length, i + per); k++) { s += fine[k]; c++; }
    coarse.push(s / Math.max(1, c));
  }
  return coarse;
}

function micSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

/** Feature 16：一键音画对齐。播放伴奏并用麦克风录几秒，求回路延迟写入 audioOffset */
async function calibrateOffset() {
  if (!audioBuf) { setHint('请先导入伴奏再校准音画偏移'); return; }
  if (aligning) return;
  if (!micSupported()) { setHint('当前环境不支持麦克风（请用桌面版 TabPilot 或 https 访问网页版）'); return; }
  if (typeof MediaRecorder === 'undefined') { setHint('当前环境不支持录音（MediaRecorder）'); return; }
  aligning = true;
  setHint('校准中：请让伴奏通过扬声器播放，我会用麦克风录几秒…（建议暂时关掉节拍器）');
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } });
    const wasMuted = audioMuted;
    audioMuted = false;
    startAudioAt(0);                       // 从曲首播放，便于麦克风录到完整开头
    const rec = new MediaRecorder(stream);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((res) => { rec.onstop = res; });
    rec.start();
    await new Promise((r) => setTimeout(r, 4000));
    rec.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    stopAudio();
    if (wasMuted) audioMuted = true;

    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    const acx = ensureAC();
    if (!acx) { setHint('音频上下文不可用，无法解码录音'); return; }
    const qbuf = await acx.decodeAudioData(await blob.arrayBuffer());
    const query = qbuf.getChannelData(0);
    const ref = audioBuf.getChannelData(0);
    const res = alignOffsetSeconds(ref, query, audioBuf.sampleRate, qbuf.sampleRate, 3);
    if (res.score < 0.3) {
      setHint('没对齐上：录音里没听清伴奏，请调大扬声器音量、靠近麦克风后重试');
      return;
    }
    // query[i]≈ref[i-lag] → lag 为负；回路延迟 L = -lag·帧长，audioOffset 取正
    audioOffset = Math.round(-res.lagFrames * ALIGN_FRAME * 1000);
    if ($('audioOffset')) $('audioOffset').value = audioOffset;
    setLed('ok', '音画对齐完成');
    setHint('已自动校准音画偏移：' + audioOffset + 'ms（系统回路延迟）。若仍差半拍可手动微调');
  } catch (e) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    setHint('校准失败：' + (e && e.message ? e.message : e) + '（麦克风被拒绝或无音频权限）');
  } finally {
    aligning = false;
  }
}

/**
 * 跟奏状态机（纯函数，verify:render 单测）：根据当前匹配分与连续命中/丢失计数，
 * 决定下一边界状态。'track' = 跟上了（绿），'degrade' = 跟丢后退回节拍级兜底滚动（黄）。
 * 返回新的 { state, good, bad }，调用方就地覆盖即可。
 */
function followStateMachine(state, score, good, bad) {
  let ng = good, nb = bad;
  if (score >= FOLLOW_LOCK) { ng = good + 1; nb = 0; }
  else { nb = bad + 1; ng = 0; }
  let ns = state;
  if (state === 'degrade') {
    if (ng >= FOLLOW_RECOVER_TICKS) ns = 'track';
  } else if (nb >= FOLLOW_DEGRADE_TICKS) {
    ns = 'degrade';
  }
  return { state: ns, good: ng, bad: nb };
}

/** 把跟奏状态反映到状态灯：track=绿 / degrade=黄 / off=灰 */
function setFollowLed(state) {
  const el = $('followLed');
  if (!el) return;
  el.className = 'led' + (state === 'track' ? ' ok' : state === 'degrade' ? ' warn' : '');
  const t = $('followStateText');
  if (t) t.textContent = state === 'track' ? '跟奏中' : state === 'degrade' ? '降级·节拍滚动' : '未跟奏';
}

/** Feature 17：开启麦克风实时跟奏 */
async function startFollow() {
  if (!audioBuf) { setHint('请先导入伴奏再开启跟奏'); return; }
  if (followOn) return;
  if (!micSupported()) { setHint('当前环境不支持麦克风'); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) { setHint('跟奏开启失败：' + (e && e.message ? e.message : e)); return; }
  const acx = ensureAC();
  if (!acx) { stream.getTracks().forEach((t) => t.stop()); setHint('音频上下文不可用，无法开启跟奏'); return; }
  const srcNode = acx.createMediaStreamSource(stream);
  const an = acx.createAnalyser();
  an.fftSize = 2048;
  srcNode.connect(an);
  followStream = stream;
  followAnalyser = an;
  followRef = buildFollowRef();
  liveEnv = [];
  followOn = true;
  followState = 'track'; followGoodStreak = 0; followBadStreak = 0;
  setFollowLed('track');
  if ($('btnFollow')) $('btnFollow').classList.add('active');
  if ($('chordChip')) $('chordChip').style.display = '';
  setHint('跟奏已开启：播放头会跟随你实际弹/听的位置自动移动（再点一次可关闭）');
  followTick();
}

function followTick() {
  if (!followOn || !followAnalyser) return;
  const buf = new Float32Array(followAnalyser.fftSize);
  followAnalyser.getFloatTimeDomainData(buf);
  let s = 0; for (let i = 0; i < buf.length; i++) { const v = buf[i]; s += v * v; }
  liveEnv.push(Math.sqrt(s / buf.length));
  if (liveEnv.length > 400) liveEnv.shift();                 // 上限 ~40s

  const W = Math.round(1.5 / (FOLLOW_TICK_MS / 1000));       // 实时窗长（粗帧）
  if (followRef && liveEnv.length >= W) {
    const win = liveEnv.slice(-W);
    const around = Math.round(curTime() / 1000 / (FOLLOW_TICK_MS / 1000));
    const winFrames = Math.round(2 / (FOLLOW_TICK_MS / 1000));
    const { pos, score } = findPosition(followRef, win, around, winFrames);
    const next = followStateMachine(followState === 'off' ? 'track' : followState, score,
      followGoodStreak, followBadStreak);
    followState = next.state; followGoodStreak = next.good; followBadStreak = next.bad;
    setFollowLed(followState);
    if (followState === 'degrade') {
      // 跟丢了：不再用麦克风位置硬拽播放头，退回 BPM 自动滚动（已有的播放循环即节拍级兜底）
      if ($('followStateText') && $('followStateText').dataset.warned !== '1') {
        setHint('跟奏暂时跟丢了，已切回节拍滚动；继续弹/听，锁定后会自动恢复');
        $('followStateText').dataset.warned = '1';
      }
    } else if ($('followStateText')) {
      $('followStateText').dataset.warned = '';
    }
    if (followState === 'track' && score > 0.4) {
      const newMs = pos * FOLLOW_TICK_MS;
      if (Math.abs(newMs - curTime()) > 250) {
        if (playing || paused) startAtTime(newMs);
        else elapsedBase = newMs;
      }
    }
  }
  // Feature 21：图片谱实时和弦识别（你弹/唱的和弦名）
  if (window.ChordCore && $('chordImg')) {
    const ch = liveChroma();
    const det = ch ? window.ChordCore.chordDetect(ch) : null;
    $('chordImg').textContent = det ? det.name : '—';
    const led = $('chordLedImg');
    if (led) led.className = 'led' + (det && !det.uncertain ? ' ok' : '');
  }

  followTimer = setTimeout(followTick, FOLLOW_TICK_MS);
}

/** 从跟奏分析器取当前帧色度向量（与 app.js 的 micChroma 同口径） */
function liveChroma() {
  if (!followAnalyser) return null;
  const n = followAnalyser.frequencyBinCount;
  const fbuf = new Float32Array(n);
  followAnalyser.getFloatFrequencyData(fbuf);
  const ctx = followAnalyser.context;
  const sr = ctx && ctx.sampleRate ? ctx.sampleRate : 44100;
  const binHz = sr / (n * 2);          // fftSize = frequencyBinCount * 2
  const c = new Float32Array(12);
  let peakDb = -Infinity;
  for (let k = 2; k < n; k++) {
    const db = fbuf[k];
    if (!isFinite(db) || db < -90) continue;
    const f = k * binHz;
    if (f < 75 || f > 1400) continue;
    if (db > peakDb) peakDb = db;
    const midi = 69 + 12 * Math.log2(f / 440);
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    c[pc] += Math.pow(10, (db + 72) / 20);
  }
  let s = 0; for (const v of c) s += v * v;
  if (s <= 0) return null;
  return c;
}

function stopFollow() {
  followOn = false;
  followState = 'off'; followGoodStreak = 0; followBadStreak = 0;
  if (followTimer) { clearTimeout(followTimer); followTimer = null; }
  if (followStream) { followStream.getTracks().forEach((t) => t.stop()); followStream = null; }
  followAnalyser = null; liveEnv = []; followRef = null;
  if ($('btnFollow')) $('btnFollow').classList.remove('active');
  if ($('chordChip')) $('chordChip').style.display = 'none';
  if ($('chordImg')) $('chordImg').textContent = '—';
  setFollowLed('off');
  setHint('跟奏已关闭');
}

/* ---- 文件导入 ---- */

function loadAudioFile(file) {
  const ctx2 = ensureAC();
  if (!ctx2) { setHint('当前环境不支持音频解码（Web Audio 不可用）'); return; }
  setHint('正在解码音频…');
  const r = new FileReader();
  r.onload = () => {
    // decodeAudioData 会 detach 传入的 ArrayBuffer，所以先留一份原始字节的副本：
    // 打包 .tabpilot 时要按原音频塞进去（mp3 比 PCM 小一个量级，不该把解码结果再编回去）
    let raw = null;
    try { raw = r.result.slice(0); } catch (e) { raw = null; }
    let done = false;
    const ok = (buf) => {
      if (done) return;
      done = true;
      installAudioBuffer(buf, file.name, raw, file.type || guessAudioMime(file.name));
      setLed('ok', '伴奏已加载：' + file.name);
      setHint('点「🎯 自动测速」推算这首曲子的 BPM，或直接开始跟随（点波形可试听）');
    };
    const bad = () => { if (!done) { done = true; setHint('音频解码失败：格式可能不受支持'); } };
    // 非 Promise 的老实现也要兼容（Safari 早期）
    try {
      const p = ctx2.decodeAudioData(r.result.slice(0), ok, bad);
      if (p && p.then) p.then(ok, bad);
    } catch (e) { bad(); }
  };
  r.onerror = () => setHint('读取音频文件失败：' + file.name);
  r.readAsArrayBuffer(file);
}

/** 按扩展名猜 MIME：从文件选择器拿到的 type 有时是空的 */
function guessAudioMime(name) {
  const m = /\.(mp3|wav|m4a|aac|ogg|oga|flac)$/i.exec(name || '');
  if (!m) return 'audio/mpeg';
  const map = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac' };
  return map[m[1].toLowerCase()] || 'audio/mpeg';
}

/** 装配已解码的伴奏：记录元信息、算波形、更新 UI（文件导入与 .tabpilot 解包共用） */
function installAudioBuffer(buf, name, raw, mime) {
  audioBuf = buf;
  audioRaw = raw && raw.byteLength ? { bytes: raw, mime: mime || guessAudioMime(name), name: name } : null;
  audioName = name;
  bpmGuess = 0;
  audioOffset = 0;                    // 换曲了，旧的偏移没有意义
  $('audioOffset').value = 0;
  audioMuted = false;
  audioPeaks = computePeaks(buf, 900);
  $('audioName').textContent = name;
  $('audioBpm').textContent = '';
  $('audioBar').classList.remove('collapsed');
  ['btnAudioPlay', 'btnBpmDetect', 'btnAudioClose', 'offsetWrap', 'audioTip']
    .forEach((id) => { $(id).style.display = ''; });
  $('btnBpmUse').style.display = 'none';
  drawWave();
  updateAudioHead(0);
}

/** 从原始音频字节直接装入伴奏（.tabpilot 解包用） */
function loadAudioBytes(u8, meta) {
  const ctx2 = ensureAC();
  if (!ctx2) { setHint('打包文件里有伴奏，但当前环境不支持音频解码（Web Audio 不可用）'); return; }
  // subarray 是视图，byteOffset 未必为 0；decodeAudioData 要求独立的 ArrayBuffer
  const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  const name = (meta && meta.name) || 'audio';
  const mime = (meta && meta.mime) || guessAudioMime(name);
  setHint('正在解码打包中的伴奏…');
  const ok = (buf) => {
    installAudioBuffer(buf, name, ab, mime);
    if (meta && meta.offset) {
      audioOffset = parseInt(meta.offset, 10) || 0;
      $('audioOffset').value = audioOffset;
    }
    setLed('ok', '伴奏已恢复：' + name);
    setHint('打包文件已还原（谱图 + 谱行 + 段落 + 伴奏），点「▶ 开始跟随」即可');
  };
  const bad = () => setHint('伴奏解码失败：打包文件里的音频格式可能不受支持');
  try {
    const p = ctx2.decodeAudioData(ab.slice(0), ok, bad);
    if (p && p.then) p.then(ok, bad);
  } catch (e) { bad(); }
}

function clearAudio() {
  stopAudio();
  audioBuf = null;
  audioRaw = null;
  audioPeaks = null;
  bpmGuess = 0;
  audioOffset = 0;
  $('audioOffset').value = 0;
  $('audioName').textContent = '未加载';
  $('audioBpm').textContent = '';
  $('audioBar').classList.add('collapsed');
  ['btnAudioPlay', 'btnBpmDetect', 'btnBpmUse', 'btnAudioClose', 'offsetWrap', 'audioTip']
    .forEach((id) => { $(id).style.display = 'none'; });
  $('waveHead').style.display = 'none';
  const cv = $('waveCanvas');
  const c = cv.getContext && cv.getContext('2d');
  if (c) c.clearRect(0, 0, cv.width, cv.height);
  setHint('已移除伴奏');
}

/* ---- 控件绑定 ---- */

$('btnAudioLoad').onclick = () => $('audioInput').click();
$('audioInput').onchange = (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) loadAudioFile(f);
  e.target.value = '';
};
$('btnAudioClose').onclick = clearAudio;

/** 波形点击/拖动：从该秒起试听（跟随正在播时则一并跳转） */
(function bindWaveSeek() {
  const box = $('waveBox');
  if (!box) return;
  let dragging = false;
  const posToSec = (ev) => {
    const r = box.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, ev.clientX - r.left));
    if (!audioBuf) return 0;
    return (x / Math.max(1, r.width)) * audioBuf.duration;
  };
  box.addEventListener('pointerdown', (e) => {
    if (!audioBuf) return;
    dragging = true;
    const sec = posToSec(e);
    audioMuted = false;
    if (playing || paused) {
      const t = Math.max(0, sec * 1000 - audioOffset);
      elapsedBase = t;
      startAtTime(t);
    } else {
      startAudioAt(sec * 1000 - audioOffset);
    }
    updateAudioHead(sec * 1000 - audioOffset);
  });
  box.addEventListener('pointermove', (e) => { if (dragging) updateAudioHead(posToSec(e) * 1000 - audioOffset); });
  const end = () => { dragging = false; };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
  box.addEventListener('pointerleave', end);
})();

$('btnAudioPlay').onclick = () => {
  if (!audioBuf) return;
  audioMuted = !audioMuted;
  if (audioMuted) { stopAudio(); setHint('伴奏已静音（只留节拍器）'); }
  else {
    startAudioAt((playing || paused) ? curTime() : elapsedBase);
    setHint('伴奏已开启');
  }
};

$('btnBpmDetect').onclick = () => {
  if (!audioBuf) return;
  $('btnBpmDetect').disabled = true;
  $('audioBpm').textContent = '分析中…';
  // 让浏览器先把「分析中」画出来，再做几十毫秒的密集计算
  setTimeout(() => {
    const bpm = detectBpmBuffer(audioBuf, 60);
    bpmGuess = bpm;
    $('btnBpmDetect').disabled = false;
    if (bpm) {
      $('audioBpm').innerHTML = '≈ <b>' + bpm + '</b> BPM';
      $('btnBpmUse').style.display = '';
      setHint('检测到约 ' + bpm + ' BPM。点「采用」把它写进上面速度并按此重排时间轴');
    } else {
      $('audioBpm').textContent = '未找到稳定节拍';
      $('btnBpmUse').style.display = 'none';
      setHint('这段音频没有明显的节拍脉冲，请手动设 BPM');
    }
    drawWave();
  }, 30);
};

$('btnBpmUse').onclick = () => {
  if (!bpmGuess) return;
  $('bpm').value = bpmGuess;
  drawBands();
  drawWave();   // 波形上的小节格线按新 BPM 重画
  setLed('ok', 'BPM 已设为 ' + bpmGuess + '（时间轴已按此重算）');
  setHint('BPM 已更新。若伴奏与起始对不上，用「偏移」做毫秒级微调');
};

$('audioOffset').onchange = (e) => {
  audioOffset = parseInt(e.target.value, 10) || 0;
  updateAudioHead(curTime());
  if (audioBuf && audioPlaying) startAudioAt(curTime());
};

// 麦克风对齐：校准音画偏移 / 实时跟奏（无该按钮或不支持时静默跳过）
if ($('btnAlign')) $('btnAlign').onclick = calibrateOffset;
if ($('btnFollow')) $('btnFollow').onclick = () => { if (followOn) stopFollow(); else startFollow(); };

window.addEventListener('resize', () => {
  if (audioPeaks) drawWave();
});

/* ---------------------------------------------------- 透视矫正（四点拉正） */

/** 四点是否构成一个可用的四边形（非退化、面积不为 0） */
function validQuad(pts) {
  if (!Array.isArray(pts) || pts.length !== 4) return false;
  for (const p of pts) {
    if (!Array.isArray(p) || p.length !== 2) return false;
    if (!isFinite(p[0]) || !isFinite(p[1])) return false;
  }
  return Math.abs(quadArea(pts)) > 1;
}

/** 四边形有向面积（鞋带公式），用于排除退化四点 */
function quadArea(pts) {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/**
 * 求单应矩阵系数，把「归一化输出坐标 (u,v) ∈ [0,1]²」映射到源图四边形。
 *
 * 映射形式（四点共 8 个约束，解 8 个系数）：
 *     x = (a·u + b·v + c) / (g·u + h·v + 1)
 *     y = (d·u + e·v + f) / (g·u + h·v + 1)
 * 角点约定：(0,0)→左上角 (1,0)→右上角 (1,1)→右下角 (0,1)→左下角。
 *
 * @param {number[][]} pts 源图上的四个角点（左上、右上、右下、左下），单位：像素
 * @returns {{a,b,c,d,e,f,g,h}}
 */
function quadHomography(pts) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = pts;
  const dx1 = x1 - x2, dx2 = x3 - x2;
  const dy1 = y1 - y2, dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  const det = dx1 * dy2 - dy1 * dx2;

  let g = 0, h = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    if (Math.abs(det) < 1e-9) return null;      // 退化四点，解不出来
    g = (sx * dy2 - dx2 * sy) / det;
    h = (dx1 * sy - sx * dy1) / det;
  }
  return {
    a: x1 - x0 + g * x1,
    b: x3 - x0 + h * x3,
    c: x0,
    d: y1 - y0 + g * y1,
    e: y3 - y0 + h * y3,
    f: y0,
    g, h,
  };
}

/** 用单应系数把归一化坐标投到源图像素坐标 */
function homographyMap(H, u, v) {
  const w = H.g * u + H.h * v + 1;
  if (Math.abs(w) < 1e-9) return [0, 0];
  return [(H.a * u + H.b * v + H.c) / w, (H.d * u + H.e * v + H.f) / w];
}

/** 透视环节的源像素缓存：拖动时反复 warp，避免每次都重新 getImageData */
let warpCache = null;

/**
 * 透视矫正：把源图中被框出的四边形拉正成一张矩形图。
 *
 * Canvas 2D 的 setTransform 只支持仿射（平行四边形→平行四边形），做不了透视，
 * 所以这里对每个输出像素做「反向映射 + 双线性采样」逐点搬像素。
 *
 * @param {HTMLImageElement|HTMLCanvasElement} src 源图
 * @param {number[][]} pts 四角点（源图坐标）
 * @param {number} [maxW] 输出最大宽度（预览用小图加速；0 = 不限制）
 */
function warpPerspective(src, pts, maxW) {
  const H = quadHomography(pts);
  if (!H) return null;

  const sw = src.naturalWidth || src.width;
  const sh = src.naturalHeight || src.height;
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  // 输出尺寸取对边的较大值，避免把内容压小
  let W = Math.max(dist(pts[0], pts[1]), dist(pts[3], pts[2]));
  let Hh = Math.max(dist(pts[0], pts[3]), dist(pts[1], pts[2]));
  W = Math.max(16, Math.round(W));
  Hh = Math.max(16, Math.round(Hh));

  // 限制尺寸：预览（maxW）或防止像素爆炸
  const cap = maxW || 2600;
  if (W > cap) { Hh = Math.max(16, Math.round((Hh * cap) / W)); W = cap; }
  if (W * Hh > 8e6) { const k = Math.sqrt(8e6 / (W * Hh)); W = Math.round(W * k); Hh = Math.round(Hh * k); }

  const sCv = document.createElement('canvas');
  sCv.width = sw;
  sCv.height = sh;
  const sctx = sCv.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(src, 0, 0, sw, sh);
  // 源像素在连续拖动中会反复用到，缓存下来省掉每次几 MB 的重新采样
  const key = (src.src || '') + '|' + sw + 'x' + sh;
  let sd = null;
  if (warpCache && warpCache.key === key) sd = warpCache.data;
  if (!sd) {
    sd = sctx.getImageData(0, 0, sw, sh).data;
    warpCache = { key, data: sd };
  }

  const out = document.createElement('canvas');
  out.width = W;
  out.height = Hh;
  const octx = out.getContext('2d');
  const od = octx.createImageData(W, Hh);
  const op = od.data;

  for (let y = 0; y < Hh; y++) {
    const v = y / (Hh - 1 || 1);
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1 || 1);
      const [sx, sy] = homographyMap(H, u, v);
      const o = (y * W + x) * 4;

      if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) {
        op[o] = op[o + 1] = op[o + 2] = 255;
        op[o + 3] = 255;
        continue;
      }
      // 双线性采样：直接取最近邻会有明显锯齿
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = sd[i00 + ch] * (1 - fx) + sd[i10 + ch] * fx;
        const bot = sd[i01 + ch] * (1 - fx) + sd[i11 + ch] * fx;
        op[o + ch] = top * (1 - fy) + bot * fy;
      }
      op[o + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);
  return out;
}

/* -------------------------------------------------------------- 图片预处理 */

/**
 * 预处理参数（每次打开修图面板重置，点「应用」才真正写回页面）。
 * 只记几何/增强开关，不缓存像素 —— 换页或改参数都重算一遍，逻辑最简单。
 */
let prep = { rot: 0, flip: false, crop: false, enhance: false, persp: false, level: 55, pts: null };
/** 透视角点所在的源图尺寸（预览缩放换算用） */
let prepBaseW = 0;
let prepBaseH = 0;

/** 初始化四点：贴着原图边角往里收 3%，省得用户从零开始拖 */
function defaultQuad(w, h) {
  const mx = w * 0.03;
  const my = h * 0.03;
  return [[mx, my], [w - mx, my], [w - mx, h - my], [mx, h - my]];
}

/** 打开修图面板并预览当前页 */
function openPrep() {
  if (!pages[curPage] || !pages[curPage].img.naturalWidth) { setHint('请先加载谱图'); return; }
  $('morePop').classList.remove('open');
  const lv = parseInt($('prepLevel').value, 10) || 55;
  prepBaseW = pages[curPage].img.naturalWidth;
  prepBaseH = pages[curPage].img.naturalHeight;
  prep = { rot: 0, flip: false, crop: false, enhance: false, persp: false, level: lv, pts: defaultQuad(prepBaseW, prepBaseH) };
  $('prepPageNo').textContent = curPage + 1;
  syncPrepUI();
  $('prepModal').style.display = 'flex';
  renderPrep();
  layoutHandles();
}

function closePrep() { $('prepModal').style.display = 'none'; }

/** 同步修图面板按钮高亮 */
function syncPrepUI() {
  $('prepFlip').classList.toggle('active', prep.flip);
  $('prepCrop').classList.toggle('active', prep.crop);
  $('prepEnh').classList.toggle('active', prep.enhance);
  $('prepPersp').classList.toggle('active', prep.persp);
  $('prepBox').classList.toggle('persp', prep.persp);
  $('prepLevel').value = prep.level;
  $('prepLevelVal').textContent = prep.level;
}

/**
 * 按当前 prep 参数生成一张处理好的 canvas。
 * 管线顺序（不能颠倒）：透视矫正 → 几何（旋转/镜像）→ 裁白边 → 去阴影增强。
 * @param {Object}   pg  页对象
 * @param {Object}   opt 预处理参数
 * @param {number}  [maxW] 透视环节的最大输出宽度（预览用小图，应用时用全分辨率）
 */
function prepCanvas(pg, opt, maxW) {
  const src = pg.img;
  const nw = src.naturalWidth;
  const nh = src.naturalHeight;

  // ① 透视矫正（可选）：四点拉正后再走后续步骤
  let base = null;
  if (opt.persp && validQuad(opt.pts)) {
    base = warpPerspective(src, opt.pts, maxW || 0);
  }
  if (!base) {
    base = document.createElement('canvas');
    base.width = nw;
    base.height = nh;
    base.getContext('2d').drawImage(src, 0, 0, nw, nh);
  }

  // ② 几何变换
  let cv = rotateCanvas(base, opt.rot, opt.flip);

  // ③ 裁白边
  if (opt.crop) {
    const c2 = cropWhite(cv);
    if (c2) cv = c2;
  }
  // ④ 增强
  if (opt.enhance && opt.level > 0) enhanceContrast(cv, opt.level);
  return cv;
}

/** 把 canvas 旋转 90° 的整数倍（可叠加水平镜像） */
function rotateCanvas(srcCv, rot, flip) {
  const r = ((rot % 360) + 360) % 360;
  const swap = (r === 90 || r === 270);
  const cv = document.createElement('canvas');
  cv.width = swap ? srcCv.height : srcCv.width;
  cv.height = swap ? srcCv.width : srcCv.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.save();
  ctx.translate(cv.width / 2, cv.height / 2);
  ctx.rotate((r * Math.PI) / 180);
  if (flip) ctx.scale(-1, 1);
  ctx.drawImage(srcCv, -srcCv.width / 2, -srcCv.height / 2);
  ctx.restore();
  return cv;
}

/**
 * 预览：把处理结果等比缩放到面板宽度。
 * @param {number} [budget] 透视环节的输出宽度上限。拖动中用小图保帧率，松手后再出清晰预览。
 */
function renderPrep(budget) {
  const pg = pages[curPage];
  if (!pg || !pg.img.naturalWidth) return;
  const cv = prepCanvas(pg, prep, budget || 900);
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

/** 把四个拖点摆到预览图上对应的位置 */
function layoutHandles() {
  if (!prep.persp || !prep.pts) return;
  const cvEl = $('prepCanvas');
  const boxEl = $('prepBox');
  const r = cvEl.getBoundingClientRect();
  const b = boxEl.getBoundingClientRect();
  const sx = prepBaseW ? r.width / prepBaseW : 0;
  const sy = prepBaseH ? r.height / prepBaseH : 0;
  if (!sx || !sy) return;
  boxEl.querySelectorAll('.pt').forEach((el) => {
    const p = prep.pts[+el.dataset.i];
    if (!p) return;
    el.style.left = (r.left - b.left + p[0] * sx) + 'px';
    el.style.top = (r.top - b.top + p[1] * sy) + 'px';
  });
}

/* 拖点交互：按下选中某个角，移动时换算回源图坐标并重算预览 */
let dragPt = -1;
function ptFromEvent(e, idx) {
  const r = $('prepCanvas').getBoundingClientRect();
  const sx = r.width ? prepBaseW / r.width : 0;
  const sy = r.height ? prepBaseH / r.height : 0;
  if (!sx || !sy) return;
  const x = Math.max(0, Math.min(prepBaseW, (e.clientX - r.left) * sx));
  const y = Math.max(0, Math.min(prepBaseH, (e.clientY - r.top) * sy));
  prep.pts[idx] = [x, y];
}

$('prepBox').querySelectorAll('.pt').forEach((el) => {
  const idx = +el.dataset.i;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragPt = idx;
    el.setPointerCapture && el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (dragPt !== idx) return;
    ptFromEvent(e, idx);
    layoutHandles();
    renderPrep(420);          // 拖动中小图预览，保证跟手
  });
  el.addEventListener('pointerup', (e) => {
    if (dragPt !== idx) return;
    dragPt = -1;
    el.releasePointerCapture && el.releasePointerCapture(e.pointerId);
    renderPrep();             // 松手后再出清晰预览
  });
  el.addEventListener('pointercancel', () => { dragPt = -1; });
});

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
  if (!prep.rot && !prep.flip && !prep.crop && !prep.enhance && !prep.persp) { setHint('没有做任何调整'); return; }
  const cv = prepCanvas(pg, prep, 0);
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
  prep = {
    rot: 0, flip: false, crop: false, enhance: false, persp: false,
    level: prep.level, pts: prep.pts,
  };
  syncPrepUI();
  renderPrep();
  layoutHandles();
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
$('prepPersp').onclick = () => {
  prep.persp = !prep.persp;
  if (prep.persp && !validQuad(prep.pts)) prep.pts = defaultQuad(prepBaseW, prepBaseH);
  syncPrepUI();
  renderPrep();
  layoutHandles();
  if (prep.persp) setHint('透视矫正：把四个角点拖到谱面的四个角上，再点「应用」把斜拍的谱拉正。');
};
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
  setZoom(zoomLevel === 1.0 ? 1.6 : 1.0);
});

/* ------------------------------------------------------------ 触控手势 */

/**
 * 统一改缩放比例的入口：夹取值 → 更新 → 重排版。
 * 抽出来是为了让双击和双指手势都只走一条路。
 */
function setZoom(z) {
  z = Math.max(0.5, Math.min(4, z));
  if (Math.abs(z - zoomLevel) < 0.005) return;
  zoomLevel = z;
  layout();
  drawBands();
}

function touchDist(ts) {
  const dx = ts[0].clientX - ts[1].clientX;
  const dy = ts[0].clientY - ts[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * 触控适配两件事：双指缩放 + 左右快划翻页。
 *
 * stage 上刻意用 'pan-x pan-y' 而不是 'none'：
 *   none 会把浏览器原生的平滑滚动一并废掉，单指拖动就不好用了；
 *   pan-x pan-y 保留平移，同时把 pinch 交给我们自己处理。
 */
stage.style.touchAction = 'pan-x pan-y';

let pinch = { active: false, dist: 0, zoom: 1 };
let swipe = { active: false, x: 0, y: 0, t: 0 };

stage.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    pinch.active = true;
    pinch.dist = touchDist(e.touches);
    pinch.zoom = zoomLevel;
    swipe.active = false;
  } else if (e.touches.length === 1) {
    swipe.active = true;
    swipe.x = e.touches[0].clientX;
    swipe.y = e.touches[0].clientY;
    swipe.t = Date.now();
  }
}, { passive: true });

stage.addEventListener('touchmove', (e) => {
  if (!pinch.active || e.touches.length !== 2) return;
  e.preventDefault();                       // 阻止页面级缩放，交由我们自己算
  const d = touchDist(e.touches);
  if (pinch.dist > 8 && d > 8) setZoom(pinch.zoom * (d / pinch.dist));
}, { passive: false });

stage.addEventListener('touchend', (e) => {
  if (pinch.active && e.touches.length < 2) pinch.active = false;
  if (swipe.active && !e.touches.length) {
    swipe.active = false;
    endSwipe(e.changedTouches && e.changedTouches[0]);
  }
}, { passive: true });

/** 松手时判定是否为"快划翻页"：够快、够长、且横向占主导 */
function endSwipe(t) {
  if (!t || pinch.active || pages.length < 2) return;
  if (zoomLevel > 1.05) return;             // 图已放大时横划是在平移画布
  const dx = t.clientX - swipe.x;
  const dy = t.clientY - swipe.y;
  if (Date.now() - swipe.t > 500) return;
  if (Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy) * 2) return;
  gotoPage(curPage + (dx < 0 ? 1 : -1));
}

/* -------------------------------------------------------- 专注（沉浸）模式 */

/**
 * 手机上顶栏 + 工具条能吃掉三分之一屏高，看谱时反而碍事。
 * body.focus 下隐藏它们，只留舞台、状态栏和一条浮动操作条。
 * @param {boolean} [on] 不传则按当前状态取反
 */
function toggleFocus(on) {
  const next = on == null ? !document.body.classList.contains('focus') : !!on;
  document.body.classList.toggle('focus', next);
  layout();
  drawBands();
  setHint(next
    ? '专注模式：已隐藏顶栏与侧栏（右上按钮或 Esc 退出），播放/翻页用屏幕底部那条浮动按钮'
    : '已退出专注模式');
}

$('btnFocus').onclick = () => toggleFocus();
$('focusExit').onclick = () => toggleFocus(false);
$('dockPrev').onclick = () => gotoPage(curPage - 1);
$('dockNext').onclick = () => gotoPage(curPage + 1);
$('dockPlay').onclick = () => {
  if (!playing) { play(); return; }
  if (paused) resume(); else pause();
};
$('dockLoop').onclick = () => $('btnLoop').click();

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
    stepTrain();   // 渐进提速：每完成一轮加一档
    startAudioAt(loopA);   // 伴奏跟着跳回 A（B→A 是瞬时跳变，必须重启音源）
  }
  const loc = locate(t);
  if (!loc) return;
  if (loc.page !== curPage) switchPageDisplay(loc.page);   // 跨页自动翻页
  showPosition(loc.band, loc.bar, loc.p);
  $('elapsed').textContent = (t / 1000).toFixed(1) + 's';
  updateAudioHead(t);

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

    // 行级跟随优先用检测到的真实小节边界，无边界时退回均分
    const seg = (window.BarlineCore ? window.BarlineCore.barBoundsAt(b.bounds, barIdx) : null)
      || { a: b.x0 + barIdx * ((b.x1 - b.x0) / b.bars), b: b.x0 + (barIdx + 1) * ((b.x1 - b.x0) / b.bars) };
    const xs = seg.a;
    const ws = Math.max(1, seg.b - seg.a);

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

  // 小节框：优先用检测到的真实边界，无边界时退回均分
  const seg2 = (window.BarlineCore ? window.BarlineCore.barBoundsAt(b.bounds, barIdx) : null)
    || { a: b.x0 + barIdx * ((b.x1 - b.x0) / b.bars), b: b.x0 + (barIdx + 1) * ((b.x1 - b.x0) / b.bars) };
  const w = Math.max(1, seg2.b - seg2.a);
  const x = seg2.a;
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

  syncAudioRate();   // 变速：让正在响的伴奏跟着变，不重启音源

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
  updateTrainUI();
});
