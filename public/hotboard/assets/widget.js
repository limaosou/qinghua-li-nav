/*
 * 导航栏热搜跑马灯组件（生产版）
 *  - 生产模式：接口失败时显示「暂无数据」，不展示虚构示例
 *  - HIDE_EMPTY：暂不可用的站点不出现在标签栏，接口恢复后自动加回
 *  - 受限并发 + 本地缓存；默认只显示前 N 个可用站点标签
 */
(function () {
  "use strict";

  const HB = window.HotBoard;
  const CFG = HB.config;
  const PRODUCTION = HB.isProduction();
  const HIDE_EMPTY = CFG.HIDE_EMPTY !== false;
  const SOURCES = HB.activeSources().slice(0, CFG.WIDGET_MAX_TABS || 12);
  const SAMPLE = PRODUCTION ? {} : (window.HOTBOARD_SAMPLE || {});
  const REFRESH_MS = CFG.AUTO_REFRESH_MS || 5 * 60 * 1000;
  const HAS_DATA = { live: 1, cache: 1, stale: 1, demo: 1 };

  const cache = {};
  let current = CFG.WIDGET_DEFAULT_SOURCE || "weibo";
  if (!SOURCES.some((s) => s.key === current)) current = SOURCES.length ? SOURCES[0].key : "";
  let loading = false;

  const tabsEl = document.getElementById("wtabs");
  const trackEl = document.getElementById("wtrack");
  const stateEl = document.getElementById("wstate");
  const refreshBtn = document.getElementById("wrefresh");

  const STATE_TEXT = {
    live: "实时", cache: "缓存", stale: "缓存(旧)",
    demo: "示例", empty: "暂无", loading: "加载中"
  };

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function visibleSources() {
    if (!HIDE_EMPTY) return SOURCES;
    return SOURCES.filter((s) => HAS_DATA[cache[s.key] && cache[s.key].state]);
  }

  function buildTabs() {
    tabsEl.innerHTML = "";
    visibleSources().forEach((s) => {
      const b = document.createElement("button");
      b.className = "hb-tab" + (s.key === current ? " active" : "");
      b.style.setProperty("--c", s.color);
      b.textContent = s.name.replace(/热搜|热榜|热门|热点/g, "");
      b.title = s.name;
      b.onclick = () => { current = s.key; buildTabs(); renderTrack(); };
      tabsEl.appendChild(b);
    });
  }

  function renderTrack() {
    const rec = cache[current];
    const list = rec && rec.list && rec.list.length ? rec.list : (SAMPLE[current] || []);
    const state = rec ? rec.state : (PRODUCTION ? "loading" : "demo");
    if (stateEl) {
      stateEl.textContent = STATE_TEXT[state] || "";
      stateEl.className = "hb-state " + state;
      stateEl.title = PRODUCTION
        ? "生产模式：接口不可用时显示「暂无」，不展示虚构示例数据"
        : "预览模式：接口不可用时回退示例数据（虚构内容）";
    }
    if (!list.length) {
      trackEl.style.animation = "none";
      const txt = state === "loading"
        ? "正在获取热搜…"
        : (visibleSources().length ? "该站暂无数据" : "暂不可用站点已隐藏，正在等待可用数据…");
      trackEl.innerHTML = `<span class="hb-none">${txt}</span>`;
      return;
    }
    trackEl.style.animation = "";
    const items = list.slice(0, 14).map((it) =>
      `<a class="hb-item" href="${escapeHtml(it.url)}" target="_blank" rel="noopener">
         <span class="hb-rank">${it.rank}</span>${escapeHtml(it.title)}
       </a><span class="hb-sep">•</span>`
    ).join("");
    // 复制一份用于无缝循环
    trackEl.innerHTML = items + items;
  }

  async function loadAll(force) {
    if (loading) return;
    loading = true;
    refreshBtn.disabled = true;
    await HB.getMany(SOURCES, (s, r) => {
      if (r.ok && r.list && r.list.length) {
        cache[s.key] = {
          list: r.list,
          state: r.stale ? "stale" : (r.cached ? "cache" : "live")
        };
      } else {
        cache[s.key] = {
          list: SAMPLE[s.key] || [],
          state: PRODUCTION ? "empty" : "demo"
        };
      }
      if (s.key === current) renderTrack();
    }, { force: !!force });

    // 取数结束后统一重建标签栏，避免加载过程中标签跳动
    const vis = visibleSources();
    if (vis.length && !vis.some((s) => s.key === current)) current = vis[0].key;
    buildTabs();
    loading = false;
    refreshBtn.disabled = false;
    renderTrack();
  }

  refreshBtn.onclick = () => loadAll(true);
  buildTabs();
  renderTrack();
  loadAll(false);
  setInterval(() => loadAll(false), REFRESH_MS);
})();
