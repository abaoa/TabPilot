/* ==========================================================================
 * sw.js — PWA Service Worker
 *
 * 策略：
 *   · 应用外壳（SHELL 列表）：install 时预缓存，配合 skipWaiting 立即生效
 *   · 同源请求：缓存优先 + 后台更新（保证离线可用，同时静默升级）
 *   · 跨源请求（如 CDN 资源）：网络优先，失败回落缓存
 *
 * ⚠️ 升级前端资源后请同步提升 CACHE 版本号，否则用户会一直拿到旧缓存。
 *    改名/新增外壳文件时也要同步更新 SHELL 列表。
 * ========================================================================== */
'use strict';

/** 缓存版本号：改动外壳资源时必须递增 */
const CACHE = 'tabpilot-v7';

/** 应用外壳：离线运行所需的最小资源集合 */
const SHELL = [
  'index.html',
  'image-tab.html',
  'css/base.css',
  'css/layout.css',
  'css/components.css',
  'js/theme.js',
  'js/settings.js',
  'js/app.js',
  'js/image-tab.js',
  'manifest.json',
  'icons/icon-512.png',
  'assets/demo-xihn.jpg',
];

/** 安装：预缓存外壳并立即接管 */
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

/** 激活：清理旧版本缓存，并接管所有客户端 */
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // 同源：缓存优先，后台回源更新
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request).then((hit) => {
        const net = fetch(e.request)
          .then((res) => {
            if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
            return res.clone();
          })
          .catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  // 跨源：网络优先，失败回落缓存
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
