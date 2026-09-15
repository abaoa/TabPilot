'use strict';
/* ============================================================
 * 谱领航 TabPilot 原型
 *  - alphaTab 渲染吉他谱（alphaTex 内置演示曲）
 *  - BPM 滚动 / 麦克风实时跟随(OTW-lite) / 模拟演奏跟随
 * ============================================================ */

const $ = (id) => document.getElementById(id);

/* ---------------- 演示曲（alphaTex） ---------------- */
const SONGS = [
  {
    id: 'twinkle',
    name: '小星星 · 旋律（含变速段）',
    tex:
      '\\title "小星星 · 跟随演示" \\tempo 100 .\n' +
      ':4 1.2.4 1.2.4 8.2.4 8.2.4 | 10.2.4 10.2.4 8.2.2 | ' +
      '6.2.4 6.2.4 5.2.4 5.2.4 | 3.2.4 3.2.4 1.2.2 |\n' +
      '\\tempo 130\n' +
      ':4 8.2.4 8.2.4 6.2.4 6.2.4 | 5.2.4 5.2.4 3.2.2 | ' +
      '8.2.4 8.2.4 6.2.4 6.2.4 | 5.2.4 5.2.4 3.2.2 |\n' +
      '\\tempo 100\n' +
      ':4 1.2.4 1.2.4 8.2.4 8.2.4 | 10.2.4 10.2.4 8.2.2 | ' +
      '6.2.4 6.2.4 5.2.4 5.2.4 | 3.2.4 3.2.4 1.2.2',
  },
  {
    id: 'chords',
    name: '和弦跟弹 · Am-F-C-G（弹唱演示）',
    tex:
      '\\title "和弦跟弹 · Am F C G" \\tempo 90 .\n' +
      // Am
      ':4 (0.1 1.2 2.3 2.4 0.5).4 (0.1 1.2 2.3 2.4 0.5).4 (0.1 1.2 2.3 2.4 0.5).4 (0.1 1.2 2.3 2.4 0.5).4 |\n' +
      // F
      ':4 (1.1 1.2 2.3 3.4 3.5 1.6).4 (1.1 1.2 2.3 3.4 3.5 1.6).4 (1.1 1.2 2.3 3.4 3.5 1.6).4 (1.1 1.2 2.3 3.4 3.5 1.6).4 |\n' +
      // C
      ':4 (0.1 1.2 0.3 2.4 3.5).4 (0.1 1.2 0.3 2.4 3.5).4 (0.1 1.2 0.3 2.4 3.5).4 (0.1 1.2 0.3 2.4 3.5).4 |\n' +
      // G
      ':4 (3.1 3.2 0.3 0.4 2.5 3.6).4 (3.1 3.2 0.3 0.4 2.5 3.6).4 (3.1 3.2 0.3 0.4 2.5 3.6).4 (3.1 3.2 0.3 0.4 2.5 3.6).4 |\n' +
      '\\tempo 110\n' +
      ':4 (0.1 1.2 2.3 2.4 0.5).4 (0.1 1.2 2.3 2.4 0.5).4 (0.1 1.2 2.3 2.4 0.5).4 (0.1 1.2 2.3 2.4 0.5).4 |\n' +
      ':4 (1.1 1.2 2.3 3.4 3.5 1.6).4 (1.1 1.2 2.3 3.4 3.5 1.6).4 (1.1 1.2 2.3 3.4 3.5 1.6).4 (1.1 1.2 2.3 3.4 3.5 1.6).4 |\n' +
      ':4 (0.1 1.2 0.3 2.4 3.5).4 (0.1 1.2 0.3 2.4 3.5).4 (0.1 1.2 0.3 2.4 3.5).4 (0.1 1.2 0.3 2.4 3.5).4 |\n' +
      ':4 (3.1 3.2 0.3 0.4 2.5 3.6).4 (3.1 3.2 0.3 0.4 2.5 3.6).4 (3.1 3.2 0.3 0.4 2.5 3.6).4 (3.1 3.2 0.3 0.4 2.5 3.6).4',
  },
];

