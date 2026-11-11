/*
 * 主展示页逻辑（生产版）
 *  - 生产模式：接口失败显示「暂无数据」，绝不展示虚构示例数据
 *  - 受限并发 + 5 分钟本地缓存（由 sources.js 的 getMany 提供）
 *  - HIDE_EMPTY：暂不可用的站点不渲染空卡片，接口恢复后自动出现
 *  - 状态标签：实时 / 缓存 / 缓存(旧) / 示例 / 暂无数据 / 加载中
 */
(function () {
  "use strict";

  const HB = window.HotBoard;
  const CFG = HB.config;
  const PRODUCTION = HB.isProduction();
  const HIDE_EMPTY = CFG.HIDE_EMPTY !== false;
  const SOURCES = HB.activeSources();
  // 生产模式下示例数据整张表都不参与渲染，连对象都不取，避免误用。
  const SAMPLE = PRODUCTION ? {} : (window.HOTBOARD_SAMPLE || {});
  const REFRESH_MS = CFG.AUTO_REFRESH_MS || 5 * 60 * 1000;

  const cache = {};        // key -> { list, state }
  let current = "all";
  let loading = false;
  let showAll = !HIDE_EMPTY;   // 「显示全部」开关；HIDE_EMPTY 关闭时默认全显
  let lastVisKey = "";

  const tabsEl = document.getElementById("tabs");
  const boardsEl = document.getElementById("boards");
  const statusEl = document.getElementById("updated");
  const refreshBtn = document.getElementById("refresh");
  const toggleBtn = document.getElementById("toggle-hidden");
  const noteEl = document.getElementById("mode-note");

  const TAGS = {
    live:    '<span class="badge live" title="已从接口成功获取到实时数据">实时</span>',
    cache:   '<span class="badge live" title="5 分钟内的本地缓存，内容仍是真实数据">缓存</span>',
    stale:   '<span class="badge demo" title="接口暂不可用，展示上次成功抓取的真实数据，可能已过期">缓存(旧)</span>',
    demo:    '<span class="badge demo" title="内置占位示例数据，是虚构内容，不代表真实热搜，请勿对外发布">示例</span>',
    empty:   '<span class="badge none" title="接口暂不可用；生产模式已禁用示例数据，故不展示任何内容">暂无数据</span>',
    loading: '<span class="badge none" title="正在获取数据">加载中…</span>'
  };
  const HAS_DATA = { live: 1, cache: 1, stale: 1, demo: 1 };

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function itemHTML(it) {
    const rc = it.rank <= 3 ? " r" + it.rank : "";
    const hot = HB.formatHot(it.hot);
    return `<li class="item">
      <span class="rank${rc}">${it.rank}</span>
      <a class="title" href="${escapeHtml(it.url)}" target="_blank" rel="noopener" title="${escapeHtml(it.title)}">${escapeHtml(it.title)}</a>
      ${hot ? `<span class="hot">${hot}</span>` : ""}
    </li>`;
  }

  function stateOf(key) {
    const rec = cache[key];
    if (!rec) return PRODUCTION ? "loading" : "demo";
    return rec.state;
  }

  function listOf(key) {
    const rec = cache[key];
    if (rec && rec.list && rec.list.length) return rec.list;
    return SAMPLE[key] || [];
  }

  // 只看有数据的站点：没数据的连卡片和导航标签都不渲染，避免一堆「暂无数据」占位。
  function visibleSources() {
    if (!HIDE_EMPTY || showAll) return SOURCES;
    return SOURCES.filter((s) => HAS_DATA[stateOf(s.key)]);
  }

  function boardHTML(source) {
    const limit = current === "all" ? 6 : CFG.MAX_ITEMS || 30;
    const list = listOf(source.key);
    const items = list.slice(0, limit).map(itemHTML).join("");
    const emptyText = stateOf(source.key) === "loading" ? "正在获取…" : "接口暂不可用，暂无数据";
    return `<section class="board" style="--c:${source.color}">
      <header class="board-head">
        <span class="dot"></span><span class="bname">${source.name}</span>${TAGS[stateOf(source.key)]}
      </header>
      <ol class="list">${items || `<li class="empty">${emptyText}</li>`}</ol>
    </section>`;
  }

  function emptyNotice() {
    if (current !== "all") {
      const s = SOURCES.find((x) => x.key === current);
      return `<div class="no-boards">「${escapeHtml(s ? s.name : current)}」当前没有可用数据。<br>
        接口恢复后会自动出现；点右上角「显示全部」可查看所有站点状态。</div>`;
    }
    return `<div class="no-boards">${loading ? "正在获取各平台热搜…" : "当前没有可用数据"}<br>
      暂不可用的站点已自动隐藏，接口恢复后会自动出现（生产模式不会展示虚构热搜）。</div>`;
  }

  function render() {
    const vis = visibleSources();
    const list = current === "all" ? vis : vis.filter((s) => s.key === current);
    boardsEl.innerHTML = list.length ? list.map(boardHTML).join("") : emptyNotice();

    // 导航栏随可用站点变化重建，避免每次取数都重画 28 个按钮
    const visKey = vis.map((s) => s.key).join(",") + "|" + showAll;
    if (visKey !== lastVisKey) { lastVisKey = visKey; buildTabs(); }

    const states = SOURCES.map((s) => stateOf(s.key));
    const live = states.filter((x) => HAS_DATA[x]).length;
    const hidden = SOURCES.length - vis.length;
    statusEl.textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN")} · 有数据 ${live}/${SOURCES.length}` +
      (hidden ? ` · 已隐藏 ${hidden}` : "");
  }

  function buildTabs() {
    const all = [{ key: "all", name: "全部", color: "#444" }].concat(visibleSources());
    tabsEl.innerHTML = "";
    all.forEach((s) => {
      const b = document.createElement("button");
      b.className = "tab" + (s.key === current ? " active" : "");
      b.style.setProperty("--c", s.color);
      b.textContent = s.name;
      b.onclick = () => { current = s.key; buildTabs(); render(); };
      tabsEl.appendChild(b);
    });
  }

  function showModeNote() {
    if (!noteEl) return;
    if (PRODUCTION) {
      noteEl.className = "mode-note prod";
      noteEl.textContent = "生产模式：已禁用内置示例数据；暂不可用的站点自动隐藏，不会对外展示虚构热搜或空卡片。";
    } else {
      noteEl.className = "mode-note dev";
      noteEl.textContent = "预览模式：接口不可用时回退内置示例数据（虚构内容，请勿对外发布）。改 config.js 的 PRODUCTION 可切换。";
    }
  }

  async function loadAll(force) {
    if (loading) return;
    loading = true;
    refreshBtn.disabled = true;
    const old = refreshBtn.textContent;
    refreshBtn.textContent = "刷新中…";

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
      render();
    }, { force: !!force });

    loading = false;
    refreshBtn.disabled = false;
    refreshBtn.textContent = old;
    render();
  }

  refreshBtn.onclick = () => loadAll(true);   // 手动刷新：跳过缓存，真的回源
  if (toggleBtn) {
    toggleBtn.textContent = showAll ? "只看有数据" : "显示全部";
    toggleBtn.onclick = () => {
      showAll = !showAll;
      toggleBtn.textContent = showAll ? "只看有数据" : "显示全部";
      render();
    };
  }

  showModeNote();
  loadAll(false);                            // 同步进入后 loading=true，避免首屏闪「当前没有可用数据」
  render();                                  // 生产模式先显示「正在获取…」，不闪示例
  setInterval(() => loadAll(false), REFRESH_MS);
})();
