/* ==========================================================================
 * chord-core.js — 和弦识别纯函数
 *
 * 谱面模式(app.js) 与 图片谱模式(image-tab.js) 共用，可在 jsdom 单测。
 * 输入：12 维色度向量(chroma)，能量归一化与否皆可。
 * 输出：chordDetect(chroma) -> { root, type, name, score, uncertain? } | null
 *       null 表示静音/全零；uncertain 表示相似度低于阈值、不可靠。
 *
 * 设计要点：
 *   · 对每个候选根音 r，把 chroma 旋转到「根音落在 0 号位」，再与各和弦模板
 *     做加权点积；取最大者。
 *   · 模板权重：和弦音 +1，个别强不协和音(大二度/三全音)给轻惩罚，帮助区分
 *     大/小与各类七和弦。
 *   · 真实弹唱和弦识别只能给「最可能」的结果，阈值用来标记不确定，下游
 *     据此显示「—」而非瞎猜。
 * ========================================================================== */
(function (g) {
  'use strict';

  /** 12 个根音名（升号写法，足够展示和弦名） */
  const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  /** 和弦类型表：相对根音的半音集合（音级）与展示后缀 */
  const CHORD_TYPES = [
    { type: 'maj',  iv: [0, 4, 7],       suf: '' },
    { type: 'min',  iv: [0, 3, 7],       suf: 'm' },
    { type: 'dim',  iv: [0, 3, 6],       suf: 'dim' },
    { type: 'aug',  iv: [0, 4, 8],       suf: 'aug' },
    { type: 'sus2', iv: [0, 2, 7],       suf: 'sus2' },
    { type: 'sus4', iv: [0, 5, 7],       suf: 'sus4' },
    { type: 'maj7', iv: [0, 4, 7, 11],   suf: 'maj7' },
    { type: 'min7', iv: [0, 3, 7, 10],   suf: 'm7' },
    { type: '7',    iv: [0, 4, 7, 10],   suf: '7' },    // 属七
    { type: 'm7b5', iv: [0, 3, 6, 10],   suf: 'm7b5' },
  ];

  // 预生成模板（只需音级集合 + 后缀）
  const TEMPLATES = CHORD_TYPES.map((t) => ({ type: t.type, suf: t.suf, iv: t.iv }));

  /** 把 chroma 旋转 r 个半音（让根音 r 的能量落到 0 号位） */
  function rotateChromaTo(chroma, r) {
    const out = new Array(12).fill(0);
    for (let i = 0; i < 12; i++) out[i] = chroma[(i + r) % 12];
    return out;
  }

  /** L2 归一化为单位向量（全零返回全零） */
  function norm(v) {
    let s = 0;
    for (const x of v) s += x * x;
    s = Math.sqrt(s);
    if (s <= 0) return v.map(() => 0);
    return v.map((x) => x / s);
  }

  /**
   * 核心识别。
   * 评分：score = on − LAMBDA·off − SIZE·(音数−3)
   *   · on / off = 落在和弦音 / 和弦外音的能量（chroma 已归一化，on+off≈1）
   *   · SIZE 给扩展和弦（7/9…）轻微复杂度惩罚，避免「冒领」三和弦
   *   · 这样能量高度集中在和弦音上时才给高分，白噪/分散音自然低于阈值
   * @param {Array<number>|Float32Array} chroma 12 维色度
   * @param {{threshold?:number,lambda?:number,sizePenalty?:number}} [opts]
   * @returns {{root:number,type:string,name:string,score:number,uncertain?:boolean}|null}
   */
  function chordDetect(chroma, opts) {
    opts = opts || {};
    const arr = (chroma instanceof Float32Array || Array.isArray(chroma)) ? Array.from(chroma) : [];
    const n = norm(arr);
    let energy = 0;
    for (const x of n) energy += x * x;
    if (energy <= 1e-9) return null;                       // 静音 / 全零

    const LAMBDA = opts.lambda != null ? opts.lambda : 0.35;
    const SIZE = opts.sizePenalty != null ? opts.sizePenalty : 0.1;
    const ROOT = opts.rootBias != null ? opts.rootBias : 0.18;   // 根音在场才给满分，避免被子集冒领

    let best = null;
    for (let r = 0; r < 12; r++) {
      const rot = rotateChromaTo(n, r);
      for (const T of TEMPLATES) {
        const set = new Set(T.iv);
        let on = 0, off = 0;
        for (let i = 0; i < 12; i++) {
          if (set.has(i)) on += rot[i];
          else off += rot[i];
        }
        // 根音在场给正偏置；不在场给等值负偏置（让「含根音的匹配」胜出）
        const rootBias = (rot[0] > 1e-6 ? ROOT : -ROOT) * Math.min(1, on + 0.001);
        const score = on - LAMBDA * off - SIZE * Math.max(0, T.iv.length - 3) + rootBias;
        if (!best || score > best.score) {
          best = { root: r, type: T.type, name: NOTE[r] + T.suf, score };
        }
      }
    }

    const thr = opts.threshold != null ? opts.threshold : 0.45;
    if (best.score < thr) {
      return { root: best.root, type: best.type, name: best.name, score: best.score, uncertain: true };
    }
    return best;
  }

  /** 由根音与类型拼出和弦名 */
  function chordName(root, type) {
    const t = CHORD_TYPES.find((x) => x.type === type);
    return NOTE[root] + (t ? t.suf : '');
  }

  /** 两和弦是否同根同性质 */
  function sameChord(a, b) {
    if (!a || !b) return false;
    return a.root === b.root && a.type === b.type;
  }

  const api = { NOTE, CHORD_TYPES, TEMPLATES, rotateChromaTo, norm, chordDetect, chordName, sameChord };
  if (typeof window !== 'undefined') window.ChordCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  g.ChordCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
