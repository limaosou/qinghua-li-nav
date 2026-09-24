/**
 * 管理端接口（除 /login 外均需 Bearer Token）
 *  POST /api/admin/login          登录
 *  GET  /api/admin/data           全量数据（含隐藏）
 *  POST /api/admin/categories     分类 create/update/delete/reorder
 *  POST /api/admin/sites          网址 create/update/delete/reorder/pin/hide
 *  POST /api/admin/fetch-favicon  抓取网站图标
 *  POST /api/admin/fetch-meta     抓取网页标题/描述/关键词
 *  GET  /api/admin/export         导出 JSON 备份
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const settings = require('../settings');
const { verifyPassword, signToken, requireAuth } = require('../auth');
const { safeFetch } = require('../netguard');

const router = express.Router();

// ---------- 登录防暴力 ----------
// 双层限额：单来源 10 分钟 5 次失败 + 全局 10 分钟 25 次失败（挡代理池分布式爆破）。
// 关键设计：限额只拦「密码错误的请求」，密码正确一律放行（管理员自救），
//   否则攻击者刷几十次错误即可把管理员本人锁在门外——那才是真正的拒绝服务。
const attempts = new Map(); // IP -> { count, first }
const globalGuard = { count: 0, first: 0 };
const WINDOW = 10 * 60 * 1000;
const IP_MAX = 5;
const GLOBAL_MAX = 25;

/** 校验管理员凭据 */
function checkCreds(username, password) {
  if (username !== (process.env.ADMIN_USERNAME || 'admin')) return false;
  if (process.env.ADMIN_PASSWORD_HASH) return verifyPassword(password, process.env.ADMIN_PASSWORD_HASH);
  if (process.env.ADMIN_PASSWORD) return password === process.env.ADMIN_PASSWORD;
  return password === 'admin123'; // ⚠️ 未配置密码时的初始口令，上线前务必修改
}

/** 生成 scrypt 哈希（格式 scrypt$saltHex$hashHex），与 scripts/hash-password.js 一致 */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** 校验「当前密码」是否匹配（与 checkCreds 的密码判定逻辑一致） */
function verifyCurrentPassword(password) {
  if (process.env.ADMIN_PASSWORD_HASH) return verifyPassword(password, process.env.ADMIN_PASSWORD_HASH);
  if (process.env.ADMIN_PASSWORD) return password === process.env.ADMIN_PASSWORD;
  return password === 'admin123';
}

/** 把新哈希持久化到 .env（覆盖 ADMIN_PASSWORD_HASH，并禁用明文 ADMIN_PASSWORD），重启后仍有效 */
function persistPasswordHash(hash) {
  const file = path.resolve(process.cwd(), '.env');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const out = [];
  let replaced = false;
  for (const line of lines) {
    if (/^\s*ADMIN_PASSWORD_HASH\s*=/.test(line)) { out.push(`ADMIN_PASSWORD_HASH=${hash}`); replaced = true; continue; }
    if (/^\s*ADMIN_PASSWORD\s*=/.test(line)) { out.push(`# ${line.trim()}（明文密码已禁用，已迁移到 ADMIN_PASSWORD_HASH）`); continue; }
    out.push(line);
  }
  if (!replaced) out.push(`ADMIN_PASSWORD_HASH=${hash}`);
  fs.writeFileSync(file, out.join('\n'), { mode: 0o600 });
}

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const key = req.ip || 'unknown';
  const now = Date.now();

  // 超出时间窗口则重置计数（顺带回收过期 IP，避免 Map 无限增长）
  if (attempts.size > 200) {
    for (const [k, v] of attempts) if (now - v.first >= WINDOW) attempts.delete(k);
  }
  const prev = attempts.get(key);
  const rec = prev && now - prev.first < WINDOW ? prev : { count: 0, first: now };
  if (globalGuard.first && now - globalGuard.first >= WINDOW) {
    globalGuard.count = 0;
    globalGuard.first = 0;
  }

  const deny = msg => {
    console.warn(`[auth] 拒绝登录 ip=${key} user=${username} 原因=${msg}`);
    res.status(429).json({ code: 1, message: msg });
  };
  const grant = () => {
    attempts.delete(key);
    globalGuard.count = 0;
    globalGuard.first = 0;
    console.log(`[auth] 登录成功 ip=${key} user=${username}`);
    res.json({ code: 0, data: { token: signToken(username) } });
  };

  const ipLocked = rec.count >= IP_MAX;
  const globalLocked = globalGuard.count >= GLOBAL_MAX;

  // 已触发限额时：密码正确即放行（解锁），错误才拒绝
  if (ipLocked || globalLocked) {
    if (checkCreds(username, password)) return grant();
    return deny(ipLocked
      ? `该网络登录失败过多，请 ${Math.ceil(WINDOW / 60000)} 分钟后再试（密码正确可立即解锁）`
      : '检测到大量异常登录尝试，已临时锁定（密码正确可立即解锁）');
  }

  if (checkCreds(username, password)) return grant();

  rec.count += 1;
  attempts.set(key, rec);
  globalGuard.count += 1;
  if (!globalGuard.first) globalGuard.first = now;
  console.warn(`[auth] 登录失败 ip=${key} user=${username} 该网络${rec.count}次 全局${globalGuard.count}次`);
  res.status(401).json({ code: 1, message: '用户名或密码错误' });
});

