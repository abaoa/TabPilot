/* ==========================================================================
 * verify-render.mjs — 渲染打磨 / 兜底降级 的正确性检验
 *
 * 纯函数，脱离 DOM 也能测：
 *   image-tab.js: followStateMachine（Feature 18：跟奏状态机，绿/黄切换）
 *   app.js:        soundingKeyPc / rotateChroma（Feature 19：变调夹音高）
 *   app.js:        wrapLoopTime / loopBeatIndex（Feature 20：乐句循环 A/B 回绕）
 *
 * 运行：npm run verify:render
 * ========================================================================== */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const imgSrc = readFileSync(join(here, '..', 'public', 'js', 'image-tab.js'), 'utf8');
const appSrc = readFileSync(join(here, '..', 'public', 'js', 'app.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/** 按花括号配平从源码抽出函数体（与 verify-align 同款思路） */
function extract(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到函数: ' + name);
  for (let p = src.indexOf('{', start), depth = 0; p < src.length; p++) {
    if (src[p] === '{') depth++;
    else if (src[p] === '}') { depth--; if (depth === 0) return src.slice(start, p + 1); }
  }
  throw new Error('花括号未配平: ' + name);
}

const FOLLOW_LOCK = +imgSrc.match(/const FOLLOW_LOCK = ([\d.]+)/)[1];
const D = +imgSrc.match(/const FOLLOW_DEGRADE_TICKS = (\d+)/)[1];
const R = +imgSrc.match(/const FOLLOW_RECOVER_TICKS = (\d+)/)[1];
ok('常量：LOCK=0.4 / DEGRADE=12 / RECOVER=5', FOLLOW_LOCK === 0.4 && D === 12 && R === 5,
  `LOCK=${FOLLOW_LOCK} D=${D} R=${R}`);

const FSM = new Function(
  `const FOLLOW_LOCK=${FOLLOW_LOCK};const FOLLOW_DEGRADE_TICKS=${D};const FOLLOW_RECOVER_TICKS=${R};\n` +
  extract(imgSrc, 'followStateMachine') + '\nreturn followStateMachine;'
)();
ok('函数已抽取：followStateMachine', typeof FSM === 'function');

console.log('\n[Feature 18] followStateMachine 状态机');
// 1) 高匹配持续 → 保持 track
let s = 'track', g = 0, b = 0;
for (let i = 0; i < 20; i++) { const r = FSM(s, 0.9, g, b); s = r.state; g = r.good; b = r.bad; }
ok('连续高匹配保持 track', s === 'track' && g === 20 && b === 0, `state=${s} good=${g}`);

// 2) 一次性低分不降级
let r2 = FSM('track', 0.1, 20, 0);
ok('单个低分不立刻降级（需累计 D 次）', r2.state === 'track' && r2.bad === 1,
  `state=${r2.state} bad=${r2.bad}`);

// 3) 连续 D 次低分 → degrade
s = 'track'; g = 0; b = 0;
for (let i = 0; i < D; i++) { const r = FSM(s, 0.1, g, b); s = r.state; g = r.good; b = r.bad; }
ok(`连续 ${D} 次低分切到 degrade`, s === 'degrade', `state=${s}`);

// 4) degrade 中零星一次高匹配不立即恢复
let r4 = FSM('degrade', 0.9, 0, D);
ok('degrade 中单个高匹配不立刻恢复（需累计 R 次）', r4.state === 'degrade' && r4.good === 1,
  `state=${r4.state} good=${r4.good}`);

// 5) degrade 连续 R 次高匹配 → 恢复 track
s = 'degrade'; g = 0; b = D;
for (let i = 0; i < R; i++) { const r = FSM(s, 0.9, g, b); s = r.state; g = r.good; b = r.bad; }
ok(`degrade 连续 ${R} 次高匹配恢复 track`, s === 'track', `state=${s}`);

// 6) 阈值边界：恰好等于 LOCK 算"跟上"
let r6 = FSM('track', FOLLOW_LOCK, 5, 0);
ok('score 恰好等于 LOCK 视为跟上', r6.state === 'track' && r6.good === 6, `good=${r6.good}`);

// 7) 'off' 是 caller 管理的终态（startFollow/stopFollow 设置），运行期不会喂入；
//    FSM 对未知/非降级初态保守保持，不擅自切到 track（避免误亮绿灯）
let r7 = FSM('off', 0.9, 0, 0);
ok("'off' 终态被保守保持（运行期由 caller 用 'track' 启动）", r7.state === 'off', `state=${r7.state}`);

console.log('\n[Feature 19] 变调夹音高：soundingKeyPc / rotateChroma');
const soundingKeyPc = new Function(
  extract(appSrc, 'soundingKeyPc') + '\nreturn soundingKeyPc;'
)();
const rotateChroma = new Function(
  extract(appSrc, 'rotateChroma') + '\nreturn rotateChroma;'
)();
ok('函数已抽取：soundingKeyPc / rotateChroma',
  typeof soundingKeyPc === 'function' && typeof rotateChroma === 'function');

// C=0。原调 C + 移调 0 + 夹 0 → C
ok('C 原调无夹 = C', soundingKeyPc(0, 0, 0) === 0);
// C 夹 2 品 → 实际 D（=2）
ok('C 夹 2 品 = D(2)', soundingKeyPc(0, 0, 2) === 2);
// C 夹 3 + 移调 -3 → 回到 C（0+ -3 + 3 = 0）
ok('C 夹 3 + 移调 -3 = C(0)', soundingKeyPc(0, -3, 3) === 0);
// 环绕：B(11) 夹 2 品 → 1（D 的等价？应为 11+2=13%12=1）
ok('B(11) 夹 2 品环绕 = 1', soundingKeyPc(11, 0, 2) === 1);
// 移调 + 变调夹 同时叠加后环绕：原调 G(7) + 移调 5 + 夹 7 = (7+5+7)%12=7 → G
ok('G 移调5+夹7 环绕回 G(7)', soundingKeyPc(7, 5, 7) === 7);

// rotateChroma：单位脉冲旋转
const unit = new Float32Array(12); unit[0] = 1;
let rot = rotateChroma(unit, 0);
ok('rotate 0 不变', rot[0] === 1 && rot[1] === 0);
rot = rotateChroma(unit, 3);
ok('rotate +3 把能量移到第 3  bins', rot[3] === 1 && rot[0] === 0);
// 长度保持 12、能量守恒
let sum = 0; for (let i = 0; i < 12; i++) sum += rot[i];
ok('rotateChroma 保持长度 12 且能量守恒', rot.length === 12 && Math.abs(sum - 1) < 1e-6,
  `len=${rot.length} sum=${sum}`);
// 环绕旋转 12 = 不变
let rot12 = rotateChroma(unit, 12);
ok('rotate 12 = 不变', rot12[0] === 1);

console.log('\n[Feature 20] 乐句循环：wrapLoopTime / loopBeatIndex');
const wrapLoopTime = new Function(
  extract(appSrc, 'wrapLoopTime') + '\nreturn wrapLoopTime;'
)();
const loopBeatIndex = new Function(
  extract(appSrc, 'loopBeatIndex') + '\nreturn loopBeatIndex;'
)();
ok('函数已抽取：wrapLoopTime / loopBeatIndex',
  typeof wrapLoopTime === 'function' && typeof loopBeatIndex === 'function');

// 区间外时间绕回区间内对应位置：t=12s, A=5s, B=10s → 5+(12-5)%5=7s
ok('越过 B 绕回区间内（12s→7s）', wrapLoopTime(12000, 5000, 10000) === 7000);
// 恰在 A
ok('恰在 A 不变', wrapLoopTime(5000, 5000, 10000) === 5000);
// 区间内不变
ok('区间内不变（7s）', wrapLoopTime(7000, 5000, 10000) === 7000);
// 远超 B（多绕一圈仍正确）：t=22s → 5+(22-5)%5=5+17%5=5+2=7s
ok('多绕一圈仍正确（22s→7s）', wrapLoopTime(22000, 5000, 10000) === 7000);
// 非法区间（B<=A 或端点空）→ 原样返回
ok('B<=A 时原样返回', wrapLoopTime(12000, 9000, 5000) === 12000);
ok('端点为空时原样返回', wrapLoopTime(12000, null, 10000) === 12000);

// loopBeatIndex：升序时间表找“≤tgt”的最大下标
const times = [0, 500, 1000, 1500, 2000, 2500];
ok('tgt 恰为某拍 → 该下标', loopBeatIndex(times, 1500) === 3);
ok('tgt 在两拍之间 → 前一拍', loopBeatIndex(times, 1700) === 3);
ok('tgt 早于首拍 → 0', loopBeatIndex(times, -100) === 0);
ok('tgt 晚于末拍 → 末下标', loopBeatIndex(times, 99999) === 5);
ok('空表 → 0', loopBeatIndex([], 1234) === 0);

console.log(`\n断言汇总：通过 ${pass} / 失败 ${fail}`);
if (fail > 0) { console.error('有失败用例'); process.exit(1); }
console.log('全部通过 ✅');
