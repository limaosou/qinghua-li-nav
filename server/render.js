/**
 * 首页服务端渲染（SSR）：
 * 把分类与网址直接渲染进 HTML 源码 —— 搜索引擎与 AI 爬虫（GPTBot 等，不执行 JS）可完整抓取内容。
 * 同时注入 window.__NAV__ 数据，浏览器端跳过请求直接接管交互。
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const settings = require('./settings');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/** 每个分类默认展示的站点数，超出的折叠进「更多」（与前端 public/index.html 保持一致） */
const SITE_LIMIT = 20;

const AVATAR_COLORS = ['bg-indigo-500','bg-sky-500','bg-emerald-500','bg-amber-500','bg-rose-500','bg-violet-500','bg-cyan-600','bg-orange-500'];
const colorOf = s => AVATAR_COLORS[([...String(s)].reduce((a, c) => a + c.codePointAt(0), 0)) % AVATAR_COLORS.length];

function getNavData() {
  const categories = db.prepare('SELECT id, name, icon FROM categories ORDER BY sort_order ASC, id ASC').all();
  const siteStmt = db.prepare(`
    SELECT id, category_id, title, url, description, tags, icon, is_pinned
    FROM sites WHERE is_hidden = 0 AND category_id = ?
    ORDER BY is_pinned DESC, sort_order ASC, id ASC`);
  return categories.map((c) => ({ ...c, sites: siteStmt.all(c.id) }));
}

/* 与前端 index.html 中的模板保持一致 */
function cardHTML(s, i, extraClass = '') {
  const tags = (s.tags || '').split(',').map(t => t.trim()).filter(Boolean);
  return `
  <a href="${esc(s.url)}" target="_blank" rel="noopener" data-idx="${i}"
     class="card-hover group relative block p-3.5 rounded-2xl border border-gray-200/80 dark:border-gray-800 bg-white dark:bg-gray-900 cursor-pointer hover:border-indigo-300 dark:hover:border-indigo-500/50 hover:shadow-[0_10px_32px_rgba(79,70,229,0.10)] dark:hover:shadow-[0_10px_32px_rgba(0,0,0,0.4)]${extraClass}">
    ${s.is_pinned ? `<span class="absolute top-2.5 right-2.5 text-indigo-400" title="置顶"><i data-lucide="pin" class="w-3.5 h-3.5"></i></span>` : ''}
    <div class="flex items-center gap-3">
      <div class="relative w-10 h-10 shrink-0">
        ${s.icon ? `<img src="${esc(s.icon)}" alt="${esc(s.title)}" class="w-10 h-10 rounded-xl object-contain bg-slate-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 p-1" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">` : ''}
        <span class="w-10 h-10 rounded-xl items-center justify-center text-sm font-bold text-white ${colorOf(s.title)}" style="display:${s.icon ? 'none' : 'flex'}">${esc((s.title || '?')[0]).toUpperCase()}</span>
      </div>
      <div class="min-w-0 pr-4">
        <div class="font-medium text-[15px] truncate group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors duration-200">${esc(s.title)}</div>
        <div class="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">${esc(s.description || s.url)}</div>
      </div>
    </div>
    ${tags.length ? `<div class="mt-2.5 flex flex-wrap gap-1.5">${tags.map(t => `<span class="px-2 py-0.5 rounded-full text-[11px] bg-slate-50 dark:bg-gray-800 text-slate-500 dark:text-slate-400 border border-gray-100 dark:border-gray-700">${esc(t)}</span>`).join('')}</div>` : ''}
  </a>`;
}

function renderFragments(data) {
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
        ${c.sites.slice(0, SITE_LIMIT).map((s, i) => cardHTML(s, i)).join('')}
      </div>
    </section>`).join('');

  return { catnav, catnavMobile, content };
}

let templateCache = null;

function baseUrl(req) {
  // 线上站点始终走 HTTPS（宝塔反代可能不回传 x-forwarded-proto，因此默认 https）
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
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
    ? `<img src="${esc(s.brand_image)}" alt="${esc(s.site_name)}" class="w-8 h-8 rounded-xl object-cover shadow-sm">`
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
  const frag = renderFragments(data);
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
    .replaceAll('<!--SSR_OG_IMAGE-->', s.brand_image ? `<meta property="og:image" content="${esc(base + s.brand_image)}">` : '')
    .replaceAll('<!--SSR_CUSTOM_HEAD-->', String(s.custom_head || ''))
    .replaceAll('<!--SSR_FAVICON-->', faviconHTML)
    .replaceAll('<!--SSR_NAV_LINKS-->', navLinksHTML)
    .replaceAll('<!--SSR_BRAND-->', brandHTML)
    .replaceAll('<!--SSR_ANNOUNCEMENT-->', announceHTML)
    .replaceAll('<!--SSR_H1-->', esc(s.site_subtitle))
    .replaceAll('<!--SSR_FOOTER-->', buildFooterHTML(s))
    .replaceAll('<!--SSR_CATNAV-->', frag.catnav)
    .replaceAll('<!--SSR_CATNAV_MOBILE-->', frag.catnavMobile)
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
    .replaceAll('<!--SSR_CAT_CARDS-->', cat.sites.map((st, i) => cardHTML(st, i)).join('\n'))
    .replaceAll('<!--SSR_CAT_SIBLINGS-->', siblingsHTML)
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

module.exports = { renderNavPage, renderCategoryPage, renderLLMsTxt, getNavData };
