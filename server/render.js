/**
 * 首页服务端渲染（SSR）：
 * 把分类与网址直接渲染进 HTML 源码 —— 搜索引擎与 AI 爬虫（GPTBot 等，不执行 JS）可完整抓取内容。
 * 同时注入 window.__NAV__ 数据，浏览器端跳过请求直接接管交互。
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const settings = require('./settings');
const stats = require('./stats');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/** 每个分类默认展示的站点数，超出的折叠进「更多」（与前端 public/index.html 保持一致） */
const SITE_LIMIT = 12;

/** 卡片标签最多展示几个，其余折叠成 +N（与前端 public/index.html 保持一致） */
const TAG_LIMIT = 3;
/** 单个标签展示的最大字符数，超出截断加省略号 */
const TAG_MAXLEN = 10;
const TAG_CHIP_CLASS = 'px-2 py-0.5 rounded-full text-[11px] bg-slate-50 dark:bg-gray-800 text-slate-500 dark:text-slate-400 border border-gray-100 dark:border-gray-700';

const AVATAR_COLORS = ['bg-indigo-500','bg-sky-500','bg-emerald-500','bg-amber-500','bg-rose-500','bg-violet-500','bg-cyan-600','bg-orange-500'];
const colorOf = s => AVATAR_COLORS[([...String(s)].reduce((a, c) => a + c.codePointAt(0), 0)) % AVATAR_COLORS.length];

/** 标签区 HTML：只展示前 TAG_LIMIT 个，其余合并为 +N（hover 看全部）；单标签过长也截断 */
function tagsHTML(s) {
  const all = (s.tags || '').split(',').map(t => t.trim()).filter(Boolean);
  if (!all.length) return '';
  const shown = all.slice(0, TAG_LIMIT).map(t => ({
    text: t.length > TAG_MAXLEN ? t.slice(0, TAG_MAXLEN) + '…' : t,
    full: t,
  }));
  const rest = all.slice(TAG_LIMIT);
  const chips = shown.map(t => `<span class="${TAG_CHIP_CLASS}"${t.full !== t.text ? ` title="${esc(t.full)}"` : ''}>${esc(t.text)}</span>`).join('');
  const more = rest.length ? `<span class="${TAG_CHIP_CLASS} cursor-default" title="${esc(rest.join('、'))}">+${rest.length}</span>` : '';
  return `<div class="mt-2.5 flex flex-wrap gap-1.5">${chips}${more}</div>`;
}

function getNavData() {
  const categories = db.prepare('SELECT id, name, icon FROM categories ORDER BY sort_order ASC, id ASC').all();
  const siteStmt = db.prepare(`
    SELECT id, category_id, title, url, description, tags, icon, is_pinned
    FROM sites WHERE is_hidden = 0 AND category_id = ?
    ORDER BY is_pinned DESC, sort_order ASC, id ASC`);
  return categories.map((c) => ({ ...c, sites: siteStmt.all(c.id) }));
}

