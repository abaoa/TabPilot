/* ==========================================================================
 * verify-bpm.mjs — 自动测速算法的离线精度检验
 *
 * image-tab.js 里的 detectBpmSamples 是一组纯函数（不碰 DOM），所以可以脱离
 * jsdom 直接用合成信号验证。这里喂的不是理想脉冲串，而是带弱拍结构、
 * 持续低频垫音与随机噪声的"鼓点"，覆盖 72–168 BPM 的常见区间。
 *
 * 之所以要单独一个脚本：
 *   1. jsdom 那套回归里加载整个页面太重，不适合做参数敏感性实验；
 *   2. BPM 检测是典型的"自相关 + 先验打分"算法，倍频错误（把 72 判成 144）
 *      只有在多组样本上才看得出来，单个断言容易漏。
 *
 * 运行：npm run verify:bpm
 * ========================================================================== */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'public', 'js', 'image-tab.js'), 'utf8');

/** 从源码里按花括号配平抠出指定函数（避免手工维护一份副本而与实际实现漂移） */
function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到函数: ' + name);
  let depth = 0;
  for (let p = src.indexOf('{', start); p < src.length; p++) {
    if (src[p] === '{') depth++;
    else if (src[p] === '}') { depth--; if (depth === 0) return src.slice(start, p + 1); }
  }
  throw new Error('花括号未配平: ' + name);
}

const NAMES = ['onsetEnvelope', 'scorePeriod', 'refinePeriod', 'autocorrLags', 'detectBpmSamples'];
const code = NAMES.map(extract).join('\n');
const { detectBpmSamples, onsetEnvelope, autocorrLags } =
  new Function(code + '\nreturn {' + NAMES.join(',') + '};')();

const SR = 44100;
const R = [];
function ok(name, cond, extra) {
  R.push((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  [' + extra + ']' : ''));
}

/**
 * 合成一段鼓点：每小节第一拍重、其余弱（贴近真实伴奏的重拍结构），
 * 再叠加持续低频与白噪声，制造混叠伪影。
 * hats=true 时再加一路八分音符的 hi-hat —— 真实伴奏几乎都有，
 * 它是一个半拍周期的干扰源，只认四分音符的算法会被它带偏。
 */
function groove(bpm, opts = {}) {
  const { noise = 0.02, pad = 0.03, secs = 20, beats = 4, hats = false, soft = 1 } = opts;
  const n = SR * secs;
  const out = new Float32Array(n);
  const beatSec = 60 / bpm;
  const hit = (tSec, amp, tone) => {
    const s = Math.round(tSec * SR);
    const len = Math.round(SR * (0.012 + 0.02 * amp));
    for (let i = 0; i < len && s + i < n; i++) {
      const env = Math.exp(-i / (SR * 0.008));
      out[s + i] += amp * env * Math.sin((2 * Math.PI * tone * i) / SR);
    }
  };
  let t = 0.5, beat = 0;                       // 起拍前留半秒空白
  while (t < secs - 0.2) {
    const idx = beat % beats;
    hit(t, (idx === 0 ? 0.95 : (idx === 2 ? 0.45 : 0.35)) * soft, 110 + 40 * soft);
    if (hats) hit(t + beatSec / 2, 0.12, 320);   // 弱起的反拍，短促高频
    t += beatSec;
    beat++;
  }
  for (let i = 0; i < n; i++) {
    out[i] += pad * Math.sin((2 * Math.PI * 82 * i) / SR);
    out[i] += noise * (Math.random() * 2 - 1);
  }
  return out;
}

console.log('=== 自动测速精度检验（合成鼓点 + 2% 噪声 + 低频垫音） ===');

// 常见 BPM 区间：误差超过 3 就算没通过（自动测速给的是"建议值"，用户可以微调）。
// 素材带 2% 白噪声，所以每个速度重复 3 次不同的随机实现，任一次跑偏都算失败 ——
// 只跑一次的话很容易撞运气，看不出算法本身的稳定性。
for (const bpm of [72, 80, 90, 100, 108, 120, 128, 140, 152, 168]) {
  const got = [];
  for (let k = 0; k < 3; k++) got.push(detectBpmSamples(groove(bpm, { secs: 20 }), SR, 60));
  ok('识别出 ' + bpm + ' BPM（3 次随机实现）', got.every((g) => Math.abs(g - bpm) <= 3), 'got=' + got.join(','));
}

console.log('=== 恶劣条件下的稳定性 ===');
const harsh = [
  ['强噪声 8%', { noise: 0.08 }, 120],
  ['强低频垫音', { pad: 0.25 }, 120],
  ['只有 8 秒素材', { secs: 8 }, 120],
  ['3/4 拍', { beats: 3 }, 96],
  ['弱力度演奏', { soft: 0.45 }, 100],
  ['带反拍 hi-hat', { hats: true }, 120],
];
for (const [label, opts, bpm] of harsh) {
  const got = detectBpmSamples(groove(bpm, Object.assign({ secs: 20 }, opts)), SR, 60);
  ok(label + ' 仍能测准 ' + bpm, Math.abs(got - bpm) <= 3, 'got=' + got);
}

console.log('=== 该拒绝时要拒绝 ===');
ok('静音返回 0', detectBpmSamples(new Float32Array(SR * 6), SR, 60) === 0);
ok('素材不足 4 秒返回 0', detectBpmSamples(groove(120, { secs: 2 }), SR, 60) === 0);

console.log('=== 包络与候选周期的基本性质 ===');
const ch120 = groove(120, { secs: 20 });
const info = onsetEnvelope(ch120, SR, 60);
ok('包络帧率接近 86fps', Math.abs(info.fps - 86.13) < 1, 'fps=' + info.fps.toFixed(2));
let nz = 0;
for (let i = 0; i < info.env.length; i++) if (info.env[i] > 0) nz++;
const ratio = nz / info.env.length;
ok('包络足够稀疏（有 onset 的帧 < 45%）', ratio < 0.45, 'ratio=' + ratio.toFixed(3));
const lags = autocorrLags(info.env, info.fps);
ok('候选周期落在 50–220 BPM 对应的 lag 区间',
  lags.length > 0 && lags.every((l) => l >= Math.round((info.fps * 60) / 220) && l <= Math.round((info.fps * 60) / 50)),
  'lags=' + lags.join(','));

const t0 = Date.now();
detectBpmSamples(groove(120, { secs: 20 }), SR, 60);
const cost = Date.now() - t0;
ok('20 秒音频测速在 500ms 内完成', cost < 500, cost + 'ms');

console.log(R.join('\n'));
const fail = R.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n=== 断言汇总：${R.length - fail} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
