/* ==========================================================================
 * app.js — 谱面模式（index.html）的业务脚本
 *
 * 三种跟随引擎：
 *   Walker    BPM 定速滚动：按乐谱时间轴匀速推进，适合跟节拍器练习
 *   Mic       麦克风实时跟随：Web Audio 取麦克风频谱 → 12 维色度向量(chroma)
 *             → 与参考轨道做余弦相似度匹配，带位置先验与迟滞防抖
 *   SimSource 模拟演奏：虚拟演奏者随机变速 + 8% 错音，用于验证跟随算法
 *
 * 跟随算法（OTW-lite）：
 *   1. 载入乐谱时为每一拍构建 12 维色度向量（音级分布，忽略八度）
 *   2. 每 100ms 取一次实时色度，在当前位置 ±(6,12) 拍的窗口内找最相似拍
 *   3. 位置先验 + 两帧防抖抑制抖动；连续失配 8 次则全曲重定位
 *
 * 依赖：vendor/alphaTab.js（渲染）、js/theme.js（主题）、js/settings.js（设置）
 * ========================================================================== */
'use strict';

/** 简写：按 id 取元素 */
const $ = (id) => document.getElementById(id);

/* --------------------------------------------------------------- 演示曲目 */
/** 内置演示曲（alphaTex 文本谱），无需外部文件即可体验跟随 */
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

/* ------------------------------------------------------------------ 全局状态 */
/** alphaTab 的 ticks per quarter note（MIDI 时间基准） */
const TPQ = 960;

/** alphaTab API 实例 */
let api = null;
/**
 * 参考轨道：每拍的 chroma 与时间轴
 * @type {{beats:Array, barStartMs:Array, chroma:Array, times:Array, barCount:number}}
 */
let ref = { beats: [], barStartMs: [], chroma: [], times: [], barCount: 0 };
/** 当前运行的引擎：{ stop(), name, setRate?, seek? } */
let engine = null;
/** BPM 滚动引擎实例 */
let walkerInst = null;
/** 麦克风音频链路：{ ctx, analyser, buf, stream, sr, fft } */
let mic = null;
/** 麦克风噪声门（dB），低于该能量的频段视为静音 */
let micGate = -72;
/** 当前高亮的 DOM 节点 */
let hlEl = null;
/** 放大镜开关 */
let magOn = false;
/** 移调半音数（-12 – +12），0 = 原调 */
let transpose = 0;

/* ------------------------------------------------------------ alphaTab 初始化 */

/** 初始化 alphaTab 并载入默认演示曲 */
function initTab() {
  transpose = clampTranspose(window.TPSettings.get('transpose'));
  if (!window.alphaTab) {
    showFallback('alphaTab 脚本加载失败，请确认 vendor/alphaTab.js 存在后刷新页面。');
    return;
  }

  try {
    api = new alphaTab.AlphaTabApi($('alphatab'), {
      core: {
        // 主线程渲染：规避部分环境下渲染 worker 静默失联的问题，
        // 常规乐谱体积下主线程渲染的耗时可以忽略
        useWorkers: false,
      },
      player: {
        enablePlayer: true,
        enableCursor: true,
        enableAutoScroll: true,
        soundFont: 'vendor/sonivox.sf3',
      },
      display: { zoom: 1.0 },
      // 恢复上次用过的移调：构造时就带上，载入的谱一开始就是移调后的状态，
      // 省得"先按原调渲染一遍、再改设置重渲染"浪费一次渲染
      notation: { transpositionPitches: [transpose] },
    });
  } catch (e) {
    console.error(e);
    showFallback('alphaTab 初始化失败：' + e.message);
    return;
  }

  // 换谱/换曲时 alphaTab 会按 settings 重新套用移调，只有 ScoreLoader 最清楚结果，
  // 所以这里直接用它给的 score 重建参考（此时音符的 realValue 已是移调后的音高）
  api.scoreLoaded.on((score) => {
    buildReference(score);
    updateTransposeUI();
  });

  // 点击谱面重定位：跟随模式下直接跳到被点击的那一拍
  try {
    api.beatMouseDown.on((args) => {
      const beat = args && args.beat ? args.beat : args;
      if (!beat || !ref.beats.length || !engine) return;
      let idx = ref.beats.indexOf(beat);
      if (idx < 0) {
        // 点到休止符等未进入列表的 beat：退到其所在小节的首拍
        const mbi = beat.voice && beat.voice.bar && beat.voice.bar.masterBar
          ? beat.voice.bar.masterBar.index
          : 0;
        idx = ref.beats.findIndex((b) => b._mbIndex >= mbi);
      }
      if (idx >= 0 && engine.seek) engine.seek(idx);
    });
  } catch (e) {
    console.warn('beatMouseDown 事件绑定失败', e);
  }

  loadSong(SONGS[0].id);
}

