/* ==========================================================================
 * settings.js — 用户设置：持久化、变更通知与设置抽屉 UI
 *
 * 设计要点：
 *  1. 单一数据源：所有设置存在 localStorage 的 'tabpilot.settings.v1' 下，
 *     本模块是唯一读写入口，页面脚本通过 onChange 订阅变更，避免各页面
 *     各自维护一份状态导致不同步。
 *  2. 设置抽屉由本模块动态创建并挂到 <body>，谱面模式与图片谱模式共用，
 *     页面只需提供 #btnSettings 触发按钮与一个挂载点。
 *  3. 主题项会同时驱动 window.TPTheme（见 theme.js）。
 *
 * 用法（页面脚本）：
 *     TPSettings.mount();                       // 创建抽屉
 *     TPSettings.onChange((s, key) => { ... }); // 订阅并应用到本页
 *     apply(TPSettings.all());                  // 启动时先应用一次
 *
 * ⚠️ APP_VERSION 需与 package.json、src-tauri/tauri.conf.json 保持同步。
 * ========================================================================== */
'use strict';

window.TPSettings = (function () {
  /** localStorage 键名 */
  var STORAGE_KEY = 'tabpilot.settings.v1';
  /** 应用版本号（同步维护：package.json / tauri.conf.json / 此处） */
  var APP_VERSION = '1.0.0';
  /** 项目主页 */
  var APP_REPO = 'https://github.com/abaoa/TabPilot';

  /** 默认设置；新增设置项时只需在此登记，抽屉与存储逻辑自动生效 */
  var DEFAULTS = {
    theme: 'auto',      // 主题模式：auto | light | dark
    rate: 100,          // 默认跟随速度百分比（50–150 = 0.5×–1.5×）
    gate: -72,          // 麦克风噪声门（dB，-90 – -40）
    zoom: 100,          // 谱面缩放百分比（60–160）
    magnifier: false,   // 是否默认开启放大镜
    showHints: true,    // 是否显示底部操作提示
    startMeasure: 1,    // 图片谱：全局起始小节号（影响谱行旁的小节标注）
    viewMode: 'flip',   // 图片谱视图：翻页 flip | 滚动 scroll（整谱纵向长图自动滚动）
    transpose: 0,       // 谱面模式：移调半音数（-12 – +12，0 = 原调）
  };

  var state = load();
  var listeners = [];
  var ui = {};          // 抽屉内控件引用

  /** 读取并合并默认值（兼容旧版本缺字段的情况） */
  function load() {
    var out = {};
    for (var k in DEFAULTS) out[k] = DEFAULTS[k];
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      var saved = raw ? JSON.parse(raw) : null;
      if (saved) {
        for (var key in DEFAULTS) {
          if (Object.prototype.hasOwnProperty.call(saved, key) && saved[key] != null) {
            out[key] = saved[key];
          }
        }
      }
    } catch (e) { /* 存储不可用：使用默认值 */ }
    return out;
  }

  /** 持久化当前设置 */
  function persist() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) { /* 隐私模式下写入失败：仅本次会话有效 */ }
  }

  /** 读取全部设置（返回副本，防止外部直接修改内部状态） */
  function all() {
    var copy = {};
    for (var k in state) copy[k] = state[k];
    return copy;
  }

  function get(key) {
    return state[key];
  }

  /** 写入单项并通知订阅者 */
  function set(key, value) {
    if (state[key] === value) return;
    state[key] = value;
    if (key === 'theme' && window.TPTheme) window.TPTheme.set(value);
    persist();
    for (var i = 0; i < listeners.length; i++) listeners[i](all(), key);
    syncUI();
  }

  /** 恢复默认设置 */
  function reset() {
    state = {};
    for (var k in DEFAULTS) state[k] = DEFAULTS[k];
    if (window.TPTheme) window.TPTheme.set(state.theme);
    persist();
    for (var i = 0; i < listeners.length; i++) listeners[i](all(), '*');
    syncUI();
  }

  /** 订阅变更；fn(all, changedKey)，'*' 表示整体重置 */
  function onChange(fn) {
    listeners.push(fn);
  }

  /* ------------------------------------------------------------------ UI */

  /** 创建元素的小工具 */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** 字段行：左侧标题 + 说明，右侧控件 */
  function field(label, desc, control) {
    var row = el('div', 'field');
    var text = el('div', 'field-text');
    text.appendChild(el('div', 'field-label', label));
    if (desc) text.appendChild(el('div', 'field-desc', desc));
    var ctl = el('div', 'field-ctl');
    ctl.appendChild(control);
    row.appendChild(text);
    row.appendChild(ctl);
    return row;
  }

  /** 分段选择器：主题三态 */
  function themeSeg() {
    var seg = el('div', 'seg');
    var opts = [
      { v: 'light', t: '浅色' },
      { v: 'dark', t: '深色' },
      { v: 'auto', t: '跟随系统' },
    ];
    ui.themeBtns = {};
    opts.forEach(function (o) {
      var b = el('button', null, o.t);
      b.type = 'button';
      b.onclick = function () { set('theme', o.v); };
      ui.themeBtns[o.v] = b;
      seg.appendChild(b);
    });
    return seg;
  }

  /** 滑杆控件：变化时把值写回设置 */
  function rangeCtl(key, min, max, step, fmt) {
    var wrap = el('span', 'slider');
    var input = document.createElement('input');
    input.type = 'range';
    input.min = min;
    input.max = max;
    input.step = step;
    var val = el('b', null, '');
    input.oninput = function () { set(key, parseInt(input.value, 10)); };
    wrap.appendChild(input);
    wrap.appendChild(val);
    ui[key] = { input: input, val: val, fmt: fmt };
    return wrap;
  }

  /** 开关控件 */
  function switchCtl(key) {
    var label = el('span', 'switch');
    var input = document.createElement('input');
    input.type = 'checkbox';
    var track = document.createElement('i');
    input.onchange = function () { set(key, input.checked); };
    label.appendChild(input);
    label.appendChild(track);
    ui[key] = { input: input };
    return label;
  }

  /** 把当前设置同步到抽屉控件（外部改值时也不会脱节） */
  function syncUI() {
    if (!ui.themeBtns) return;                       // 抽屉尚未创建
    for (var v in ui.themeBtns) {
      ui.themeBtns[v].classList.toggle('on', state.theme === v);
    }
    ['rate', 'gate', 'zoom'].forEach(function (k) {
      var c = ui[k];
      if (!c) return;
      c.input.value = state[k];
      c.val.textContent = c.fmt(state[k]);
    });
    ['magnifier', 'showHints'].forEach(function (k) {
      if (ui[k]) ui[k].input.checked = !!state[k];
    });
  }

  /** 打开 / 关闭抽屉 */
  function setOpen(open) {
    if (!ui.drawer) return;
    ui.drawer.classList.toggle('on', open);
    ui.overlay.classList.toggle('on', open);
    var btn = document.getElementById('btnSettings');
    if (btn) btn.classList.toggle('active', open);
    if (open) syncUI();
  }

  function isOpen() {
    return !!(ui.drawer && ui.drawer.classList.contains('on'));
  }

  /** 构建并挂载设置抽屉 */
  function mount() {
    if (ui.drawer) return;                            // 幂等：只创建一次

    /* 遮罩：点击关闭 */
    var overlay = el('div', 'overlay');
    overlay.onclick = function () { setOpen(false); };

    /* 抽屉主体 */
    var drawer = el('aside', 'drawer');
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-label', '设置');

    var head = el('div', 'drawer-head');
    head.appendChild(el('h3', null, '⚙️ 设置'));
    var close = el('button', 'btn icon', '✕');
    close.type = 'button';
    close.title = '关闭设置';
    close.onclick = function () { setOpen(false); };
    head.appendChild(close);
    drawer.appendChild(head);

    var body = el('div', 'drawer-body');

    /* — 外观 — */
    var secLook = el('div', 'settings-section');
    secLook.appendChild(el('h4', null, '外观'));
    secLook.appendChild(field('主题', '深色适合夜间练习；「跟随系统」随系统设置自动切换', themeSeg()));
    body.appendChild(secLook);

    /* — 跟随 — */
    var secFollow = el('div', 'settings-section');
    var h4b = el('h4', null, '跟随');
    secFollow.appendChild(h4b);
    secFollow.appendChild(field('默认速度', 'BPM 滚动与播放的初始倍速（0.5×–1.5×）', rangeCtl('rate', 50, 150, 5, function (v) { return (v / 100).toFixed(1) + 'x'; })));
    secFollow.appendChild(field('麦克风噪声门', '环境嘈杂时调低（更严格），听不清时调高', rangeCtl('gate', -90, -40, 1, function (v) { return v + 'dB'; })));
    body.appendChild(secFollow);

    /* — 视图 — */
    var secView = el('div', 'settings-section');
    secView.appendChild(el('h4', null, '视图'));
    secView.appendChild(field('谱面缩放', '谱面模式：谱面显示比例', rangeCtl('zoom', 60, 160, 5, function (v) { return v + '%'; })));
    secView.appendChild(field('默认开启放大镜', '进入页面时自动显示右下角放大跟随窗', switchCtl('magnifier')));
    secView.appendChild(field('显示操作提示', '底部状态栏右侧的引导文字', switchCtl('showHints')));
    body.appendChild(secView);

    /* — 关于 — */
    var secAbout = el('div', 'settings-section');
    secAbout.appendChild(el('h4', null, '关于'));
    var lines = [
      ['版本', 'v' + APP_VERSION],
      ['许可', 'MIT'],
      ['渲染引擎', 'alphaTab'],
    ];
    lines.forEach(function (p) {
      var row = el('div', 'about-line');
      row.appendChild(el('span', null, p[0]));
      row.appendChild(el('b', null, p[1]));
      secAbout.appendChild(row);
    });
    var repoRow = el('div', 'about-line');
    var a = el('a', 'link', 'GitHub 仓库');
    a.href = APP_REPO;
    a.target = '_blank';
    a.rel = 'noopener';
    repoRow.appendChild(a);
    secAbout.appendChild(repoRow);
    body.appendChild(secAbout);

    drawer.appendChild(body);

    /* 底部操作区 */
    var foot = el('div', 'drawer-foot');
    var resetBtn = el('button', 'btn', '↺ 恢复默认');
    resetBtn.type = 'button';
    resetBtn.onclick = reset;
    var spacer = el('span', 'spacer');
    var doneBtn = el('button', 'btn primary', '完成');
    doneBtn.type = 'button';
    doneBtn.onclick = function () { setOpen(false); };
    foot.appendChild(resetBtn);
    foot.appendChild(spacer);
    foot.appendChild(doneBtn);
    drawer.appendChild(foot);

    document.body.appendChild(overlay);
    document.body.appendChild(drawer);

    ui.overlay = overlay;
    ui.drawer = drawer;

    /* 触发按钮 + Esc 关闭 */
    var btn = document.getElementById('btnSettings');
    if (btn) btn.onclick = function () { setOpen(!isOpen()); };
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen()) setOpen(false);
    });

    syncUI();
  }

  return {
    DEFAULTS: DEFAULTS,
    VERSION: APP_VERSION,
    all: all,
    get: get,
    set: set,
    reset: reset,
    onChange: onChange,
    mount: mount,
    open: function () { setOpen(true); },
    close: function () { setOpen(false); },
  };
})();
