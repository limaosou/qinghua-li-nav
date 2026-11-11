/*
 * HotBoard 集中配置
 * 只改这一个文件，不必碰取数逻辑和页面代码。
 * 必须在 sources.js / app.js / widget.js / embed.js 之前加载。
 */
(function () {
  "use strict";

  window.HotBoardConfig = {
    // 生产模式：true = 接口失败时显示「暂无数据」，绝不展示内置示例（示例是虚构内容）。
    // 本地预览想看满屏效果，改成 false 即可；想恢复生产标准再改回 true。
    // 这是最轻量的一级「回撤」：只动这一个布尔值。
    PRODUCTION: true,

    // 静态资源版本号：改过 js/css 后 bump，CDN 才会回源取新文件。
    ASSET_VERSION: "20261111c",

    // 请求与缓存策略
    CACHE_TTL: 5 * 60 * 1000,      // 成功结果本地缓存 5 分钟
    STALE_TTL: 30 * 60 * 1000,     // 接口失败时，最多允许用 30 分钟内的旧「真实」数据
    CONCURRENCY: 5,                // 同时在途请求上限（28 站不再一把梭，避免被限流）
    REQUEST_TIMEOUT: 9000,         // 普通接口超时
    PROXY_TIMEOUT: 15000,          // 经代理抓页面超时
    AUTO_REFRESH_MS: 5 * 60 * 1000,
    MAX_ITEMS: 30,                 // 单站最多保留条目数

    // 部分平台的 RSS / 趋势页不带 CORS 头，需经代理转发。
    // 换成自己的代理地址即可获得稳定 SLA（需返回 Access-Control-Allow-Origin）。
    CORS_PROXY: function (u) {
      return "https://api.allorigins.win/raw?url=" + encodeURIComponent(u);
    },

    // 隐藏暂不可用站点：true = 本轮没拿到真实数据的站点不显示空卡片/空标签，
    // 接口恢复后自动重新出现（不会因为一次网络波动就永久丢掉一个站点）。
    // 页面上「显示全部」按钮可临时查看被隐藏的站点状态。
    HIDE_EMPTY: true,

    // 站点开关：null = 全部 28 站；填 key 数组则「永久」只启用指定站点。
    // 例：只想保留实测稳定的 6 站 → ["toutiao","hackernews","github","devto","wikipedia","stackoverflow"]
    // 注意：本机沙箱屏蔽了 vvhan/imsyy，实测通不代表用户浏览器里也只通这些，故默认不启用白名单。
    ENABLED_SOURCES: null,

    // 嵌入组件（导航栏跑马灯）默认设置
    WIDGET_DEFAULT_SOURCE: "weibo",
    WIDGET_MAX_TABS: 12,           // 导航栏最多显示多少个站点标签，避免挤爆
    // 目标站 www.liqinghua.com：锚点是搜索框，注入脚本再向上定位到搜索区 section。
    // 实际插入点由 deploy/hotboard-inject.js 的 data-anchor / data-anchor-closest 决定。
    EMBED_ANCHOR: "#searchInput",
    EMBED_BASE: "/hotboard/"
  };
})();