/** 显示错误提示层 */
function showFallback(msg) {
  const f = $('fallback');
  f.style.display = 'flex';
  f.textContent = msg;
}

/** 载入内置演示曲（alphaTex） */
function loadSong(id) {
  ref = { beats: [], barStartMs: [], chroma: [], times: [], barCount: 0 };
  clearHighlight();
  const song = SONGS.find((s) => s.id === id);
  if (!api || !song) return;
  api.tex(song.tex);
}

/* ------------------------------------------------- 谱面文件导入（.gp / MIDI 等） */

/** 导入本地谱面文件；MusicXML 走文本，其余按二进制读取 */
function importFile(file) {
  if (!api || !file) return;
  stopEngine();

  const isText = /\.(musicxml|xml)$/i.test(file.name);
  const reader = new FileReader();
  reader.onload = () => {
    try {
      clearHighlight();
      api.load(reader.result);      // scoreLoaded 事件会重建参考轨道

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
      console.error('导入失败', e);
      setHint('导入失败：' + e.message);
    }
  };

  if (isText) reader.readAsText(file);
  else reader.readAsArrayBuffer(file);
}

/* ------------------------------------------------------------ 参考轨道构建 */

/** 音符时值 → ticks（1 = 全音符） */
const DUR_TICKS = { 1: 3840, 2: 1920, 4: 960, 8: 480, 16: 240, 32: 120, 64: 60, 128: 30 };

/** 计算一个 beat 占用的 ticks（含附点） */
function beatTicks(b) {
  const d = DUR_TICKS[b.duration] || 960;
  const dots = b.dots || 0;
  return d * (dots ? 2 - Math.pow(0.5, dots) : 1);
}

/** 计算一个小节占用的 ticks（依据拍号） */
function barTicks(mb) {
  try {
    const ts = mb.timeSignature;
    return ts.numerator * (4 / ts.denominator) * TPQ;
  } catch (e) {
    return 3840;      // 4/4 拍兜底
  }
}

/**
 * 乐谱载入完成后构建参考轨道。
 * 为每一拍标注：_tick（MIDI tick）、_timeMs（毫秒）、_mbIndex（小节）、
 * _domId（渲染 DOM 中的序号，含休止符，用于高亮定位）。
 */
function buildReference(score) {
  try {
    const mbs = score.masterBars;

    // 小节起点：逐小节累加 tick 与毫秒（避免依赖模型内部字段）
    const barStartTick = [];
    const barStartMs = [];
    let tick = 0;
    let ms = 0;
    for (let i = 0; i < mbs.length; i++) {
      const tempo = mbs[i].tempo || 120;
      barStartTick[i] = tick;
      barStartMs[i] = ms;
      const bt = barTicks(mbs[i]);
      tick += bt;
      ms += (bt * 60000) / (tempo * TPQ);
    }

    // 遍历所有 beat 并标注时间信息
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
              b._timeMs = barStartMs[mb.index] + (off * 60000) / (tempo * TPQ);
              b._domId = domId++;
              if (!b.isRest) beats.push(b);
              off += beatTicks(b);
            }
          }
        }
      }
    }
    beats.sort((a, b) => a._tick - b._tick || a._mbIndex - b._mbIndex);

    const chroma = [];
    const times = [];
    for (const b of beats) {
      times.push(b._timeMs);
      chroma.push(beatChroma(b));
    }

    ref = { beats, barStartMs, chroma, times, barCount: mbs.length };
  } catch (e) {
    console.error('参考轨道构建失败', e);
  }
}

/**
 * 计算一个 beat 的 12 维色度向量（音级分布，忽略八度），并做 L2 归一化。
 * @returns {Float32Array} 长度 12 的归一化向量
 */