/* ---------------- 全局状态 ---------------- */
const TPQ = 960; // alphaTab ticks per quarter note

let api = null;               // AlphaTabApi
let ref = { beats: [], barStartMs: [], chroma: [], times: [] };
let engine = null;            // { stop(), name }
let walkerInst = null;
let mic = null;               // { ctx, analyser, buf, stream }
let lastZoom = 1.0;

/* ---------------- 初始化 alphaTab ---------------- */
function initTab() {
  if (!window.alphaTab) {
    showFallback('alphaTab 脚本加载失败（需要联网访问 CDN），请检查网络后刷新。');
    return;
  }
  try {
    api = new alphaTab.AlphaTabApi($('alphatab'), {
      core: {
        // 渲染走主线程：规避部分环境下渲染 worker 静默失联的问题，
        // 且 headless 自检更稳定（谱面不大，主线程渲染耗时可忽略）
        useWorkers: false,
      },
      player: {
        enablePlayer: true,
        enableCursor: true,
        enableAutoScroll: true,
        soundFont: 'vendor/sonivox.sf3',
      },
      display: { zoom: 1.0 },
    });
  } catch (e) {
    console.error(e);
    showFallback('alphaTab 初始化失败：' + e.message);
    return;
  }
  api.scoreLoaded.on((score) => buildReference(score));
  // 点击谱面重定位：跟随模式下直接跳到点击的 beat
  try {
    api.beatMouseDown.on((args) => {
      const beat = args && args.beat ? args.beat : args;
      if (!beat || !ref.beats.length || !engine) return;
      let idx = ref.beats.indexOf(beat);
      if (idx < 0) {
        // 点到休止符等未入列表的 beat：退到其所在小节的首拍
        const mbi = beat.voice && beat.voice.bar && beat.voice.bar.masterBar
          ? beat.voice.bar.masterBar.index : 0;
        idx = ref.beats.findIndex((b) => b._mbIndex >= mbi);
      }
      if (idx >= 0 && engine.seek) engine.seek(idx);
    });
  } catch (e) { console.warn('beatMouseDown attach failed', e); }
  if (location.search.indexOf('autotest') >= 0) {
    const log = (m) => {
      const d = document.createElement('div');
      d.textContent = m;
      $('testlog').appendChild(d);
    };
    window.addEventListener('error', (e) => log('JS ERROR: ' + e.message + ' @' + (e.filename || '') + ':' + (e.lineno || '')));
    window.addEventListener('unhandledrejection', (e) => log('REJECTION: ' + e.reason));
    try {
      api.error.on((err) => log('alphaTab error: ' + JSON.stringify(err.detail || err)));
      api.renderStarted.on(() => log('renderStarted'));
      api.renderFinished.on(() => log('renderFinished'));
    } catch (e) { log('event attach fail: ' + e.message); }
  }
  loadSong(SONGS[0].id);
}

function showFallback(msg) {
  const f = $('fallback');
  f.style.display = 'flex';
  f.textContent = msg;
}

function loadSong(id) {
  ref = { beats: [], barStartMs: [], chroma: [], times: [], barCount: 0 };
  clearHighlight();
  const song = SONGS.find((s) => s.id === id);
  if (!api || !song) return;
  api.tex(song.tex);
}

/* ---------------- .gp / MusicXML / MIDI 文件导入 ---------------- */
function importFile(file) {
  if (!api || !file) return;
  stopEngine();
  const isText = /\.(musicxml|xml)$/i.test(file.name);
  const reader = new FileReader();
  reader.onload = () => {
    try {
      clearHighlight();
      api.load(reader.result); // scoreLoaded 事件会重建参考轨道
      const sel = $('song');
      let opt = sel.querySelector('option[value="__custom"]');
      if (!opt) {
        opt = document.createElement('option');
        opt.value = '__custom';
        sel.appendChild(opt);
      }
      opt.textContent = '📂 ' + file.name;
      sel.value = '__custom';
      setHint('已导入 ' + file.name + '，选择一种跟随模式即可开始');
    } catch (e) {
      console.error('import failed', e);
      setHint('导入失败：' + e.message);
    }
  };
  if (isText) reader.readAsText(file);
  else reader.readAsArrayBuffer(file);
}

