/* ==========================================================================
 * verify-timing.mjs — 演奏录音复盘核心(timing-core.js)单测
 *
 * 直接以 Function 方式加载 timing-core.js（UMD：无 window 时落到 globalThis），
 * 取回 TimingCore.computeTimingDeviation 等纯函数验证。覆盖：
 *   · 全局偏移校正（整段录音起录晚了也能对齐）
 *   · 每拍偏差的量值与符号（正=拖拍 / 负=抢拍）
 *   · 漏拍（静音）标记且不污染统计
 *   · 空输入 / 空拍点 / 全静音录音的兜底
 *   · envelopeFromPcm（PCM→RMS 包络）
 *   · impulseEnv（拍点→理想脉冲参考包络）
 *   · findBestLag（互相关求延迟）/ normalizeEnv / summarizeDeviations
 * ========================================================================== */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'public', 'js', 'timing-core.js');

const src = readFileSync(SRC, 'utf8');
const TC = new Function(src + '\nreturn globalThis.TimingCore;')();
const {
  envelopeFromPcm, normalizeEnv, impulseEnv, findBestLag,
  summarizeDeviations, computeTimingDeviation,
} = TC;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
}
/** 近似相等 */
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

const DT = 0.01;                       // 帧长 10ms
const BEATS = [0.5, 1.0, 1.5, 2.0, 2.5];
const TOTAL = 3.2;

/** 由「实际发声时刻」造一份录音包络：整体延迟 lagSec，第 idx 拍再额外偏 extraSec */
function takeEnv(lagSec, idx, extraSec) {
  const times = BEATS.map((t, i) => t + lagSec + (i === idx ? extraSec : 0));
  return impulseEnv(times, DT, TOTAL + lagSec + 0.5, 0.15);
}

console.log('=== 演奏录音复盘核心检验 ===');

// ---- 1) 全局偏移校正 + 单拍拖拍 ----
{
  const refEnv = impulseEnv(BEATS, DT, TOTAL, 0.15);
  const recEnv = takeEnv(0.20, 2, 0.06);        // 整体晚 0.2s，第 3 拍再晚 0.06s
  const r = computeTimingDeviation(refEnv, recEnv, BEATS, { dt: DT });

  ok('全局偏移识别为 0.20s', near(r.offset, 0.20, 0.03), 'offset=' + r.offset.toFixed(3));
  ok('拍数一致', r.beats.length === BEATS.length, 'got=' + r.beats.length);
  ok('未拖拍的偏差≈0', near(r.beats[0].deviation, 0, 0.015) && near(r.beats[1].deviation, 0, 0.015),
    r.beats.slice(0, 2).map((b) => b.deviation.toFixed(3)).join(','));
  ok('第 3 拍拖拍 +0.06s（正=拖）', near(r.beats[2].deviation, 0.06, 0.015),
    'dev=' + r.beats[2].deviation.toFixed(3));
  ok('最差拍定位到第 3 拍(index 2)', r.worstBeat === 2, 'worst=' + r.worstBeat);
  ok('maxAbs ≈ 0.06', near(r.maxAbs, 0.06, 0.015), 'maxAbs=' + r.maxAbs.toFixed(3));
  ok('准确率 4/5', near(r.accuracy, 0.8, 0.001), 'accuracy=' + r.accuracy.toFixed(3));
}

// ---- 2) 抢拍（负偏差） ----
{
  const refEnv = impulseEnv(BEATS, DT, TOTAL, 0.15);
  const recEnv = takeEnv(0.20, 3, -0.05);       // 第 4 拍抢 0.05s
  const r = computeTimingDeviation(refEnv, recEnv, BEATS, { dt: DT });
  ok('抢拍为负偏差 ≈ -0.05s', near(r.beats[3].deviation, -0.05, 0.015),
    'dev=' + r.beats[3].deviation.toFixed(3));
  ok('抢拍拍是最差拍', r.worstBeat === 3, 'worst=' + r.worstBeat);
}

// ---- 3) 无全局偏移、完全准确 ----
{
  const refEnv = impulseEnv(BEATS, DT, TOTAL, 0.15);
  const recEnv = takeEnv(0, -1, 0);
  const r = computeTimingDeviation(refEnv, recEnv, BEATS, { dt: DT });
  ok('无偏移时 offset≈0', near(r.offset, 0, 0.02), 'offset=' + r.offset.toFixed(3));
  ok('全准：maxAbs 很小', r.maxAbs < 0.02, 'maxAbs=' + r.maxAbs.toFixed(4));
  ok('全准：准确率 100%', near(r.accuracy, 1, 0.001), 'accuracy=' + r.accuracy.toFixed(3));
}

// ---- 4) 全静音录音 → 全部漏弹，不污染统计 ----
{
  const refEnv = impulseEnv(BEATS, DT, TOTAL, 0.15);
  const recEnv = new Array(refEnv.length).fill(0);
  const r = computeTimingDeviation(refEnv, recEnv, BEATS, { dt: DT });
  ok('全静音：每一拍都标记 missed', r.beats.every((b) => b.missed === true));
  ok('全静音：有效拍数 0', r.counted === 0, 'counted=' + r.counted);
  ok('全静音：worstBeat = -1', r.worstBeat === -1, 'worst=' + r.worstBeat);
}

// ---- 5) 兜底：空输入 ----
{
  const r1 = computeTimingDeviation([], [], [], { dt: DT });
  ok('空包络 → beats 为空', Array.isArray(r1.beats) && r1.beats.length === 0);
  const refEnv = impulseEnv(BEATS, DT, TOTAL, 0.15);
  const r2 = computeTimingDeviation(refEnv, refEnv, [], { dt: DT });
  ok('空拍点 → beats 为空', r2.beats.length === 0);
  const r3 = computeTimingDeviation(null, null, null);
  ok('null 入参不抛异常', r3 && r3.beats.length === 0);
}

