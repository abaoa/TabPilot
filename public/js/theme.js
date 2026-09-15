/* ==========================================================================
 * theme.js — 主题早期注入（防闪烁）
 *
 * 必须在 <head> 中以同步方式加载，且不能加 defer：
 * 浏览器解析到 <body> 前就要确定 data-theme，否则深色用户会在首屏看到一帧
 * 白底，产生明显的闪烁（FOUC）。
 *
 * 对外暴露 window.TPTheme：
 *   - resolve(mode)  把 'auto' 解析为 'light' / 'dark'
 *   - set(mode)      立即应用某个模式
 *   - get()          当前已生效的主题（light / dark）
 * ========================================================================== */
'use strict';

(function () {
  /** localStorage 键名，与 settings.js 保持一致 */
  var STORAGE_KEY = 'tabpilot.settings.v1';
  /** 深色模式媒体查询 */
  var DARK_QUERY = '(prefers-color-scheme: dark)';

  /** 读取用户已保存的主题模式，默认 auto（跟随系统） */
  function readMode() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      var saved = raw ? JSON.parse(raw) : null;
      if (saved && saved.theme) return saved.theme;
    } catch (e) { /* 隐私模式或存储被禁用：忽略，回落到 auto */ }
    return 'auto';
  }

  /** 把 'auto' 解析成具体的 'light' / 'dark' */
  function resolve(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    try {
      return window.matchMedia && window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
    } catch (e) {
      return 'light';
    }
  }

  var mode = readMode();
  document.documentElement.setAttribute('data-theme', resolve(mode));

  window.TPTheme = {
    resolve: resolve,
    /** 应用主题模式；mode 可为 light / dark / auto */
    set: function (next) {
      mode = next;
      document.documentElement.setAttribute('data-theme', resolve(mode));
    },
    /** 当前真正生效的主题 */
    get: function () {
      return document.documentElement.getAttribute('data-theme') || 'light';
    },
    /** 系统深色偏好变化时（仅在 auto 模式下需要响应） */
    onSystemChange: function (fn) {
      try {
        var mq = window.matchMedia(DARK_QUERY);
        var handler = function () { fn(resolve(mode)); };
        if (mq.addEventListener) mq.addEventListener('change', handler);
        else if (mq.addListener) mq.addListener(handler);
      } catch (e) { /* 不支持 matchMedia：忽略 */ }
    },
  };
})();
