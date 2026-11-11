/*
 * HotBoard 原生 DOM 嵌入组件（生产用，替代 iframe）
 *
 * 为什么不用 iframe：iframe 内容搜索引擎抓不到、样式与主站割裂、多一次跨域上下文。
 * 本组件直接把热搜条插进主站 DOM，所有样式以 .hb2- 为前缀并作用域在容器内，
 * 不污染主站的 :root / * / body 等全局规则。
 *
 * 依赖（按顺序）：assets/config.js → assets/sources.js
 *                 非生产模式可再加载 assets/sample.js（生产模式不加载，杜绝虚构内容）
 * 用法（anchor 可传选择器或 Element；目标站从 #searchInput 向上定位到搜索区 section）：
 *       var box = document.querySelector("#searchInput");
 *       HotBoardEmbed.mount({ anchor: box.closest("section"), base: "/hotboard/" });
 *       HotBoardEmbed.unmount()
 * 线上一般由 deploy/hotboard-inject.min.js 自动完成定位与加载，不用手写上面这段。
 */
(function () {
  "use strict";

  const BAR_ID = "hb2-bar";
  const STYLE_ID = "hb2-style";
  const KEYFRAMES = "hb2-scroll";

  let bar = null;
  let timer = null;
  let mounted = false;
  const S = {
    sources: [], prod: true, sample: {}, base: "/hotboard/",
    current: "", cache: {}, loading: false, hideEmpty: true
  };
  const HAS_DATA = { live: 1, cache: 1, stale: 1, demo: 1 };

  const CSS = `
.${BAR_ID}, .${BAR_ID} * { box-sizing: border-box; margin: 0; padding: 0; }
.${BAR_ID} {
  --hb2-bg: #ffffff; --hb2-text: #1f2329; --hb2-sub: #8a8f99;
  --hb2-border: #e8eaf0; --hb2-accent: #ff4d4f;
  display: flex; align-items: center; gap: 10px; width: 100%;
  height: 46px; padding: 0 12px; overflow: hidden;
  background: var(--hb2-bg); color: var(--hb2-text);
  border: 1px solid var(--hb2-border); border-radius: 10px;
  font-size: 13px; line-height: 1.4;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
@media (prefers-color-scheme: dark) {
  .${BAR_ID} { --hb2-bg: #1e2128; --hb2-text: #e8eaed; --hb2-sub: #8b909a; --hb2-border: #2a2e38; }
}
.hb2-brand { flex: 0 0 auto; font-weight: 700; white-space: nowrap; }
.hb2-state {
  flex: 0 0 auto; font-size: 10px; line-height: 1; padding: 2px 5px;
  border-radius: 4px; border: 1px solid var(--hb2-border);
  color: var(--hb2-sub); white-space: nowrap;
}
.hb2-state.live, .hb2-state.cache { color: #07a050; border-color: rgba(7,193,96,.35); }
.hb2-state.stale, .hb2-state.demo { color: #d97700; border-color: rgba(255,125,0,.35); }
.hb2-tabs {
  flex: 0 1 auto; min-width: 0; max-width: 42%;
  display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none;
}
.hb2-tabs::-webkit-scrollbar { display: none; }
.hb2-tab {
  --c: #888; flex: 0 0 auto; border: 1px solid var(--hb2-border);
  background: transparent; color: var(--hb2-text); border-radius: 999px;
  padding: 3px 9px; font-size: 12px; cursor: pointer; white-space: nowrap;
  font-family: inherit; transition: background .15s, color .15s;
}
.hb2-tab.active { background: var(--c); border-color: var(--c); color: #fff; }
.hb2-marquee {
  flex: 1 1 auto; min-width: 0; overflow: hidden; position: relative; height: 100%;
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 18px, #000 calc(100% - 18px), transparent);
  mask-image: linear-gradient(90deg, transparent, #000 18px, #000 calc(100% - 18px), transparent);
}
.hb2-track {
  display: inline-flex; align-items: center; height: 100%; white-space: nowrap;
  will-change: transform; animation: ${KEYFRAMES} 38s linear infinite;
}
.hb2-marquee:hover .hb2-track { animation-play-state: paused; }
@keyframes ${KEYFRAMES} { from { transform: translateX(0); } to { transform: translateX(-50%); } }
.hb2-item {
  color: var(--hb2-text); text-decoration: none; padding: 0 4px;
  font-size: 13px; white-space: nowrap;
}
.hb2-item:hover { color: var(--hb2-accent); }
.hb2-rank {
  display: inline-block; min-width: 16px; margin-right: 4px;
  font-size: 11px; font-weight: 700; color: var(--hb2-sub);
}
.hb2-sep { color: var(--hb2-sub); margin: 0 12px; opacity: .5; }
.hb2-none { color: var(--hb2-sub); font-size: 12px; padding: 0 6px; }
.hb2-all {
  flex: 0 0 auto; color: var(--hb2-accent); text-decoration: none;
  font-size: 12px; white-space: nowrap;
}
.hb2-refresh {
  flex: 0 0 auto; border: none; background: transparent; color: var(--hb2-sub);
  font-size: 15px; cursor: pointer; padding: 2px 4px; font-family: inherit;
}
.hb2-refresh:hover { color: var(--hb2-accent); }
.hb2-refresh:disabled { opacity: .5; cursor: default; }
@media (max-width: 620px) { .hb2-tabs, .hb2-state { display: none; } }
`;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function stateText(st) {
    return ({ live: "实时", cache: "缓存", stale: "旧", demo: "示例", empty: "暂无", loading: "…" })[st] || "";
  }

  // 暂不可用的站点不出现在标签栏；接口恢复后自动加回
  function visibleSources() {
    if (!S.hideEmpty) return S.sources;
    return S.sources.filter((s) => HAS_DATA[S.cache[s.key] && S.cache[s.key].state]);
  }

  function buildTabs() {
    const el = bar.querySelector(".hb2-tabs");
    el.innerHTML = "";
    visibleSources().forEach((s) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "hb2-tab" + (s.key === S.current ? " active" : "");
      b.style.setProperty("--c", s.color);
      b.textContent = s.name.replace(/热搜|热榜|热门|热点/g, "");
      b.title = s.name;
      b.onclick = () => { S.current = s.key; buildTabs(); renderTrack(); };
      el.appendChild(b);
    });
  }

  function renderTrack() {
    const rec = S.cache[S.current];
    const list = rec && rec.list && rec.list.length ? rec.list : (S.sample[S.current] || []);
    const st = rec ? rec.state : (S.prod ? "loading" : "demo");

    const stateEl = bar.querySelector(".hb2-state");
    stateEl.textContent = stateText(st);
    stateEl.className = "hb2-state " + st;
    stateEl.title = S.prod
      ? "生产模式：接口不可用时显示「暂无」，不展示虚构示例数据"
      : "预览模式：接口不可用时回退示例数据（虚构内容）";

    const track = bar.querySelector(".hb2-track");
    if (!list.length) {
      track.style.animation = "none";
      track.innerHTML = `<span class="hb2-none">${st === "loading" ? "正在获取热搜…" : "暂无可用数据（暂不可用站点已隐藏）"}</span>`;
      return;
    }
    track.style.animation = "";
    const items = list.slice(0, 14).map((it) =>
      `<a class="hb2-item" href="${esc(it.url)}" target="_blank" rel="noopener">
         <span class="hb2-rank">${it.rank}</span>${esc(it.title)}
       </a><span class="hb2-sep">•</span>`
    ).join("");
    track.innerHTML = items + items; // 复制一份用于无缝循环
  }

  async function loadAll(force) {
    const HB = window.HotBoard;
    if (!HB || S.loading) return;
    S.loading = true;
    const btn = bar.querySelector(".hb2-refresh");
    btn.disabled = true;
    await HB.getMany(S.sources, (s, r) => {
      if (r.ok && r.list && r.list.length) {
        S.cache[s.key] = {
          list: r.list,
          state: r.stale ? "stale" : (r.cached ? "cache" : "live")
        };
      } else {
        S.cache[s.key] = {
          list: S.sample[s.key] || [],
          state: S.prod ? "empty" : "demo"
        };
      }
      if (s.key === S.current) renderTrack();
    }, { force: !!force });
    // 取数结束后统一重建标签栏，避免加载过程中标签来回跳动
    const vis = visibleSources();
    if (vis.length && !vis.some((s) => s.key === S.current)) S.current = vis[0].key;
    buildTabs();
    S.loading = false;
    btn.disabled = false;
    renderTrack();
  }

  function mount(options) {
    if (mounted && bar && bar.isConnected) return bar;
    if (mounted) unmount();

    const HB = window.HotBoard;
    if (!HB) {
      console.warn("[HotBoard] config.js / sources.js 尚未加载，无法挂载嵌入组件");
      return null;
    }

    const o = options || {};
    const CFG = HB.config || {};
    const anchor = typeof o.anchor === "string" ? document.querySelector(o.anchor) : o.anchor;
    if (!anchor || !anchor.parentNode) {
      if (typeof console !== "undefined") console.warn("[HotBoard] 未找到挂载锚点：", o.anchor || CFG.EMBED_ANCHOR);
      return null;
    }

    let base = o.base || CFG.EMBED_BASE || "/hotboard/";
    if (base.charAt(base.length - 1) !== "/") base += "/";
    S.base = base;
    S.prod = HB.isProduction();
    S.hideEmpty = CFG.HIDE_EMPTY !== false;
    S.sample = S.prod ? {} : (window.HOTBOARD_SAMPLE || {});
    S.sources = HB.activeSources().slice(0, CFG.WIDGET_MAX_TABS || 12);
    S.current = CFG.WIDGET_DEFAULT_SOURCE || "weibo";
    if (!S.sources.some((s) => s.key === S.current)) {
      S.current = S.sources.length ? S.sources[0].key : "";
    }
    S.cache = {};

    ensureStyle();
    bar = document.createElement("div");
    bar.id = BAR_ID;
    bar.className = BAR_ID;
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "热搜榜");
    bar.innerHTML =
      '<span class="hb2-brand">🔥热搜</span>' +
      '<span class="hb2-state loading" title="正在获取数据">…</span>' +
      '<div class="hb2-tabs"></div>' +
      '<div class="hb2-marquee"><div class="hb2-track"></div></div>' +
      `<a class="hb2-all" href="${esc(base)}index.html" target="_blank" rel="noopener" title="查看全站热搜">全站›</a>` +
      '<button class="hb2-refresh" type="button" title="刷新">↻</button>';

    // 默认插在锚点之后；可改 placement: "append" 插进锚点内部末尾
    if (o.placement === "append") anchor.appendChild(bar);
    else if (anchor.insertAdjacentElement) anchor.insertAdjacentElement("afterend", bar);
    else anchor.parentNode.insertBefore(bar, anchor.nextSibling);

    bar.querySelector(".hb2-refresh").onclick = () => loadAll(true);
    mounted = true;
    buildTabs();
    renderTrack();
    loadAll(false);
    timer = setInterval(() => { if (bar && bar.isConnected) loadAll(false); }, CFG.AUTO_REFRESH_MS || 300000);
    return bar;
  }

  function unmount() {
    if (timer) { clearInterval(timer); timer = null; }
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    bar = null;
    mounted = false;
    S.cache = {};
    const st = document.getElementById(STYLE_ID);
    if (st && st.parentNode) st.parentNode.removeChild(st);
  }

  window.HotBoardEmbed = {
    mount: mount,
    unmount: unmount,
    isMounted: function () { return !!(mounted && bar && bar.isConnected); }
  };
})();