/* 与前端 index.html 中的模板保持一致 */
function cardHTML(s, i, extraClass = '', detailEnabled = false) {
  const href = detailEnabled ? `/site/${s.id}` : esc(s.url);
  const attrs = detailEnabled ? '' : 'target="_blank" rel="noopener"';
  const dataId = detailEnabled ? '' : `data-id="${esc(s.id ?? '')}"`;
  return `
  <a href="${href}" ${attrs} ${dataId} data-idx="${i}"
     class="card-hover group relative block p-3.5 rounded-2xl border border-gray-200/80 dark:border-gray-800 bg-white dark:bg-gray-900 cursor-pointer hover:border-indigo-300 dark:hover:border-indigo-500/50 hover:shadow-[0_10px_32px_rgba(79,70,229,0.10)] dark:hover:shadow-[0_10px_32px_rgba(0,0,0,0.4)]${extraClass}">
    ${s.is_pinned ? `<span class="absolute top-2.5 right-2.5 text-indigo-400" title="置顶"><i data-lucide="pin" class="w-3.5 h-3.5"></i></span>` : ''}
    <div class="flex items-center gap-3">
      <div class="relative w-10 h-10 shrink-0">
        ${s.icon ? `<img src="${esc(s.icon)}" alt="${esc(s.title)}" loading="lazy" decoding="async" class="w-10 h-10 rounded-xl object-contain bg-slate-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 p-1" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">` : ''}
        <span class="w-10 h-10 rounded-xl items-center justify-center text-sm font-bold text-white ${colorOf(s.title)}" style="display:${s.icon ? 'none' : 'flex'}">${esc((s.title || '?')[0]).toUpperCase()}</span>
      </div>
      <div class="min-w-0 pr-4">
        <div class="font-medium text-[15px] truncate group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors duration-200">${esc(s.title)}</div>
        <div class="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">${esc(s.description || s.url)}</div>
      </div>
    </div>
    ${tagsHTML(s)}
  </a>`;
}

function renderFragments(data, detailEnabled = false) {
  const catnav = data.map(c => `
    <a href="#cat-${c.id}" class="cat-link flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm text-slate-600 dark:text-slate-400 hover:bg-white dark:hover:bg-gray-800/60 hover:text-indigo-500 transition-colors duration-200 cursor-pointer" data-cat="${c.id}">
      <span class="w-7 h-7 rounded-lg bg-slate-100 dark:bg-gray-800 flex items-center justify-center text-sm shrink-0">${c.icon || '📁'}</span>
      <span class="truncate">${esc(c.name)}</span>
      <span class="ml-auto text-[11px] text-slate-400 dark:text-slate-500">${c.sites.length}</span>
    </a>`).join('');

  const catnavMobile = data.map(c => `
    <a href="#cat-${c.id}" class="cat-chip shrink-0 px-3.5 py-1.5 rounded-full text-xs font-medium bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 text-slate-600 dark:text-slate-300 cursor-pointer">${c.icon || ''} ${esc(c.name)}</a>`).join('');

  const content = data.map(c => `
    <section id="cat-${c.id}" class="scroll-mt-24" aria-label="${esc(c.name)}">
      <div class="flex items-center gap-2.5 mb-4">
        <span class="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-50 to-sky-50 dark:from-indigo-500/10 dark:to-sky-500/10 border border-indigo-100/60 dark:border-indigo-500/20 flex items-center justify-center text-base">${c.icon || '📁'}</span>
        <h2 class="text-lg font-bold tracking-tight">${esc(c.name)}</h2>
        <span class="px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 dark:bg-gray-800 text-slate-500 dark:text-slate-400">${c.sites.length}</span>
        ${c.sites.length > SITE_LIMIT ? `
        <a href="/cat/${c.id}" class="ml-auto inline-flex items-center gap-0.5 text-xs font-medium text-slate-400 dark:text-slate-500 hover:text-indigo-500 dark:hover:text-indigo-400 transition-colors" aria-label="查看「${esc(c.name)}」全部 ${c.sites.length} 个站点">
          更多<i data-lucide="chevron-right" class="w-3.5 h-3.5"></i>
        </a>` : ''}
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        ${c.sites.slice(0, SITE_LIMIT).map((s, i) => cardHTML(s, i, '', detailEnabled)).join('')}
      </div>
    </section>`).join('');

  return { catnav, catnavMobile, content };
}

/** 编辑精选条：汇集全站被「置顶」的站点（后台「置顶」即入选），最多 12 个 */
function featuredHTML(data, detailEnabled = false) {
  const pinned = [];
  for (const c of data) for (const s of c.sites) if (s.is_pinned) pinned.push(s);
  if (!pinned.length) return '';
  const cards = pinned.slice(0, 12).map((s, i) => cardHTML(s, i, '', detailEnabled)).join('');
  return `<section class="mb-10" aria-label="青花狸精选">
    <div class="flex items-center gap-2.5 mb-4">
      <span class="w-8 h-8 rounded-xl bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-500/10 dark:to-orange-500/10 border border-amber-100/60 dark:border-amber-500/20 flex items-center justify-center text-base">⭐</span>
      <h2 class="text-lg font-bold tracking-tight">青花狸精选</h2>
      <span class="px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-100 dark:bg-amber-500/15 text-amber-600 dark:text-amber-300">站长私藏</span>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">${cards}</div>
  </section>`;
}

/** 热门站点条：按点击降序取前 12（clicks>0 才显示），空则不渲染 */
function popularHTML(detailEnabled = false) {
  const rows = db
    .prepare(`SELECT id, category_id, title, url, description, tags, icon, is_pinned
              FROM sites WHERE is_hidden = 0 AND clicks > 0 ORDER BY clicks DESC LIMIT 12`)
    .all();
  if (!rows.length) return '';
  const cards = rows.map((s, i) => cardHTML(s, i, '', detailEnabled)).join('');
  return `<section class="mb-10" aria-label="热门站点">
    <div class="flex items-center gap-2.5 mb-4">
      <span class="w-8 h-8 rounded-xl bg-gradient-to-br from-rose-50 to-pink-50 dark:from-rose-500/10 dark:to-pink-500/10 border border-rose-100/60 dark:border-rose-500/20 flex items-center justify-center text-base">🔥</span>
      <h2 class="text-lg font-bold tracking-tight">大家都在用</h2>
      <span class="px-2 py-0.5 rounded-full text-[11px] font-medium bg-rose-100 dark:bg-rose-500/15 text-rose-600 dark:text-rose-300">按真实点击</span>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">${cards}</div>
  </section>`;
}

/**
 * 通用左侧分类导航（首页以外的所有页面共用）
 * @param {Array} data 分类数据
 * @param {string|number|null} activeId 当前分类 id；传 'home' 高亮首页
 */
function buildSideNav(data, activeId = null) {
  const active = activeId == null ? '' : String(activeId);
  const item = (href, icon, name, count, on) => `
    <a href="${href}" class="flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm transition-colors duration-200 ${on
      ? 'bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 font-medium'
      : 'text-slate-600 dark:text-slate-400 hover:bg-white dark:hover:bg-gray-800/60 hover:text-indigo-500 dark:hover:text-indigo-400'}">
      <span class="w-7 h-7 rounded-lg ${on ? 'bg-indigo-100 dark:bg-indigo-500/20' : 'bg-slate-100 dark:bg-gray-800'} flex items-center justify-center text-sm shrink-0">${esc(icon || '📁')}</span>
      <span class="truncate">${esc(name)}</span>
      ${count == null ? '' : `<span class="ml-auto text-[11px] text-slate-400 dark:text-slate-500">${count}</span>`}
    </a>`;
  const total = data.reduce((a, c) => a + (c.count != null ? c.count : (c.sites ? c.sites.length : 0)), 0);
  return `<nav class="sticky top-20 space-y-1" aria-label="分类导航">
    <p class="px-3 pb-1 text-[11px] font-medium tracking-wide text-slate-400 dark:text-slate-500">导航</p>
    ${item('/', '🏠', '首页', total, active === 'home')}
    <p class="px-3 pt-3 pb-1 text-[11px] font-medium tracking-wide text-slate-400 dark:text-slate-500">全部分类</p>
    ${data.map(c => {
      const n = c.count != null ? c.count : (c.sites ? c.sites.length : 0);
      return item(`/cat/${c.id}`, c.icon, c.name, n, active === String(c.id));
    }).join('')}
  </nav>`;
}

/** 轻量分类清单（只取 id/名称/图标/收录数），给侧栏用，避免整站站点数据 */
function getSideNavData() {
  return db.prepare(`
    SELECT c.id, c.name, c.icon, COUNT(s.id) AS count
    FROM categories c LEFT JOIN sites s ON s.category_id = c.id AND s.is_hidden = 0
    GROUP BY c.id ORDER BY c.sort_order ASC, c.id ASC`).all();
}

let templateCache = null;

function baseUrl(req) {
  // 线上站点始终走 HTTPS（宝塔反代可能不回传 x-forwarded-proto，因此默认 https）；
  // 本地直连没有反向代理头，用实际协议，避免 301 跳到本地不存在的 https。
  const fwdProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
  const proto = fwdProto || (isLocal ? req.protocol || 'http' : 'https');
  return `${proto}://${host}`;
}