router.use(requireAuth);

// ---------- 全量数据 ----------
router.get('/data', (req, res) => {
  const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order ASC, id ASC').all();
  const sites = db
    .prepare('SELECT * FROM sites ORDER BY category_id ASC, is_pinned DESC, sort_order ASC, id ASC')
    .all();
  res.json({ code: 0, data: { categories, sites } });
});

// ---------- 分类管理 ----------
router.post('/categories', (req, res) => {
  const { action } = req.body || {};
  try {
    if (action === 'create') {
      const { name, icon = '', sort_order = 0 } = req.body;
      if (!name || !String(name).trim()) throw new Error('分类名称不能为空');
      const info = db
        .prepare('INSERT INTO categories (name, icon, sort_order) VALUES (?, ?, ?)')
        .run(String(name).trim(), String(icon || ''), Number(sort_order) || 0);
      return res.json({ code: 0, data: { id: info.lastInsertRowid } });
    }
    if (action === 'update') {
      const { id, name, icon, sort_order } = req.body;
      const cur = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
      if (!cur) throw new Error('分类不存在');
      db.prepare('UPDATE categories SET name = ?, icon = ?, sort_order = ? WHERE id = ?').run(
        name !== undefined ? String(name).trim() : cur.name,
        icon !== undefined ? String(icon || '') : cur.icon,
        sort_order !== undefined ? Number(sort_order) || 0 : cur.sort_order,
        id
      );
      return res.json({ code: 0 });
    }
    if (action === 'delete') {
      const { id } = req.body;
      const cur = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
      if (!cur) throw new Error('分类不存在');
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM sites WHERE category_id = ?').run(id); // 级联删除分类下网址
        db.prepare('DELETE FROM categories WHERE id = ?').run(id);
      });
      tx();
      return res.json({ code: 0 });
    }
    if (action === 'reorder') {
      const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
      const upd = db.prepare('UPDATE categories SET sort_order = ? WHERE id = ?');
      db.transaction(() => ids.forEach((id, i) => upd.run(i, id)))();
      return res.json({ code: 0 });
    }
    return res.status(400).json({ code: 1, message: '未知操作' });
  } catch (e) {
    res.status(400).json({ code: 1, message: e.message });
  }
});

