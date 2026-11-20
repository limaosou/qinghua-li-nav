/**
 * NavHub Service Worker：轻量离线壳
 * 策略（v14 起全部网络优先）：
 *  - 所有同源 GET：网络优先，成功即更新缓存，失败回退缓存（离线仍可开）
 *  - 缓存不再优先返回，避免改了 CSS/图标后老访客被旧壳锁住
 */
// 版本号仍需提升：新 SW install 时会 delete 掉旧版本缓存、重装 SHELL。
// v14：背景由暖瓷白改纯白 + 顶栏改纯文字 + favicon 换极简猫头，但此前多次改动
//      漏升版本，静态资源走缓存优先导致老访客一直看到米黄背景/旧图标。
//      本版把静态资源也改为网络优先，今后改样式/图标无需再升版本即可生效。
// v13：此前版本（静态资源缓存优先，会锁旧 CSS）。
// v12：全站换青花瓷皮肤（新增 /porcelain.css，模板 head 全部引入，
// 顶栏/卡片/侧栏/按钮改钴蓝釉面），页面与静态资源都变了，升版本清掉旧壳。
// v11：统一五个前台模板顶栏品牌区间距（首页/关于的 gap-2.5 改 gap-2），
// 修掉首页与关于页站名比其它页靠后 2px 的问题，升版本清掉旧页面壳。
// v10：顶栏站名字号 28/32px 改 20/24px（小于 LOGO），SSR head 内联 CSS 同步；
// 页面 HTML 变了，升版本让老访客丢掉缓存里的旧页面壳。
// v9：去掉 Google Fonts、字体栈改纯系统字体，并在 SSR head 内联首帧字体骨架；
// 页面结构变化，必须升版本让老访客丢掉缓存里带网络字体的旧 HTML。
// v8：新增 iPhone 主屏幕图标 /apple-touch-icon.png 与主题同步脚本 /ios-chrome.js。
const CACHE = 'navhub-v14';
const SHELL = ['/', '/index.html', '/cat.html', '/about.html', '/favicon.ico', '/favicon-dark.ico', '/apple-touch-icon.png', '/ios-chrome.js', '/porcelain.css', '/brand-icon.png', '/brand-icon-maskable.png', '/brand-logo.png', '/brand-logo-light.png', '/brand-logo-dark.png', '/manifest.webmanifest'];

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

  // 其余静态资源（css/js/png/图标/webmanifest）：也改网络优先。
  // 缓存优先会让改了样式/图标后老访客一直拿到旧文件（如米黄背景锁死），
  // 强刷只能绕开 HTTP 缓存、绕不开 SW，所以这里统一网络优先，失败才回退缓存。
  e.respondWith(
    fetch(req)
      .then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return r; })
      .catch(() => caches.match(req))
  );
});
