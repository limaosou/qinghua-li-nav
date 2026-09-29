#!/usr/bin/env node
/**
 * 搜索引擎主动提交：把 sitemap 里的链接主动推给搜索引擎，加速收录
 *
 * 设计：
 *  - 抓取线上 SITE_URL/sitemap.xml，解析全部 <loc> 链接（不依赖 xml 库，正则即可）。
 *  - 百度（国内主战场，收录最快）：主动推送接口 + sitemap 提交接口，需 BAIDU_ZZ_TOKEN。
 *  - 必应 / Bing（同时喂给 ChatGPT、Copilot 等）：IndexNow 协议，需 BING_INDEXNOW_KEY；
 *    脚本会自动在 public/<key>.txt 生成校验文件，供 IndexNow 回查。
 *  - 两个 token 都不填时直接退出（exit 2），不报错、不联网。
 *  - 报告写入 data/submit-report.json。
 *
 * 用法：
 *   node scripts/submit-index.js
 *   npm run submit
 * 建议 crontab（每天 04:00）：
 *   0 4 * * * cd /www/wwwroot/qinghua-li-nav && /usr/bin/node scripts/submit-index.js >> data/submit.log 2>&1
 */
'use strict';
const fs = require('fs');
const path = require('path');

// 极简 .env 读取（与 server/env.js 行为一致：KEY=VALUE，忽略注释与空行）
function loadEnv() {
  const file = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const k = m[1], v = m[2].replace(/^["']|["']$/g, '');
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnv();

const REPO_ROOT = path.resolve(__dirname, '..');
const SITE_URL = (process.env.SITE_URL || 'https://www.liqinghua.com').replace(/\/+$/, '');
const BAIDU_TOKEN = process.env.BAIDU_ZZ_TOKEN || '';
const BAIDU_SITE = process.env.BAIDU_SITE || SITE_URL.replace(/^https?:\/\//, '');
const BING_KEY = process.env.BING_INDEXNOW_KEY || '';
const SITEMAP_URL = `${SITE_URL}/sitemap.xml`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[submit ${new Date().toISOString()}]`, ...a);

async function fetchText(url, opts) {
  const r = await fetch(url, opts);
  return { status: r.status, text: await r.text() };
}

async function getSitemapUrls() {
  const { status, text } = await fetchText(SITEMAP_URL);
  if (status !== 200) throw new Error(`抓取 sitemap 失败 HTTP ${status}`);
  const locs = [...text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim()).filter(Boolean);
  if (!locs.length) throw new Error('sitemap 中未解析到任何 <loc>');
  return locs;
}

async function pushBaidu(urls) {
  const q = `site=${encodeURIComponent(BAIDU_SITE)}&token=${encodeURIComponent(BAIDU_TOKEN)}`;
  // 1) 主动推送（收录最快）
  const push = await fetchText(`http://data.zz.baidu.com/urls?${q}`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: urls.join('\n'),
  });
  // 2) 提交 sitemap（兜底，让百度完整抓取）
  const sm = await fetchText(`http://data.zz.baidu.com/sitemap?${q}`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: SITEMAP_URL,
  });
  return {
    pushed: urls.length,
    pushStatus: push.status, pushResp: push.text.slice(0, 200),
    sitemapStatus: sm.status, sitemapResp: sm.text.slice(0, 200),
  };
}

async function pushBing(urls) {
  const host = SITE_URL.replace(/^https?:\/\//, '');
  const keyFile = path.join(REPO_ROOT, 'public', `${BING_KEY}.txt`);
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, BING_KEY, 'utf8'); // IndexNow 回查校验文件
  const keyLocation = `${SITE_URL}/${BING_KEY}.txt`;
  const r = await fetchText('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host, key: BING_KEY, keyLocation, urlList: urls }),
  });
  return { status: r.status, resp: r.text.slice(0, 200) };
}

async function main() {
  if (!BAIDU_TOKEN && !BING_KEY) {
    log('未配置 BAIDU_ZZ_TOKEN / BING_INDEXNOW_KEY，跳过（exit 2）。');
    log('配置方法见 README「搜索引擎主动提交」一节。');
    process.exit(2);
  }
  let urls;
  try {
    urls = await getSitemapUrls();
    log(`sitemap 解析到 ${urls.length} 个链接`);
  } catch (e) {
    log('读取 sitemap 失败：', e.message);
    process.exit(1);
  }

  const report = { at: new Date().toISOString(), site: SITE_URL, urls: urls.length, baidu: null, bing: null, skipped: [] };

  if (BAIDU_TOKEN) {
    try { report.baidu = await pushBaidu(urls); log('百度提交完成', JSON.stringify(report.baidu)); }
    catch (e) { report.skipped.push(`baidu: ${e.message}`); log('百度提交异常：', e.message); }
  } else report.skipped.push('baidu: 未配置 BAIDU_ZZ_TOKEN');

  if (BING_KEY) {
    try { report.bing = await pushBing(urls); log('必应 IndexNow 完成', JSON.stringify(report.bing)); }
    catch (e) { report.skipped.push(`bing: ${e.message}`); log('必应提交异常：', e.message); }
  } else report.skipped.push('bing: 未配置 BING_INDEXNOW_KEY');

  try {
    const out = path.resolve(REPO_ROOT, 'data', 'submit-report.json');
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    log('报告已写入', out);
  } catch (e) { log('写报告失败（忽略）：', e.message); }

  process.exit(report.skipped.length && !report.baidu && !report.bing ? 1 : 0);
}

main().catch((e) => { log('异常：', e.message); process.exit(1); });