/* ---------------- 参考轨道构建 ---------------- */
const DUR_TICKS = { 1: 3840, 2: 1920, 4: 960, 8: 480, 16: 240, 32: 120, 64: 60, 128: 30 };

function beatTicks(b) {
  const d = DUR_TICKS[b.duration] || 960;
  const dots = b.dots || 0;
  return d * (dots ? 2 - Math.pow(0.5, dots) : 1);
}

function barTicks(mb) {
  try {
    const ts = mb.timeSignature;
    return ts.numerator * (4 / ts.denominator) * TPQ;
  } catch (e) { return 3840; }
}

function buildReference(score) {
  try {
    const mbs = score.masterBars;
    // 小节起始 tick / 毫秒（累加法，避免依赖模型内部字段）
    const barStartTick = [], barStartMs = [];
    let tick = 0, ms = 0;
    for (let i = 0; i < mbs.length; i++) {
      const tempo = mbs[i].tempo || 120;
      barStartTick[i] = tick; barStartMs[i] = ms;
      const bt = barTicks(mbs[i]);
      tick += bt; ms += bt * 60000 / (tempo * TPQ);
    }
    // 遍历所有 beat 并赋 tick / 时间
    const beats = [];
    let domId = 0;
    for (const track of score.tracks) {
      for (const staff of track.staves) {
        for (const bar of staff.bars) {
          const mb = bar.masterBar;
          const tempo = mb.tempo || 120;
          for (const voice of bar.voices) {
            let off = 0;
            for (const b of voice.beats) {
              b._tick = barStartTick[mb.index] + off;
              b._mbIndex = mb.index;
              b._timeMs = barStartMs[mb.index] + off * 60000 / (tempo * TPQ);
              b._domId = domId++; // 渲染 DOM 中的顺序（含休止符）
              if (!b.isRest) beats.push(b);
              off += beatTicks(b);
            }
          }
        }
      }
    }
    beats.sort((a, b) => a._tick - b._tick || a._mbIndex - b._mbIndex);

    const chroma = [], times = [];
    for (const b of beats) {
      times.push(b._timeMs);
      chroma.push(beatChroma(b));
    }
    ref = { beats, barStartMs, chroma, times, barCount: mbs.length };
    console.log('[ref] beats:', beats.length, 'bars:', mbs.length,
      'lastMs:', times[times.length - 1]);
  } catch (e) {
    console.error('buildReference failed', e);
  }
}

function beatChroma(beat) {
  const c = new Float32Array(12);
  for (const n of beat.notes) {
    if (n.isDead || n.isTieDestination) continue;
    let midi = null;
    try { midi = n.realValue; } catch (e) { /* noop */ }
    if (midi == null || midi < 0) {
      // 兜底：fret + standard tuning(string1=64? alphaTab string1=high E = 64+? )
      // standard: string1 E4(64), 2 B3(59), 3 G3(55), 4 D3(50), 5 A2(45), 6 E2(40)
      const base = [64, 59, 55, 50, 45, 40];
      const st = n.string || 1;
      midi = (base[st - 1] || 0) + (n.fret || 0);
    }
    const pc = ((midi % 12) + 12) % 12;
    c[pc] += 1;
  }
  // L2 归一化
  let s = 0; for (const v of c) s += v * v;
  if (s > 0) { s = Math.sqrt(s); for (let i = 0; i < 12; i++) c[i] /= s; }
  return c;
}

function cosine(a, b) {
  let d = 0;
  for (let i = 0; i < 12; i++) d += a[i] * b[i];
  return d; // a、b 均已归一化
}

