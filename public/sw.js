/**
 * NavHub Service Worker：轻量离线壳
 * 策略：
 *  - 页面（/、/cat/*、/about）：网络优先，失败回退缓存（离线可开）
 *  - /api/*：网络优先，失败回退缓存（数据接口尽量实时）
 *  - 静态资源（js/css/png/webmanifest）：缓存优先
 */
const CACHE = 'navhub-v1';
const SHELL = ['/', '/index.html', '/cat.html', '/about.html', '/brand-icon.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 只处理同源

  // 数据接口：网络优先
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // 页面：网络优先，离线回退缓存页
  if (url.pathname === '/' || url.pathname.startsWith('/cat') || url.pathname === '/about') {
    e.respondWith(
      fetch(req)
        .then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return r; })
        .catch(() => caches.match(req).then((r) => r || caches.match('/')))
    );
    return;
  }

  // 静态资源：缓存优先，回源补齐
  e.respondWith(
    caches.match(req).then((r) =>
      r || fetch(req).then((rr) => { const copy = rr.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return rr; }).catch(() => r)
    )
  );
});