function beatChroma(beat) {
  const c = new Float32Array(12);
  for (const n of beat.notes) {
    if (n.isDead || n.isTieDestination) continue;

    let midi = null;
    try { midi = n.realValue; } catch (e) { /* 部分版本无该字段 */ }

    if (midi == null || midi < 0) {
      // 兜底：按标准调弦（1 弦高 E=64 → 6 弦低 E=40）加品位推算
      const base = [64, 59, 55, 50, 45, 40];
      const st = n.string || 1;
      midi = (base[st - 1] || 0) + (n.fret || 0);
    }

    const pc = ((midi % 12) + 12) % 12;
    c[pc] += 1;
  }

  let s = 0;
  for (const v of c) s += v * v;
  if (s > 0) {
    s = Math.sqrt(s);
    for (let i = 0; i < 12; i++) c[i] /= s;
  }
  return c;
}

/** 两个已归一化向量的余弦相似度 */
function cosine(a, b) {
  let d = 0;
  for (let i = 0; i < 12; i++) d += a[i] * b[i];
  return d;
}

/* ------------------------------------------------------ 高亮 / 滚动 / 放大镜 */

/** 高亮第 i 拍并更新状态栏与放大镜 */
function highlightIndex(i) {
  const b = ref.beats[i];
  if (!b || !api) return;
  try { api.tickPosition = b._tick; } catch (e) { /* 某些状态下不可设置，忽略 */ }

  let bar = '-';
  if (ref.barCount) bar = String(b._mbIndex + 1) + ' / ' + ref.barCount;
  $('barNum').textContent = bar;

  try { highlightDom(b); } catch (e) { /* 渲染未就绪时忽略 */ }
}

/** 音符级红色高亮（锚定 alphaTab 渲染出的 <g class="bN"> 节点） */
function highlightDom(b) {
  if (hlEl) {
    hlEl.classList.remove('at-hl');
    hlEl = null;
  }

  let g = null;
  try { g = $('alphatab').querySelector('g.b' + b._domId); }
  catch (e) { return; }

  if (g) {
    g.classList.add('at-hl');
    hlEl = g;
  }
  updateMagnifier(g);
}

/** 放大镜：克隆当前行 SVG，缩放平移到当前 beat 中心 */
function updateMagnifier(g) {
  if (!magOn || !g) return;
  const rowSvg = g.ownerSVGElement;
  if (!rowSvg) return;

  let bb;
  try { bb = g.getBBox(); } catch (e) { return; }

  const content = $('magContent');
  const scale = 2.4;
  const mw = content.clientWidth || 380;
  const mh = content.clientHeight || 180;
  const cx = bb.x + bb.width / 2;
  const cy = bb.y + bb.height / 2;

  const clone = rowSvg.cloneNode(true);
  clone.removeAttribute('style');
  // 关键：字形 CSS 规则针对 `.at-surface.at .at`，克隆体不在该容器内，
  // 必须补上这两个 class，否则 PUA 乐谱字形会回退成方块
  clone.setAttribute('class', 'at-surface-svg at-surface at');
  clone.style.position = 'absolute';
  clone.style.transformOrigin = '0 0';
  clone.style.transform =
    'translate(' + (mw / 2 - cx * scale) + 'px,' + (mh / 2 - cy * scale) + 'px) scale(' + scale + ')';

  content.innerHTML = '';
  content.appendChild(clone);

  // 同步高亮克隆体中的当前 beat
  try {
    const m = g.getAttribute('class').match(/b(\d+)/);
    const cg = m ? clone.querySelector('g.b' + m[1]) : null;
    if (cg) cg.classList.add('at-hl');
  } catch (e) { /* 忽略 */ }
}

/** 清除高亮与放大镜内容 */
function clearHighlight() {
  if (hlEl) {
    hlEl.classList.remove('at-hl');
    hlEl = null;
  }
  $('magContent').innerHTML = '';
}

/** 设置状态灯与模式文字 */
function setLed(cls, modeText) {
  $('led').className = 'led ' + cls;
  $('modeText').textContent = modeText;
}

/** 设置置信度条（0–1） */
function setConf(v) {
  $('conf').style.width = Math.round(Math.max(0, Math.min(1, v)) * 100) + '%';
}

/** 设置底部提示文字 */
function setHint(msg) {
  $('hint').textContent = msg || '';
}

/* -------------------------------------------------------- 引擎 1：BPM 定速滚动 */

/** 按乐谱时间轴匀速推进（不受实际演奏影响） */
class Walker {
  /**
   * @param {number} rate 播放倍速
   */
  constructor(rate) {
    this.rate = rate;
    this.t0 = performance.now();
    this.lastIdx = -1;
    this.raf = null;
    this.timer = null;
  }

