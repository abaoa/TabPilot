/* ==========================================================================
 * verify-align.mjs — 音频对齐核心的正确性检验
 *
 * 对齐核心（rmsEnvelope / decimateRate / bestLag / alignOffsetSeconds /
 * findPosition）是纯函数，脱离 DOM/AudioContext 也能测。重点验证：
 *
 *   1. alignOffsetSeconds 能从"延迟副本"里还原出已知延迟（Feature 16 底层）。
 *      还要扛得住：噪声、以及伴奏/麦克风采样率不一致（44.1k vs 48k）。
 *   2. findPosition 能从参考包络里，把一段已知起点的小窗重新定位回来
 *      （Feature 17 底层），即使搜索中心偏离真实位置也能"重锁"。
 *
 * 之所以单独一个脚本：这些边界（跨采样率、噪声、重锁）在页面级回归里
 * 很难表达，而纯函数测起来很快、很稳。
 *
 * 运行：npm run verify:align
 * ========================================================================== */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'public', 'js', 'image-tab.js'), 'utf8');

/** 从源码按花括号配平抽出指定函数（避免手工维护副本导致与实际实现漂移） */
function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到函数: ' + name);
  for (let p = src.indexOf('{', start), depth = 0; p < src.length; p++) {
    if (src[p] === '{') depth++;
    else if (src[p] === '}') { depth--; if (depth === 0) return src.slice(start, p + 1); }
  }
  throw new Error('花括号未配平: ' + name);
}

const ALIGN_SR = +src.match(/const ALIGN_SR = (\d+)/)[1];
const ALIGN_FRAME = +src.match(/const ALIGN_FRAME = ([\d.]+)/)[1];
const NAMES = ['decimateRate', 'rmsEnvelope', 'bestLag', 'alignOffsetSeconds', 'findPosition'];
const code = `const ALIGN_SR = ${ALIGN_SR};\nconst ALIGN_FRAME = ${ALIGN_FRAME};\n` + NAMES.map(extract).join('\n');
const SL = new Function(code + '\nreturn {' + NAMES.join(',') + '};')();
const { decimateRate, rmsEnvelope, bestLag, alignOffsetSeconds, findPosition } = SL;

