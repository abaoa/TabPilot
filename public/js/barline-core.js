/* ==========================================================================
 * barline-core.js — 图片谱小节线检测的纯函数集合
 *
 * 供 image-tab.js 使用，可在 jsdom 单测。只依赖标准 JS：
 * 输入是「像素数组 / 覆盖率数组 / 坐标数组」，不碰 canvas、不碰 DOM，
 * 因此浏览器、Tauri 壳、node 单测里行为完全一致。
 *
 * 检测思路（六线谱的行内小节线）：
 *   1. 对一行的谱线高度范围做**列投影**：统计每一列的暗像素覆盖率。
 *      小节线是贯穿整行的竖线，其所在列的覆盖率会接近 1。
 *   2. 覆盖率 ≥ 阈值（且谱线下沿外无明显延伸，以排除符杆）的列构成 mask。
 *   3. 把 mask 中连续的列合并成一根竖线（取中心），过宽的段是文字块要丢弃，
 *      间距过近的竖线合并（谱首括线、反复双竖线算一个边界）。
 *   4. 竖线 + 行左右端点 → 小节边界数组 → 行内按真实边界跟随（不再均分）。
 * ========================================================================== */
(function (g) {
  'use strict';

  /** 统一成普通数组（只读，不改动入参） */
  function toArr(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v.slice();
    if (typeof v.length === 'number') return Array.prototype.slice.call(v);
    return [];
  }

  /**
   * 列投影：统计矩形区域内每一列的暗像素覆盖率(0–1)。
   * @param {Uint8ClampedArray|Array<number>} data RGBA 序列（长度 >= w*h*4）
   * @param {number} w 图像宽
   * @param {number} h 图像高
   * @param {{x0:number,y0:number,x1:number,y1:number}} rect 感兴趣区（右下开区间）
   * @param {number} [thr=170] 灰度阈值，低于此算暗像素
   * @returns {Array<number>} 长度 = x1-x0 的覆盖率数组
   */
  function columnProjection(data, w, h, rect, thr) {
    if (!data || !w || !h || !rect) return [];
    const x0 = Math.max(0, Math.round(rect.x0));
    const x1 = Math.min(w, Math.round(rect.x1));
    const y0 = Math.max(0, Math.round(rect.y0));
    const y1 = Math.min(h, Math.round(rect.y1));
    if (x1 <= x0 || y1 <= y0) return [];
    const t = thr != null ? thr : 170;
    const rows = y1 - y0;
    const out = new Array(x1 - x0);
    for (let x = x0; x < x1; x++) {
      let c = 0;
      for (let y = y0; y < y1; y++) {
        const i = (y * w + x) * 4;
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (lum < t) c++;
      }
      out[x - x0] = c / rows;
    }
    return out;
  }

  /** 箱式平滑（radius=0 或 1 表示不平滑） */
  function smooth(arr, radius) {
    const a = toArr(arr);
    const r = Math.max(0, radius | 0);
    if (r <= 0 || a.length < 3) return a;
    const out = new Array(a.length);
    for (let i = 0; i < a.length; i++) {
      let s = 0;
      let n = 0;
      for (let k = -r; k <= r; k++) {
        const j = i + k;
        if (j < 0 || j >= a.length) continue;
        s += a[j];
        n++;
      }
      out[i] = n ? s / n : a[i];
    }
    return out;
  }

  /**
   * 局部极大值（支持平台：连续相等取中点）。
   * 注：整段全等（无任何起伏）不算峰——否则平坦谱面会在正中冒出一条假竖线。
   * @param {Array<number>} arr
   * @param {{minVal?:number, minGap?:number}} [opts]
   *   minVal 峰值下限（低于此不要）；minGap 相邻峰的最小间距，过近保留更高的
   * @returns {Array<{i:number,v:number}>} 按下标升序
   */
  function localMaxima(arr, opts) {
    const o = opts || {};
    const minVal = o.minVal != null ? o.minVal : 0;
    const minGap = Math.max(1, o.minGap != null ? o.minGap : 1);
    const a = toArr(arr);
    const cands = [];
    let i = 0;
    while (i < a.length) {
      let j = i;
      while (j + 1 < a.length && a[j + 1] === a[i]) j++;      // 平台段
      const v = a[i];
      const wholeFlat = i === 0 && j === a.length - 1;         // 全序列无起伏
      const leftOK = i === 0 || a[i - 1] < v;
      const rightOK = j === a.length - 1 || a[j + 1] < v;
      if (!wholeFlat && leftOK && rightOK && v >= minVal) {
        cands.push({ i: Math.floor((i + j) / 2), v });
      }
      i = j + 1;
    }
    if (cands.length <= 1) return cands;
    const out = [];
    for (const c of cands) {
      const last = out[out.length - 1];
      if (last && c.i - last.i < minGap) {
        if (c.v > last.v) out[out.length - 1] = c;             // 过近保留更高的
      } else {
        out.push(c);
      }
    }
    return out;
  }

  /**
   * 从二值 mask（1=该列是一根竖线的候选）提取竖线中心 x。
   * @param {Array<number>|Uint8Array} mask
   * @param {{maxRun?:number, mergeGap?:number}} [opts]
   *   maxRun 连续候选列的最大宽度，超过视为文字块丢弃（默认 5）
   *   mergeGap 相邻竖线小于该距离则合并（默认 20，谱首括线/反复双竖线算一个边界）
   * @returns {Array<number>} 升序的竖线 x（相对 mask 起点）
   */
  function linesFromMask(mask, opts) {
    const o = opts || {};
    const maxRun = o.maxRun != null ? o.maxRun : 5;
    const mergeGap = o.mergeGap != null ? o.mergeGap : 20;
    const a = toArr(mask);

    const raw = [];
    let x0 = -1;
    for (let x = 0; x <= a.length; x++) {
      const on = x < a.length && Number(a[x]) > 0;
      if (on) {
        if (x0 < 0) x0 = x;
      } else if (x0 >= 0) {
        if (x - x0 <= maxRun) raw.push(Math.round((x0 + x - 1) / 2));
        x0 = -1;
      }
    }

    const out = [];
    for (const x of raw) {
      const last = out[out.length - 1];
      if (last != null && x - last < mergeGap) out[out.length - 1] = Math.round((last + x) / 2);
      else out.push(x);
    }
    return out;
  }

  /**
   * 由「行内竖线」+「行左右端点」拼出小节边界数组。
   * 会丢弃离端点过近的线、过窄的间隔，并保证首尾就是行的两个端点。
   * @param {Array<number>} lines 行内竖线 x（无需预先排序）
   * @param {number} x0 行左端点
   * @param {number} x1 行右端点
   * @param {number} [minBarWidth=0] 最小小节宽度(px)
   * @returns {Array<number>} 升序边界数组，长度 ≥ 2；小节数 = 长度 − 1
   */
  function barBounds(lines, x0, x1, minBarWidth) {
    const mw = Math.max(0, minBarWidth || 0);
    const lo = Math.min(x0, x1);
    const hi = Math.max(x0, x1);
    const src = (Array.isArray(lines) ? lines.slice() : []).sort((a, b) => a - b);
    const out = [lo];
    for (const x of src) {
      if (x <= lo + mw || x >= hi - mw) continue;             // 贴着端点的线没意义
      if (x - out[out.length - 1] < mw) continue;             // 间隔太窄
      out.push(x);
    }
    if (hi - out[out.length - 1] < mw && out.length > 1) out[out.length - 1] = hi;
    else out.push(hi);
    return out;
  }

  /**
   * 取第 barIdx 个小节的左右边界（行级跟随用）。
   * 越界的 barIdx 会被夹到有效范围，边界不足返回 null 让调用方回退均分。
   * @returns {{a:number,b:number,index:number,count:number}|null}
   */
  function barBoundsAt(bounds, barIdx) {
    if (!bounds || bounds.length < 2) return null;
    const count = bounds.length - 1;
    const i = Math.max(0, Math.min(count - 1, barIdx | 0));
    return { a: bounds[i], b: bounds[i + 1], index: i, count };
  }

  const api = {
    toArr,
    columnProjection,
    smooth,
    localMaxima,
    linesFromMask,
    barBounds,
    barBoundsAt,
  };
  if (typeof window !== 'undefined') window.BarlineCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  g.BarlineCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
