/* ==========================================================================
 * image-tab.js — 图片谱跟随（image-tab.html 的业务脚本）
 *
 * 为什么图片谱需要校准：
 *   JPG/PNG 只有像素，没有"小节坐标"这类结构化信息。因此流程是
 *     ① 载入谱图
 *     ② 识别谱行（水平投影找六线谱线簇 → 聚类成行，并检测竖直小节线求每行小节数）
 *     ③ 按 BPM × 每行小节数展开时间轴，行内小节均分推进
 *     ④ 行内高亮当前小节框 + 扫描线，右下放大镜光栅放大当前小节
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
/** 当前行 / 当前小节索引 */
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

$('btnLoad').onclick = () => $('fileInput').click();

$('fileInput').onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => loadImage(r.result);
  r.readAsDataURL(f);
  e.target.value = '';   // 允许重复选择同一个文件
};

$('btnDemo').onclick = () => loadImage('assets/demo-xihn.jpg');

/** 载入谱图并重置校准结果 */
function loadImage(src) {
  tabImg.onload = () => {
    bands = [];
    stop();
    layout();
    renderBandList();
    setLed('', '图片已加载');
    setHint('点「🤖 自动识别谱行」识别谱面行，或「✌️ 手动框行」逐行框选');
  };
  tabImg.src = src;
}

/**
 * 重新计算图片显示尺寸：先按容器宽度自适应，再叠加用户缩放。
 * 缩放使用 CSS zoom，覆盖层作为 #imgWrap 子元素会自动跟随，无需重算坐标。
 */
function layout() {
  if (!tabImg.naturalWidth) return;
  const w = stage.clientWidth - 16;
  const scale = Math.min(1, w / tabImg.naturalWidth) * zoomLevel;
  imgWrap.style.zoom = scale;
  imgWrap.style.width = tabImg.naturalWidth + 'px';
}

window.addEventListener('resize', layout);

/* ------------------------------------------------------- 谱行识别（投影法） */

$('btnDetect').onclick = () => {
  if (!tabImg.naturalWidth) { setHint('请先加载谱图'); return; }
  bands = detectBands();
  renderBandList();
  setLed('ok', '已识别 ' + bands.length + ' 行');
  setHint('检查右侧行列表：可删除误检行、修改每行小节数，然后点「▶ 开始跟随」');
};

/**
 * 自动识别谱行。
 * 思路：把图片降采样到 700px 宽做水平投影 → 找出"横贯画面的实线"→ 按间距
 * 把六线谱的 6 条线聚类成一个谱行系统 → 再逐行检测竖直小节线求小节数。
 */
function detectBands() {
  const SW = 700;                                        // 降采样宽度（速度与精度折中）
  const s = SW / tabImg.naturalWidth;                    // 采样比例
  const sh = Math.round(tabImg.naturalHeight * s);

  const cv = document.createElement('canvas');
  cv.width = SW;
  cv.height = sh;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(tabImg, 0, 0, SW, sh);
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
    const y1 = Math.min(tabImg.naturalHeight, Math.round(b / s + PAD_BOT));
    const ext = xExtent(Math.round(a / s), Math.round(b / s));
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
  for (const b of fin) b.bars = detectBarCount(b);
  return fin;
}

/**
 * 检测某一行的小节数：在谱线高度范围内做垂直投影找竖线。
 * 判据：列暗像素覆盖 ≥88% 谱线高度，且谱线下沿外延伸 ≤9px
 * （音符符杆会明显伸出谱线外，小节线不会；据此排除符杆误检）。
 */
function detectBarCount(b) {
  const top = b.sTop;
  const bot = b.sBot;
  const h = bot - top + 1;
  if (h < 10) return 4;

  const cv = document.createElement('canvas');
  const m = 8;                                          // 上下留边，便于检测"延伸"
  cv.width = tabImg.naturalWidth;
  cv.height = h + m * 2;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(tabImg, 0, top - m, tabImg.naturalWidth, cv.height, 0, 0, cv.width, cv.height);
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
function xExtent(y0, y1) {
  const s = 700 / tabImg.naturalWidth;
  const cv = document.createElement('canvas');
  cv.width = 700;
  cv.height = Math.max(1, Math.round((y1 - y0) * s));
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(tabImg, 0, y0, tabImg.naturalWidth, y1 - y0, 0, 0, 700, cv.height);
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
    return [Math.round(tabImg.naturalWidth * 0.06), Math.round(tabImg.naturalWidth * 0.94)];
  }
  return [Math.round(minX / s), Math.round(maxX / s)];
}

