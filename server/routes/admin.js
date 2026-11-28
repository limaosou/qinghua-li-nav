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
const icons = require('../icons');
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

// ---------- 图标本地化 ----------
// 保存网址后若 icon 还是外链，就在后台悄悄下载到本站并改写数据库，
// 这样新增站点不用再登服务器跑命令。失败不影响保存结果（原外链照常可用）。
function autoLocalizeIcon(siteId) {
  if (!settings.getSettings().icon_auto_localize) return;
  setImmediate(async () => {
    try {
      const s = db.prepare('SELECT id, title, url, icon FROM sites WHERE id = ?').get(siteId);
      if (!s || !icons.needsLocalize(s)) return;
      const r = await icons.localizeSite(s);
      console.log(
        r.ok
          ? `[icons] #${siteId} ${s.title} 已本地化 → ${r.icon}`
          : `[icons] #${siteId} ${s.title} 自动本地化失败：${r.reason}`
      );
    } catch (e) {
      console.log(`[icons] #${siteId} 自动本地化异常：${e.message}`);
    }
  });
}

// 批量本地化（后台「图标本地化」面板用，不阻塞请求）
const iconJob = { running: false, stop: false, done: 0, total: 0, ok: 0, skip: 0, fail: 0, failures: [], scope: '', startedAt: null, finishedAt: null };

router.post('/icons/localize', async (req, res) => {
  if (iconJob.running) return res.json({ code: 0, data: { started: false, message: '正在下载中', total: iconJob.total, done: iconJob.done } });
  const scope = String(req.body?.scope || 'missing'); // missing=只补缺失 / all=全部重下
  let sites = db.prepare('SELECT id, title, url, icon FROM sites WHERE is_hidden = 0 ORDER BY id ASC').all();
  if (scope !== 'all') sites = sites.filter((s) => icons.needsLocalize(s));
  if (!sites.length) return res.json({ code: 0, data: { started: false, message: '没有需要处理的图标' } });

  Object.assign(iconJob, { running: true, stop: false, done: 0, total: sites.length, ok: 0, skip: 0, fail: 0, failures: [], scope, startedAt: Date.now(), finishedAt: null });
  (async () => {
    const r = await icons.localizeMany(sites, {
      force: scope === 'all',
      concurrency: 6,
      shouldStop: () => iconJob.stop,
      onProgress: (acc) => {
        iconJob.ok = acc.ok;
        iconJob.skip = acc.skipped;
        iconJob.fail = acc.fail;
        iconJob.failures = acc.failures;
        iconJob.done = acc.ok + acc.skipped + acc.fail;
      },
    });
    iconJob.running = false;
    iconJob.finishedAt = Date.now();
    console.log(`[icons] 完成 ${iconJob.done}/${iconJob.total}，成功 ${iconJob.ok}，失败 ${iconJob.fail}`);
  })();
  res.json({ code: 0, data: { started: true, total: sites.length } });
});

router.post('/icons/stop', (req, res) => {
  if (iconJob.running) iconJob.stop = true;
  res.json({ code: 0 });
});

// 字母图标兜底：把仍然解析不到图标的站点，生成本地 SVG（不联网，瞬间完成）
router.post('/icons/letters', (req, res) => {
  const sites = db.prepare('SELECT id, title, url, icon FROM sites WHERE is_hidden = 0 ORDER BY id ASC').all()
    .filter((s) => icons.needsLocalize(s));
  if (!sites.length) return res.json({ code: 0, data: { done: 0, message: '所有站点都已有本地图标' } });
  let done = 0;
  for (const s of sites) {
    try { if (icons.letterIcon(s).ok) done++; } catch { /* 单个失败不影响其他 */ }
  }
  console.log(`[icons] 已为 ${done} 个站点生成字母图标`);
  res.json({ code: 0, data: { done } });
});

