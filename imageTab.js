/* ============================================================
 * 谱领航 TabPilot · 图片谱跟随
 * 原理：谱图无坐标信息 → 半自动校准（自动投影识别谱行 + 手动修正）
 *       → 时间轴按 BPM×每行小节数展开 → 行内小节均分高亮
 *       → canvas 放大镜实时放大当前小节（光栅图，无字体问题）
 * ============================================================ */
'use strict';

const $ = (id) => document.getElementById(id);
const stage = $('stage'), imgWrap = $('imgWrap'), tabImg = $('tabImg');
const barBox = $('barBox'), scanline = $('scanline');

/* ---------------- 状态 ---------------- */
let bands = [];        // { y0, y1, x0, x1, bars } 图片像素坐标
let manualMode = false, manualPts = [];
let playing = false, paused = false;
let elapsedBase = 0;   // 暂停前累计的"音乐时间"(ms)
let t0 = 0;            // 本次恢复的 wallclock 起点
let rate = 1.0;
let timer = null;
let curBand = -1, curBar = -1;
let zoomLevel = 1.0;
let magOn = true;
let metro = false, ac = null, lastBeat = -1;

/* ---------------- 节拍器 ---------------- */
$('btnMetro').onclick = () => {
  metro = !metro;
  $('btnMetro').classList.toggle('active', metro);
  if (metro) {
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
  }
};
function clickTick(accent) {
  if (!metro || !ac) return;
  try {
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = accent ? 1200 : 750;
    g.gain.setValueAtTime(0.0001, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(accent ? 0.45 : 0.28, ac.currentTime + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.07);
    o.connect(g); g.connect(ac.destination);
    o.start(); o.stop(ac.currentTime + 0.09);
  } catch (e) { /* noop */ }
}

/* ---------------- 工具 ---------------- */
function setLed(cls, text) {
  $('led').className = 'led' + (cls ? ' ' + cls : '');
  $('modeText').textContent = text;
}
function setHint(t) { $('hint').textContent = t; }

/* ---------------- 日志（autotest 用） ---------------- */
const logs = [];
function log(s) {
  logs.push(s);
  const el = $('testlog');
  if (el) {
    el.innerHTML = logs.map((l) => '<div>' + l + '</div>').join('');
    el.scrollTop = el.scrollHeight;
  }
}

/* ---------------- 图片加载 ---------------- */
$('btnLoad').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => loadImage(r.result);
  r.readAsDataURL(f);
};
$('btnDemo').onclick = () => loadImage('demo-xihn.jpg');

function loadImage(src) {
  tabImg.onload = () => {
    bands = [];
    stop();
    layout();
    renderBandList();
    setLed('', '图片已加载');
    setHint('点「🤖 自动识别谱行」识别谱面行，或「✌️ 手动框行」逐行框选');
    log('img loaded: ' + tabImg.naturalWidth + 'x' + tabImg.naturalHeight);
  };
  tabImg.src = src;
}

/* 图片缩放：容器宽度自适应 + zoomLevel（zoom 影响布局，子覆盖层随缩放） */
function layout() {
  const w = stage.clientWidth - 16;
  const scale = Math.min(1, w / tabImg.naturalWidth) * zoomLevel;
  imgWrap.style.zoom = scale;
  imgWrap.style.width = tabImg.naturalWidth + 'px';
  stage.scrollTo(0, 0);
}
window.addEventListener('resize', layout);

/* ---------------- 谱行识别（水平投影法） ---------------- */
$('btnDetect').onclick = () => {
  if (!tabImg.naturalWidth) { setHint('请先加载谱图'); return; }
  bands = detectBands();
  renderBandList();
  setLed('ok', '已识别 ' + bands.length + ' 行');
  setHint('检查右侧行列表：可删除误检行、修改每行小节数，然后点「▶ 开始跟随」');
  log('detect: ' + bands.length + ' bands');
};