function buildJSONLD(data, base, s) {
  const items = [];
  let pos = 0;
  for (const c of data) for (const s2 of c.sites) {
    if (pos >= 100) break; // 控制体积
    items.push({ '@type': 'ListItem', position: ++pos, name: `${c.name} - ${s2.title}`, url: s2.url });
  }
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', name: `${s.site_name}导航`, alternateName: 'NavHub 网址导航', url: base + '/', description: s.site_description || '分类收录常用网站、开发工具、影视娱乐与学习资源的网址导航。', inLanguage: 'zh-CN' },
      { '@type': 'ItemList', name: '收录网站列表', numberOfItems: items.length, itemListElement: items },
    ],
  };
}

/** 生成首页 HTML（SSR） */
/** 品牌区（图片/emoji + 站名），首页与分类页共用 */
function buildBrandHTML(s) {
  return s.brand_image
    ? `<img src="${esc(s.brand_image)}" alt="${esc(s.site_name)}" decoding="async" class="w-8 h-8 rounded-xl object-cover shadow-sm">`
      + `<span>${esc(s.site_name)}</span>`
    : `<span class="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 to-sky-400 text-white flex items-center justify-center shadow-sm text-base">${esc(s.brand_icon || '🧭')}</span>`
      + `<span>${esc(s.site_name)}</span>`;
}

/** 浏览器标签页 favicon：品牌图片优先，否则用品牌 emoji 动态生成 SVG */
function buildFaviconHTML(s) {
  return s.brand_image
    ? `<link rel="icon" type="image/png" href="${esc(s.brand_image)}">`
    : `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>${s.brand_icon || '🧭'}</text></svg>`)}">`;
}

/** 页脚：文本 + 备案号（如有） */
function buildFooterHTML(s) {
  const icp = String(s.icp || '').trim()
    ? ` · <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener" class="hover:text-indigo-500 transition-colors">${esc(s.icp)}</a>`
    : '';
  return `${esc(s.footer_text)}${icp}`;
}