router.get('/icons/status', (req, res) => {
  const totalSites = db.prepare('SELECT COUNT(*) c FROM sites WHERE is_hidden = 0').get().c;
  const localCount = db.prepare("SELECT COUNT(*) c FROM sites WHERE is_hidden = 0 AND icon LIKE '/icons/%'").get().c;
  res.json({
    code: 0,
    data: {
      running: iconJob.running,
      done: iconJob.done,
      total: iconJob.total,
      ok: iconJob.ok,
      skip: iconJob.skip,
      fail: iconJob.fail,
      failures: iconJob.failures.slice(0, 60),
      scope: iconJob.scope,
      startedAt: iconJob.startedAt,
      finishedAt: iconJob.finishedAt,
      localCount,
      totalSites,
    },
  });
});

// ---------- 网址管理 ----------
router.post('/sites', (req, res) => {
  const { action } = req.body || {};
  try {
    if (action === 'create') {
      const { category_id, title, url, description = '', tags = '', icon = '', detail_content = '', sort_order = 0, is_pinned = 0, is_hidden = 0, is_direct = 0 } = req.body;
      if (!title || !url) throw new Error('标题和网址不能为空');
      if (!db.prepare('SELECT id FROM categories WHERE id = ?').get(category_id)) throw new Error('所属分类不存在');
      const info = db
        .prepare(`INSERT INTO sites (category_id, title, url, description, tags, icon, detail_content, sort_order, is_pinned, is_hidden, is_direct)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(category_id, String(title).trim(), String(url).trim(), String(description), String(tags), String(icon), String(detail_content),
             Number(sort_order) || 0, is_pinned ? 1 : 0, is_hidden ? 1 : 0, is_direct ? 1 : 0);
      autoLocalizeIcon(info.lastInsertRowid);
      return res.json({ code: 0, data: { id: info.lastInsertRowid } });
    }
    if (action === 'update') {
      const b = req.body;
      const cur = db.prepare('SELECT * FROM sites WHERE id = ?').get(b.id);
      if (!cur) throw new Error('网址不存在');
      db.prepare(`UPDATE sites SET category_id=?, title=?, url=?, description=?, tags=?, icon=?, detail_content=?,
                  sort_order=?, is_pinned=?, is_hidden=?, is_direct=? WHERE id=?`)
        .run(
          b.category_id ?? cur.category_id,
          b.title !== undefined ? String(b.title).trim() : cur.title,
          b.url !== undefined ? String(b.url).trim() : cur.url,
          b.description !== undefined ? String(b.description) : cur.description,
          b.tags !== undefined ? String(b.tags) : cur.tags,
          b.icon !== undefined ? String(b.icon || '') : cur.icon,
          b.detail_content !== undefined ? String(b.detail_content) : (cur.detail_content || ''),
          b.sort_order !== undefined ? Number(b.sort_order) || 0 : cur.sort_order,
          b.is_pinned !== undefined ? (b.is_pinned ? 1 : 0) : cur.is_pinned,
          b.is_hidden !== undefined ? (b.is_hidden ? 1 : 0) : cur.is_hidden,
          b.is_direct !== undefined ? (b.is_direct ? 1 : 0) : (cur.is_direct || 0),
          b.id
        );
      autoLocalizeIcon(b.id);
      return res.json({ code: 0 });
    }
    if (action === 'delete') {
      const id = Number(req.body.id);
      const info = db.prepare('DELETE FROM sites WHERE id = ?').run(id);
      // 体检结果是服务端内存态，刷新后台时由 /check-links/status 原样恢复。
      // 这里不清理的话，数据库里已经删掉的网址会在体检结果表里“复活”，
      // 再点一次删除还会返回成功（其实没有记录可删），看起来就像删不掉。
      if (info.changes) linkJob.results = linkJob.results.filter(r => r.id !== id);
      return res.json({ code: 0, data: { deleted: info.changes } });
    }
    if (action === 'reorder') {
      const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
      const upd = db.prepare('UPDATE sites SET sort_order = ? WHERE id = ?');
      db.transaction(() => ids.forEach((id, i) => upd.run(i, id)))();
      return res.json({ code: 0 });
    }
    if (action === 'toggle') {
      const { id, field } = req.body; // field: is_pinned | is_hidden | is_direct
      if (!['is_pinned', 'is_hidden', 'is_direct'].includes(field)) throw new Error('无效字段');
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

// 合规体检 UA：明确标识身份与用途，站点管理员可据此放行或按自身规则处置。
// 旧版伪装 Chrome 却拖一条 NavHub 尾巴，TLS/HTTP2 指纹与真浏览器不符，
// 反而更容易被 WAF 判为"假浏览器"而挑战——这是过去大量 403/503 的诱因之一。
const LINK_UA = 'NavHub-LinkCheck/1.0 (+https://www.liqinghua.com)';

/** 从响应头识别 CDN/WAF 提供商。只读取站点公开返回的头，不改变请求、不挑战、不绕过防护。 */
function detectWaf(h = {}) {
  const blob = [h.server, h.via, h.poweredBy, h.cfMitigated].join(' ').toLowerCase();
  if (h.cfRay || h.cfMitigated || /cloudflare/.test(blob)) return 'cloudflare';
  if (/edgeone|tencent cloud/.test(blob)) return 'edgeone';
  if (h.awsCfId || /cloudfront|amazon/.test(blob)) return 'cloudfront';
  if (/akamai/.test(blob)) return 'akamai';
  if (/waf|sucuri|imperva|incapsula|mod_security|modsecurity/.test(blob)) return 'waf';
  return '';
}

/** 礼貌解析 Retry-After（秒或 HTTP 日期），封顶 10s 避免拖垮后台队列。 */
function parseRetryAfter(v) {
  if (!v) return 0;
  const n = Number(v);
  const sec = Number.isFinite(n) ? n : (Date.parse(v) - Date.now()) / 1000;
  return Number.isFinite(sec) ? Math.max(0, Math.min(Math.ceil(sec), 10)) * 1000 : 0;
}

/** 结构化探测日志：单行 JSON，便于 grep / 日志系统聚合；不含 Cookie/Token 等敏感信息。 */
function logProbe(rec) {
  console.log('[linkcheck:probe] ' + JSON.stringify(rec));
}

/** 汇总指标：可疑率、受保护占比、WAF 命中、重试率、耗时分位数。 */
function summarize(results, durationMs) {
  const c = { total: results.length, ok: 0, warn: 0, fail: 0, protected: 0, wafBlocked: 0, retried: 0 };
  const times = [];
  for (const r of results) {
    if (c[r.status] !== undefined) c[r.status]++;
    if (r.protected) c.protected++;
    if (r.waf) c.wafBlocked++;
    if ((r.attempts || 1) > 1) c.retried++;
    times.push(r.elapsedMs || 0);
  }
  times.sort((a, b) => a - b);
  return {
    ...c,
    suspicionRate: c.total ? +(c.warn / c.total).toFixed(3) : 0, // 核心指标：可疑率（目标 < 0.05）
    avgMs: c.total ? Math.round(times.reduce((a, b) => a + b, 0) / c.total) : 0,
    p95Ms: times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] : 0,
    durationMs,
  };
}

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

/** 单次探测（不重试）。resp 时保留最终落点 URL 与关键响应头，作为精准判定的证据。 */
async function attempt(url, timeoutMs, method = 'GET') {
  try {
    // 走安全闸门：禁止内网/回环/云元数据，且重定向逐跳校验
    const r = await safeFetch(url, {
      method, // GET 为主；仅当站点返回 405 时才用 HEAD 做合规替代验证
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': LINK_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    const h = r.headers;
    return {
      kind: 'resp', code: r.status, finalUrl: r.finalUrl || '',
      headers: {
        server: (h.get('server') || '').slice(0, 80),
        via: (h.get('via') || '').slice(0, 80),
        poweredBy: (h.get('x-powered-by') || '').slice(0, 80),
        cfRay: h.get('cf-ray') || '',
        cfMitigated: h.get('cf-mitigated') || '',
        awsCfId: h.get('x-amz-cf-id') || '',
        cache: (h.get('x-cache') || h.get('x-cache-lookup') || '').slice(0, 80),
        retryAfter: h.get('retry-after') || '',
      },
    };
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

/**
 * 把单次探测结果翻译成结论。核心判定原则（避免"可疑站过多"）：
 *
 *  A. 只要收到任何 HTTP 响应（含 4xx/5xx），就证明站点网络层存活——DNS、TCP、TLS、HTTP
 *     全通。此时「拒绝访问」是站点的正常防护（登录墙/WAF/限流），不是失效、也不该算可疑。
 *  B. 只把"连不上/连不稳"当失效候选：DNS 不存在、连接超时、连接拒绝、重置、证书致命错误。
 *  C. 区分「可核查的软失败」与「真失效」：404 页面迁移、证书细节、503 瞬时故障 → warn 待人工确认。
 *
 * 三档 status 保持前端兼容；category 给出细粒度原因（日志与前端提示用）。
 * 重试只针对真正可能是抖动的类别，且不针对"站点明确拒绝"反复敲门。
 */
function classify(a) {
  if (a.kind === 'resp') {
    const code = a.code;
    const waf = detectWaf(a.headers || {});
    const wafTag = waf ? `（站点由 ${waf} 防护）` : '';
    if (code < 400) return { status: 'ok', category: 'reachable', code, message: '' };

    // 登录墙 / 反爬 / WAF 拦截：站点明确活着，只是拒绝匿名自动访问 → 判 ok，不计可疑
    if ([401, 403, 405, 406, 429].includes(code)) {
      const why = code === 401 ? '需要登录' : code === 403 ? '禁止匿名访问/WAF 拦截'
        : code === 405 ? '拒绝此请求方法' : code === 406 ? '内容协商不匹配' : '触发限流';
      return {
        status: 'ok', category: 'protected', code,
        message: `站点在线，${why}（HTTP ${code}）${wafTag}；浏览器手动打开通常可访问，非失效`,
        protected: true, waf,
        // 405 值得用 HEAD 做一次合规替代验证；其它拒绝类不重试（尊重站点意愿）
        altMethod: code === 405 ? 'HEAD' : '',
      };
    }
    // 404/410：域名与服务器都在，只是这个路径没了（常见于改版）→ 待人工确认
    if ([404, 410].includes(code)) {
      return { status: 'warn', category: 'not_found', code, message: `站点在线，但登记路径返回 HTTP ${code}，可能已改版或迁移，建议核实网址（非域名失效）` };
    }
    // 408 请求超时：客户端侧问题，非站点失效
    if (code === 408) return { status: 'warn', category: 'client_timeout', code, message: 'HTTP 408，请求处理超时（多为客户端网络问题），建议稍后复查' };
    // 5xx：服务端可能是瞬时故障（503 维护 / 502 上游抖动），不在这里直接判死，交 probeSite 重试确认
    if (code >= 500) {
      const hint = code === 503 ? '服务暂时不可用（常见于维护/限流）' : '服务端错误';
      return { status: 'warn', category: 'server_error', code, message: `HTTP ${code}，${hint}${wafTag}；将重试确认`, waf, retryable: true };
    }
    // 其余 4xx（400/402/407/412/418/422 等）：站点有响应即存活，归一化到 warn 提示人工看
    return { status: 'warn', category: 'http_4xx', code, message: `站点在线，返回 HTTP ${code}（请求被站点规则拒绝），非失效` };
  }

  switch (a.kind) {
    case 'cert': {
      // 证书链不全 / 域名不匹配 / 已过期：浏览器大多能自动补全或放行，站点通常仍可访问，不判死
      const c = String(a.code || '');
      const why = /ALTNAME/i.test(c) ? '证书与域名不匹配（可能只是 www/裸域差异或 CDN 配置问题）'
        : /EXPIRED/i.test(c) ? '证书已过期'
        : /SELF[_ ]?SIGNED|DEPTH_ZERO/i.test(c) ? '自签名证书'
        : '证书链不完整（站点未下发中间证书）';
      return { status: 'warn', category: 'cert', code: 0, message: `${why}${c ? `（${c}）` : ''}：浏览器一般仍能打开，建议保留` };
    }
    case 'header':
      return { status: 'warn', category: 'header', code: 0, message: '响应头异常（站点限流或协议兼容问题），未必是死链' };
    case 'timeout':
      return { status: 'fail', category: 'timeout', code: 0, message: '连接超时', retryable: true };
    case 'dns':
      // EAI_AGAIN 是解析服务器临时故障，不是域名不存在——单独重试，不判死
      return a.code === 'EAI_AGAIN'
        ? { status: 'warn', category: 'dns_temp', code: 0, message: '域名解析暂时失败（DNS 抖动），将重试', retryable: true }
        : { status: 'fail', category: 'dns', code: 0, message: '域名解析失败（域名不存在）' };
    case 'refused':
      return { status: 'fail', category: 'refused', code: 0, message: '连接被拒绝', retryable: true };
    case 'reset':
      return { status: 'fail', category: 'reset', code: 0, message: '连接被重置', retryable: true };
    default:
      return { status: 'fail', category: 'net', code: 0, message: a.message || (a.code || '未知错误'), retryable: true };
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
 * 探测单个网址。判定原则：收到 HTTP 响应即证明站点在线（详见 classify 注释）。
 *   ok   —— 2xx/3xx；401/403/405/406/429 归为"在线但受站点防护"（protected，不计可疑）；
 *           白名单内站点直接 ok（跳过探测）
 *   warn —— 404/410 路径迁移、证书细节、5xx 重试后仍异常、响应头异常、域名漂移：
 *           站点多半活着，需人工确认而非删除
 *   fail —— DNS 不存在、连接超时/拒绝/重置（重试后仍失败）等真正连不上的情况
 * 礼貌重试：只针对可能抖动的类别，遵守 Retry-After（封顶 10s）；405 用 HEAD 替代验证；
 * 明确拒绝（401/403/406/429）与 DNS 不存在不重试——尊重站点规则，不硬闯。
 */
async function probeSite(site, whitelist = []) {
  const started = Date.now();
  const head = { id: site.id, title: site.title, url: site.url };
  if (whitelist.includes(site.url)) {
    const r = { status: 'ok', category: 'whitelisted', code: 0, message: '已标记正常（白名单，跳过探测）', whitelisted: true, attempts: 0, elapsedMs: 0 };
    logProbe({ ...head, ...r });
    return r;
  }

  let a = await attempt(site.url, 8000);
  let r = classify(a);
  let attempts = 1;

  // 合规替代验证：405「方法不被允许」时改用 HEAD 复核一次。
  // 这不是绕过限制——只是换用站点更可能接受的标准方法，且不发起第二次 GET 冲击。
  if (r.altMethod) {
    await sleep(250);
    const h = await attempt(site.url, 8000, r.altMethod);
    attempts++;
    if (h.kind === 'resp' && h.code < 400) {
      r = { status: 'ok', category: 'reachable_via_head', code: h.code, protected: true,
        message: `GET 被站点拒绝，但 HEAD 正常（HTTP ${h.code}），站点在线`, waf: detectWaf(h.headers || {}) };
      a = h;
    }
  }

  // 礼貌重试：仅对"可能是网络抖动"的类别；遵守站点 Retry-After（封顶 10s），
  // 否则短退避。站点明确拒绝（401/403/406/429）与 DNS 不存在不重试——尊重站点与事实。
  if (r.retryable) {
    const wait = Math.min((a.headers && parseRetryAfter(a.headers.retryAfter)) || 1200, 10000);
    await sleep(wait);
    const b = await attempt(site.url, 15000);
    attempts++;
    const rb = classify(b);
    if (rb.status === 'ok') {
      r = { ...rb, message: rb.message ? `${rb.message}（重试后恢复）` : '重试后恢复正常' };
    } else if (r.status === 'warn' && rb.status === 'fail') {
      // 首探软失败（如 503）已证明站点在线，重试时网络异常不足以推翻 → 保留 warn 不误杀
      r = { ...r, message: `${r.message}；重试时网络异常（${b.code || b.kind}）` };
    } else {
      r = { ...rb, message: `${rb.message}（已重试一次）` };
    }
    a = b;
  }

  // 域名漂移：登记的是 A 域名，跳转链最后落到 B 域名（可能已换域名或被接替）
  if (r.status === 'ok' && a.finalUrl) {
    try {
      const orig = new URL(site.url).host;
      const fin = new URL(a.finalUrl).host;
      if (!sameSite(orig, fin)) {
        r = { status: 'warn', code: r.code, category: 'domain_drift',
          message: `已跳转到其他站点（${fin}）：原网址可能已更换域名或被他人接替，建议核实后更新或删除`, drifted: true };
      }
    } catch { /* URL 解析失败则忽略 */ }
  }

  const out = {
    ...r, whitelisted: false, category: r.category || r.status,
    protected: !!r.protected, waf: r.waf || detectWaf(a.headers || {}),
    attempts, elapsedMs: Date.now() - started,
  };
  logProbe({ ...head, ...out });
  return out;
}

router.post('/check-links/start', (req, res) => {
  if (linkJob.running) return res.json({ code: 0, data: { started: false, message: '检测已在进行中', total: linkJob.total, done: linkJob.done } });
  const categoryId = Number(req.body?.category_id) || null;
  const sites = categoryId
    ? db.prepare('SELECT id, title, url, category_id FROM sites WHERE category_id = ?').all(categoryId)
    : db.prepare('SELECT id, title, url, category_id FROM sites').all();
  if (!sites.length) return res.status(400).json({ code: 1, message: '没有可检测的网址' });

  const whitelist = getWhitelist();
  Object.assign(linkJob, { running: true, stop: false, done: 0, total: sites.length, results: [], startedAt: Date.now(), finishedAt: null, whitelist, summary: null });
  // 并发从 10 降到 4：对一批站点同时打 10 个请求太像扫描器，容易自己触发 429/403。
  // 配合礼貌重试与 Retry-After，牺牲一点速度换取"拒绝探测"误判大幅下降。
  const CONCURRENCY = 4;
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
    const summary = summarize(linkJob.results, linkJob.finishedAt - linkJob.startedAt);
    linkJob.summary = summary;
    console.log(`[linkcheck] 完成 ${linkJob.done}/${linkJob.total}，耗时 ${Math.round(summary.durationMs / 1000)}s · summary ${JSON.stringify(summary)}`);
  })();
  res.json({ code: 0, data: { started: true, total: sites.length } });
});

router.get('/check-links/status', (req, res) => {
  // 体检结果是内存态，可能被别的入口删掉站点（网址管理删除、分类级联删除、直接改库）。
  // 返回前按现存站点过滤一次并回写，避免刷新后台时已删的网址又出现在体检结果表里。
  const alive = new Set(db.prepare('SELECT id FROM sites').all().map(s => s.id));
  const results = linkJob.results.filter(r => alive.has(r.id));
  if (results.length !== linkJob.results.length) linkJob.results = results;
  res.json({
    code: 0,
    data: { running: linkJob.running, done: linkJob.done, total: linkJob.total, startedAt: linkJob.startedAt, finishedAt: linkJob.finishedAt, results, whitelist: linkJob.whitelist || getWhitelist(), summary: linkJob.summary || null },
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
      r.category = 'whitelisted';
      r.protected = false;
      r.waf = '';
      r.message = '已标记正常（白名单，跳过探测）';
      delete r.drifted;
    } else {
      const pr = await probeSite({ id: r.id, title: r.title, url: r.url }, next);
      Object.assign(r, pr, { whitelisted: false });
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