function detectBands() {
  // 降采样绘制到离屏 canvas，做水平暗像素投影
  const SW = 700;
  const s = SW / tabImg.naturalWidth;
  const sh = Math.round(tabImg.naturalHeight * s);
  const cv = document.createElement('canvas');
  cv.width = SW; cv.height = sh;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(tabImg, 0, 0, SW, sh);
  const d = ctx.getImageData(0, 0, SW, sh).data;
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
  // 1) 只取高置信"谱线行"（实线横贯画面，占比 >0.5；文字/和弦图/简谱达不到）
  const LINE_TH = 0.5;
  const segs = [];
  let start = -1;
  for (let y = 0; y < sh; y++) {
    if (dark[y] > LINE_TH) { if (start < 0) start = y; }
    else if (start >= 0) { segs.push([start, y]); start = -1; }
  }
  if (start >= 0) segs.push([start, sh]);
  // 2) 近邻谱线聚类成谱行系统：六线谱 6 条线的间距 << 系统间距
  const GAP = 22 / s;          // 同一谱行内线的最大间距（原始像素 ~38px）
  const clusters = [];
  for (const sg of segs) {
    const last = clusters[clusters.length - 1];
    if (last && sg[0] - last[1] < GAP) { last[1] = sg[1]; last[2]++; }
    else clusters.push([sg[0], sg[1], 1]);
  }
  // 3) 过滤：谱行至少含 3 条线、跨度合理（sTop/sBot = 谱线实际上下边界，供小节线检测用）
  const out = [];
  const PAD_TOP = 40 / s, PAD_BOT = 62 / s;
  for (const [a, b, n] of clusters) {
    if (n < 3 || (b - a) > 90 / s) continue;
    const y0 = Math.max(0, Math.round(a / s - PAD_TOP));
    const y1 = Math.min(tabImg.naturalHeight, Math.round(b / s + PAD_BOT));
    const ext = xExtent(Math.round(a / s), Math.round(b / s));
    out.push({ y0, y1, x0: ext[0], x1: ext[1], bars: 4, sTop: Math.round(a / s), sBot: Math.round(b / s) });
  }
  // 4) 兜底：重叠簇合并
  const fin = [];
  for (const b of out) {
    const last = fin[fin.length - 1];
    if (last && b.y0 < last.y1 - 10) last.y1 = Math.max(last.y1, b.y1);
    else fin.push(b);
  }
  // 5) 每行小节数：检测竖直小节线
  for (const b of fin) b.bars = detectBarCount(b);
  log('proj diag: segs=' + segs.length + ' clusters=' + clusters.length +
      ' peaks=[' + clusters.slice(0, 8).map((c) => c[2] + 'L').join(',') + ']');
  return fin;
}

/* 小节线检测：谱行区域内做垂直投影。
 * 判据：列暗像素覆盖 ≥88% 谱线高度，且谱线上下沿外 2~5px 无延伸
 * （音符符杆会伸出到梁上/梁下，小节线只在谱线范围内）→ 排除符杆误检 */
function detectBarCount(b) {
  const top = b.sTop, bot = b.sBot;
  const h = bot - top + 1;
  if (h < 10) return 4;
  const cv = document.createElement('canvas');
  const m = 8; // 上下边距
  cv.width = tabImg.naturalWidth;
  cv.height = h + m * 2;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(tabImg, 0, top - m, tabImg.naturalWidth, cv.height, 0, 0, cv.width, cv.height);
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
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
  // 候选列：谱线内高覆盖。符杆排除：测量谱线下沿外的暗色延伸长度，
  // 小节线即使触梁延伸也 ≤9px（梁厚），符杆延伸到梁 >9px
  const cand = new Uint8Array(cv.width);
  const LUM = (x, y) => {
    if (x < 0 || x >= cv.width || y < 0 || y >= cv.height) return 255;
    const i = (y * cv.width + x) * 4;
    return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  };
  for (let x = 0; x < cv.width; x++) {
    if (cov[x] < 0.88) continue;
    let tail = 0;
    for (let y = m + h + 1; y < m + h + 42; y++) {   // 下沿外延伸长度
      if (LUM(x - 1, y) < 170 || LUM(x, y) < 170 || LUM(x + 1, y) < 170) tail++;
      else break;
    }
    if (tail <= 9) cand[x] = 1;
  }
  // 相邻候选列分组 = 一根小节线；宽度>5 的是文字块，丢弃
  const raw = [];
  let x0 = -1;
  for (let x = 0; x <= cv.width; x++) {
    if (x < cv.width && cand[x]) { if (x0 < 0) x0 = x; }
    else if (x0 >= 0) {
      if (x - x0 <= 5) raw.push(Math.round((x0 + x - 1) / 2));
      x0 = -1;
    }
  }
  // 合并 <20px 的相邻竖线（谱首括线+起始线、反复双竖线 = 一个边界）
  const lines = [];
  for (const x of raw) {
    if (lines.length && x - lines[lines.length - 1] < 20) lines[lines.length - 1] = Math.round((lines[lines.length - 1] + x) / 2);
    else lines.push(x);
  }
  // 限制在谱线 x 范围内
  const inRange = lines.filter((x) => x >= b.x0 - 6 && x <= b.x1 + 6);
  const bars = inRange.length - 1;
  return bars >= 1 && bars <= 16 ? bars : 4;
}