/* ---------------- 高亮 / 滚动 / 放大镜 ---------------- */
let hlEl = null;
let magOn = false;

function highlightIndex(i) {
  const b = ref.beats[i];
  if (!b || !api) return;
  try { api.tickPosition = b._tick; } catch (e) { /* noop */ }
  let bar = '-';
  try { bar = String(b._mbIndex + 1) + ' / ' + ref.barCount; } catch (e) {}
  $('barNum').textContent = bar;
  try { highlightDom(b); } catch (e) { /* noop */ }
}

/** 音符级红色高亮（锚定 alphaTab 渲染的 <g class="bN">） */
function highlightDom(b) {
  if (hlEl) { hlEl.classList.remove('at-hl'); hlEl = null; }
  let g = null;
  try { g = $('alphatab').querySelector('g.b' + b._domId); }
  catch (e) { console.error('highlightDom query failed', e); return; }
  if (g) { g.classList.add('at-hl'); hlEl = g; }
  updateMagnifier(g);
}

/** 放大镜：克隆当前行 SVG，缩放平移到当前 beat 中心 */
function updateMagnifier(g) {
  if (!magOn || !g) return;
  const rowSvg = g.ownerSVGElement;
  if (!rowSvg) return;
  let bb;
  try { bb = g.getBBox(); } catch (e) { return; }
  const mag = $('magnifier'), content = $('magContent');
  const scale = 2.4;
  const mw = content.clientWidth || 380, mh = content.clientHeight || 180;
  const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
  const clone = rowSvg.cloneNode(true);
  clone.removeAttribute('style');
  // 关键：字形 CSS 规则为 ".at-surface.at .at { font-family:'alphaTab' }"，
  // 克隆体不在 .at-surface 容器内，必须补上这两个 class，否则 PUA 字形全部回退成方块
  clone.setAttribute('class', 'at-surface-svg at-surface at');
  clone.style.position = 'absolute';
  clone.style.transformOrigin = '0 0';
  clone.style.transform =
    'translate(' + (mw / 2 - cx * scale) + 'px,' + (mh / 2 - cy * scale) + 'px) scale(' + scale + ')';
  content.innerHTML = '';
  content.appendChild(clone);
  // 高亮克隆体里的当前 beat
  try {
    const cg = clone.querySelector('g.b' + g.getAttribute('class').match(/b(\d+)/)[1]);
    if (cg) cg.classList.add('at-hl');
  } catch (e) { /* noop */ }
}

function clearHighlight() {
  if (hlEl) { hlEl.classList.remove('at-hl'); hlEl = null; }
  $('magContent').innerHTML = '';
}

function setLed(cls, modeText) {
  $('led').className = 'led ' + cls;
  $('modeText').textContent = modeText;
}

function setConf(v) {
  $('conf').style.width = Math.round(Math.max(0, Math.min(1, v)) * 100) + '%';
}

/* ---------------- 引擎 1：BPM 定速滚动 ---------------- */
class Walker {
  constructor(rate) {
    this.rate = rate;
    this.t0 = performance.now();
    this.lastIdx = -1;
    this.raf = null;
  }
  start() {
    this.t0 = performance.now();
    const loop = () => {
      const t = ((performance.now() - this.t0) / 1000) * this.rate * 1000;
      let i = Math.max(0, this.lastIdx);
      while (i + 1 < ref.times.length && ref.times[i + 1] <= t) i++;
      while (i > 0 && ref.times[i] > t) i--;
      if (i !== this.lastIdx && ref.beats.length) { this.lastIdx = i; highlightIndex(i); }
      $('speedVal').textContent = this.rate.toFixed(1) + 'x';
    };
    this.raf = requestAnimationFrame(loop);
    this.timer = setInterval(loop, 50); // rAF 兜底（headless/后台标签页 rAF 会冻结）
  }
  setRate(r) {
    const cur = ((performance.now() - this.t0) / 1000) * this.rate * 1000;
    this.t0 = performance.now() - (cur / r) * 1000;
    this.rate = r;
  }
  /** 跳转到第 i 拍（点击谱面重定位） */
  seek(i) {
    i = Math.max(0, Math.min(ref.times.length - 1, i));
    const t = ref.times[i];
    this.t0 = performance.now() - (t / this.rate);
    this.lastIdx = i;
    highlightIndex(i);
  }
  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.timer) clearInterval(this.timer);
  }
}