  start() {
    this.t0 = performance.now();
    const loop = () => {
      const t = ((performance.now() - this.t0) / 1000) * this.rate * 1000;
      let i = Math.max(0, this.lastIdx);
      while (i + 1 < ref.times.length && ref.times[i + 1] <= t) i++;
      while (i > 0 && ref.times[i] > t) i--;
      if (i !== this.lastIdx && ref.beats.length) {
        this.lastIdx = i;
        highlightIndex(i);
      }
      $('speedVal').textContent = this.rate.toFixed(1) + 'x';
    };
    this.raf = requestAnimationFrame(loop);
    // rAF 在后台标签页会被冻结，用定时器兜底
    this.timer = setInterval(loop, 50);
  }

  /** 变速：保持当前音乐时间不跳变 */
  setRate(r) {
    const cur = ((performance.now() - this.t0) / 1000) * this.rate * 1000;
    this.t0 = performance.now() - (cur / r) * 1000;
    this.rate = r;
  }

  /** 跳转到第 i 拍 */
  seek(i) {
    i = Math.max(0, Math.min(ref.times.length - 1, i));
    this.t0 = performance.now() - ref.times[i] / this.rate;
    this.lastIdx = i;
    highlightIndex(i);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.timer) clearInterval(this.timer);
  }
}

/* --------------------------------------------------------------- 麦克风音源 */

/**
 * 启动麦克风。
 * 关闭回声消除/降噪/自动增益——这些处理会破坏音高信息，导致跟随失准。
 * 需要安全上下文（https 或 localhost）；Tauri 的资产协议本身即为安全上下文。
 */
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

  mic = {
    ctx,
    analyser,
    buf: new Float32Array(analyser.frequencyBinCount),
    stream,
    sr: ctx.sampleRate,
    fft: analyser.fftSize,
  };
}

/**
 * 取当前麦克风帧的色度向量，并更新输入电平表。
 * 只统计 75–1400Hz（吉他基频范围）且高于噪声门的频段。
 */
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

  // 输入电平表：有效频段峰值相对噪声门的余量
  const el = $('lvl');
  if (el) {
    el.style.width = isFinite(peakDb)
      ? (Math.max(0, Math.min(1, (peakDb - micGate) / 34)) * 100).toFixed(0) + '%'
      : '0%';
  }

  let s = 0;
  for (const v of c) s += v * v;
  if (s > 0) {
    s = Math.sqrt(s);
    for (let i = 0; i < 12; i++) c[i] /= s;
  }
  return c;
}

/** 标准正态随机（Box–Muller），用于给模拟演奏加噪声 */
function gauss() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* --------------------------------------------------- 引擎 2：模拟演奏音源 */

/** 虚拟演奏者：沿参考轨道行进，带随机速度波动与偶发错音 */
class SimSource {
  constructor() {
    this.t = 0;
    this.speed = 1;
    this.last = performance.now();
    this.cur = 0;
    this.wrong = null;
  }

  /** 返回当前时刻的色度向量（含噪声与错音扰动） */
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

    let s = 0;
    for (const v of c) s += v * v;
    if (s > 0) {
      s = Math.sqrt(s);
      for (let k = 0; k < 12; k++) c[k] /= s;
    }
    return c;
  }

  /** 当前演奏速度（相对乐谱的倍率） */
  speedFactor() {
    if (this.cur <= 0 || this.cur >= ref.times.length - 1) return null;
    return this.speed;
  }

  stop() { /* 无资源需要释放 */ }
}

/* --------------------------------------------------------- 引擎 3：OTW 跟随器 */

/**
 * 实时跟随器：把音源的色度流对齐到参考轨道。
 * 匹配策略：窗口内最大相似度 − 位置先验惩罚；切换需两帧确认（防抖）。
 */
class Follower {
  /**
   * @param {{chroma:Function, speedFactor?:Function, stop?:Function}} source 音源
   */
  constructor(source) {
    this.source = source;
    this.idx = 0;
    this.lastHi = -1;
    this.lost = 0;
    this.pending = -1;
    this.pendingCount = 0;
    this.smoothed = 0;
    this.timer = setInterval(() => this.step(), 100);
  }