/* 求某行区域里暗像素的水平范围（= 谱线左右边界） */
function xExtent(y0, y1) {
  const s = 700 / tabImg.naturalWidth;
  const cv = document.createElement('canvas');
  cv.width = 700; cv.height = Math.max(1, Math.round((y1 - y0) * s));
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(tabImg, 0, y0, tabImg.naturalWidth, y1 - y0, 0, 0, 700, cv.height);
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let minX = cv.width, maxX = 0;
  for (let y = 0; y < cv.height; y++) {
    for (let x = 0; x < cv.width; x++) {
      const i = (y * cv.width + x) * 4;
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum < 170) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
    }
  }
  if (minX >= maxX) return [Math.round(tabImg.naturalWidth * 0.06), Math.round(tabImg.naturalWidth * 0.94)];
  return [Math.round(minX / s), Math.round(maxX / s)];
}

/* ---------------- 手动框行 ---------------- */
$('btnManual').onclick = () => {
  manualMode = !manualMode;
  manualPts = [];
  $('btnManual').classList.toggle('active', manualMode);
  $('tipManual').style.display = manualMode ? 'block' : 'none';
  $('manualStep').textContent = '1';
};
tabImg.addEventListener('click', (e) => {
  const r = tabImg.getBoundingClientRect();
  const y = (e.clientY - r.top) / r.height * tabImg.naturalHeight;
  if (manualMode) {
    manualPts.push(y);
    $('manualStep').textContent = manualPts.length + 1;
    if (manualPts.length === 2) {
      const [a, b] = manualPts.sort((p, q) => p - q);
      const ext = xExtent(Math.round(a), Math.round(b));
      bands.push({ y0: Math.round(a), y1: Math.round(b), x0: ext[0], x1: ext[1], bars: 4 });
      bands.sort((p, q) => p.y0 - q.y0);
      manualPts = [];
      $('manualStep').textContent = '1';
      renderBandList();
      log('manual band added @' + Math.round(a));
    }
  } else if (bands.length) {
    // 点击行 = 从该行开始播放
    const bi = bands.findIndex((b) => y >= b.y0 && y <= b.y1);
    if (bi >= 0) seek(bi);
  }
});

