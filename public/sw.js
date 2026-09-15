/* 谱领航 TabPilot Service Worker：应用外壳缓存优先，CDN 运行时缓存 */
'use strict';
const CACHE = 'tabpilot-v1';
const SHELL = [
  'index.html', 'imageTab.html', '../src/app.js', '../src/imageTab.js',
  'manifest.json', 'icons/icon-512.png', '../assets/demo-xihn.jpg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // 同源：缓存优先，后台更新
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request).then((hit) => {
        const net = fetch(e.request).then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
          return res.clone();
        }).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }
  // 跨源（alphaTab CDN 等）：网络优先，失败回落缓存
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request))
  );
});