  /** 每次 tick：取一帧色度 → 匹配 → 更新高亮与置信度 */
  step() {
    if (!ref.beats.length) return;
    const c = this.source.chroma();
    if (!c) return;
    const silence = c.every((v) => v === 0);

    let best = this.idx;
    let bestS = -2;
    let bestSim = 0;

    if (!silence) {
      const lo = Math.max(0, this.idx - 6);
      const hi = Math.min(ref.chroma.length - 1, this.idx + 12);

      for (let i = lo; i <= hi; i++) {
        const sim = cosine(c, ref.chroma[i]);
        const s = sim - 0.025 * Math.abs(i - this.idx);      // 位置先验
        if (s > bestS) { bestS = s; best = i; bestSim = sim; }
      }

      // 迟滞 + 两帧防抖：明显更优，或当前相似度过低时才切换
      const curSim = cosine(c, ref.chroma[this.idx]);
      if (best !== this.idx) {
        if (bestS > curSim - 0.025 * Math.abs(best - this.idx) + 0.04 || curSim < 0.4) {
          if (best === this.pending) this.pendingCount++;
          else { this.pending = best; this.pendingCount = 1; }

          if (this.pendingCount >= 2 || curSim < 0.35) {
            this.idx = best;
            bestSim = Math.max(bestSim, 0);
            this.pendingCount = 0;
            this.pending = -1;
          }
        } else {
          this.pending = -1;
          this.pendingCount = 0;
        }
      } else {
        this.pending = -1;
        this.pendingCount = 0;
      }

      // 连续失配 → 全曲重定位（例如中途跳段演奏）
      if (bestSim < 0.5) {
        this.lost++;
        if (this.lost > 8) {
          let gi = this.idx;
          let gs = -2;
          for (let i = 0; i < ref.chroma.length; i++) {
            const sim = cosine(c, ref.chroma[i]);
            if (sim > gs) { gs = sim; gi = i; }
          }
          this.idx = gi;
          this.lost = 0;
        }
      } else {
        this.lost = 0;
      }

      this.smoothed = this.smoothed * 0.7 + Math.max(0, bestSim) * 0.3;
    } else {
      this.smoothed *= 0.95;        // 静音：保持位置，置信度缓降
    }

    if (this.idx !== this.lastHi) {
      this.lastHi = this.idx;
      highlightIndex(this.idx);
    }

    setConf(this.smoothed);
    const sf = this.source.speedFactor ? this.source.speedFactor() : null;
    $('speedVal').textContent = sf ? sf.toFixed(2) + 'x' : '-';
  }

  /** 跳转到第 i 拍 */
  seek(i) {
    this.idx = Math.max(0, Math.min(ref.beats.length - 1, i));
    this.lastHi = -1;
    this.lost = 0;
    this.pending = -1;
    this.pendingCount = 0;
  }

  stop() {
    clearInterval(this.timer);
    if (this.source.stop) this.source.stop();
  }
}

/* ---------------------------------------------------------------- 引擎切换 */

/** 停止当前引擎并释放麦克风 */
function stopEngine() {
  if (engine) {
    try { engine.stop(); } catch (e) { /* 忽略停止异常 */ }
    engine = null;
  }
  if (mic) {
    try {
      mic.stream.getTracks().forEach((t) => t.stop());
      mic.ctx.close();
    } catch (e) { /* 忽略 */ }
    mic = null;
  }
  setConf(0);
  $('speedVal').textContent = '-';
  setLed('', '待机');
  syncButtons(null);
}

/** 同步模式按钮的选中态 */
function syncButtons(activeId) {
  ['btnWalker', 'btnMic', 'btnSim'].forEach((id) => {
    $(id).classList.toggle('active', id === activeId);
  });
}

