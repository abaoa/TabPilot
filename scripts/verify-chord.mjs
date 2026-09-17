/* ==========================================================================
 * verify-chord.mjs — 和弦识别核心(chord-core.js)单测
 *
 * 直接以 Function 方式加载 chord-core.js（UMD：无 window 时落到 globalThis），
 * 取回 ChordCore.chordDetect 等纯函数验证。覆盖：
 *   · 各类和弦的准确识别（大/小/属七/大七/小七/减/增/sus）
 *   · 静音/全零 → null
 *   · 不确定（低于阈值）标记 uncertain
 *   · 音高八度/转位不变性（同和弦不同把位同结果）
 *   · 真实感混合（带轻微非和弦音）仍识别正确
 *   · rotateChromaTo / chordName 辅助
 * ========================================================================== */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'public', 'js', 'chord-core.js');

const src = readFileSync(SRC, 'utf8');
const ChordCore = new Function(src + '\nreturn globalThis.ChordCore;')();
const { chordDetect, chordName, rotateChromaTo, NOTE } = ChordCore;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')); }
}

/** 构造一个只在指定音级有能量的 12 维 chroma（模拟该和弦的基频集合） */
function chromaOf(pcs, weights) {
  const v = new Array(12).fill(0);
  pcs.forEach((pc, i) => { v[pc] = weights ? (weights[i] || 1) : 1; });
  return v;
}

console.log('=== 和弦识别核心检验 ===');

// ---- 1) 各类基础和弦准确识别 ----
// 直接用和弦类型表推导音级集合，避免手写音级出错：pcs = (root + 音级) % 12
const TEST_SET = [
  { root: 0,  type: 'maj' },   // C
  { root: 9,  type: 'min' },   // Am
  { root: 7,  type: '7' },     // G7
  { root: 5,  type: 'maj7' },  // Fmaj7
  { root: 11, type: 'min7' },  // Bm7
  { root: 0,  type: 'dim' },   // Cdim
  { root: 0,  type: 'aug' },   // Caug
  { root: 0,  type: 'sus2' },  // Csus2
  { root: 0,  type: 'sus4' },  // Csus4
  { root: 2,  type: 'm7b5' },  // Dm7b5
];
for (const c of TEST_SET) {
  const T = ChordCore.CHORD_TYPES.find((x) => x.type === c.type);
  const pcs = T.iv.map((d) => (c.root + d) % 12);
  const exp = ChordCore.chordName(c.root, c.type);
  const det = chordDetect(chromaOf(pcs));
  ok('识别 ' + exp + ' → ' + (det ? det.name : 'null'),
    det && det.name === exp && det.type === c.type,
    det ? ('got=' + det.name) : 'null');
}

// ---- 2) 静音 / 全零 → null ----
ok('静音(null) → null', chordDetect(new Array(12).fill(0)) === null);
ok('全零 Float32Array → null', chordDetect(new Float32Array(12)) === null);

// ---- 3) 八度/转位不变性：同一和弦不同「把位」（音级集合相同）结果一致 ----
const c1 = chordDetect(chromaOf([0, 4, 7]));
const c2 = chordDetect(chromaOf([12 % 12, 16 % 12, 19 % 12]));   // 高八度，音级相同
ok('八度不变性：C 与高八度 C 同结果', c1 && c2 && c1.name === c2.name && c1.name === 'C',
  c1 && c2 ? (c1.name + '/' + c2.name) : 'null');

// ---- 4) 真实感混合：带轻微非和弦音仍识别正确 ----
const mixed = chromaOf([0, 4, 7, 1, 6], [1, 1, 1, 0.08, 0.08]);  // C 和弦 + 轻微二度/三全音
const dm = chordDetect(mixed);
ok('混合微噪仍能识别 C', dm && dm.name === 'C', dm ? ('got=' + dm.name + ' score=' + dm.score.toFixed(3)) : 'null');

// ---- 5) 不确定标记：能量分散（全 12 音等能量）应 uncertain 或低分 ----
const flat = chromaOf([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], new Array(12).fill(1));
const df = chordDetect(flat);
ok('均匀白噪标记为 uncertain 或低分', df === null || df.uncertain === true || df.score < 0.6,
  df ? ('score=' + df.score.toFixed(3) + ' uncertain=' + !!df.uncertain) : 'null');

// ---- 6) 阈值可调：调高阈值后标准 C 仍应确定 ----
const detHi = chordDetect(chromaOf([0, 4, 7]), { threshold: 0.95 });
ok('标准 C 在 0.95 阈值下仍确定', detHi && !detHi.uncertain && detHi.name === 'C',
  detHi ? ('score=' + detHi.score.toFixed(3)) : 'null');

// ---- 7) 辅助函数 ----
ok('chordName(9,"min") = "Am"', chordName(9, 'min') === 'Am');
ok('rotateChromaTo 把根音 0 能量移到 0 号位',
  rotateChromaTo([0,0,0,0,0,0,0,0,0,1,0,0], 9)[0] === 1);   // A(9) 能量移到 0
ok('NOTE 长度 12', NOTE.length === 12);

console.log(`\n断言汇总：通过 ${pass} / 失败 ${fail}`);
if (fail > 0) { console.error('存在失败用例'); process.exit(1); }
console.log('全部通过 ✅');
