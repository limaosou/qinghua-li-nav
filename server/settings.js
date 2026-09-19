/**
 * 站点配置（key-value 存储于 settings 表）
 * 参考 Go Nav 的站点配置模块：基本信息 / SEO / 首页 / 搜索引擎 / 自定义代码
 */
const db = require('./db');

const DEFAULTS = {
  // 基本信息
  site_name: '青花狸',
  site_title: '青花狸导航 - 简洁好用的网址导航 | 精选常用网站、开发工具、影视娱乐、学习资源',
  site_subtitle: '青花狸 · 今天是哪一站？',             // 首页 H1
  site_description: '青花狸导航是一个简洁高效的网址导航站：分类收录常用网站、开发工具、影视娱乐与学习资源，支持百度/Google/Bing 等多引擎搜索、站内实时搜索、深色模式，移动端与电脑端完美适配。',
  site_keywords: '青花狸,青花狸导航,网址导航,网站导航,常用网站,开发工具,影视娱乐,学习资源,导航站',
  footer_text: '青花狸导航 · 精选好站，随点随达',
  icp: '',                                             // 备案号，留空不显示
  // 首页配置
  brand_icon: '🦝',                                    // emoji 或图片 URL（http 开头当图片用）
  brand_image: '',                                     // 品牌图片，优先于 brand_icon
  announcement: '',                                    // 公告通知，留空不显示
  // SEO 配置
  robots_txt: 'User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\n',
  // 搜索配置
  engines: [
    { name: '百度', url: 'https://www.baidu.com/s?wd={query}' },
    { name: 'Google', url: 'https://www.google.com/search?q={query}' },
    { name: 'Bing', url: 'https://www.bing.com/search?q={query}' },
    { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q={query}' },
  ],
  // 顶部导航链接（前台顶栏，{label, url}）
  nav_links: [],
  // 自定义代码（注入 </head> 前）
  custom_head: '',
};

const upsert = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const merged = { ...DEFAULTS };
  for (const { key, value } of rows) {
    if (!(key in DEFAULTS)) continue;
    try {
      merged[key] = JSON.parse(value); // engines 等结构化值
    } catch {
      merged[key] = value;
    }
  }
  return merged;
}

/** 前台可公开的字段 */
function getPublicSettings() {
  const s = getSettings();
  return {
    site_name: s.site_name,
    site_subtitle: s.site_subtitle,
    footer_text: s.footer_text,
    icp: s.icp,
    brand_icon: s.brand_icon,
    brand_image: s.brand_image,
    announcement: s.announcement,
    engines: s.engines,
    nav_links: s.nav_links,
  };
}

function saveSettings(partial) {
  const allowed = Object.keys(DEFAULTS);
  const saved = [];
  for (const [k, v] of Object.entries(partial || {})) {
    if (!allowed.includes(k)) continue;
    upsert.run(k, typeof v === 'string' ? v : JSON.stringify(v));
    saved.push(k);
  }
  return saved;
}

module.exports = { getSettings, getPublicSettings, saveSettings, DEFAULTS };
