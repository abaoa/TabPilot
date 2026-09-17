/* ==========================================================================
 * timing-core.js — 演奏录音复盘：节奏偏差分析的纯函数集合
 *
 * 谱面模式(app.js) 与 图片谱模式(image-tab.js) 共用，可在 jsdom 单测。
 * 只依赖标准 JS：不碰 DOM、不碰 Web Audio，输入输出都是普通数组/数字，
 * 因此浏览器、Tauri 壳、node 单测里行为完全一致。
 *
 * 复盘流程（由调用方串起来）：
 *   1. 录音  → PCM（Float32Array）
 *   2. envelopeFromPcm(pcm, hop)          → 逐帧 RMS 能量包络
 *   3. impulseEnv(beatTimes, dt, total)   → 由拍点生成的理想参考包络
 *   4. computeTimingDeviation(ref, rec, beatTimes, opts)
 *                                          → 每拍偏差 + 汇总
 *
 * 偏差约定（重要）：
 *   · offset > 0 表示「整段录音比参考晚」（常见于起录时机、设备延迟），
 *     它在 computeTimingDeviation 内部被扣除。
 *   · 每拍 deviation = 实际峰值时刻 − offset − 该拍理论时刻
 *     → 正 = 拖拍（弹晚了），负 = 抢拍（弹早了）。
 *     反映的局部抖动/系统性抢拖，不受整段录音起始偏移影响。
 * ========================================================================== */