/* ---------------- 实时音源 ---------------- */
async function startMic() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 8192;
  analyser.smoothingTimeConstant = 0.35;
  src.connect(analyser);
  const buf = new Float32Array(analyser.frequencyBinCount);
  mic = { ctx, analyser, buf, stream, sr: ctx.sampleRate, fft: analyser.fftSize };
}

let micGate = -72;            // 噪声门（dB），灵敏度滑杆可调

function micChroma() {
  if (!mic) return null;
  mic.analyser.getFloatFrequencyData(mic.buf);
  const c = new Float32Array(12);
  const binHz = mic.sr / mic.fft;
  let peakDb = -Infinity;
  for (let k = 2; k < mic.buf.length; k++) {
    const db = mic.buf[k];
    if (db < micGate) continue;
    const f = k * binHz;
    if (f < 75 || f > 1400) continue;
    if (db > peakDb) peakDb = db;
    const midi = 69 + 12 * Math.log2(f / 440);
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    c[pc] += Math.pow(10, (db + 72) / 20);
  }
  // 输入电平表：有效频段峰值 dB 相对噪声门的余量
  if (isFinite(peakDb)) {
    const lvl = Math.max(0, Math.min(1, (peakDb - micGate) / 34));
    const el = $('lvl');
    if (el) el.style.width = (lvl * 100).toFixed(0) + '%';
  } else {
    const el = $('lvl');
    if (el) el.style.width = '0%';
  }
  let s = 0; for (const v of c) s += v * v;
  if (s > 0) { s = Math.sqrt(s); for (let i = 0; i < 12; i++) c[i] /= s; }
  return c;
}

/** 模拟演奏：沿参考轨道行进，带速度波动 + 偶发错音 */
class SimSource {
  constructor() {
    this.t = 0;
    this.speed = 1;
    this.last = performance.now();
    this.cur = 0;
    this.wrong = null;
  }
  chroma() {
    if (!ref.times.length) return null;
    const now = performance.now();
    const dt = (now - this.last) / 1000;
    this.last = now;
    this.speed += (Math.random() - 0.5) * 0.05;
    this.speed = Math.min(1.45, Math.max(0.6, this.speed));
    this.t += dt * this.speed * 1000;
    let i = this.cur;
    while (i + 1 < ref.times.length && ref.times[i + 1] <= this.t) i++;
    while (i > 0 && ref.times[i] > this.t) i--;
    if (i !== this.cur) {
      this.cur = i;
      this.wrong = Math.random() < 0.08 ? Math.floor(Math.random() * 12) : null;
    }
    const c = Float32Array.from(ref.chroma[i] || new Float32Array(12));
    for (let k = 0; k < 12; k++) c[k] += Math.abs(gauss()) * 0.04;
    if (this.wrong != null) c[this.wrong] += 0.9;
    let s = 0; for (const v of c) s += v * v;
    if (s > 0) { s = Math.sqrt(s); for (let k = 0; k < 12; k++) c[k] /= s; }
    return c;
  }
  speedFactor() {
    if (this.cur <= 0 || this.cur >= ref.times.length - 1) return null;
    const dtRef = ref.times[this.cur + 1] - ref.times[this.cur];
    return dtRef > 0 ? this.speed : null;
  }
  stop() { /* nothing */ }
}

