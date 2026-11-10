/**
 * iPhone 主屏幕（standalone）外观同步。
 *
 * 为什么需要它：站点主题是用户用 localStorage 手动切换的，系统的
 * prefers-color-scheme 不会跟着变，所以 head 里带 media 的 theme-color 与
 * apple-mobile-web-app-status-bar-style 必须按「页面实际主题」动态更新。
 *
 * 用 MutationObserver 监听 <html> 的 class，主题按钮一切换就自动同步，
 * 不需要改动任何页面里的主题切换函数。
 *
 * 状态栏只用 default / black（都保留独立状态栏行），不用 black-translucent：
 * 后者会让内容顶进刘海/灵动岛区域，而现有顶栏是 sticky 且没有 safe-area padding-top。
 */
(function () {
  var LIGHT = '#ffffff';
  var DARK = '#0f172a';

  function apply() {
    var dark = document.documentElement.classList.contains('dark');
    var color = dark ? DARK : LIGHT;
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', color);
    var bar = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    if (bar) bar.setAttribute('content', dark ? 'black' : 'default');
  }

  apply();
  if (window.MutationObserver) {
    new MutationObserver(apply).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    });
  }
  window.addEventListener('storage', function (e) {
    if (e.key === 'navhub_theme') apply();
  });
  try {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', apply);
    else if (mq.addListener) mq.addListener(apply);
  } catch (_) { /* 老版本 Safari 无监听能力时，初始 apply() 已足够 */ }
})();