/* ---------------- 谱行列表渲染 ---------------- */
function renderBandList() {
  const el = $('bandList');
  if (!bands.length) {
    el.innerHTML = '<div class="tip">加载图片后点「自动识别谱行」，或用「手动框行」在图上依次点击行的上、下边界。</div>';
    drawBands();
    return;
  }
  el.innerHTML = bands.map((b, i) =>
    '<div class="bandItem" data-i="' + i + '">' +
    '<b>行 ' + (i + 1) + '</b>' +
    '<span class="lbl">小节</span><input type="number" min="1" max="16" value="' + b.bars + '" data-bars="' + i + '">' +
    '<button class="del" data-del="' + i + '">✕</button></div>').join('');
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

/* 谱行覆盖层 */
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

/* ---------------- 时间轴与播放 ---------------- */
function bandDur(b) { return b.bars * parseInt($('bpb').value) * 60000 / parseInt($('bpm').value); }
function totalDur() { return bands.reduce((s, b) => s + bandDur(b), 0); }

/* 音乐时间(ms) → { band, bar, bandProgress, globalProgress } */
function locate(t) {
  let acc = 0;
  for (let i = 0; i < bands.length; i++) {
    const d = bandDur(bands[i]);
    if (t < acc + d || i === bands.length - 1) {
      const p = Math.max(0, Math.min(1, (t - acc) / d));
      return { band: i, bar: Math.min(bands[i].bars - 1, Math.floor(p * bands[i].bars)), p, g: t / Math.max(1, totalDur()) };
    }
    acc += d;
  }
  return null;
}

function musicNow() { return elapsedBase + (performance.now() - t0) * rate; }

$('btnPlay').onclick = () => {
  if (!bands.length) { setHint('请先识别或手动框选谱行'); return; }
  if (playing && !paused) return;
  if (paused) { resume(); return; }
  start(0);
};
$('btnPause').onclick = () => {
  if (!playing || paused) return;
  elapsedBase = musicNow();
  paused = true;
  setLed('warn', '已暂停');
};
function resume() {
  paused = false;
  t0 = performance.now();
  setLed('ok', '图片谱跟随中');
}
function start(fromBand) {
  stop(false);
  if (metro) {
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
  }
  elapsedBase = bands.slice(0, fromBand).reduce((s, b) => s + bandDur(b), 0);
  t0 = performance.now();
  lastBeat = -1;
  playing = true; paused = false;
  timer = setInterval(tick, 40);
  setLed('ok', '图片谱跟随中');
  setHint('跟随中：红色框 = 当前小节，右下放大镜实时放大。点击任意行可跳转。');
  $('btnPlay').textContent = '▶ 跟随中…';
}
function seek(bandIdx) {
  if (!bands.length) return;
  if (playing || paused) { start(bandIdx); }
  else {
    // 未播放时也显示位置预览
    showPosition(bandIdx, 0);
    elapsedBase = bands.slice(0, bandIdx).reduce((s, b) => s + bandDur(b), 0);
    $('bandNum').textContent = (bandIdx + 1) + ' / ' + bands.length;
  }
}
function stop(reset = true) {
  if (timer) clearInterval(timer);
  timer = null;
  playing = false; paused = false;
  curBand = curBar = -1;
  barBox.style.display = 'none';
  scanline.style.display = 'none';
  $('btnPlay').textContent = '▶ 开始跟随';
  if (reset) { elapsedBase = 0; setLed('', '待机'); }
  $('btnPlay').onclick = () => {
    if (!bands.length) { setHint('请先识别或手动框选谱行'); return; }
    start(0);
  };
}
$('btnStop').onclick = () => stop();

$('rate').oninput = (e) => {
  const nr = e.target.value / 100;
  if (playing && !paused) { elapsedBase = musicNow(); t0 = performance.now(); }
  rate = nr;
  $('rateVal').textContent = rate.toFixed(1) + 'x';
};
$('bpm').onchange = drawBands;

$('btnMag').onclick = () => {
  magOn = !magOn;
  $('btnMag').classList.toggle('active', magOn);
  $('magnifier').classList.toggle('on', magOn && playing);
};

/* 缩放：ctrl+滚轮 或 双击切换（MVP：双击 100%↔适应宽） */
tabImg.addEventListener('dblclick', () => {
  zoomLevel = zoomLevel === 1.0 ? 1.6 : 1.0;
  layout(); drawBands();
});

/* ---------------- 每帧渲染 ---------------- */
function tick() {
  if (!playing || paused) return;
  const t = musicNow();
  if (t >= totalDur()) { stop(); setLed('ok', '已播完'); return; }
  const loc = locate(t);
  showPosition(loc.band, loc.bar, loc.p);
  $('elapsed').textContent = (t / 1000).toFixed(1) + 's';
  // 节拍器：稳定 BPM 下全局拍号对拍数取模即可
  const beatMs = 60000 / parseInt($('bpm').value);
  const beat = Math.floor(t / beatMs);
  if (beat !== lastBeat) {
    lastBeat = beat;
    clickTick(beat % parseInt($('bpb').value) === 0);
  }
}

function showPosition(bandIdx, barIdx, p = 0) {
  const b = bands[bandIdx];
  if (!b) return;
  curBand = bandIdx; curBar = barIdx;
  // 小节框：行内 x 均分
  const w = (b.x1 - b.x0) / b.bars;
  const x = b.x0 + barIdx * w;
  barBox.style.display = 'block';
  barBox.style.left = x + 'px';
  barBox.style.top = b.y0 + 'px';
  barBox.style.width = w + 'px';
  barBox.style.height = (b.y1 - b.y0) + 'px';
  // 行内扫描线（行内进度）
  scanline.style.display = 'block';
  scanline.style.top = (b.y1 - 2) + 'px';
  scanline.style.left = b.x0 + 'px';
  scanline.style.width = (b.x1 - b.x0) + 'px';
  // 自动滚动：当前行滚到视口中上部
  const scale = imgWrap.getBoundingClientRect().width / tabImg.naturalWidth;
  const targetY = (b.y0 * scale) - stage.clientHeight * 0.3;
  if (Math.abs(stage.scrollTop - targetY) > 8) stage.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
  // 状态
  $('bandNum').textContent = (bandIdx + 1) + ' / ' + bands.length;
  $('barNum').textContent = (barIdx + 1) + ' / ' + b.bars;
  // 高亮列表项
  document.querySelectorAll('.bandItem').forEach((it, i) => it.classList.toggle('cur', i === bandIdx));
  // 放大镜
  if (magOn) drawMag(x, b.y0, w, b.y1 - b.y0);
}

/* ---------------- 放大镜（canvas 光栅放大） ---------------- */
function drawMag(x, y, w, h) {
  const cv = $('magCanvas'), ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  if (!tabImg.naturalWidth) return;
  // 源区域：当前小节 + 上下扩展一点，保持比例铺满画布
  const padY = h * 0.25;
  const sx = Math.max(0, x - w * 0.1);
  const sy = Math.max(0, y - padY);
  const sw = Math.min(tabImg.naturalWidth - sx, w * 1.2);
  const sh = h + padY * 2;
  // cover 适配
  const sAsp = sw / sh, cAsp = cv.width / cv.height;
  let dw, dh;
  if (sAsp > cAsp) { dw = cv.width; dh = cv.width / sAsp; }
  else { dh = cv.height; dw = cv.height * sAsp; }
  ctx.drawImage(tabImg, sx, sy, sw, sh, (cv.width - dw) / 2, (cv.height - dh) / 2, dw, dh);
  // 中心参考线
  ctx.strokeStyle = 'rgba(225,29,72,.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cv.width / 2, 0); ctx.lineTo(cv.width / 2, cv.height);
  ctx.stroke();
}

/* ---------------- 自检（?autotest=1）/ 演示（?demo=1） ---------------- */
async function loadDemo() {
  await new Promise((r) => { tabImg.onload = () => r(); tabImg.src = 'demo-xihn.jpg'; });
  bands = detectBands();
  renderBandList();
  log('img ok: ' + tabImg.naturalWidth + 'x' + tabImg.naturalHeight + ', bands=' + bands.length);
}

async function autotest() {
  log('autotest start');
  $('testlog').style.display = 'block';
  await loadDemo();
  log('bands=' + bands.length + (bands.length >= 3 && bands.length <= 10 ? ' PASS' : ' FAIL(expect 3~10)'));
  log('bars per band=[' + bands.map((b) => b.bars).join(',') + '] (auto-detected)');
  if (!bands.length) {
    // 兜底：人工注入 4 行（均匀切分）以便继续验证播放链路
    const H = tabImg.naturalHeight;
    for (let i = 0; i < 4; i++) {
      const y0 = Math.round(H * (0.14 + i * 0.22));
      bands.push({ y0, y1: y0 + Math.round(H * 0.16), x0: 60, x1: tabImg.naturalWidth - 60, bars: 4 });
    }
    log('fallback bands injected: ' + bands.length);
  }
  bands.forEach((b, i) => log('band' + i + ': y=' + b.y0 + '-' + b.y1 + ' x=' + b.x0 + '-' + b.x1 + ' bars=' + b.bars));
  renderBandList();
  // 播放 5 秒，观察推进
  start(0);
  const t0 = performance.now();
  let lastBar = -1, advanced = 0, n = 0;
  while (performance.now() - t0 < 5000) {
    await new Promise((r) => setTimeout(r, 400));
    const shown = $('barNum').textContent;
    const total = parseInt(String(shown).split('/')[0]) || 0;
    if (total > lastBar) { advanced++; lastBar = total; }
    log('t=' + ((performance.now() - t0) / 1000).toFixed(1) + 's band=' + $('bandNum').textContent +
        ' bar=' + shown + ' magOn=' + $('magnifier').classList.contains('on'));
    n++;
  }
  log('playback advanced ' + advanced + '/' + n + ' ticks' + (advanced >= 2 ? ' PASS' : ' FAIL'));
  // 放大镜绘制检查
  try {
    drawMag(100, bands[0].y0, 200, bands[0].y1 - bands[0].y0);
    const px = $('magCanvas').getContext('2d').getImageData(400, 190, 1, 1).data;
    log('magnifier center px=' + px.join(',') + (px[3] > 0 ? ' PASS' : ' FAIL'));
  } catch (e) { log('magnifier FAIL: ' + e.message); }
  stop();
  log('autotest done');
}

/* ---------------- 启动 ---------------- */
window.addEventListener('DOMContentLoaded', () => {
  $('magnifier').classList.add('on');
  if (location.search.includes('autotest=1')) autotest();
  else if (location.search.includes('demo=1')) {
    loadDemo().then(() => { if (bands.length) start(0); });
  }
});