function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* ---------------- 引擎 2：OTW-lite 跟随 ---------------- */
class Follower {
  constructor(source) {
    this.source = source;
    this.idx = 0;
    this.lastHi = -1;
    this.lost = 0;
    this.pending = -1;
    this.pendingCount = 0;
    this.timer = setInterval(() => this.step(), 100);
    this.smoothed = 0;
  }
  step() {
    if (!ref.beats.length) return;
    const c = this.source.chroma();
    if (!c) return;
    const silence = c.every((v) => v === 0);

    let best = this.idx, bestS = -2, bestSim = 0;
    const lo = Math.max(0, this.idx - 6);
    const hi = Math.min(ref.chroma.length - 1, this.idx + 12);
    if (!silence) {
      for (let i = lo; i <= hi; i++) {
        const sim = cosine(c, ref.chroma[i]);
        const s = sim - 0.025 * Math.abs(i - this.idx); // 位置先验
        if (s > bestS) { bestS = s; best = i; bestSim = sim; }
      }
      // 迟滞 + 两帧防抖：明显更优 或 当前相似度过低才切换
      const curSim = cosine(c, ref.chroma[this.idx]);
      if (best !== this.idx) {
        if (bestS > curSim - 0.025 * Math.abs(best - this.idx) + 0.04 || curSim < 0.4) {
          if (best === this.pending) this.pendingCount++;
          else { this.pending = best; this.pendingCount = 1; }
          if (this.pendingCount >= 2 || curSim < 0.35) {
            this.idx = best;
            bestSim = Math.max(bestSim, 0);
            this.pendingCount = 0; this.pending = -1;
          }
        } else { this.pending = -1; this.pendingCount = 0; }
      } else { this.pending = -1; this.pendingCount = 0; }
      // 失联检测 → 全曲重定位
      if (bestSim < 0.5) {
        this.lost++;
        if (this.lost > 8) {
          let gi = this.idx, gs = -2;
          for (let i = 0; i < ref.chroma.length; i++) {
            const sim = cosine(c, ref.chroma[i]);
            if (sim > gs) { gs = sim; gi = i; }
          }
          this.idx = gi; this.lost = 0;
        }
      } else this.lost = 0;
      this.smoothed = this.smoothed * 0.7 + Math.max(0, bestSim) * 0.3;
    } else {
      this.smoothed *= 0.95; // 静音：保持位置，置信度缓降
    }

    if (this.idx !== this.lastHi) { this.lastHi = this.idx; highlightIndex(this.idx); }
    setConf(this.smoothed);
    $('speedVal').textContent = this.source.speedFactor
      ? ((this.source.speedFactor() || 0)).toFixed(2) + 'x'
      : '-';
  }
  /** 跳转到第 i 拍（点击谱面重定位） */
  seek(i) {
    this.idx = Math.max(0, Math.min(ref.beats.length - 1, i));
    this.lastHi = -1;
    this.lost = 0;
    this.pending = -1;
    this.pendingCount = 0;
  }
  stop() { clearInterval(this.timer); if (this.source.stop) this.source.stop(); }
}

/* ---------------- 引擎切换 ---------------- */
function stopEngine() {
  if (engine) { try { engine.stop(); } catch (e) {} engine = null; }
  if (mic) {
    try { mic.stream.getTracks().forEach((t) => t.stop()); mic.ctx.close(); } catch (e) {}
    mic = null;
  }
  setConf(0);
  $('speedVal').textContent = '-';
  setLed('', '待机');
  syncButtons(null);
}

function syncButtons(activeId) {
  for (const id of ['btnWalker', 'btnMic', 'btnSim']) {
    $(id).classList.toggle('active', id === activeId);
  }
}

async function runWalker() {
  stopEngine();
  if (!ref.beats.length) { setHint('谱面尚未就绪，请稍候'); return; }
  walkerInst = new Walker($('rate').value / 100);
  engine = {
    stop: () => walkerInst.stop(),
    name: 'walker',
    setRate: (r) => walkerInst.setRate(r),
    seek: (i) => walkerInst.seek(i),
  };
  setLed('ok', 'BPM 定速滚动');
  setHint('固定速度滚动模式：适合跟节拍器练习');
  syncButtons('btnWalker');
  walkerInst.start();
}