// ---- 6) envelopeFromPcm：正弦的 RMS = A/√2 ----
{
  const N = 2048, HOP = 512;
  const pcm = new Float32Array(N);
  for (let i = 0; i < N; i++) pcm[i] = Math.sin((2 * Math.PI * 8 * i) / HOP);  // 每帧整数个周期
  const env = envelopeFromPcm(pcm, HOP);
  ok('包络帧数 = 采样数/hop', env.length === N / HOP, 'len=' + env.length);
  ok('正弦 RMS ≈ 0.7071', env.every((v) => near(v, Math.SQRT1_2, 0.02)), 'v0=' + env[0].toFixed(4));
  ok('hop 默认 512 也可用', envelopeFromPcm(pcm).length === N / 512);
}

// ---- 7) normalizeEnv ----
{
  const n = normalizeEnv([0, 2, 4]);
  ok('归一化 [0,2,4] → [0,.5,1]', n[0] === 0 && n[1] === 0.5 && n[2] === 1, n.join(','));
  ok('全零归一化仍全零', normalizeEnv([0, 0, 0]).every((v) => v === 0));
}

// ---- 8) impulseEnv：拍点为峰，衰减后归零 ----
{
  const env = impulseEnv([1.0], DT, 2.0, 0.1);
  ok('拍点处为峰值 1', near(env[Math.round(1.0 / DT)], 1, 1e-6), 'v=' + env[Math.round(1.0 / DT)]);
  ok('衰减结束后为 0（1.2s 处）', env[Math.round(1.2 / DT)] === 0);
  ok('包络长度覆盖总时长', env.length === Math.ceil(2.0 / DT) + 1, 'len=' + env.length);
  ok('空拍点 → 全零包络', impulseEnv([], DT, 1.0, 0.1).every((v) => v === 0));
}

// ---- 9) findBestLag ----
{
  const ref = impulseEnv([1.0], DT, 2.0, 0.1);
  const rec = impulseEnv([1.3], DT, 2.0, 0.1);      // 晚 0.3s = 30 帧
  ok('延迟 0.3s → lag = 30 帧', findBestLag(ref, rec, 60) === 30, 'lag=' + findBestLag(ref, rec, 60));
  ok('同信号 → lag = 0', findBestLag(ref, ref, 60) === 0);
  ok('最大搜索 0 帧 → lag = 0', findBestLag(ref, rec, 0) === 0);
  ok('常量序列无相关性 → 0', findBestLag([1, 1, 1, 1], [1, 1, 1, 1], 3) === 0);
}

// ---- 10) summarizeDeviations ----
{
  const s = summarizeDeviations([
    { beat: 0, deviation: 0.01, missed: false },
    { beat: 1, deviation: -0.2, missed: false },
    { beat: 2, deviation: 9.9, missed: true },      // 漏弹应被忽略
  ], 0.05);
  ok('maxAbs 取绝对值最大', near(s.maxAbs, 0.2, 1e-6), 'maxAbs=' + s.maxAbs);
  ok('worstBeat 指向该拍', s.worstBeat === 1, 'worst=' + s.worstBeat);
  ok('meanAbs 只算有效拍', near(s.meanAbs, 0.105, 1e-6), 'mean=' + s.meanAbs);
  ok('准确率 1/2', near(s.accuracy, 0.5, 1e-6), 'acc=' + s.accuracy);
  ok('有效拍计数', s.counted === 2, 'counted=' + s.counted);
}

// ---- 11) 页面接线完整性：防止脚本/按钮漏接（纯文本检查，不启 jsdom） ----
{
  const pub = (f) => readFileSync(join(__dirname, '..', 'public', f), 'utf8');
  const idx = pub('index.html');
  const img = pub('image-tab.html');
  const sw = pub('sw.js');
  const appjs = pub('js/app.js');
  const imgjs = pub('js/image-tab.js');
  const ids = ['btnRec', 'btnReview', 'recChip', 'recTime', 'reviewModal',
    'rvStats', 'rvChart', 'rvWorst', 'rvAudio', 'rvJump', 'rvClose', 'rvClose2'];
  const miss = (html) => ids.filter((id) => html.indexOf('id="' + id + '"') < 0);

  ok('index.html 引入 timing-core.js', idx.indexOf('js/timing-core.js') >= 0);
  ok('index.html 复盘元素齐全', miss(idx).length === 0, '缺=' + miss(idx).join(','));
  ok('image-tab.html 引入 timing-core.js', img.indexOf('js/timing-core.js') >= 0);
  ok('image-tab.html 复盘元素齐全', miss(img).length === 0, '缺=' + miss(img).join(','));
  ok('app.js 调用了 computeTimingDeviation', appjs.indexOf('computeTimingDeviation') >= 0);
  ok('image-tab.js 调用了 computeTimingDeviation', imgjs.indexOf('computeTimingDeviation') >= 0);
  ok('sw.js 缓存版本不低于 v16', +((sw.match(/tabpilot-v(\d+)/) || [0, 0])[1]) >= 16);
  ok('sw.js 预缓存含 timing-core.js', sw.indexOf("'js/timing-core.js'") >= 0);
}

console.log(`\n断言汇总：通过 ${pass} / 失败 ${fail}`);
if (fail > 0) { console.error('存在失败用例'); process.exit(1); }
console.log('全部通过 ✅');