/* ---------------------------------------------------------------- 手动框行 */

$('btnManual').onclick = () => {
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
      const ext = xExtent(Math.round(a), Math.round(b));
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
    if (bi >= 0) seek(bi);
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

  el.innerHTML = bands.map((b, i) =>
    '<div class="bandItem" data-i="' + i + '">' +
    '<b>行 ' + (i + 1) + '</b>' +
    '<span class="lbl">小节</span><input type="number" min="1" max="16" value="' + b.bars + '" data-bars="' + i + '" aria-label="第 ' + (i + 1) + ' 行小节数">' +
    '<button class="del" data-del="' + i + '" title="删除该行" aria-label="删除第 ' + (i + 1) + ' 行">✕</button>' +
    '</div>').join('');

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
      renderBandList();
    };
  });

  el.querySelectorAll('.bandItem').forEach((it) => {
    it.onclick = () => seek(+it.dataset.i);
  });

  drawBands();
}

/** 在图上绘制谱行覆盖层（半透明框，便于核对识别结果） */
function drawBands() {
  imgWrap.querySelectorAll('.band').forEach((n) => n.remove());
  for (const b of bands) {
    const d = document.createElement('div');
    d.className = 'band';
    d.style.top = b.y0 + 'px';
    d.style.left = b.x0 + 'px';
    d.style.width = (b.x1 - b.x0) + 'px';
    d.style.height = (b.y1 - b.y0) + 'px';
    imgWrap.appendChild(d);
  }
}

/* ------------------------------------------------------------------ 时间轴 */

/** 某一行的时长（ms）= 小节数 × 每小节拍数 × 一拍时长 */
function bandDur(b) {
  return (b.bars * parseInt($('bpb').value, 10) * 60000) / parseInt($('bpm').value, 10);
}

/** 全曲总时长（ms） */
function totalDur() {
  return bands.reduce((s, b) => s + bandDur(b), 0);
}

/**
 * 音乐时间(ms) → 位置信息
 * @returns {{band:number, bar:number, p:number, g:number}|null}
 *   band 行索引、bar 行内小节索引、p 行内进度(0–1)、g 全曲进度(0–1)
 */
function locate(t) {
  let acc = 0;
  for (let i = 0; i < bands.length; i++) {
    const d = bandDur(bands[i]);
    if (t < acc + d || i === bands.length - 1) {
      const p = Math.max(0, Math.min(1, (t - acc) / d));
      return {
        band: i,
        bar: Math.min(bands[i].bars - 1, Math.floor(p * bands[i].bars)),
        p,
        g: t / Math.max(1, totalDur()),
      };
    }
    acc += d;
  }
  return null;
}

/** 当前音乐时间（ms）：暂停前的累计 + 本次恢复后按倍速推进的时间 */
function musicNow() {
  return elapsedBase + (performance.now() - t0) * rate;
}

/* -------------------------------------------------------------------- 播放 */

/** 开始/继续跟随 */
function play() {
  if (!bands.length) { setHint('请先识别或手动框选谱行'); return; }
  if (playing && !paused) return;
  if (paused) { resume(); return; }
  start(0);
}

/** 从头或指定行开始播放 */
function start(fromBand) {
  stop(false);
  if (metro) {
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
  }
  elapsedBase = bands.slice(0, fromBand).reduce((s, b) => s + bandDur(b), 0);
  t0 = performance.now();
  lastBeat = -1;
  playing = true;
  paused = false;
  timer = setInterval(tick, 40);
  setLed('ok', '图片谱跟随中');
  setHint('跟随中：红色框 = 当前小节，右下放大镜实时放大。点击任意行可跳转。');
  $('btnPlay').textContent = '▶ 跟随中…';
}