/** 启动 BPM 定速滚动 */
function runWalker() {
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

/** 启动麦克风实时跟随 */
async function runMic() {
  stopEngine();
  if (!ref.beats.length) { setHint('谱面尚未就绪，请稍候'); return; }

  setLed('warn', '正在请求麦克风…');
  try {
    await startMic();
  } catch (e) {
    console.error(e);
    setLed('bad', '麦克风不可用');
    setHint('麦克风授权失败或环境不支持（需 HTTPS / localhost / Tauri 资产协议）');
    return;
  }

  const f = new Follower({ chroma: micChroma, speedFactor: () => null, stop: () => {} });
  engine = { stop: () => f.stop(), name: 'mic', seek: (i) => f.seek(i) };
  setLed('ok', '麦克风实时跟随中');
  setHint('看「输入电平」表：弹奏时明显超过静音即可；若乱跳调低灵敏度，跟不上则调高');
  syncButtons('btnMic');
}

/** 启动模拟演奏跟随（算法自检 / 演示） */
function runSim() {
  stopEngine();
  if (!ref.beats.length) { setHint('谱面尚未就绪，请稍候'); return; }

  const src = new SimSource();
  const f = new Follower(src);
  engine = { stop: () => f.stop(), name: 'sim', seek: (i) => f.seek(i) };
  setLed('ok', '模拟演奏跟随中（含错音/变速注入）');
  setHint('演示模式：虚拟演奏者以 0.6x~1.45x 随机变速弹奏，8% 概率弹错音');
  syncButtons('btnSim');
}

/* ---------------------------------------------------------------- 移调 */

/**
 * 常用移调只在一个八度内有意义（再往上/下用「换弦+升八度」表达更清楚），
 * 而 keysignature 拼写也只在 ±12 半音内能给出人读得懂的调名。
 */
function clampTranspose(n) {
  n = Math.round(Number(n) || 0);
  return Math.max(-12, Math.min(12, n));
}

/** 十二音的音名拼写：往上升用升号、往下降用降号，避免出现 C## / Bbb 这种叠符号 */
const PC_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const PC_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
/** 按半音数查音程名称，用于把 "+2" 翻译成人话 */
const INTERVALS = ['纯一度', '小二度', '大二度', '小三度', '大三度', '纯四度',
  '增四度', '纯五度', '小六度', '大六度', '小七度', '大七度', '纯八度'];

/**
 * alphaTab 的 keySignature 存的是「五度圈上的位置」：
 *   C=0, G=1, D=2, A=3, E=4, B=5, F#=6, C#=7，反向 F=-1, Bb=-2 …
 * 主音在十二音筒上的位置正好是 (7 × ks) mod 12 —— 15 个调逐个验算都成立。
 */
function keyPc(ks) { return ((7 * (ks || 0)) % 12 + 12) % 12; }

/** 取当前谱的首小节调号；取不到按 C 处理 */
function scoreKey() {
  try {
    const s = api && api.score;
    if (!s) return 0;
    if (s.masterBars && s.masterBars[0] && typeof s.masterBars[0].keySignature === 'number') {
      return s.masterBars[0].keySignature;
    }
    return typeof s.keySignature === 'number' ? s.keySignature : 0;
  } catch (e) { return 0; }
}

/**
 * 把移调量直接写进 score 模型。
 *
 * 为什么不能只改 settings 就算完：settings 要等下一次渲染由 ScoreLoader 才会套到 staff 上，
 * 而参考轨道必须此刻就重建 —— 直接写 staff 能让两者立刻一致。渲染时 alphaTab 会再写一遍同
 * 样的值，这一步是幂等的。
 *
 * 符号（读 alphaTab 源码确认过，别靠猜）：
 *   内部 realValue = fret + stringTuning − staff.transpositionPitch
 *   settings 写入 staff.transpositionPitch = −transpositionPitches[i]
 *   两处负号抵消 → **settings 里给正值就是升高**，UI 上也就按这个方向标注。
 */
function applyTranspositionToScore(score, semis) {
  if (!score || !score.tracks) return;
  for (const track of score.tracks) {
    for (const staff of track.staves || []) {
      try { staff.transpositionPitch = -semis; } catch (e) { /* 只读属性时忽略 */ }
    }
  }
}

/**
 * 设置移调：显示、跟随判定基准、播放音高三处一起变。
 * 中途改动会停下正在跑的跟随 —— 参考轨道换了，旧的高亮位置已经没有意义。
 */
function setTranspose(n) {
  transpose = clampTranspose(n);
  window.TPSettings.set('transpose', transpose);

  try { api.settings.notation.transpositionPitches = [transpose]; } catch (e) { /* 无该设置 */ }
  if (api && api.score) {
    applyTranspositionToScore(api.score, transpose);
    stopEngine();
    clearHighlight();
    // 参考轨道必须重建：OTW 跟随是靠 chroma 比对"谱上的音"和"耳朵听到的音"，
    // 音符 realValue 变了而参考还是原调的话，跟随会一路判错。
    buildReference(api.score);
    try { api.render(); } catch (e) {
      try { api.updateSettings(); } catch (e2) { /* 都不支持就不重渲染 */ }
    }
  }
  updateTransposeUI();
  setHint(transpose === 0
    ? '已回到原调'
    : ('已移调 ' + (transpose > 0 ? '+' : '') + transpose + ' 半音（' + intervalName(transpose) + '）'));
}

function intervalName(n) { return INTERVALS[Math.min(12, Math.abs(n))]; }

/** 更新工具条数值与底部的「原调 X → Y」提示 */
function updateTransposeUI() {
  const el = $('trVal');
  if (!el) return;
  const n = transpose;
  el.textContent = n === 0 ? '原调' : (n > 0 ? '+' + n : String(n));

  const ks = scoreKey();
  const from = keyPc(ks);
  const to = ((from + n) % 12 + 12) % 12;
  // 降号调（F / Bb / Eb …）读成降号名更自然，升号调反之
  const origName = (ks < 0 ? PC_FLAT : PC_SHARP)[from];
  const newName = (n >= 0 ? PC_SHARP : PC_FLAT)[to];
  const kv = $('keyVal');
  if (kv) {
    kv.textContent = n === 0
      ? ('原调 ' + origName)
      : ((n > 0 ? '+' + n : n) + '（' + intervalName(n) + '）' + origName + '→' + newName);
  }
  $('btnTrReset').classList.toggle('active', n !== 0);
}

/* -------------------------------------------------------------------- UI */

/** 绑定页面控件事件 */
function bindUI() {
  const sel = $('song');
  for (const s of SONGS) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.name;
    sel.appendChild(o);
  }
  sel.onchange = () => {
    stopEngine();
    loadSong(sel.value);
  };

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
    window.TPSettings.set('magnifier', magOn);
  };

  // 移调
  $('btnTrUp').onclick = () => setTranspose(transpose + 1);
  $('btnTrDown').onclick = () => setTranspose(transpose - 1);
  $('btnTrReset').onclick = () => setTranspose(0);
  // 键盘 [ / ] 快速升降半音（焦点在输入控件里时不抢按键）
  document.addEventListener('keydown', (e) => {
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === '[') setTranspose(transpose - 1);
    else if (e.key === ']') setTranspose(transpose + 1);
  });

  // 参数滑杆：统一写入设置，由设置模块分发回本页面与其他页面
  $('rate').oninput = (e) => window.TPSettings.set('rate', parseInt(e.target.value, 10));
  $('gate').oninput = (e) => window.TPSettings.set('gate', parseInt(e.target.value, 10));
  $('zoom').oninput = (e) => window.TPSettings.set('zoom', parseInt(e.target.value, 10));
}

