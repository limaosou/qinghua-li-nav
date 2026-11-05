/**
 * 站点图标本地化（共享模块）
 *
 * 后台新增/编辑网址、后台「图标本地化」面板、命令行脚本都调用这里，
 * 保证三处逻辑一致。
 *
 * 设计要点：
 * - 优先用文件头（magic bytes）判断真实格式，不轻信 content-type
 *   （不少老站点把 ico 当 image/png 返回，或返回 application/octet-stream）
 * - 依次尝试：原图标地址 → favicon.im → 站点自身 /favicon.ico（https 再 http）
 * - 失败不动数据库，原图仍然可用，只是走外链
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');
const PUBLIC_PREFIX = '/icons/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 8000;
const MAX_BYTES = 512 * 1024;

const EXT_BY_TYPE = {
  'image/png': '.png',
  'image/apng': '.png',
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

function ensureDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

/** 按文件头判断格式，识别不出返回 '' */
function sniffExt(buf) {
  if (buf.length < 4) return '';
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return '.png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return '.gif';
  if (b.length > 11 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  if (b[0] === 0x00 && b[1] === 0x00 && (b[2] === 0x01 || b[2] === 0x02) && b[3] === 0x00) return '.ico';
  if (b.length > 12 && b.toString('ascii', 4, 8) === 'ftyp') {
    const brand = b.toString('ascii', 8, 12);
    if (brand === 'avif' || brand === 'avis') return '.avif';
  }
  const head = b.toString('utf8', 0, Math.min(buf.length, 512)).trim();
  if (/^<\?xml/i.test(head) || /^<svg/i.test(head)) {
    if (/<svg[\s>]/i.test(b.toString('utf8', 0, Math.min(buf.length, 4096)))) return '.svg';
  }
  return '';
}

function extFromUrl(url) {
  const m = String(url).match(/\.([a-z0-9]{2,4})(?:\?|#|$)/i);
  const e = m ? '.' + m[1].toLowerCase() : '';
  return ['.png', '.jpg', '.webp', '.gif', '.svg', '.ico'].includes(e) ? e : '';
}

/**
 * favicon.im 抓不到目标站时不会报错，而是返回一张 257 字节的灰色圆底 "f" 占位图。
 * 直接当成功保存会让一堆站点顶着同样的灰图标，所以识别出来当失败处理，
 * 好让调用方继续去试站点自己的 /favicon.ico。
 */
function isPlaceholder(buf, ext) {
  if (ext !== '.svg' || buf.length > 800) return false;
  const s = buf.toString('utf8');
  return /#808080/i.test(s) && /<circle/i.test(s) && /text-anchor="middle"/i.test(s);
}

/** 把底层网络错误翻译成看得懂的话，后台失败清单直接展示 */
function describeError(e) {
  const msg = String(e?.message || '');
  if (/HTTP \d{3}/.test(msg)) return msg;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || /aborted|timeout/i.test(msg)) return '超时（12 秒无响应）';
  const c = e?.cause;
  const code = c?.code || (Array.isArray(c?.errors) && c.errors[0]?.code) || '';
  const map = {
    ENOTFOUND: '域名解析失败',
    EAI_AGAIN: '域名解析超时',
    ECONNREFUSED: '对方拒绝连接',
    ECONNRESET: '连接被重置',
    ECONNABORTED: '连接中断',
    ETIMEDOUT: '连接超时',
    EPROTO: 'TLS 协议错误',
    CERT_HAS_EXPIRED: '证书已过期',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书无法验证',
    DEPTH_ZERO_SELF_SIGNED_CERT: '自签名证书',
    ERR_TLS_CERT_ALTNAME_INVALID: '证书域名不匹配',
    UND_ERR_CONNECT_TIMEOUT: '连接超时',
    UND_ERR_SOCKET: '连接被中断',
  };
  if (map[code]) return map[code];
  if (/certificate/i.test(msg)) return '证书错误';
  if (msg && msg !== 'fetch failed') return msg;
  return '网络请求失败';
}

/** 网络层抖动可重试；HTTP 4xx/5xx 是对方明确拒绝、超时重试只会让等待翻倍，都不重试 */
function isRetryable(e) {
  const msg = String(e?.message || '');
  if (/HTTP \d{3}/.test(msg)) return false;
  if (/不是图片|文件过大|响应为空|占位图/.test(msg)) return false;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || /aborted|timeout/i.test(msg)) return false;
  return true;
}

async function fetchImage(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ctype = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('响应为空');
  if (buf.length > MAX_BYTES) throw new Error(`文件过大 ${(buf.length / 1024) | 0}KB`);

  const sniffed = sniffExt(buf);
  if (sniffed) {
    if (isPlaceholder(buf, sniffed)) throw new Error('图标服务返回占位图');
    return { buf, ext: sniffed };
  }
  if (ctype.startsWith('image/')) {
    const ext = EXT_BY_TYPE[ctype] || extFromUrl(url) || '.png';
    if (isPlaceholder(buf, ext)) throw new Error('图标服务返回占位图');
    return { buf, ext };
  }
  throw new Error(`不是图片 (${ctype || '无 content-type'})`);
}

/** 带一次重试的抓取，缓解 favicon.im 偶发限流/抖动 */
async function fetchImageWithRetry(url) {
  try {
    return await fetchImage(url);
  } catch (e) {
    if (!isRetryable(e)) throw e;
    await new Promise((r) => setTimeout(r, 600));
    return await fetchImage(url);
  }
}

/** 图标是否已经是本地文件，且文件确实存在 */
function isLocal(icon) {
  return String(icon || '').startsWith(PUBLIC_PREFIX);
}

function fileExists(id) {
  try {
    return fs.readdirSync(OUT_DIR).some((f) => f.startsWith(`${id}.`));
  } catch {
    return false;
  }
}

/** 需要本地化的站点：不是本地路径，或本地路径但文件丢了 */
function needsLocalize(site) {
  const icon = String(site.icon || '').trim();
  if (isLocal(icon)) return !fileExists(site.id);
  return true;
}

/** 覆盖前清掉同 id 的旧文件，避免 png/ico 两份并存 */
function cleanupOld(id, keepName) {
  let files = [];
  try { files = fs.readdirSync(OUT_DIR); } catch { return; }
  for (const f of files) {
    if (f.startsWith(`${id}.`) && f !== keepName) {
      try { fs.unlinkSync(path.join(OUT_DIR, f)); } catch { /* 忽略 */ }
    }
  }
}

/** 抓首页 HTML，解析 <link rel="icon"> 指向的真实图标地址（很多站点根目录没有 favicon.ico） */
async function fetchHtmlIconUrls(site) {
  const pageUrl = /^https?:\/\//i.test(String(site.url || '')) ? String(site.url) : `https://${site.url}`;
  const res = await fetch(pageUrl, {
    redirect: 'follow',
    signal: AbortSignal.timeout(8000),
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = (await res.text()).slice(0, 400 * 1024);
  const base = res.url || pageUrl;

  const found = [];
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const rel = (tag.match(/rel\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    if (!/icon/i.test(rel) || /mask-icon/i.test(rel)) continue;
    const href = (tag.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    if (!href || /^data:/i.test(href)) continue;
    try {
      found.push({ rel: rel.trim().toLowerCase(), url: new URL(href, base).href });
    } catch { /* 非法 href 忽略 */ }
  }

  // apple-touch-icon 通常是 180×180 的大图，优先；其余按文档顺序
  found.sort((a, b) => (b.rel.includes('apple') ? 1 : 0) - (a.rel.includes('apple') ? 1 : 0));
  return [...new Set(found.map((f) => f.url))].slice(0, 5);
}

function candidatesFor(site) {
  const icon = String(site.icon || '').trim();
  const list = [];
  if (/^https?:\/\//i.test(icon)) list.push(icon);

  let host = '';
  try { host = new URL(site.url).host; } catch { /* url 不规范 */ }
  if (host) {
    const bare = host.replace(/^www\./i, '');
    // favicon.im 能拿到较大尺寸的图，放前面；它抓不到时返回灰底占位图，
    // 会被 isPlaceholder 拦下，自动继续试站点自己的 favicon.ico
    list.push(`https://favicon.im/${host}?larger=true`);
    list.push(`https://${host}/favicon.ico`);
    if (bare !== host) list.push(`https://${bare}/favicon.ico`);
    list.push(`http://${host}/favicon.ico`);
  }
  return [...new Set(list)];
}

/**
 * 本地化单个站点
 * @returns {{ok:boolean, icon?:string, skipped?:boolean, reason?:string}}
 */
async function localizeSite(site, opts = {}) {
  const force = !!opts.force;
  const icon = String(site.icon || '').trim();

  if (isLocal(icon) && !force && fileExists(site.id)) {
    return { ok: true, skipped: true, icon };
  }

  ensureDir();

  // data URI 直接落盘，顺手缩小 HTML 体积
  const dm = icon.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (dm) {
    try {
      const type = (dm[1] || 'image/png').toLowerCase();
      const buf = dm[2] ? Buffer.from(dm[3], 'base64') : Buffer.from(decodeURIComponent(dm[3]), 'binary');
      if (!buf.length) throw new Error('data URI 解析为空');
      const ext = sniffExt(buf) || EXT_BY_TYPE[type] || '.png';
      const name = `${site.id}${ext}`;
      fs.writeFileSync(path.join(OUT_DIR, name), buf);
      cleanupOld(site.id, name);
      db.prepare('UPDATE sites SET icon = ? WHERE id = ?').run(PUBLIC_PREFIX + name, site.id);
      return { ok: true, icon: PUBLIC_PREFIX + name };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  const list = candidatesFor(site);
  if (!list.length) return { ok: false, reason: '图标为空且无法从网址推断域名' };

  let lastErr = null;
  let triedCount = 0;

  const save = (buf, ext) => {
    const name = `${site.id}${ext}`;
    fs.writeFileSync(path.join(OUT_DIR, name), buf);
    cleanupOld(site.id, name);
    db.prepare('UPDATE sites SET icon = ? WHERE id = ?').run(PUBLIC_PREFIX + name, site.id);
    return { ok: true, icon: PUBLIC_PREFIX + name, bytes: buf.length };
  };

  const tryUrls = async (urls) => {
    for (const url of urls) {
      triedCount++;
      try {
        const { buf, ext } = await fetchImageWithRetry(url);
        return save(buf, ext);
      } catch (e) {
        lastErr = e;
        // 域名都解析不出来，换哪个路径都一样，直接收工，别让一个死站拖住整批
        if (describeError(e) === '域名解析失败') break;
      }
    }
    return null;
  };

  // ① 常规猜测：库中地址 / favicon.im / 根目录 favicon.ico
  const first = await tryUrls(list);
  if (first) return first;

  // 域名根本解析不了，抓首页也是白费时间
  if (describeError(lastErr) === '域名解析失败') {
    return { ok: false, reason: `试了 ${triedCount} 个地址，最后：域名解析失败` };
  }

  // ② 解析首页 <link rel="icon">：很多站点根目录没有 favicon.ico，
  //    图标实际放在 /favicon.svg 或某个 CDN 路径上
  try {
    const htmlUrls = await fetchHtmlIconUrls(site);
    const r = await tryUrls(htmlUrls);
    if (r) return r;
  } catch (e) {
    lastErr = e;
  }

  return {
    ok: false,
    reason: lastErr ? `试了 ${triedCount} 个地址，最后：${describeError(lastErr)}` : '全部地址均失败',
  };
}

const LETTER_COLORS = ['#6366F1', '#0EA5E9', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6'];

/** 生成字母图标（纯本地 SVG，不联网），给实在抓不到图标的站点兜底 */
function letterIcon(site, opts = {}) {
  const title = String(site.title || '').trim();
  const ch = (title.match(/[\s\S]/u) || ['?'])[0].toUpperCase();
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const color = LETTER_COLORS[Math.abs(Number(site.id) || 0) % LETTER_COLORS.length];
  const fs1 = /[\u4e00-\u9fa5]/.test(ch) ? 44 : 48;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="${esc(title)}">
<rect width="64" height="64" rx="14" fill="${color}"/>
<text x="32" y="44" text-anchor="middle" font-family="-apple-system,Segoe UI,PingFang SC,Microsoft YaHei,sans-serif" font-size="${fs1}" font-weight="600" fill="#fff">${esc(ch)}</text>
</svg>`;
  const buf = Buffer.from(svg, 'utf8');
  if (opts.dry) return { ok: true, bytes: buf.length, icon: `${PUBLIC_PREFIX}${site.id}.svg` };
  ensureDir();
  const name = `${site.id}.svg`;
  fs.writeFileSync(path.join(OUT_DIR, name), buf);
  cleanupOld(site.id, name);
  db.prepare('UPDATE sites SET icon = ? WHERE id = ?').run(PUBLIC_PREFIX + name, site.id);
  return { ok: true, icon: PUBLIC_PREFIX + name, bytes: buf.length, letter: true };
}

/** 并发跑一批（返回汇总，不抛错） */
async function localizeMany(sites, opts = {}) {
  const concurrency = Math.min(Number(opts.concurrency) || 6, Math.max(1, sites.length));
  const result = { ok: 0, skipped: 0, fail: 0, failures: [] };
  let cursor = 0;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const shouldStop = typeof opts.shouldStop === 'function' ? opts.shouldStop : () => false;

  const worker = async () => {
    while (cursor < sites.length) {
      if (shouldStop()) return;
      const site = sites[cursor++];
      const r = await localizeSite(site, opts);
      if (r.ok) {
        if (r.skipped) result.skipped++;
        else result.ok++;
      } else {
        result.fail++;
        result.failures.push({ id: site.id, title: site.title, reason: r.reason });
      }
      if (onProgress) onProgress(result, site);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return result;
}

module.exports = {
  OUT_DIR,
  PUBLIC_PREFIX,
  isLocal,
  fileExists,
  needsLocalize,
  localizeSite,
  localizeMany,
  letterIcon,
  sniffExt,
};
