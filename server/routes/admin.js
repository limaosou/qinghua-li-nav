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
const db = require('../db');
const settings = require('../settings');
const { verifyPassword, signToken, requireAuth } = require('../auth');

const router = express.Router();

// ---------- 登录（带简单防暴力：10 分钟内最多 5 次失败） ----------
const attempts = new Map();

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const key = req.ip || 'unknown';
  const now = Date.now();
  const rec = attempts.get(key) || { count: 0, first: now };
  if (rec.count >= 5 && now - rec.first < 10 * 60 * 1000) {
    return res.status(429).json({ code: 1, message: '失败次数过多，请 10 分钟后再试' });
  }

  const okUser = username === (process.env.ADMIN_USERNAME || 'admin');
  let okPass = false;
  if (process.env.ADMIN_PASSWORD_HASH) {
    okPass = verifyPassword(password, process.env.ADMIN_PASSWORD_HASH);
  } else if (process.env.ADMIN_PASSWORD) {
    okPass = password === process.env.ADMIN_PASSWORD;
  } else {
    okPass = password === 'admin123'; // ⚠️ 未配置密码时的默认口令，仅用于首次登录
  }

  if (okUser && okPass) {
    attempts.delete(key);
    return res.json({ code: 0, data: { token: signToken(username) } });
  }

  rec.count += 1;
  rec.first = rec.first && now - rec.first < 10 * 60 * 1000 ? rec.first : now;
  attempts.set(key, rec);
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

// ---------- 抓取网站图标 ----------
router.post('/fetch-favicon', async (req, res) => {
  const raw = String(req.body?.url || '').trim();
  if (!raw) return res.status(400).json({ code: 1, message: '请先填写网址' });
  try {
    const u = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
    // 优先直接抓取站点 /favicon.ico，转 base64 存储（避免外链失效）
    try {
      const r = await fetch(u.origin + '/favicon.ico', {
        signal: AbortSignal.timeout(6000),
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 NavHub/1.0' },
      });
      const ct = r.headers.get('content-type') || '';
      if (r.ok && ct.startsWith('image')) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 0 && buf.length < 300 * 1024) {
          return res.json({ code: 0, data: { icon: `data:${ct.split(';')[0]};base64,${buf.toString('base64')}` } });
        }
      }
    } catch { /* fallthrough */ }
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
    const r = await fetch(u.href, {
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
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
  } catch {
    res.status(400).json({ code: 1, message: '抓取失败，请手动填写' });
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