/** 暂停（保留当前位置） */
function pause() {
  if (!playing || paused) return;
  elapsedBase = musicNow();
  paused = true;
  setLed('warn', '已暂停');
}

/** 从暂停处继续 */
function resume() {
  paused = false;
  t0 = performance.now();
  setLed('ok', '图片谱跟随中');
}

/** 跳转到指定行；未播放时仅做位置预览 */
function seek(bandIdx) {
  if (!bands.length) return;
  if (playing || paused) {
    start(bandIdx);
    return;
  }
  showPosition(bandIdx, 0);
  elapsedBase = bands.slice(0, bandIdx).reduce((s, b) => s + bandDur(b), 0);
  $('bandNum').textContent = (bandIdx + 1) + ' / ' + bands.length;
}

/** 停止播放。reset 为 true 时回到起点并清空状态灯 */
function stop(reset = true) {
  if (timer) clearInterval(timer);
  timer = null;
  playing = false;
  paused = false;
  curBand = curBar = -1;
  barBox.style.display = 'none';
  scanline.style.display = 'none';
  $('btnPlay').textContent = '▶ 开始跟随';
  if (reset) {
    elapsedBase = 0;
    setLed('', '待机');
  }
}

$('btnPlay').onclick = play;
$('btnPause').onclick = pause;
$('btnStop').onclick = () => stop();
$('btnClear').onclick = () => {
  bands = [];
  stop();
  renderBandList();
  setLed('', '待机');
  setHint('已清空谱行，请重新加载谱图或识别谱行');
};

/* ------------------------------------------------------------ 视图与交互 */

/** 速度滑杆：写入设置，由设置模块统一分发 */
$('rate').oninput = (e) => {
  window.TPSettings.set('rate', parseInt(e.target.value, 10));
};

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
  const t = musicNow();
  if (t >= totalDur()) {
    stop();
    setLed('ok', '已播完');
    return;
  }
  const loc = locate(t);
  if (!loc) return;
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

  // 小节框：行内按小节数均分
  const w = (b.x1 - b.x0) / b.bars;
  const x = b.x0 + barIdx * w;
  barBox.style.display = 'block';
  barBox.style.left = x + 'px';
  barBox.style.top = b.y0 + 'px';
  barBox.style.width = w + 'px';
  barBox.style.height = (b.y1 - b.y0) + 'px';

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
  $('barNum').textContent = (barIdx + 1) + ' / ' + b.bars;

  document.querySelectorAll('.bandItem').forEach((it, i) => it.classList.toggle('cur', i === bandIdx));

  if (magOn) drawMag(x, b.y0, w, b.y1 - b.y0);
}

/* ------------------------------------------------------ 放大镜（光栅放大） */

/**
 * 把当前小节区域绘制到放大镜 canvas 上。
 * 图片没有矢量信息，直接按源区域缩放绘制（cover 适配，保持比例铺满）。
 */
function drawMag(x, y, w, h) {
  const cv = $('magCanvas');
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  if (!tabImg.naturalWidth) return;

  const padY = h * 0.25;
  const sx = Math.max(0, x - w * 0.1);
  const sy = Math.max(0, y - padY);
  const sw = Math.min(tabImg.naturalWidth - sx, w * 1.2);
  const sh = h + padY * 2;

  const sAsp = sw / sh;
  const cAsp = cv.width / cv.height;
  let dw, dh;
  if (sAsp > cAsp) { dw = cv.width; dh = cv.width / sAsp; }
  else { dh = cv.height; dw = cv.height * sAsp; }

  ctx.drawImage(tabImg, sx, sy, sw, sh, (cv.width - dw) / 2, (cv.height - dh) / 2, dw, dh);

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

  magOn = !!s.magnifier;
  $('btnMag').classList.toggle('active', magOn);
  $('magnifier').classList.toggle('on', magOn);

  $('hint').style.display = s.showHints ? '' : 'none';
}

/* ---------------------------------------------------------------- 启动 */

window.addEventListener('DOMContentLoaded', () => {
  window.TPSettings.mount();
  window.TPSettings.onChange(applySettings);
  applySettings(window.TPSettings.all());
  layout();
});