async function runMic() {
  stopEngine();
  if (!ref.beats.length) { setHint('谱面尚未就绪，请稍候'); return; }
  setLed('warn', '正在请求麦克风…');
  try { await startMic(); }
  catch (e) {
    console.error(e);
    setLed('bad', '麦克风不可用');
    setHint('麦克风授权失败或浏览器不支持（需 https/localhost）');
    return;
  }
  const f = new Follower({ chroma: micChroma, speedFactor: () => null, stop: () => {} });
  engine = { stop: () => f.stop(), name: 'mic', seek: (i) => f.seek(i) };
  setLed('ok', '麦克风实时跟随中');
  setHint('弹奏时看「输入电平」表：弹奏明显超过静音即可；若乱跳调低灵敏度（数值更小），跟不上调高（数值更大）');
  syncButtons('btnMic');
}

async function runSim() {
  stopEngine();
  if (!ref.beats.length) { setHint('谱面尚未就绪，请稍候'); return; }
  const src = new SimSource();
  const f = new Follower(src);
  engine = { stop: () => f.stop(), name: 'sim', seek: (i) => f.seek(i) };
  setLed('ok', '模拟演奏跟随中（含错音/变速注入）');
  setHint('演示模式：虚拟演奏者以 0.6x~1.45x 随机变速弹奏，8% 概率弹错音，跟随器需实时对齐');
  syncButtons('btnSim');
}

function setHint(msg) { $('hint').textContent = msg || ''; }

/* ---------------- UI 绑定 ---------------- */
function bindUI() {
  const sel = $('song');
  for (const s of SONGS) {
    const o = document.createElement('option');
    o.value = s.id; o.textContent = s.name;
    sel.appendChild(o);
  }
  sel.onchange = () => { stopEngine(); loadSong(sel.value); };

  $('btnWalker').onclick = runWalker;
  $('btnMic').onclick = runMic;
  $('btnSim').onclick = runSim;
  $('btnStop').onclick = stopEngine;
  $('btnLoad').onclick = () => $('fileInput').click();
  $('fileInput').onchange = (e) => {
    if (e.target.files[0]) importFile(e.target.files[0]);
    e.target.value = '';
  };
  $('btnMag').onclick = () => {
    magOn = !magOn;
    $('btnMag').classList.toggle('active', magOn);
    $('magnifier').classList.toggle('on', magOn);
    if (!magOn) $('magContent').innerHTML = '';
  };

  $('rate').oninput = (e) => {
    const r = e.target.value / 100;
    $('rateVal').textContent = r.toFixed(1) + 'x';
    if (engine && engine.name === 'walker' && engine.setRate) engine.setRate(r);
  };
  $('gate').oninput = (e) => {
    micGate = parseInt(e.target.value);
    $('gateVal').textContent = micGate + 'dB';
  };
  $('zoom').oninput = (e) => {
    const z = e.target.value / 100;
    $('zoomVal').textContent = Math.round(z * 100) + '%';
    if (!api) return;
    try {
      api.settings.display.zoom = z;
      if (api.updateSettings) api.updateSettings();
      if (api.render) api.render();
    } catch (err) { console.warn('zoom failed', err); }
  };
}

/* ---------------- 启动 ---------------- */
window.addEventListener('DOMContentLoaded', () => {
  bindUI();
  initTab();
  if (location.search.indexOf('autotest') >= 0) {
    $('testlog').style.display = 'block';
    autotest();
  }
});