(function (g) {
  'use strict';

  /** 把 Float32Array / 类数组统一成普通数组（后续只读，不改动入参） */
  function toArr(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v.slice();
    if (typeof v.length === 'number') return Array.prototype.slice.call(v);
    return [];
  }

  /** 最大值（空数组返回 0） */
  function maxOf(a) {
    let m = 0;
    for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
    return m;
  }

  /** 去均值 + 除标准差的 z-score，供归一化互相关使用 */
  function zscore(a) {
    const n = a.length;
    if (!n) return [];
    let mu = 0;
    for (let i = 0; i < n; i++) mu += a[i];
    mu /= n;
    let v = 0;
    for (let i = 0; i < n; i++) { const d = a[i] - mu; v += d * d; }
    v /= n;
    const sd = Math.sqrt(v);
    if (!(sd > 1e-12)) return a.map(() => 0);      // 常量序列没有相关性可言
    return a.map((x) => (x - mu) / sd);
  }

  /**
   * PCM → RMS 能量包络。
   * @param {Array<number>|Float32Array} pcm 单声道采样
   * @param {number} [hop=512] 每帧采样数
   * @returns {Array<number>} 逐帧 RMS
   */
  function envelopeFromPcm(pcm, hop) {
    const a = toArr(pcm);
    const h = Math.max(1, hop || 512);
    const n = Math.floor(a.length / h);
    const out = new Array(n);
    for (let f = 0; f < n; f++) {
      let s = 0;
      const base = f * h;
      for (let i = 0; i < h; i++) { const x = a[base + i]; s += x * x; }
      out[f] = Math.sqrt(s / h);
    }
    return out;
  }

  /** 包络归一化到 [0,1]（全零保持全零） */
  function normalizeEnv(env) {
    const a = toArr(env);
    const m = maxOf(a);
    if (m <= 0) return a.map(() => 0);
    return a.map((x) => x / m);
  }

  /**
   * 由拍点时刻生成理想参考包络：每个拍点放一个指数衰减脉冲（峰值 1）。
   * 谱面没有现成音频时，用它充当「标准答案」跟录音包络做互相关。
   * @param {Array<number>} beatTimes 拍点时刻（秒）
   * @param {number} dt 帧长（秒）
   * @param {number} totalSec 包络总时长（秒）
   * @param {number} [decaySec=0.15] 衰减时长（秒）
   */
  function impulseEnv(beatTimes, dt, totalSec, decaySec) {
    const step = dt > 0 ? dt : 0.01;
    const n = Math.max(1, Math.ceil((totalSec > 0 ? totalSec : 0) / step) + 1);
    const env = new Array(n).fill(0);
    const decay = decaySec != null ? decaySec : 0.15;
    const len = Math.max(1, Math.round(decay / step));
    const beats = Array.isArray(beatTimes) ? beatTimes : [];
    for (let b = 0; b < beats.length; b++) {
      const c = Math.round(beats[b] / step);
      for (let k = 0; k < len; k++) {
        const i = c + k;
        if (i < 0) continue;
        if (i >= n) break;
        const v = Math.exp((-3 * k) / len);
        if (v > env[i]) env[i] = v;
      }
    }
    return env;
  }

  /**
   * 归一化互相关：求使 recEnv[i + lag] 最贴合 refEnv[i] 的 lag（帧）。
   * lag > 0 表示录音整体比参考晚（拖）；lag < 0 表示提前。
   * @param {number} maxLagFrames 最大搜索帧数（>=0）
   */
  function findBestLag(refEnv, recEnv, maxLagFrames) {
    const a = zscore(toArr(refEnv));
    const b = zscore(toArr(recEnv));
    const L = Math.max(0, Math.round(maxLagFrames || 0));
    if (!a.length || !b.length) return 0;
    let bestLag = 0;
    let bestScore = -Infinity;
    for (let lag = -L; lag <= L; lag++) {
      let s = 0;
      let n = 0;
      for (let i = 0; i < a.length; i++) {
        const j = i + lag;
        if (j < 0 || j >= b.length) continue;
        s += a[i] * b[j];
        n++;
      }
      if (n < 8) continue;                       // 重叠太短不作数
      const score = s / n;
      if (score > bestScore) { bestScore = score; bestLag = lag; }
    }
    return bestLag;
  }

  /**
   * 汇总每拍偏差。
   * @param {Array<{deviation:number,missed:boolean,beat:number}>} beats
   * @param {number} toleranceSec 判定「准」的容差（秒）
   */
  function summarizeDeviations(beats, toleranceSec) {
    const tol = toleranceSec != null ? toleranceSec : 0.05;
    const list = Array.isArray(beats) ? beats : [];
    let maxAbs = -1;
    let sum = 0;
    let cnt = 0;
    let good = 0;
    let worst = -1;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (!b || b.missed) continue;
      const d = Math.abs(b.deviation);
      if (d > maxAbs) { maxAbs = d; worst = b.beat != null ? b.beat : i; }
      sum += d;
      cnt++;
      if (d <= tol) good++;
    }
    if (!cnt) return { maxAbs: 0, meanAbs: 0, worstBeat: -1, accuracy: 0, counted: 0 };
    return {
      maxAbs,
      meanAbs: sum / cnt,
      worstBeat: worst,
      accuracy: good / cnt,
      counted: cnt,
    };
  }

  /**
   * 核心：比对参考包络与录音包络，给出每拍的节奏偏差。
   *
   * @param {Array<number>|Float32Array} referenceEnv 参考包络（等间隔帧能量）
   * @param {Array<number>|Float32Array} recordedEnv  录音包络（等间隔帧能量）
   * @param {Array<number>} beatTimes   拍点理论时刻（秒），升序
   * @param {Object} [opts]
   * @param {number} [opts.dt=0.01]          帧长（秒）
   * @param {number} [opts.maxLagSec=0.6]    全局偏移搜索范围（秒）
   * @param {number} [opts.windowSec=0.18]   每拍找峰的窗口半宽（秒）
   * @param {number} [opts.toleranceSec=0.05] 判定「弹准」的容差（秒）
   * @param {number} [opts.silenceRatio=0.06] 低于录音峰值该比例视为漏弹
   * @returns {{dt:number, offset:number, beats:Array, maxAbs:number,
   *            meanAbs:number, worstBeat:number, accuracy:number, counted:number}}
   */
  function computeTimingDeviation(referenceEnv, recordedEnv, beatTimes, opts) {
    const o = opts || {};
    const dt = o.dt != null && o.dt > 0 ? o.dt : 0.01;
    const maxLagSec = o.maxLagSec != null ? o.maxLagSec : 0.6;
    const windowSec = o.windowSec != null ? o.windowSec : 0.18;
    const toleranceSec = o.toleranceSec != null ? o.toleranceSec : 0.05;
    const silenceRatio = o.silenceRatio != null ? o.silenceRatio : 0.06;

    const refArr = toArr(referenceEnv);
    const recArr = toArr(recordedEnv);
    const beatArr = Array.isArray(beatTimes) ? beatTimes.slice() : [];

    if (!refArr.length || !recArr.length || !beatArr.length) {
      return {
        dt, offset: 0, beats: [], maxAbs: 0, meanAbs: 0,
        worstBeat: -1, accuracy: 0, counted: 0,
      };
    }

    // 1) 全局对齐：互相关求整段录音相对参考的延迟
    const maxLag = Math.round(maxLagSec / dt);
    const lag = findBestLag(refArr, recArr, maxLag);
    const offset = lag * dt;

    // 2) 每拍在「理论时刻 + 全局偏移」附近找能量峰
    const halfWin = Math.max(1, Math.round(windowSec / dt));
    const recPeak = maxOf(recArr);
    // 全静音时阈值取 Infinity，让每一拍都判定为漏弹
    const silenceThr = recPeak > 0 ? recPeak * silenceRatio : Infinity;

    const out = [];
    for (let b = 0; b < beatArr.length; b++) {
      const bt = beatArr[b];
      const center = Math.round((bt + offset) / dt);
      const lo = Math.max(0, center - halfWin);
      const hi = Math.min(recArr.length - 1, center + halfWin);
      let bestIdx = -1;
      let bestVal = -Infinity;
      for (let i = lo; i <= hi; i++) {
        if (recArr[i] > bestVal) { bestVal = recArr[i]; bestIdx = i; }
      }
      const detectedTime = bestIdx >= 0 ? bestIdx * dt : bt;
      out.push({
        beat: b,
        beatTime: bt,
        detectedTime,
        // 扣掉全局偏移，剩下的才是这一拍自己的抢/拖
        deviation: detectedTime - offset - bt,
        missed: !(bestVal >= silenceThr),
      });
    }

    const sum = summarizeDeviations(out, toleranceSec);
    return {
      dt,
      offset,
      beats: out,
      maxAbs: sum.maxAbs,
      meanAbs: sum.meanAbs,
      worstBeat: sum.worstBeat,
      accuracy: sum.accuracy,
      counted: sum.counted,
    };
  }

  const api = {
    toArr,
    maxOf,
    zscore,
    envelopeFromPcm,
    normalizeEnv,
    impulseEnv,
    findBestLag,
    summarizeDeviations,
    computeTimingDeviation,
  };
  if (typeof window !== 'undefined') window.TimingCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  g.TimingCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