/**
 * 应用设置到本页面。
 * @param {Object} s 完整设置对象
 */
function applySettings(s) {
  // 速度
  $('rate').value = s.rate;
  $('rateVal').textContent = (s.rate / 100).toFixed(1) + 'x';
  if (engine && engine.name === 'walker' && engine.setRate) engine.setRate(s.rate / 100);

  // 麦克风噪声门
  micGate = s.gate;
  $('gate').value = s.gate;
  $('gateVal').textContent = s.gate + 'dB';

  // 谱面缩放
  $('zoom').value = s.zoom;
  $('zoomVal').textContent = s.zoom + '%';
  if (api) {
    try {
      api.settings.display.zoom = s.zoom / 100;
      if (api.updateSettings) api.updateSettings();
      if (api.render) api.render();
    } catch (err) {
      console.warn('缩放应用失败', err);
    }
  }

  // 移调。initTab 构造 API 时已经把上次的值带进去了，
  // 所以这里只有「用户在会话里改了设置」才会真正重渲染；否则只刷新显示。
  const tr = clampTranspose(s.transpose);
  if (tr !== transpose) setTranspose(tr);
  else updateTransposeUI();

  // 放大镜
  magOn = !!s.magnifier;
  $('btnMag').classList.toggle('active', magOn);
  $('magnifier').classList.toggle('on', magOn);
  if (!magOn) $('magContent').innerHTML = '';

  // 底部提示
  $('hint').style.display = s.showHints ? '' : 'none';
}

/* ------------------------------------------------------------------ 启动 */

window.addEventListener('DOMContentLoaded', () => {
  window.TPSettings.mount();
  window.TPSettings.onChange(applySettings);
  bindUI();
  initTab();
  applySettings(window.TPSettings.all());
});
