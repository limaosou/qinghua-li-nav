/*
 * 热搜聚合 · 数据源与容错逻辑
 * 纯前端：浏览器直接调用公共聚合接口，无需后端。
 * 设计要点：
 *  1. 多接口容错 —— 依次尝试 vvhan / imsyy / codelife，任一可用即返回。
 *  2. 字段归一化 —— 不同接口字段名不同，统一抽取为 {title, hot, url}。
 *  3. 配置外置 —— 开关/代理/超时/并发统一读 assets/config.js。
 *  4. 限流与缓存 —— 并发队列 + 5 分钟本地缓存，只缓存真实数据。
 *  5. 不做编造 —— 取数失败返回空；是否展示示例由调用方按 PRODUCTION 决定。
 */
(function () {
  "use strict";

  // config.js 未加载时（如 node 单测）使用同款默认值，保证逻辑可独立运行。
  const CFG = Object.assign({
    PRODUCTION: true,
    CACHE_TTL: 5 * 60 * 1000,
    STALE_TTL: 30 * 60 * 1000,
    CONCURRENCY: 5,
    REQUEST_TIMEOUT: 9000,
    PROXY_TIMEOUT: 15000,
    MAX_ITEMS: 30,
    CORS_PROXY: (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
    ENABLED_SOURCES: null
  }, (typeof window !== "undefined" && window.HotBoardConfig) || {});

  // 聚合的站点。types 为各接口对应的站点标识（不同接口命名不一）。
  const SOURCES = [
    { key: "baidu",   name: "百度热搜", color: "#2932e1", types: { vvhan: "baidu",    imsyy: "baidu",    codelife: "baidu" } },
    { key: "weibo",   name: "微博热搜", color: "#e6162d", types: { vvhan: "weibo",    imsyy: "weibo",    codelife: "weibo" } },
    { key: "zhihu",   name: "知乎热榜", color: "#0066ff", types: { vvhan: "zhihu",    imsyy: "zhihu",    codelife: "zhihu" } },
    { key: "douyin",  name: "抖音热点", color: "#fe2c55", types: { vvhan: "douyin",   imsyy: "douyin",   codelife: "douyin" } },
    { key: "bili",    name: "B站热门",  color: "#fb7299", types: { vvhan: "bili",     imsyy: "bilibili", codelife: "bilibili" } },
    { key: "toutiao", name: "今日头条", color: "#ed3a3a", types: { vvhan: "toutiao",  imsyy: "toutiao",  codelife: "toutiao" } },
    { key: "kr36",    name: "36氪",    color: "#ff7d00", types: { vvhan: "36kr",     imsyy: "36kr",     codelife: "36kr" } },
    { key: "weixin",  name: "微信热点", color: "#07c160", types: { vvhan: "weixin",   imsyy: "weixin",   codelife: "weixin" } },
    { key: "ithome",  name: "IT之家",  color: "#d32f2f", types: { vvhan: "ithome",   imsyy: "ithome",   codelife: "ithome" } },
    { key: "juejin",  name: "掘金",    color: "#1e80ff", types: { vvhan: "juejin",   imsyy: "juejin",   codelife: "juejin" } },
    { key: "sspai",   name: "少数派",  color: "#d71a1b", types: { vvhan: "sspai",    imsyy: "sspai",    codelife: "sspai" } },
    { key: "hupu",    name: "虎扑",    color: "#c8102e", types: { vvhan: "hupu",     imsyy: "hupu",     codelife: "hupu" } },
    { key: "douban",  name: "豆瓣",    color: "#2e963d", types: { vvhan: "douban",   imsyy: "douban",   codelife: "douban" } },
    { key: "netease", name: "网易新闻", color: "#c62828", types: { vvhan: "netease",  imsyy: "netease",  codelife: "netease" } },
    { key: "thepaper",name: "澎湃新闻", color: "#8e2b2b", types: { vvhan: "thepaper", imsyy: "thepaper", codelife: "thepaper" } },
    { key: "huxiu",   name: "虎嗅",    color: "#f5a623", types: { vvhan: "huxiu",    imsyy: "huxiu",    codelife: "huxiu" } },
    { key: "v2ex",    name: "V2EX",    color: "#586069", types: { vvhan: "v2ex",     imsyy: "v2ex",     codelife: "v2ex" } },
    { key: "coolapk", name: "酷安",    color: "#21a366", types: { vvhan: "coolapk",  imsyy: "coolapk",  codelife: "coolapk" } },
    { key: "tieba",   name: "百度贴吧", color: "#3385ff", types: { vvhan: "tieba",    imsyy: "tieba",    codelife: "tieba" } },
    { key: "sina",    name: "新浪热点", color: "#e65722", types: { vvhan: "sina",     imsyy: "sina",     codelife: "sina" } },
    { key: "hackernews",    name: "Hacker News",     color: "#ff6600", types: {} },
    { key: "github",        name: "GitHub 热榜",      color: "#8250df", types: {} },
    { key: "devto",         name: "DEV Community",    color: "#3b49df", types: {} },
    { key: "wikipedia",     name: "维基百科热页",      color: "#6b7280", types: {} },
    { key: "stackoverflow", name: "Stack Overflow",   color: "#f48024", types: {} },
    { key: "reddit",     name: "Reddit",       color: "#ff4500", types: {} },
    { key: "x",          name: "X (Twitter)",  color: "#1d9bf0", types: {} },
    { key: "bing",       name: "Bing",         color: "#008373", types: {} }
  ];

  // 公共聚合接口。extract(j) 从各异的返回结构中取出原始列表。
  const PROVIDERS = [
    {
      name: "vvhan",
      url: (t) => `https://api.vvhan.com/api/hotlist?type=${t}`,
      extract: (j) => (j && j.data) ? j.data : (j && j.result && j.result.list) ? j.result.list : []
    },
    {
      name: "imsyy",
      url: (t) => `https://api-hot.imsyy.top/${t}`,
      extract: (j) => {
        if (!j || !j.data) return [];
        return Array.isArray(j.data) ? j.data : (j.data.data || []);
      }
    },
    {
      name: "codelife",
      url: (t) => `https://api.codelife.cc/api/top/list?id=${t}`,
      extract: (j) => (j && j.data) ? j.data : []
    }
  ];

  function pick(o, keys) {
    for (const k of keys) {
      if (o && o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
    }
    return "";
  }

  // 把接口返回的不规则条目统一为 {rank, title, hot, url}
  function normalize(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((o, i) => ({
        rank: i + 1,
        title: String(pick(o, ["title", "name", "word", "query", "hotword", "content", "show", "topic"])),
        hot: pick(o, ["hot", "hotValue", "heat", "hotScore", "score", "num", "count", "hotScore"]),
        url: String(pick(o, ["url", "link", "href", "mobilUrl", "mobileUrl"]) || "#")
      }))
      .filter((x) => x.title && x.title !== "undefined" && x.title !== "null");
  }

  // 热度值格式化：已是「万/亿」文本则原样返回，否则按数值换算。
  function formatHot(h) {
    if (h === "" || h === undefined || h === null) return "";
    const s = String(h);
    if (/万|亿|w\b|W\b/i.test(s)) return s;
    const n = Number(s.replace(/,/g, ""));
    if (isNaN(n)) return s;
    if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, "") + "亿";
    if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, "") + "万";
    return String(n);
  }

  // 代理地址统一从 config.js 读取，站长改配置不必碰本文件。
  const CORS_PROXY = CFG.CORS_PROXY;

  async function fetchProxied(url) {
    const res = await fetchWithTimeout(CORS_PROXY(url), CFG.PROXY_TIMEOUT);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  }

  function decodeEntities(s) {
    return String(s)
      .replace(/<!\[CDATA\[|\]\]>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
      .replace(/&nbsp;/g, " ");
  }

  // 解析 RSS / Atom：Reddit 用 <entry>，Bing News 用 <item>
  function parseFeed(xml, tag) {
    const blocks = String(xml).split(new RegExp("<" + tag + "[\\s>]", "i")).slice(1);
    return blocks.slice(0, 20).map((b) => {
      const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(b);
      const l = /<link[^>]*href=["']([^"']+)["']/i.exec(b) ||
                /<link[^>]*>\s*([^<\s]+)\s*<\/link>/i.exec(b);
      return {
        title: t ? decodeEntities(t[1]).trim() : "",
        url: l ? decodeEntities(l[1]).trim() : ""
      };
    }).filter((x) => x.title);
  }

  // 解析 trends24.in 的 X 趋势列表（<a class=trend-link>）
  function parseXtrends(html) {
    const re = /(<a[^>]*class=["']?trend-link["']?[^>]*>)([\s\S]*?)<\/a>/gi;
    const out = [];
    let m;
    while ((m = re.exec(html)) && out.length < 20) {
      const href = /href=["']([^"']+)["']/.exec(m[1]);
      const title = decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim();
      if (title) out.push({ title: title, hot: "", url: href ? href[1] : "https://x.com/search" });
    }
    return out;
  }

  // 国外站点：直接调用各平台官方开放 API（均实测返回 Access-Control-Allow-Origin: *）。
  // 这些站点不经 PROVIDERS 链，统一由 CUSTOM_FETCHERS 提供，返回结构交给 normalize() 归一。
  const CUSTOM_FETCHERS = {
    hackernews: async () => {
      const res = await fetchWithTimeout("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=20");
      const j = await res.json();
      return normalize((j.hits || []).map((h) => ({
        title: h.title || h.story_title || "",
        hot: h.points,
        url: h.url || h.story_url || ("https://news.ycombinator.com/item?id=" + h.objectID)
      })));
    },
    github: async () => {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      const since = d.toISOString().slice(0, 10);
      const q = encodeURIComponent("created:>" + since);
      const res = await fetchWithTimeout(
        `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=20`
      );
      const j = await res.json();
      return normalize((j.items || []).map((r) => ({
        title: r.full_name + (r.description ? " — " + r.description : ""),
        hot: r.stargazers_count,
        url: r.html_url
      })));
    },
    devto: async () => {
      const res = await fetchWithTimeout("https://dev.to/api/articles?top=7&per_page=20");
      const j = await res.json();
      return normalize((j || []).map((a) => ({
        title: a.title,
        hot: a.public_reactions_count != null ? a.public_reactions_count : a.comments_count,
        url: a.url
      })));
    },
    wikipedia: async () => {
      const d = new Date(Date.now() - 2 * 86400000); // 浏览量数据约延迟 1~2 天
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      const path = `${d.getUTCFullYear()}/${mm}/${dd}`;
      const res = await fetchWithTimeout(
        `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia.org/all-access/${path}`
      );
      const j = await res.json();
      const arts = (j.items && j.items[0] && j.items[0].articles) || [];
      return normalize(arts.slice(0, 20).map((a) => ({
        title: String(a.article).replace(/_/g, " "),
        hot: a.views,
        url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(a.article)
      })));
    },
    stackoverflow: async () => {
      const res = await fetchWithTimeout(
        "https://api.stackexchange.com/2.3/questions?site=stackoverflow&sort=hot&pagesize=20&filter=default"
      );
      const j = await res.json();
      return normalize((j.items || []).map((q) => ({
        title: q.title,
        hot: q.view_count,
        url: q.link
      })));
    },
    reddit: async () => {
      const xml = await fetchProxied("https://www.reddit.com/r/popular/.rss");
      const items = parseFeed(xml, "entry");
      if (!items.length) throw new Error("empty");
      return normalize(items.map((x) => ({ title: x.title, hot: "", url: x.url })));
    },
    x: async () => {
      const html = await fetchProxied("https://trends24.in/united-states/");
      const items = parseXtrends(html);
      if (!items.length) throw new Error("empty");
      return normalize(items);
    },
    bing: async () => {
      const xml = await fetchProxied("https://www.bing.com/news/search?q=top&format=rss");
      const items = parseFeed(xml, "item");
      if (!items.length) throw new Error("empty");
      return normalize(items.map((x) => ({ title: x.title, hot: "", url: x.url })));
    }
  };

  async function fetchWithTimeout(url, ms) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), ms || CFG.REQUEST_TIMEOUT);
    try {
      return await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    } finally {
      clearTimeout(id);
    }
  }

  // 本地缓存：只缓存「成功拿到的真实数据」，示例/占位数据永不入缓存。
  const CACHE_PREFIX = "hb:v2:";
  const store = (function () {
    try {
      return (typeof localStorage !== "undefined" && localStorage) ? localStorage : null;
    } catch (e) { return null; }
  })();

  function cacheGet(key) {
    if (!store) return null;
    try {
      const raw = store.getItem(CACHE_PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function cacheSet(key, list, provider) {
    if (!store) return;
    try {
      store.setItem(CACHE_PREFIX + key, JSON.stringify({
        ts: Date.now(), list: list, provider: provider
      }));
    } catch (e) { /* 隐私模式 / 配额满：忽略，不影响主流程 */ }
  }

  function clearCache() {
    if (!store) return;
    try {
      const keys = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k && k.indexOf(CACHE_PREFIX) === 0) keys.push(k);
      }
      keys.forEach((k) => store.removeItem(k));
    } catch (e) { /* 忽略 */ }
  }

  // 站点开关：config.js 的 ENABLED_SOURCES 为 null 时启用全部。
  function activeSources() {
    const allow = CFG.ENABLED_SOURCES;
    return (Array.isArray(allow) && allow.length)
      ? SOURCES.filter((s) => allow.indexOf(s.key) >= 0)
      : SOURCES.slice();
  }

  // 把异常对象压成一行可读文本，供自检页展示失败原因。
  function errText(e) {
    if (!e) return "unknown";
    return String(e && e.message ? e.message : e).replace(/\s+/g, " ").slice(0, 160);
  }

  // 获取单个站点的热搜。
  // 返回 {ok, provider, list, cached?, stale?, error?}
  //  1) 5 分钟内的本地缓存直接命中（不重复打接口）
  //  2) 接口成功 → 写缓存
  //  3) 接口失败 → 允许回退到 30 分钟内的旧「真实」数据（stale: true），仍不编造内容
  //  4) 都没有 → ok:false，由调用方按 PRODUCTION 决定显示「暂无数据」还是示例
  async function getHot(source, opts) {
    const force = !!(opts && opts.force);
    const hit = force ? null : cacheGet(source.key);
    const now = Date.now();
    if (hit && hit.list && hit.list.length && now - hit.ts < CFG.CACHE_TTL) {
      return { ok: true, provider: hit.provider, list: hit.list, cached: true };
    }

    let result = { ok: false, provider: null, list: [] };

    // 国外站点走官方 API / RSS 专用函数
    const custom = CUSTOM_FETCHERS[source.key];
    if (custom) {
      try {
        const list = await custom();
        if (list.length) result = { ok: true, provider: "official", list: list.slice(0, CFG.MAX_ITEMS) };
        else result.error = "接口返回空列表（可能限流 / 结构改版 / 代理被拦）";
      } catch (e) { result.error = errText(e); }
    } else {
      let lastErr = null;
      for (const p of PROVIDERS) {
        const t = source.types[p.name] || source.key;
        try {
          const res = await fetchWithTimeout(p.url(t));
          if (!res.ok) throw new Error("HTTP " + res.status);
          const j = await res.json();
          const list = normalize(p.extract(j));
          if (!list.length) throw new Error("empty");
          result = { ok: true, provider: p.name, list: list.slice(0, CFG.MAX_ITEMS) };
          break;
        } catch (e) { lastErr = e; }
      }
      if (!result.ok) result.error = errText(lastErr);
    }

    if (result.ok) {
      cacheSet(source.key, result.list, result.provider);
      return result;
    }

    // 接口全挂：用上次成功抓取的真实数据顶上（有过期上限），比空白好且不是编造。
    if (hit && hit.list && hit.list.length && now - hit.ts < CFG.STALE_TTL) {
      return { ok: true, provider: hit.provider, list: hit.list, stale: true };
    }
    return result;
  }

  // 受限并发批量取数：onEach(source, result) 在每站完成时立即回调，便于增量渲染。
  // 28 站不再 Promise.all 一把梭，默认最多 5 个请求在途，显著降低被第三方限流的概率。
  async function getMany(sources, onEach, opts) {
    const results = new Array(sources.length);
    let cursor = 0;
    const n = Math.max(1, Math.min(CFG.CONCURRENCY, sources.length || 1));
    await Promise.all(Array.from({ length: n }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= sources.length) break;
        const t0 = Date.now();
        let r;
        try { r = await getHot(sources[i], opts); }
        catch (e) { r = { ok: false, provider: null, list: [], error: errText(e) }; }
        results[i] = r;
        if (typeof onEach === "function") {
          // 第三参数为该站真实耗时（ms），供部署后自检页逐站展示
          try { onEach(sources[i], r, Date.now() - t0); } catch (e) { /* 渲染异常不影响取数 */ }
        }
      }
    }));
    return results;
  }

  window.HotBoard = {
    SOURCES, activeSources, getHot, getMany, clearCache,
    formatHot, normalize,
    isProduction: function () { return !!CFG.PRODUCTION; },
    config: CFG
  };
})();