function renderNavPage(req) {
  if (!templateCache) {
    templateCache = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  }
  const data = getNavData();
  const s = settings.getSettings();
  const detail = !!s.site_detail_enabled;
  const frag = renderFragments(data, detail);
  const base = baseUrl(req);
  // JSON 内的 </script> 需要转义，防止提前闭合脚本标签
  const navJSON = JSON.stringify(data).replace(/</g, '\\u003c');
  const settingsJSON = JSON.stringify(settings.getPublicSettings()).replace(/</g, '\\u003c');

  // 品牌图标与 favicon（共用函数）
  const brandHTML = buildBrandHTML(s);
  const faviconHTML = buildFaviconHTML(s);

  const announceHTML = String(s.announcement || '').trim()
    ? `<div class="max-w-2xl mx-auto mb-6 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-100 dark:border-indigo-500/20 text-sm text-indigo-700 dark:text-indigo-300">
         <i data-lucide="megaphone" class="w-4 h-4 shrink-0"></i><span>${esc(s.announcement)}</span>
       </div>`
    : '';

  // 顶部导航链接（后台可配置）
  const navLinks = Array.isArray(s.nav_links) ? s.nav_links.filter(l => l?.label && l?.url) : [];
  const navLinksHTML = navLinks.length
    ? `<nav class="hidden md:flex items-center gap-1 mr-1" aria-label="顶部导航">
        ${navLinks.map(l => `<a href="${esc(l.url)}" ${/^https?:\/\//.test(l.url) ? 'target="_blank" rel="noopener"' : ''} class="px-2.5 py-1.5 rounded-lg text-sm text-slate-600 dark:text-slate-300 hover:text-indigo-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors duration-200">${esc(l.label)}</a>`).join('')}
      </nav>`
    : '';

  return templateCache
    .replaceAll('<!--SSR_TITLE-->', esc(s.site_title))
    .replaceAll('<!--SSR_DESCRIPTION-->', esc(s.site_description))
    .replaceAll('<!--SSR_KEYWORDS-->', esc(s.site_keywords))
    .replaceAll('<!--SSR_SITE_NAME-->', esc(s.site_name))
    .replaceAll('<!--SSR_CANONICAL-->', esc(base + '/'))
    .replaceAll('<!--SSR_JSONLD-->', `<script type="application/ld+json">${JSON.stringify(buildJSONLD(data, base, s)).replace(/</g, '\\u003c')}</script>`)
    // 社交分享用横版完整 LOGO（1200×630），顶栏/favicon 仍用正方形 brand-icon.png
    .replaceAll('<!--SSR_OG_IMAGE-->', `<meta property="og:image" content="${esc(base + '/brand-logo.png')}">`)
    .replaceAll('<!--SSR_CUSTOM_HEAD-->', String(s.custom_head || ''))
    .replaceAll('<!--SSR_FAVICON-->', faviconHTML)
    .replaceAll('<!--SSR_NAV_LINKS-->', navLinksHTML)
    .replaceAll('<!--SSR_BRAND-->', brandHTML)
    .replaceAll('<!--SSR_ANNOUNCEMENT-->', announceHTML)
    .replaceAll('<!--SSR_H1-->', esc(s.site_subtitle))
    .replaceAll('<!--SSR_FOOTER-->', buildFooterHTML(s))
    .replaceAll('<!--SSR_CATNAV-->', frag.catnav)
    .replaceAll('<!--SSR_CATNAV_MOBILE-->', frag.catnavMobile)
    .replaceAll('<!--SSR_FEATURED-->', featuredHTML(data, detail))
    .replaceAll('<!--SSR_POPULAR-->', popularHTML(detail))
    .replaceAll('<!--SSR_CONTENT-->', frag.content)
    .replaceAll('<!--SSR_DATA-->', `<script>window.__NAV__=${navJSON};window.__SETTINGS__=${settingsJSON};</script>`);
}

// ============ 分类详情页（/cat/:id）============
let catTemplateCache = null;

/** 渲染单个分类的全部站点；分类不存在返回 null */
function renderCategoryPage(req, catId) {
  if (!catTemplateCache) {
    catTemplateCache = fs.readFileSync(path.join(__dirname, '..', 'public', 'cat.html'), 'utf8');
  }
  const data = getNavData();
  const s = settings.getSettings();
  const cat = data.find(c => String(c.id) === String(catId));
  if (!cat) return null;

  const base = baseUrl(req);
  const catJSONLD = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: s.site_name, item: base + '/' },
        { '@type': 'ListItem', position: 2, name: cat.name, item: `${base}/cat/${cat.id}` },
      ] },
      { '@type': 'ItemList', name: cat.name, numberOfItems: cat.sites.length,
        itemListElement: cat.sites.slice(0, 100).map((st, i) =>
          ({ '@type': 'ListItem', position: i + 1, name: st.title, url: st.url })) },
    ],
  };
  const heads = cat.sites.slice(0, 3).map(x => x.title).join('、');
  const desc = `${s.site_name}「${cat.name}」分类共精选收录 ${cat.sites.length} 个网站${heads ? `，包括 ${heads} 等` : ''}，持续更新。`;

  const siblings = data.filter(c => c.id !== cat.id);
  const siblingsHTML = siblings.length
    ? `<div class="mt-10 pt-6 border-t border-gray-200/70 dark:border-gray-800">
        <p class="text-xs font-medium text-slate-400 dark:text-slate-500 mb-3">浏览其他分类</p>
        <div class="flex flex-wrap gap-2">
          ${siblings.map(c => `<a href="/cat/${c.id}" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 text-slate-600 dark:text-slate-300 hover:border-indigo-300 hover:text-indigo-500 dark:hover:border-indigo-500/40 dark:hover:text-indigo-400 transition-colors"><span>${c.icon || '📁'}</span>${esc(c.name)}<span class="text-slate-400 dark:text-slate-500">${c.sites.length}</span></a>`).join('')}
        </div>
      </div>`
    : '';

  return catTemplateCache
    .replaceAll('<!--SSR_CAT_TITLE-->', esc(`${cat.name} - ${s.site_name}`))
    .replaceAll('<!--SSR_CAT_DESCRIPTION-->', esc(desc))
    .replaceAll('<!--SSR_SITE_NAME-->', esc(s.site_name))
    .replaceAll('<!--SSR_CANONICAL-->', esc(`${base}/cat/${cat.id}`))
    .replaceAll('<!--SSR_JSONLD-->', `<script type="application/ld+json">${JSON.stringify(catJSONLD).replace(/</g, '\\u003c')}</script>`)
    .replaceAll('<!--SSR_FAVICON-->', buildFaviconHTML(s))
    .replaceAll('<!--SSR_CUSTOM_HEAD-->', String(s.custom_head || ''))
    .replaceAll('<!--SSR_BRAND-->', buildBrandHTML(s))
    .replaceAll('<!--SSR_CAT_NAME-->', esc(cat.name))
    .replaceAll('<!--SSR_CAT_ICON-->', cat.icon || '📁')
    .replaceAll('<!--SSR_CAT_COUNT-->', String(cat.sites.length))
    .replaceAll('<!--SSR_CAT_CARDS-->', cat.sites.map((st, i) => cardHTML(st, i, '', !!s.site_detail_enabled)).join('\n'))
    .replaceAll('<!--SSR_CAT_SIBLINGS-->', siblingsHTML)
    .replaceAll('<!--SSR_SIDE_NAV-->', buildSideNav(data, cat.id))
    .replaceAll('<!--SSR_FOOTER-->', buildFooterHTML(s));
}

/** 生成 llms.txt（面向 AI 搜索引擎的内容清单，GEO 优化） */
function renderLLMsTxt(req) {
  const data = getNavData();
  const s = settings.getSettings();
  const total = data.reduce((a, c) => a + c.sites.length, 0);
  const lines = [
    `# ${s.site_name}导航`,
    '',
    `> ${s.site_description || '简洁好用的中文网址导航站。分类收录常用网站、开发工具、影视娱乐与学习资源，支持多引擎搜索、站内实时搜索与深色模式。'}`,
    `> 站点：${baseUrl(req)}/ · 收录 ${data.length} 个分类共 ${total} 个精选网址。`,
    '',
  ];
  for (const c of data) {
    lines.push(`## ${c.icon || ''} ${c.name}`);
    for (const s2 of c.sites) {
      lines.push(`- [${s2.title}](${s2.url})${s2.description ? `：${s2.description}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** 页面渲染器：/about 品牌故事 + 收录规范 */
let aboutTemplateCache = null;
function renderAboutPage(req) {
  if (!aboutTemplateCache) {
    aboutTemplateCache = fs.readFileSync(path.join(__dirname, '..', 'public', 'about.html'), 'utf8');
  }
  const s = settings.getSettings();
  const base = baseUrl(req);
  return aboutTemplateCache
    .replaceAll('<!--SSR_TITLE-->', esc(`${s.site_name}导航 · 关于我们`))
    .replaceAll('<!--SSR_DESCRIPTION-->', esc(s.site_description || '青花狸导航：一只蓝白小狸，替你收藏全网好站。'))
    .replaceAll('<!--SSR_SITE_NAME-->', esc(s.site_name))
    .replaceAll('<!--SSR_FAVICON-->', buildFaviconHTML(s))
    .replaceAll('<!--SSR_CUSTOM_HEAD-->', String(s.custom_head || ''))
    .replaceAll('<!--SSR_BRAND-->', buildBrandHTML(s))
    .replaceAll('<!--SSR_SIDE_NAV-->', buildSideNav(getSideNavData()))
    .replaceAll('<!--SSR_FOOTER-->', buildFooterHTML(s));
}

/** 站点详情页（/site/:id）：站点信息 + 每日访问统计柱状图（SSR，利于单站 SEO 收录） */
let siteTemplateCache = null;
function renderSiteDetail(req, siteId) {
  if (!siteTemplateCache) {
    siteTemplateCache = fs.readFileSync(path.join(__dirname, '..', 'public', 'site.html'), 'utf8');
  }
  const id = Number(siteId);
  const site = db.prepare('SELECT id, category_id, title, url, description, tags, icon, is_pinned, clicks, detail_content FROM sites WHERE id = ? AND is_hidden = 0').get(id);
  if (!site) return null;
  const cat = db.prepare('SELECT id, name, icon FROM categories WHERE id = ?').get(site.category_id);
  const s = settings.getSettings();
  const base = baseUrl(req);
  // 展示口径：真实访问不足阈值时由 stats 模块补演示值（数值按 site+day 哈希稳定，刷新不变）
  const st = stats.getSiteStats(id);
  const stats15 = st.series;
  const total15 = st.total15;
  const totalPc = st.totalPc;
  const totalMb = st.totalMb;
  const related = db.prepare('SELECT id, category_id, title, url, description, tags, icon, is_pinned FROM sites WHERE is_hidden = 0 AND category_id = ? AND id != ? ORDER BY is_pinned DESC, sort_order ASC LIMIT 8').all(site.category_id, id);
  const maxBar = Math.max(1, ...stats15.flatMap(x => [x.pc, x.mb]));
  const barsHTML = stats15.map((x, i) => {
    const pcH = x.pc ? Math.max(Math.round((x.pc / maxBar) * 100), 5) : 0;
    const mbH = x.mb ? Math.max(Math.round((x.mb / maxBar) * 100), 5) : 0;
    const total = x.pc + x.mb;
    // 提示框贴住该日最高的那根柱子（太矮的日子压到 40% 高度，避免落得太低挡住邻柱）
    const maxH = Math.max(pcH, mbH);
    // 提示框对齐：靠边的几列分别贴左/贴右（窄屏下居中会顶出卡片），中间列居中
    const tipPos = i <= 2 ? 'left-0' : i >= stats15.length - 3 ? 'right-0' : 'left-1/2 -translate-x-1/2';
    return `<div class="bar-col group relative flex-1 flex flex-col items-center justify-end h-full min-w-0 outline-none" tabindex="0" aria-label="${esc(x.day)}：PC端 ${x.pc} 次，移动端 ${x.mb} 次，合计 ${total} 次">\n      <span class="pointer-events-none absolute inset-x-0.5 bottom-0 top-0 rounded-xl bg-indigo-100/80 dark:bg-indigo-400/15 opacity-0 scale-y-0 group-hover:opacity-100 group-hover:scale-y-100 group-focus:opacity-100 group-focus:scale-y-100 origin-bottom transition duration-300 ease-out"></span>\n      <div class="relative flex items-end justify-center gap-1 sm:gap-1.5 w-full" style="height:140px">\n        <div class="bar-pc w-2.5 sm:w-3.5 max-w-[45%] rounded-t bg-[#3B82F6] transition duration-200 group-hover:brightness-110" style="height:${pcH}%"></div>\n        <div class="bar-mb w-2.5 sm:w-3.5 max-w-[45%] rounded-t bg-[#10B981] transition duration-200 group-hover:brightness-110" style="height:${mbH}%"></div>\n        <div class="bar-tip pointer-events-none absolute z-20 opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition-opacity duration-150 ${tipPos}" style="bottom:max(calc(${maxH}% + 6px),40%)">\n          <div class="rounded-xl bg-slate-900/95 dark:bg-slate-700 text-white text-[11px] leading-snug px-2.5 py-1.5 shadow-xl whitespace-nowrap">\n            <div class="text-[10px] text-slate-400 dark:text-slate-300">${esc(x.day)} · 合计 <b class="text-white font-semibold">${total}</b> 次</div>\n            <div class="flex items-center gap-2 mt-0.5">\n              <span class="flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-sm bg-[#3B82F6]"></span>PC <b class="font-semibold">${x.pc}</b></span>\n              <span class="flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-sm bg-[#10B981]"></span>移动 <b class="font-semibold">${x.mb}</b></span>\n            </div>\n          </div>\n        </div>\n      </div>\n      <span class="bar-day relative z-10 px-1.5 py-0.5 mt-1 rounded-md text-[9px] sm:text-[10px] leading-none whitespace-nowrap text-slate-400 dark:text-slate-500 transition-colors duration-200 group-hover:bg-indigo-500 group-hover:text-white group-focus:bg-indigo-500 group-focus:text-white"><span class="sm:hidden">${Number(x.day.slice(8, 10))}</span><span class="hidden sm:inline">${esc(x.day.slice(5))}</span></span>\n    </div>`;
  }).join('');
  const siteIconHTML = site.icon
    ? `<img src="${esc(site.icon)}" alt="${esc(site.title)}" decoding="async" class="w-16 h-16 rounded-2xl object-contain bg-slate-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 p-1.5" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><span class="w-16 h-16 rounded-2xl items-center justify-center text-xl font-bold text-white ${colorOf(site.title)}" style="display:none">${esc((site.title||'?')[0]).toUpperCase()}</span>`
    : `<span class="w-16 h-16 rounded-2xl items-center justify-center text-xl font-bold text-white ${colorOf(site.title)}">${esc((site.title||'?')[0]).toUpperCase()}</span>`;
  const tags = (site.tags || '').split(',').map(t => t.trim()).filter(Boolean);
  const tagHTML = tags.length ? `<div class="flex flex-wrap gap-1.5">${tags.map(t => `<span class="${TAG_CHIP_CLASS}">${esc(t)}</span>`).join('')}</div>` : '';
  const relatedHTML = related.length ? `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">${related.map((r, i) => cardHTML(r, i, '', true)).join('\n')}</div>` : `<p class="text-sm text-slate-400 dark:text-slate-500">该分类下暂无其他站点</p>`;
  const desc = `${s.site_name}收录的网站「${site.title}」：${site.description || ''}。近 15 天访问 ${total15} 次（PC端 ${totalPc} / 移动端 ${totalMb}），点击直达官网。`;
  const detailContentHTML = String(site.detail_content || '').trim()
    ? `<section class="site-intro bg-white dark:bg-gray-900 rounded-2xl border border-gray-200/80 dark:border-gray-800 shadow-sm p-6 mb-8 leading-relaxed text-sm text-slate-600 dark:text-slate-300">${String(site.detail_content)}</section>`
    : '';
  const jsonld = JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebPage', name: site.title, url: `${base}/site/${site.id}`, description: site.description || '' }).replace(/</g, '\\u003c');
  return siteTemplateCache
    .replaceAll('<!--SSR_TITLE-->', esc(`${site.title} - ${s.site_name}`))
    .replaceAll('<!--SSR_DESCRIPTION-->', esc(desc))
    .replaceAll('<!--SSR_KEYWORDS-->', esc(tags.join(',') || s.site_keywords))
    .replaceAll('<!--SSR_SITE_NAME-->', esc(s.site_name))
    .replaceAll('<!--SSR_CANONICAL-->', esc(`${base}/site/${site.id}`))
    .replaceAll('<!--SSR_JSONLD-->', `<script type="application/ld+json">${jsonld}</script>`)
    .replaceAll('<!--SSR_FAVICON-->', buildFaviconHTML(s))
    .replaceAll('<!--SSR_CUSTOM_HEAD-->', String(s.custom_head || ''))
    .replaceAll('<!--SSR_BRAND-->', buildBrandHTML(s))
    .replaceAll('<!--SSR_FOOTER-->', buildFooterHTML(s))
    .replaceAll('<!--SSR_SITE_ID-->', String(site.id))
    .replaceAll('<!--SSR_SITE_TITLE-->', esc(site.title))
    .replaceAll('<!--SSR_SITE_ICON-->', siteIconHTML)
    .replaceAll('<!--SSR_SITE_URL-->', esc(site.url))
    .replaceAll('<!--SSR_SITE_DESC-->', esc(site.description || ''))
    .replaceAll('<!--SSR_CAT_NAME-->', esc(cat ? cat.name : ''))
    .replaceAll('<!--SSR_CAT_ID-->', String(cat ? cat.id : ''))
    .replaceAll('<!--SSR_CAT_ICON-->', cat ? (cat.icon || '📁') : '📁')
    .replaceAll('<!--SSR_CLICKS-->', String(stats.displayClicks(site.clicks, st, site.id)))
    .replaceAll('<!--SSR_TOTAL15-->', String(total15))
    .replaceAll('<!--SSR_TOTAL_PC-->', String(totalPc))
    .replaceAll('<!--SSR_TOTAL_MB-->', String(totalMb))
    .replaceAll('<!--SSR_DETAIL_CONTENT-->', detailContentHTML)
    .replaceAll('<!--SSR_TAGS-->', tagHTML)
    .replaceAll('<!--SSR_BARS-->', barsHTML)
    .replaceAll('<!--SSR_SIDE_NAV-->', buildSideNav(getSideNavData(), site.category_id))
    .replaceAll('<!--SSR_RELATED-->', relatedHTML);
}

/**
 * 网站地图（HTML 版）：百度不认 XML 地图，只吃 HTML 页面，所以这里用 SSR 输出全站清单。
 * 每个条目都链接到站内 /site/{id} 详情页，让蜘蛛顺着爬过去收录单站长尾页。
 */
let sitemapTemplateCache = null;
function renderSitemapPage(req) {
  if (!sitemapTemplateCache) {
    sitemapTemplateCache = fs.readFileSync(path.join(__dirname, '..', 'public', 'sitemap.tpl.html'), 'utf8');
  }
  const s = settings.getSettings();
  const base = baseUrl(req);
  const siteStmt = db.prepare(`SELECT id, title, description FROM sites
    WHERE category_id = ? AND is_hidden = 0
    ORDER BY is_pinned DESC, sort_order ASC, id ASC`);
  const groups = getSideNavData()
    .map(c => ({ ...c, sites: siteStmt.all(c.id) }))
    .filter(g => g.sites.length);
  const siteCount = groups.reduce((a, g) => a + g.sites.length, 0);

  const body = groups.map(g => `
    <section id="cat-${g.id}" class="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200/80 dark:border-gray-800 shadow-sm p-5">
      <h2 class="text-base font-bold tracking-tight flex items-center gap-2 mb-3">
        <span class="w-7 h-7 rounded-lg bg-slate-100 dark:bg-gray-800 flex items-center justify-center text-sm shrink-0">${esc(g.icon || '📁')}</span>
        <a href="/cat/${g.id}" class="hover:text-indigo-500 dark:hover:text-indigo-400 transition-colors">${esc(g.name)}</a>
        <span class="text-xs font-normal text-slate-400 dark:text-slate-500">${g.sites.length} 个</span>
      </h2>
      <ul class="grid sm:grid-cols-2 gap-x-6 gap-y-2.5">
        ${g.sites.map(x => `<li class="min-w-0">
          <a href="/site/${x.id}" class="map-link text-sm font-medium text-slate-700 dark:text-slate-300 hover:text-indigo-500 dark:hover:text-indigo-400">${esc(x.title)}</a>
          ${x.description ? `<span class="block text-[11px] leading-snug text-slate-400 dark:text-slate-500 truncate">${esc(x.description)}</span>` : ''}
        </li>`).join('\n        ')}
      </ul>
    </section>`).join('');

  const title = `${s.site_name}导航网站地图 - 全部分类与收录网址一览`;
  const desc = `${s.site_name}导航网站地图：共 ${groups.length} 个分类、${siteCount} 个收录网址的完整清单，含常用站点、影视动漫、资源搜索、游戏软件、阅读漫画、音乐、实用工具等分类，点击即可查看站点介绍并直达官网。`;
  return sitemapTemplateCache
    .replaceAll('<!--SSR_TITLE-->', esc(title))
    .replaceAll('<!--SSR_DESCRIPTION-->', esc(desc))
    .replaceAll('<!--SSR_KEYWORDS-->', esc(s.site_keywords))
    .replaceAll('<!--SSR_SITE_NAME-->', esc(s.site_name))
    .replaceAll('<!--SSR_CANONICAL-->', esc(`${base}/sitemap.html`))
    .replaceAll('<!--SSR_FAVICON-->', buildFaviconHTML(s))
    .replaceAll('<!--SSR_CUSTOM_HEAD-->', String(s.custom_head || ''))
    .replaceAll('<!--SSR_BRAND-->', buildBrandHTML(s))
    .replaceAll('<!--SSR_FOOTER-->', buildFooterHTML(s))
    .replaceAll('<!--SSR_CAT_COUNT-->', String(groups.length))
    .replaceAll('<!--SSR_SITE_COUNT-->', String(siteCount))
    .replaceAll('<!--SSR_SIDE_NAV-->', buildSideNav(getSideNavData()))
    .replaceAll('<!--SSR_SITEMAP_BODY-->', body);
}

/** sitemap.xml：首页 + 分类页 + 全部站点详情页 + 地图页/关于页 */
function renderSitemapXML(req) {
  const base = baseUrl(req);
  const cats = getSideNavData();
  const sites = db.prepare('SELECT id, created_at FROM sites WHERE is_hidden = 0 ORDER BY category_id ASC, sort_order ASC, id ASC').all();
  // created_at 形如 2026-11-05 22:00:00（服务器本地时间），转成带时区的 ISO 给爬虫
  const iso = t => {
    const m = String(t || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
    return m ? `${m[1]}T${m[2]}+08:00` : '';
  };
  const urlTag = (loc, freq, priority, lastmod) =>
    `  <url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}<changefreq>${freq}</changefreq><priority>${priority}</priority></url>`;
  const lines = [
    urlTag(`${base}/`, 'daily', '1.0'),
    ...cats.map(c => urlTag(`${base}/cat/${c.id}`, 'daily', '0.8')),
    ...sites.map(x => urlTag(`${base}/site/${x.id}`, 'weekly', '0.7', iso(x.created_at))),
    urlTag(`${base}/sitemap.html`, 'weekly', '0.6'),
    urlTag(`${base}/about`, 'monthly', '0.5'),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${lines.join('\n')}
</urlset>`;
}

module.exports = { renderNavPage, renderCategoryPage, renderLLMsTxt, renderAboutPage, getNavData, renderSiteDetail, renderSitemapPage, renderSitemapXML, baseUrl };