// ---------- 网址管理 ----------
router.post('/sites', (req, res) => {
  const { action } = req.body || {};
  try {
    if (action === 'create') {
      const { category_id, title, url, description = '', tags = '', icon = '', sort_order = 0, is_pinned = 0, is_hidden = 0 } = req.body;
      if (!title || !url) throw new Error('标题和网址不能为空');
      if (!db.prepare('SELECT id FROM categories WHERE id = ?').get(category_id)) throw new Error('所属分类不存在');
      const info = db
        .prepare(`INSERT INTO sites (category_id, title, url, description, tags, icon, sort_order, is_pinned, is_hidden)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(category_id, String(title).trim(), String(url).trim(), String(description), String(tags), String(icon),
             Number(sort_order) || 0, is_pinned ? 1 : 0, is_hidden ? 1 : 0);
      return res.json({ code: 0, data: { id: info.lastInsertRowid } });
    }
    if (action === 'update') {
      const b = req.body;
      const cur = db.prepare('SELECT * FROM sites WHERE id = ?').get(b.id);
      if (!cur) throw new Error('网址不存在');
      db.prepare(`UPDATE sites SET category_id=?, title=?, url=?, description=?, tags=?, icon=?,
                  sort_order=?, is_pinned=?, is_hidden=? WHERE id=?`)
        .run(
          b.category_id ?? cur.category_id,
          b.title !== undefined ? String(b.title).trim() : cur.title,
          b.url !== undefined ? String(b.url).trim() : cur.url,
          b.description !== undefined ? String(b.description) : cur.description,
          b.tags !== undefined ? String(b.tags) : cur.tags,
          b.icon !== undefined ? String(b.icon || '') : cur.icon,
          b.sort_order !== undefined ? Number(b.sort_order) || 0 : cur.sort_order,
          b.is_pinned !== undefined ? (b.is_pinned ? 1 : 0) : cur.is_pinned,
          b.is_hidden !== undefined ? (b.is_hidden ? 1 : 0) : cur.is_hidden,
          b.id
        );
      return res.json({ code: 0 });
    }
    if (action === 'delete') {
      db.prepare('DELETE FROM sites WHERE id = ?').run(req.body.id);
      return res.json({ code: 0 });
    }
    if (action === 'reorder') {
      const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
      const upd = db.prepare('UPDATE sites SET sort_order = ? WHERE id = ?');
      db.transaction(() => ids.forEach((id, i) => upd.run(i, id)))();
      return res.json({ code: 0 });
    }
    if (action === 'toggle') {
      const { id, field } = req.body; // field: is_pinned | is_hidden
      if (!['is_pinned', 'is_hidden'].includes(field)) throw new Error('无效字段');
      db.prepare(`UPDATE sites SET ${field} = 1 - ${field} WHERE id = ?`).run(id);
      return res.json({ code: 0 });
    }
    return res.status(400).json({ code: 1, message: '未知操作' });
  } catch (e) {
    res.status(400).json({ code: 1, message: e.message });
  }
});

// ---------- 链接体检（失效链接检测） ----------
// 后台异步任务：并发探测各站点可达性，前端轮询进度。结果存内存，进程重启即失效（属预期）。
const linkJob = { running: false, stop: false, done: 0, total: 0, results: [], startedAt: null, finishedAt: null };

const LINK_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 NavHub/1.0';

// ---------- 白名单：人工确认「这条不是死链」后，体检不再把它算进失效 ----------
const WL_KEY = 'link_ok_urls';
const wlGet = db.prepare('SELECT value FROM settings WHERE key = ?');
const wlSet = db.prepare(
  "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
);
function getWhitelist() {
  try {
    const v = JSON.parse(wlGet.get(WL_KEY)?.value || '[]');
    return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function saveWhitelist(arr) {
  wlSet.run(WL_KEY, JSON.stringify([...new Set(arr)].slice(0, 500)));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// 真实错误码形如 UNABLE_TO_GET_ISSUER_CERT_LOCALLY / ERR_TLS_CERT_ALTNAME_INVALID / DEPTH_ZERO_SELF_SIGNED_CERT，
// 而 e.message 往往只是 "fetch failed"，所以要把 cause.message 也纳入判断
const CERT_HINT = /cert|ssl|tls|altname|unable_to_verify|self[_ ]?signed|depth_zero|expired/i;

/** 单次探测，返回归一化结果（不重试）。resp 时带上最终落点 URL，供域名漂移检测 */
async function attempt(url, timeoutMs) {
  try {
    // 走安全闸门：禁止内网/回环/云元数据，且重定向逐跳校验
    const r = await safeFetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': LINK_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    return { kind: 'resp', code: r.status, finalUrl: r.finalUrl || '' };
  } catch (e) {
    const code = String(e?.cause?.code || e?.code || '').toUpperCase();
    const msg = String(e?.message || e || '未知错误');
    const causeMsg = String(e?.cause?.message || '');
    let kind = 'net';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') kind = 'dns';
    else if (['ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code) || /timeout|abort/i.test(msg)) kind = 'timeout';
    else if (/header|overflow/i.test(msg) || /HPE_|HEADERS_OVERFLOW/i.test(code)) kind = 'header';
    else if (CERT_HINT.test(msg) || CERT_HINT.test(code) || CERT_HINT.test(causeMsg)) kind = 'cert';
    else if (code === 'ECONNREFUSED') kind = 'refused';
    else if (['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'ERR_SOCKET_CLOSED'].includes(code)) kind = 'reset';
    return { kind, code, message: msg.slice(0, 90) };
  }
}

/** 把单次探测结果翻译成三档结论 */
function classify(a) {
  if (a.kind === 'resp') {
    if (a.code < 400) return { status: 'ok', code: a.code, message: '' };
    if ([401, 403, 405, 406, 429, 503].includes(a.code))
      return { status: 'warn', code: a.code, message: `HTTP ${a.code}，站点拒绝探测（可能拦爬虫，不一定是死链）` };
    if (a.code >= 500 || [520, 521, 522, 525, 526, 527, 530].includes(a.code))
      return { status: 'fail', code: a.code, message: `HTTP ${a.code}（服务端错误，将重试）` };
    return { status: 'fail', code: a.code, message: `HTTP ${a.code}` };
  }
  switch (a.kind) {
    case 'cert': {
      // 证书链不全 / 域名不匹配 / 已过期：浏览器大多能自动补全或放行，站点通常仍可访问，不判死
      const c = String(a.code || '');
      const why = /ALTNAME/i.test(c) ? '证书与域名不匹配（可能只是 www/裸域差异或 CDN 配置问题）'
        : /EXPIRED/i.test(c) ? '证书已过期'
        : /SELF[_ ]?SIGNED|DEPTH_ZERO/i.test(c) ? '自签名证书'
        : '证书链不完整（站点未下发中间证书）';
      return { status: 'warn', code: 0, message: `${why}${c ? `（${c}）` : ''}：浏览器一般仍能打开，建议保留` };
    }
    case 'header':
      return { status: 'warn', code: 0, message: '响应头异常（站点限流或协议兼容问题），未必是死链' };
    case 'timeout':
      return { status: 'fail', code: 0, message: '连接超时' };
    case 'dns':
      return { status: 'fail', code: 0, message: a.code === 'EAI_AGAIN' ? '域名解析暂时失败' : '域名解析失败（域名不存在）' };
    case 'refused':
      return { status: 'fail', code: 0, message: '连接被拒绝' };
    case 'reset':
      return { status: 'fail', code: 0, message: '连接被重置（将重试）' };
    default:
      return { status: 'fail', code: 0, message: a.message || (a.code || '未知错误') };
  }
}

/** 判断两个 host 是否同一站点（忽略 www，兼容 com.cn 等二级后缀） */
function sameSite(h1, h2) {
  const base = h => {
    const parts = String(h).replace(/^www\./, '').toLowerCase().split('.');
    const tail = parts.slice(-2).join('.');
    return ['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn'].includes(tail) && parts.length >= 3
      ? parts.slice(-3).join('.') : tail;
  };
  return base(h1) === base(h2);
}

/**
 * 探测单个网址。分三档：
 *   ok   —— 2xx/3xx；白名单内的站点直接判 ok（跳过探测，不再反复出现在可疑名单里）
 *   warn —— 拒绝探测(401/403/429/503)、证书问题、响应头异常、重定向落到其他域名：多半活着，不建议直接删
 *   fail —— 4xx、5xx(重试后)、DNS 失败、超时、连接拒绝
 * 5xx / 超时 / 连接重置会换更长的超时重试一次，避免瞬时抖动被误杀。
 */
async function probeSite(site, whitelist = []) {
  if (whitelist.includes(site.url)) {
    return { status: 'ok', code: 0, message: '已标记正常（白名单，跳过探测）', whitelisted: true };
  }
  const a = await attempt(site.url, 8000);
  let r = classify(a);
  // 服务端错误、超时、连接重置 → 重试一次（DNS 失败不重试，重试也没用）；4xx 属明确响应，不重试
  const retryable = (a.kind === 'resp' && r.status === 'fail' && (a.code >= 500 || [520, 521, 522, 525, 526, 527, 530].includes(a.code)))
    || ['timeout', 'reset', 'net'].includes(a.kind);
  if (retryable) {
    await sleep(700);
    const b = await attempt(site.url, 15000);
    r = classify(b);
    if (r.status === 'fail' && a.kind === 'resp') r.message = `HTTP ${a.code}（已重试一次仍失败）`;
    else if (r.status === 'fail' && a.kind === 'timeout') r.message = '连接超时（已重试一次，15s）';
  }
  // 域名漂移：登记的是 A 域名，跳转链最后落到 B 域名（挂羊头卖狗肉/换域名/被接替）
  if (r.status === 'ok' && a.finalUrl) {
    try {
      const orig = new URL(site.url).host;
      const fin = new URL(a.finalUrl).host;
      if (!sameSite(orig, fin)) {
        r = { status: 'warn', code: r.code, message: `已跳转到其他站点（${fin}）：原网址可能已更换域名或被他人接替，建议核实后更新或删除`, drifted: true };
      }
    } catch { /* URL 解析失败则忽略 */ }
  }
  return { ...r, whitelisted: false };
}

router.post('/check-links/start', (req, res) => {
  if (linkJob.running) return res.json({ code: 0, data: { started: false, message: '检测已在进行中', total: linkJob.total, done: linkJob.done } });
  const categoryId = Number(req.body?.category_id) || null;
  const sites = categoryId
    ? db.prepare('SELECT id, title, url, category_id FROM sites WHERE category_id = ?').all(categoryId)
    : db.prepare('SELECT id, title, url, category_id FROM sites').all();
  if (!sites.length) return res.status(400).json({ code: 1, message: '没有可检测的网址' });

  const whitelist = getWhitelist();
  Object.assign(linkJob, { running: true, stop: false, done: 0, total: sites.length, results: [], startedAt: Date.now(), finishedAt: null, whitelist });
  const CONCURRENCY = 10;
  (async () => {
    let idx = 0;
    const worker = async () => {
      while (!linkJob.stop && idx < sites.length) {
        const s = sites[idx++];
        const r = await probeSite(s, whitelist);
        linkJob.results.push({ id: s.id, title: s.title, url: s.url, category_id: s.category_id, ...r });
        linkJob.done++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sites.length) }, worker));
    linkJob.running = false;
    linkJob.finishedAt = Date.now();
    console.log(`[linkcheck] 完成 ${linkJob.done}/${linkJob.total}，耗时 ${Math.round((linkJob.finishedAt - linkJob.startedAt) / 1000)}s`);
  })();
  res.json({ code: 0, data: { started: true, total: sites.length } });
});

router.get('/check-links/status', (req, res) => {
  res.json({
    code: 0,
    data: { running: linkJob.running, done: linkJob.done, total: linkJob.total, startedAt: linkJob.startedAt, finishedAt: linkJob.finishedAt, results: linkJob.results, whitelist: linkJob.whitelist || getWhitelist() },
  });
});

/** 白名单维护：标记正常后跳过探测、不再出现在可疑/失效名单；取消标记则当场重新探测一次 */
router.post('/check-links/whitelist', async (req, res) => {
  const { action, url } = req.body || {};
  const list = getWhitelist();
  if (action === 'add') {
    if (!url) return res.status(400).json({ code: 1, message: '缺少 url' });
    if (!list.includes(url)) list.push(url);
    saveWhitelist(list);
  } else if (action === 'remove') {
    saveWhitelist(list.filter(u => u !== url));
  } else if (action === 'clear') {
    saveWhitelist([]);
  } else {
    return res.status(400).json({ code: 1, message: '未知操作' });
  }
  const next = getWhitelist();
  linkJob.whitelist = next;
  // 已出结果同步刷新：标记 → 直接算 ok（不再回可疑堆）；取消/清空 → 当场补一次探测还原真实状态
  for (const r of linkJob.results) {
    const isTarget = (action === 'add' && r.url === url)
      || (action === 'remove' && r.url === url)
      || (action === 'clear' && r.whitelisted);
    if (!isTarget) continue;
    if (action === 'add') {
      r.whitelisted = true;
      r.status = 'ok';
      r.message = '已标记正常（白名单，跳过探测）';
      delete r.drifted;
    } else {
      const pr = await probeSite({ url: r.url }, next);
      Object.assign(r, { status: pr.status, code: pr.code, message: pr.message, whitelisted: false });
      delete r.drifted;
    }
  }
  return res.json({ code: 0, data: { whitelist: next } });
});

router.post('/check-links/stop', (req, res) => {
  if (linkJob.running) linkJob.stop = true;
  res.json({ code: 0 });
});

// ---------- 抓取网站图标 ----------
router.post('/fetch-favicon', async (req, res) => {
  const raw = String(req.body?.url || '').trim();
  if (!raw) return res.status(400).json({ code: 1, message: '请先填写网址' });
  try {
    const u = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
    // 优先直接抓取站点 /favicon.ico，转 base64 存储（避免外链失效）
    // 走安全闸门：内网/回环/云元数据地址直接拒绝（SSRF 防护）
    let guardMsg = '';
    try {
      const r = await safeFetch(u.origin + '/favicon.ico', {
        signal: AbortSignal.timeout(6000),
        headers: { 'User-Agent': 'Mozilla/5.0 NavHub/1.0' },
      });
      const ct = r.headers.get('content-type') || '';
      if (r.ok && ct.startsWith('image')) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 0 && buf.length < 300 * 1024) {
          return res.json({ code: 0, data: { icon: `data:${ct.split(';')[0]};base64,${buf.toString('base64')}` } });
        }
      }
    } catch (e) {
      guardMsg = String(e?.message || '');
    }
    if (/禁止访问|仅支持/.test(guardMsg)) {
      return res.status(400).json({ code: 1, message: `不允许抓取该地址：${guardMsg}` });
    }
    // 兜底：第三方图标服务
    return res.json({ code: 0, data: { icon: `https://favicon.im/${u.hostname}?larger=true` } });
  } catch {
    res.status(400).json({ code: 1, message: '无效的网址' });
  }
});

// ---------- 抓取网页元信息（标题/描述/标签） ----------
router.post('/fetch-meta', async (req, res) => {
  const raw = String(req.body?.url || '').trim();
  if (!raw) return res.status(400).json({ code: 1, message: '请先填写网址' });
  try {
    const u = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
    const r = await safeFetch(u.href, {
      signal: AbortSignal.timeout(8000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 NavHub/1.0',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,ko;q=0.8,en;q=0.7',
      },
    });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || !/text\/html|xhtml/i.test(ct)) {
      return res.json({ code: 0, data: {}, message: `无法按 HTML 解析（HTTP ${r.status}，类型 ${ct || '未知'}）` });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    let html = buf.toString('utf8').slice(0, 600000);
    // 非UTF-8（如 GBK/GB2312/Big5）站点按声明编码重解码；找不到声明时若已现乱码则尝试常见中文编码兜底
    const cs = ((html.match(/charset\s*=\s*["']?([\w-]+)/i) || [])[1] || '').toLowerCase();
    const decodeWith = label => { try { return new TextDecoder(label).decode(buf).slice(0, 600000); } catch { return null; } };
    const alias = { gb2312: 'gbk', gbk2312: 'gbk', 'iso-8859-1': 'windows-1252', utf8: 'utf-8' };
    const norm = alias[cs] || cs;
    if (norm && norm !== 'utf-8') {
      const retry = decodeWith(norm);
      if (retry) html = retry;
    } else if (!norm && /\uFFFD/.test(html.slice(0, 3000))) {
      for (const label of ['gbk', 'gb18030', 'big5']) {
        const retry = decodeWith(label);
        if (retry && !/\uFFFD/.test(retry.slice(0, 3000))) { html = retry; break; }
      }
    }

    const clean = s => String(s || '')
      .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return ' '; } })
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ' '; } })
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, 200);
    const metaContent = (name) => {
      const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i');
      const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, 'i');
      return clean((html.match(re) || [])[1] || (html.match(re2) || [])[1] || '');
    };

    const title =
      metaContent('og:title') ||
      clean((html.match(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i) || [])[1] || '').replace(/[-_｜|—·]\s*(首页|官网|Official Site|Home)$/i, '');

    const description =
      metaContent('og:description') ||
      metaContent('description') ||
      clean((html.match(/<meta[^>]+http-equiv=["']description["'][^>]*content=["']([^"']*)["']/i) || [])[1] || '');

    const keywords = metaContent('keywords');
    const tags = keywords
      ? keywords.split(/[,，;；]+/).map(t => t.trim()).filter(Boolean).slice(0, 5).join(',')
      : '';

    res.json({ code: 0, data: { title, description, tags } });
  } catch (e) {
    const m = String(e?.message || '');
    res.status(400).json({ code: 1, message: /禁止访问|仅支持/.test(m) ? `不允许抓取该地址：${m}` : '抓取失败，请手动填写' });
  }
});

// ---------- 投稿审核 ----------
router.get('/submissions', (req, res) => {
  const { status } = req.query;
  const rows = status
    ? db.prepare('SELECT * FROM submissions WHERE status = ? ORDER BY id DESC').all(String(status))
    : db.prepare(`SELECT * FROM submissions ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, id DESC`).all();
  res.json({ code: 0, data: rows });
});

// 审核通过时尝试补抓站点图标（失败不阻塞）
async function tryFavicon(pageUrl) {
  try {
    const u = new URL(pageUrl);
    const r = await fetch(u.origin + '/favicon.ico', {
      signal: AbortSignal.timeout(3000), redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 NavHub/1.0' },
    });
    const ct = r.headers.get('content-type') || '';
    if (r.ok && ct.startsWith('image')) {
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 0 && buf.length < 300 * 1024) return `data:${ct.split(';')[0]};base64,${buf.toString('base64')}`;
    }
  } catch { /* ignore */ }
  try { return `https://favicon.im/${new URL(pageUrl).hostname}?larger=true`; } catch { return ''; }
}

router.post('/submissions', async (req, res) => {
  const { action, id } = req.body || {};
  try {
    const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
    if (!sub) throw new Error('投稿不存在');
    if (action === 'approve') {
      if (sub.status !== 'pending') throw new Error('该投稿已处理过');
      const category_id = Number(req.body.category_id);
      if (!db.prepare('SELECT id FROM categories WHERE id = ?').get(category_id)) throw new Error('请选择要收录到的分类');
      const icon = await tryFavicon(sub.url);
      db.prepare(`INSERT INTO sites (category_id, title, url, description, tags, icon, sort_order)
                  VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order),0)+1 FROM sites WHERE category_id = ?))`)
        .run(category_id, sub.title, sub.url, sub.description || '', sub.tags || '', icon, category_id);
      db.prepare("UPDATE submissions SET status = 'approved', reviewed_at = datetime('now','localtime') WHERE id = ?").run(id);
      return res.json({ code: 0, message: '已收录' });
    }
    if (action === 'reject') {
      db.prepare("UPDATE submissions SET status = 'rejected', reviewed_at = datetime('now','localtime') WHERE id = ?").run(id);
      return res.json({ code: 0 });
    }
    if (action === 'delete') {
      db.prepare('DELETE FROM submissions WHERE id = ?').run(id);
      return res.json({ code: 0 });
    }
    return res.status(400).json({ code: 1, message: '未知操作' });
  } catch (e) {
    res.status(400).json({ code: 1, message: e.message });
  }
});

// ---------- 站点配置 ----------
router.get('/settings', (req, res) => {
  res.json({ code: 0, data: settings.getSettings() });
});

router.post('/settings', (req, res) => {
  try {
    const body = req.body || {};
    // 搜索引擎列表校验
    if (body.engines !== undefined) {
      if (!Array.isArray(body.engines)) throw new Error('搜索引擎格式错误');
      body.engines = body.engines
        .filter(e => e && String(e.name).trim() && String(e.url).trim())
        .slice(0, 10)
        .map(e => ({ name: String(e.name).trim().slice(0, 20), url: String(e.url).trim().slice(0, 500) }));
      if (!body.engines.length) throw new Error('至少保留一个搜索引擎');
      if (!body.engines.every(e => e.url.includes('{query}'))) throw new Error('搜索引擎 URL 必须包含 {query} 占位符');
    }
    // 顶部导航链接校验
    if (body.nav_links !== undefined) {
      if (!Array.isArray(body.nav_links)) throw new Error('导航链接格式错误');
      body.nav_links = body.nav_links
        .filter(l => l && String(l.label).trim() && String(l.url).trim())
        .slice(0, 10)
        .map(l => ({ label: String(l.label).trim().slice(0, 20), url: String(l.url).trim().slice(0, 500) }));
    }
    const saved = settings.saveSettings(body);
    if (!saved.length) throw new Error('没有可保存的字段');
    res.json({ code: 0, data: { saved } });
  } catch (e) {
    res.status(400).json({ code: 1, message: e.message });
  }
});

// ---------- 修改管理员密码 ----------
router.post('/change-password', (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ code: 1, message: '当前密码和新密码都不能为空' });
  if (String(newPassword).length < 6) return res.status(400).json({ code: 1, message: '新密码至少 6 位' });
  if (!verifyCurrentPassword(currentPassword)) return res.status(401).json({ code: 1, message: '当前密码不正确' });
  try {
    const hash = hashPassword(newPassword);
    process.env.ADMIN_PASSWORD_HASH = hash; // 立即生效（登录实时读取 process.env）
    persistPasswordHash(hash);             // 持久化到 .env，重启后仍有效
    console.log('[auth] 管理员密码已修改');
    res.json({ code: 0, message: '密码已修改，下次登录请使用新密码' });
  } catch (e) {
    res.status(500).json({ code: 1, message: '写入失败：' + e.message });
  }
});

// ---------- 导出备份 ----------
router.get('/export', (req, res) => {
  const payload = {
    app: 'navhub',
    version: 1,
    exported_at: new Date().toISOString(),
    categories: db.prepare('SELECT * FROM categories ORDER BY sort_order ASC, id ASC').all(),
    sites: db.prepare('SELECT * FROM sites ORDER BY category_id ASC, sort_order ASC, id ASC').all(),
  };
  res.setHeader('Content-Disposition', 'attachment; filename="navhub-backup.json"');
  res.json(payload);
});

module.exports = router;
