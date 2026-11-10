/**
 * NavHub Service Worker：轻量离线壳
 * 策略：
 *  - 页面（/、/cat/*、/about）：网络优先，失败回退缓存（离线可开）
 *  - /api/*：网络优先，失败回退缓存（数据接口尽量实时）
 *  - 静态资源（js/css/png/webmanifest）：缓存优先
 */
// 换品牌 LOGO / favicon / SSR 页面结构后必须提升版本号：静态资源是缓存优先，
// 旧缓存里可能还存着 /favicon.ico 的 404 响应、白底旧图标或旧版页面 HTML
// v8：新增 iPhone 主屏幕图标 /apple-touch-icon.png 与主题同步脚本 /ios-chrome.js，
// 并把 iOS 相关 meta 收敛进 SSR 输出，必须升版本让老访客丢掉旧页面壳。
const CACHE = 'navhub-v8';
const SHELL = ['/', '/index.html', '/cat.html', '/about.html', '/favicon.ico', '/favicon-dark.ico', '/apple-touch-icon.png', '/ios-chrome.js', '/brand-icon.png', '/brand-icon-maskable.png', '/brand-logo.png', '/brand-logo-light.png', '/brand-logo-dark.png', '/manifest.webmanifest'];

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

  // 页面（含详情页 / 地图页 / 后台）：网络优先，离线回退缓存页。
  // SSR 页面内容会随版本变化，不能走「静态资源：缓存优先」，否则老访客一直看到旧 HTML
  const isPage = url.pathname === '/' || url.pathname === '/about' || url.pathname === '/admin'
    || url.pathname === '/sitemap.html' || url.pathname.startsWith('/cat') || url.pathname.startsWith('/site');
  if (isPage) {
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