/* ---------------- 自检模式（headless 测试用） ---------------- */
async function autotest() {
  const log = (m) => {
    const d = document.createElement('div');
    d.textContent = m;
    $('testlog').appendChild(d);
  };
  log('autotest started, alphaTab=' + (window.alphaTab ? 'loaded' : 'MISSING'));
  let waited = 0;
  while (!ref.beats.length && waited < 15000) {
    await new Promise((r) => setTimeout(r, 250)); waited += 250;
  }
  if (!ref.beats.length) { log('FAIL: reference empty'); log('fallback=' + $('fallback').textContent); return; }
  log('PASS: beats=' + ref.beats.length + ' bars=' + ref.barCount +
      ' lastMs=' + ref.times[ref.times.length - 1]);
  if (!isFinite(ref.times[ref.times.length - 1])) { log('FAIL: times not finite'); return; }

  // 等待谱面 DOM（<g class="bN">）真正渲染出来，消除重渲染竞态
  let w2 = 0;
  while (!document.querySelector('#alphatab g.b0') && w2 < 15000) {
    await new Promise((r) => setTimeout(r, 250)); w2 += 250;
  }
  // 诊断：surface 内容与字体加载状态
  try {
    const surf = document.querySelector('.at-surface');
    log('diag surface=' + (surf ? surf.children.length + ' kids,' + surf.innerHTML.length + 'B' : 'MISSING'));
    log('diag fonts=' + Array.from(document.fonts).map((f) => f.family + ':' + f.status).join(',') +
        ' check=' + document.fonts.check('12px alphaTab'));
    const svgs = document.querySelectorAll('#alphatab svg');
    log('diag svg count=' + svgs.length + (svgs.length ? ' first=' + svgs[0].getAttribute('class') : ''));
  } catch (e) { log('diag fail: ' + e.message); }
  log(document.querySelector('#alphatab g.b0')
    ? 'PASS: DOM beats rendered' : 'FAIL: DOM beats not rendered');

  try { api.tickPosition = ref.beats[2]._tick; log('tickPosition set ok'); }
  catch (e) { log('tickPosition THROWS: ' + e.message); }
  await new Promise((r) => setTimeout(r, 800));
  const cursorEls = document.querySelectorAll('[class*="cursor"]').length;
  log('cursor elements in DOM: ' + cursorEls);

  // Walker 测试（4x 速度）
  walkerInst = new Walker(4);
  engine = { stop: () => walkerInst.stop(), name: 'walker' };
  walkerInst.start();
  let lastBar = -1, changes = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 4000) {
    const b = parseInt($('barNum').textContent) || 0;
    if (b !== lastBar && b > 0) { lastBar = b; changes++; }
    await new Promise((r) => setTimeout(r, 100));
  }
  walkerInst.stop();
  log(changes > 3 ? 'PASS: walker' : 'FAIL: walker changes=' + changes + ' lastBar=' + lastBar);

  // Sim 跟随测试（同时开启放大镜验证 DOM 锚定）
  magOn = true;
  $('magnifier').classList.add('on');
  const src = new SimSource();
  const f = new Follower(src);
  let aligned = 0, n = 0;
  const s0 = performance.now();
  while (performance.now() - s0 < 9000) {
    await new Promise((r) => setTimeout(r, 500));
    const shown = parseInt(($('barNum').textContent || '').split(' ')[0]) || 0;
    const truth = ref.beats[src.cur] ? ref.beats[src.cur]._mbIndex + 1 : 0;
    if (shown === truth) aligned++;
    n++;
    log('sim t=' + Math.round((performance.now() - s0) / 1000) + 's shown=' + shown +
        ' truth=' + truth + ' conf=' + $('conf').style.width);
  }
  f.stop();
  log('SIM bar-level accuracy: ' + aligned + '/' + n + (aligned / n > 0.6 ? ' PASS' : ' FAIL'));
  const hlCount = document.querySelectorAll('.at-hl').length;
  const magSvg = document.querySelectorAll('#magContent svg').length;
  log((hlCount > 0 ? 'PASS: DOM highlight (' + hlCount + ')' : 'FAIL: no DOM highlight') +
      ' | ' + (magSvg > 0 ? 'PASS: magnifier' : 'FAIL: magnifier empty'));
  log('autotest done');
}
