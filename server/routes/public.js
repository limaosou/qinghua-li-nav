/**
 * 公开接口：
 *  GET  /api/public/nav       前台数据
 *  GET  /api/public/settings  前台公开配置
 *  POST /api/public/submit    访客投稿（进入待审核队列）
 */
const express = require('express');
const db = require('../db');
const settings = require('../settings');

const router = express.Router();

// 简单投稿频率限制：每 IP 每小时最多 5 条
const submitLog = new Map();
function tooFrequent(ip) {
  const now = Date.now();
  const arr = (submitLog.get(ip) || []).filter(t => now - t < 3600 * 1000);
  submitLog.set(ip, arr);
  return arr.length >= 5;
}

// 访客投稿
router.post('/submit', (req, res) => {
  try {
    const b = req.body || {};
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || '';
    if (tooFrequent(ip)) return res.status(429).json({ code: 1, message: '投稿太频繁了，请一小时后再试' });

    let url = String(b.url || '').trim();
    const title = String(b.title || '').trim().slice(0, 60);
    const description = String(b.description || '').trim().slice(0, 200);
    const tags = String(b.tags || '').trim().slice(0, 100);
    const contact = String(b.contact || '').trim().slice(0, 100);
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    let host;
    try { host = new URL(url).hostname; } catch { return res.status(400).json({ code: 1, message: '网址格式不对' }); }
    if (!title) return res.status(400).json({ code: 1, message: '请填写网站名称' });

    // 去重：已收录或已在待审核队列
    const norm = u => String(u).replace(/\/+$/, '').toLowerCase();
    const dupSite = db.prepare('SELECT id FROM sites WHERE LOWER(TRIM(url)) = ?').get(norm(url));
    const dupSub = db.prepare("SELECT id FROM submissions WHERE status = 'pending' AND LOWER(TRIM(url)) = ?").get(norm(url));
    if (dupSite) return res.status(400).json({ code: 1, message: '这个网站已经在导航里啦' });
    if (dupSub) return res.status(400).json({ code: 1, message: '该网站已在审核队列中，请耐心等待' });

    db.prepare('INSERT INTO submissions (title, url, description, tags, contact, ip) VALUES (?, ?, ?, ?, ?, ?)')
      .run(title, url, description, tags, contact, ip);
    res.json({ code: 0, message: '投稿成功，审核通过后将展示在前台' });
  } catch (e) {
    res.status(500).json({ code: 1, message: '提交失败，请稍后重试' });
  }
});

// 前台公开的站点配置（搜索引擎列表、品牌、公告等）
router.get('/settings', (req, res) => {
  res.json({ code: 0, data: settings.getPublicSettings() });
});

router.get('/nav', (req, res) => {
  const categories = db
    .prepare('SELECT id, name, icon FROM categories ORDER BY sort_order ASC, id ASC')
    .all();

  const siteStmt = db.prepare(`
    SELECT id, category_id, title, url, description, tags, icon, is_pinned
    FROM sites
    WHERE is_hidden = 0 AND category_id = ?
    ORDER BY is_pinned DESC, sort_order ASC, id ASC
  `);

  const data = categories.map((c) => ({ ...c, sites: siteStmt.all(c.id) }));
  res.json({ code: 0, data });
});

module.exports = router;
