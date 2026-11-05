#!/usr/bin/env node
/**
 * 站点图标本地化
 *
 * 线上首页 100+ 个图标原本全部指向第三方 favicon.im，每个请求都要先 302 再回源目标站，
 * 单张 0.5 秒上下，且首屏就全部发起，导致图标迟迟不显示。
 * 本脚本把图标下载到 public/icons/，数据库 icon 字段改成本地路径，之后图标与网页同样快。
 *
 * 用法（在项目根目录执行）：
 *   node scripts/localize-icons.js              # 处理所有还没本地化的站点
 *   node scripts/localize-icons.js --force      # 全部重新下载（换图标后刷新用）
 *   node scripts/localize-icons.js --limit=30   # 只处理前 30 个（先试水）
 *   node scripts/localize-icons.js --dry        # 只看会做什么，不写文件不改库
 *
 * 说明：
 * - 不改动原图内容，按服务器返回的 content-type 定扩展名（png/jpg/webp/ico/svg…）
 * - favicon.im 拿不到时，回退到「站点域名/favicon.ico」
 * - 支持 data:image/...;base64 形式的内联图标（转为文件，减小 HTML 体积）
 * - 单个失败不影响其他，最后会列出失败清单，可重复执行补齐
 */
const fs = require('fs');
const path = require('path');
const db = require('../server/db');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');
const PUBLIC_PREFIX = '/icons/';
const CONCURRENCY = 8;
const TIMEOUT_MS = 12000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

const argv = process.argv.slice(2);
const limitArg = argv.find(a => a.startsWith('--limit'));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) || 0 : 0;
const FORCE = argv.includes('--force');
const DRY = argv.includes('--dry');

const EXT_BY_TYPE = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'image/ico': '.ico',
  'image/avif': '.avif',
};

function extFromUrl(url) {
  const m = String(url).match(/\.([a-z0-9]{2,4})(?:\?|#|$)/i);
  const e = m ? '.' + m[1].toLowerCase() : '';
  return ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico'].includes(e) ? e : '';
}

async function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('响应为空');
    if (type && !type.startsWith('image/') && !/octet-stream/.test(type)) throw new Error(`不是图片 (${type})`);
    return { buf, type };
  } finally {
    clearTimeout(timer);
  }
}

/** 按图标记录拿到 { buf, ext }，失败抛错 */
async function resolveIcon(site) {
  const icon = String(site.icon || '').trim();

  // ① data URI：直接解码
  const dm = icon.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (dm) {
    const type = (dm[1] || 'image/png').toLowerCase();
    const buf = dm[2] ? Buffer.from(dm[3], 'base64') : Buffer.from(decodeURIComponent(dm[3]), 'binary');
    if (!buf.length) throw new Error('data URI 解析为空');
    return { buf, ext: EXT_BY_TYPE[type] || '.png' };
  }

  // ② 原本就是外链：优先原样下载
  const candidates = [];
  if (/^https?:\/\//i.test(icon)) candidates.push(icon);

  // ③ 兜底：用站点自己的域名走 favicon.im，再不行直连 /favicon.ico
  let host = '';
  try { host = new URL(site.url).host; } catch { /* url 不规范就跳过兜底 */ }
  if (host) {
    candidates.push(`https://favicon.im/${host}?larger=true`);
    candidates.push(`https://${host}/favicon.ico`);
  }

  let lastErr = null;
  for (const url of candidates) {
    try {
      const { buf, type } = await fetchWithTimeout(url);
      return { buf, ext: EXT_BY_TYPE[type] || extFromUrl(url) || '.png' };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('没有可用的图标地址');
}

function iconExists(id) {
  try {
    return fs.readdirSync(OUT_DIR).some(f => f.startsWith(`${id}.`));
  } catch {
    return false;
  }
}

/** 覆盖前先清掉同 id 的旧文件，避免 png/ico 两份并存 */
function cleanupOld(id, keepName) {
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (f.startsWith(`${id}.`) && f !== keepName) {
      try { fs.unlinkSync(path.join(OUT_DIR, f)); } catch { /* 忽略 */ }
    }
  }
}

const stats = { ok: 0, skip: 0, fail: 0 };
const failures = [];
let cursor = 0;

async function handle(site) {
  const icon = String(site.icon || '').trim();
  const alreadyLocal = icon.startsWith(PUBLIC_PREFIX);

  if (alreadyLocal && !FORCE) {
    if (iconExists(site.id)) { stats.skip++; return; }
  }

  if (DRY) { stats.ok++; return; }

  try {
    const { buf, ext } = await resolveIcon(site);
    const name = `${site.id}${ext}`;
    fs.writeFileSync(path.join(OUT_DIR, name), buf);
    cleanupOld(site.id, name);
    db.prepare('UPDATE sites SET icon = ? WHERE id = ?').run(PUBLIC_PREFIX + name, site.id);
    stats.ok++;
    const kb = (buf.length / 1024).toFixed(1);
    console.log(`  ✓ [${String(site.id).padStart(4)}] ${String(site.title).slice(0, 18).padEnd(18)} ${name.padEnd(10)} ${kb}KB`);
  } catch (e) {
    stats.fail++;
    failures.push({ id: site.id, title: site.title, reason: e.message });
    console.log(`  ✗ [${String(site.id).padStart(4)}] ${String(site.title).slice(0, 18).padEnd(18)} ${e.message}`);
  }
}

async function worker() {
  while (cursor < rows.length) {
    const site = rows[cursor++];
    await handle(site);
  }
}

let rows = [];

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  rows = db.prepare('SELECT id, title, url, icon FROM sites WHERE is_hidden = 0 ORDER BY id ASC').all();
  if (LIMIT > 0) rows = rows.slice(0, LIMIT);

  console.log(`待处理 ${rows.length} 个站点图标${FORCE ? '（--force 全部重下）' : ''}${DRY ? '（--dry 仅演示，不写文件）' : ''}\n`);

  const t0 = Date.now();
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length || 1) }, worker));

  console.log(`\n完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  成功(含已存在) ${stats.ok}   已有跳过 ${stats.skip}   失败 ${stats.fail}`);
  if (failures.length) {
    console.log('\n失败清单（可重复执行本脚本补齐）：');
    failures.forEach(f => console.log(`  [${f.id}] ${f.title} —— ${f.reason}`));
  }
  if (DRY) console.log('\n提示：--dry 只统计数量，未实际下载。去掉 --dry 才会真正执行。');
})();