const R = [];
function ok(name, cond, extra) {
  R.push((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  [' + extra + ']' : ''));
}
function approx(name, got, want, tol, extra) {
  ok(name, Math.abs(got - want) <= tol, (extra || '') + ' got=' + got + ' want=' + want + ' tol=' + tol);
}

/* ---- 确定性合成"鼓机"音轨（带种子噪声，保证单测可复现） ---- */
let seed = 12345;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function makeTrack(sr, dur, bpm) {
  const n = Math.floor(sr * dur);
  const out = new Float32Array(n);
  const beat = (sr * 60) / bpm;
  for (let i = 0; i < n; i++) {
    const phase = (i % beat) / beat;
    let v = 0;
    if (phase < 0.08) v += Math.sin((2 * Math.PI * 60 * i) / sr) * (1 - phase / 0.08);   // 底鼓
    if (phase > 0.5 && phase < 0.58) v += (rnd() * 2 - 1) * 0.6 * (1 - (phase - 0.5) / 0.08); // 军鼓噪声
    v += 0.1 * Math.sin((2 * Math.PI * 110 * i) / sr);                                   // 持续贝斯
    out[i] = v;
  }
  return out;
}
/** 把 sig 整体向右延迟 shiftSamples 个样本（左侧补零），模拟"录制比真身晚" */
function delay(sig, shiftSamples) {
  const out = new Float32Array(sig.length);
  for (let i = shiftSamples; i < sig.length; i++) out[i] = sig[i - shiftSamples];
  return out;
}
function addNoise(sig, amp) {
  const out = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i++) out[i] = sig[i] + (rnd() * 2 - 1) * amp;
  return out;
}

console.log('=== 音频对齐核心检验 ===');
const SR = 44100;
const track = makeTrack(SR, 12, 100);
const Lf = 40;                                  // 期望延迟：40 个包络帧
const Lsec = Lf * ALIGN_FRAME;

/* ---- 1. 已知延迟（同采样率）能还原 ---- */
{
  const q = delay(track, Math.round(Lsec * SR));
  const res = alignOffsetSeconds(track, q, SR, SR, 3);
  approx('延迟还原：lagFrames ≈ -40（同采样率）', res.lagFrames, -Lf, 3, 'score=' + res.score.toFixed(3));
  ok('延迟还原：相似度较高', res.score > 0.6, 'score=' + res.score.toFixed(3));
  approx('延迟还原：lagSec 与帧数一致', res.lagSec, res.lagFrames * ALIGN_FRAME, 1e-9);
}

/* ---- 2. 扛噪声 ---- */
{
  const q = addNoise(delay(track, Math.round(Lsec * SR)), 0.15);
  const res = alignOffsetSeconds(track, q, SR, SR, 3);
  approx('扛噪声：lagFrames ≈ -40', res.lagFrames, -Lf, 5, 'score=' + res.score.toFixed(3));
  ok('扛噪声：仍有明确峰值', res.score > 0.4, 'score=' + res.score.toFixed(3));
}

/* ---- 3. 跨采样率（44.1k 伴奏 vs 48k 麦克风） ---- */
{
  const SR2 = 48000;
  const track2 = makeTrack(SR2, 12, 100);
  const q = delay(track2, Math.round(Lsec * SR2));
  const res = alignOffsetSeconds(track, q, SR, SR2, 3);   // ref 用 44.1k，query 用 48k
  approx('跨采样率：lagFrames ≈ -40', res.lagFrames, -Lf, 4, 'score=' + res.score.toFixed(3));
  ok('跨采样率：相似度较高', res.score > 0.5, 'score=' + res.score.toFixed(3));
}

/* ---- 4. 无延迟时返回约 0 ---- */
{
  const res = alignOffsetSeconds(track, track, SR, SR, 3);
  approx('无延迟：lagFrames ≈ 0', res.lagFrames, 0, 2, 'score=' + res.score.toFixed(3));
}

/* ---- 5. findPosition：已知起点能找回 ---- */
{
  const d = decimateRate(track, SR, ALIGN_SR);
  const er = rmsEnvelope(d, ALIGN_SR, ALIGN_FRAME);
  const P = 200, Q = 40;
  const query = er.slice(P, P + Q);
  const r1 = findPosition(er, query, P, 60);
  ok('定位：精确回到起点 P=200', r1.pos === P, 'pos=' + r1.pos + ' score=' + r1.score.toFixed(3));
  const r2 = findPosition(er, query, P + 12, 60);   // 搜索中心故意偏 12 帧
  ok('定位：中心偏离仍能重锁到 P=200', r2.pos === P, 'pos=' + r2.pos);
  ok('定位：匹配分数接近 1', r2.score > 0.99, 'score=' + r2.score.toFixed(3));
}

/* ---- 6. 包络/降采样长度合理 ---- */
{
  const d = decimateRate(track, SR, ALIGN_SR);
  ok('降采样：长度 = floor(N·target/sr)',
    d.length === Math.floor(track.length * ALIGN_SR / SR),
    'len=' + d.length);
  const er = rmsEnvelope(d, ALIGN_SR, ALIGN_FRAME);
  const exp = Math.floor(d.length / Math.floor(ALIGN_SR * ALIGN_FRAME));
  ok('包络：帧数 ≈ N / 帧长样本数', Math.abs(er.length - exp) <= 1, 'frames=' + er.length + ' exp=' + exp);
  const same = bestLag(er, er, 10);
  ok('互相关：完全相同信号 lag=0', same.lag === 0, 'lag=' + same.lag + ' score=' + same.score.toFixed(3));
}

const fails = R.filter((r) => r.startsWith('FAIL'));
console.log(R.join('\n'));
console.log('=== 断言汇总：' + (R.length - fails.length) + ' 通过 / ' + fails.length + ' 失败 ===');
if (fails.length) process.exit(1);
