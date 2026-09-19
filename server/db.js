/**
 * 数据库初始化（SQLite / better-sqlite3）
 * 数据文件：DATA_DIR/nav.db，建议纳入服务器定时备份。
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR || './data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'nav.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- 建表 ----------
db.exec(`
CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  icon        TEXT    DEFAULT '',
  sort_order  INTEGER DEFAULT 0,
  created_at  TEXT    DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sites (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  title        TEXT    NOT NULL,
  url          TEXT    NOT NULL,
  description  TEXT    DEFAULT '',
  tags         TEXT    DEFAULT '',
  icon         TEXT    DEFAULT '',
  sort_order   INTEGER DEFAULT 0,
  is_pinned    INTEGER DEFAULT 0,
  is_hidden    INTEGER DEFAULT 0,
  created_at   TEXT    DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT DEFAULT ''
);

-- 前台访客投稿（后台审核后才进入网址表）
CREATE TABLE IF NOT EXISTS submissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  url         TEXT    NOT NULL,
  description TEXT    DEFAULT '',
  tags        TEXT    DEFAULT '',
  contact     TEXT    DEFAULT '',
  status      TEXT    DEFAULT 'pending',   -- pending | approved | rejected
  ip          TEXT    DEFAULT '',
  created_at  TEXT    DEFAULT (datetime('now','localtime')),
  reviewed_at TEXT    DEFAULT ''
);
`);

// ---------- 首次启动写入示例数据 ----------
function seedIfEmpty() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
  if (n > 0) return;

  const insCat = db.prepare('INSERT INTO categories (name, icon, sort_order) VALUES (?, ?, ?)');
  const insSite = db.prepare(
    'INSERT INTO sites (category_id, title, url, description, tags, icon, sort_order, is_pinned) VALUES (?,?,?,?,?,?,?,?)'
  );

  const fav = (d) => `https://favicon.im/${d}?larger=true`;

  const seed = [
    {
      name: '常用推荐', icon: '⭐',
      sites: [
        ['百度', 'https://www.baidu.com', '全球领先的中文搜索引擎', '搜索,引擎', fav('baidu.com'), 0, 1],
        ['GitHub', 'https://github.com', '全球最大的代码托管平台', '代码,开源', fav('github.com'), 1, 1],
        ['知乎', 'https://www.zhihu.com', '有问题，就会有答案', '社区,问答', fav('zhihu.com'), 2, 0],
        ['哔哩哔哩', 'https://www.bilibili.com', '你感兴趣的视频都在B站', '视频,弹幕', fav('bilibili.com'), 3, 0],
        ['淘宝', 'https://www.taobao.com', '淘宝网 - 随时随地淘！', '购物,电商', fav('taobao.com'), 4, 0],
      ],
    },
    {
      name: '开发工具', icon: '💻',
      sites: [
        ['MDN Web Docs', 'https://developer.mozilla.org', 'Web 技术权威文档', '文档,前端', fav('developer.mozilla.org'), 0, 0],
        ['npm', 'https://www.npmjs.com', 'JavaScript 包管理仓库', 'npm,包管理', fav('npmjs.com'), 1, 0],
        ['Can I Use', 'https://caniuse.com', '浏览器兼容性查询', '兼容性,前端', fav('caniuse.com'), 2, 0],
        ['Vercel', 'https://vercel.com', '前端应用一键部署平台', '部署,托管', fav('vercel.com'), 3, 0],
      ],
    },
    {
      name: '影视娱乐', icon: '🎬',
      sites: [
        ['豆瓣电影', 'https://movie.douban.com', '看电影、评分、写影评', '电影,评分', fav('movie.douban.com'), 0, 0],
        ['YouTube', 'https://www.youtube.com', '全球最大视频网站', '视频,国外', fav('youtube.com'), 1, 0],
        ['爱奇艺', 'https://www.iqiyi.com', '中国领先的视频门户', '视频,剧集', fav('iqiyi.com'), 2, 0],
      ],
    },
    {
      name: '学习资源', icon: '📚',
      sites: [
        ['力扣 LeetCode', 'https://leetcode.cn', '刷题提升算法能力', '算法,面试', fav('leetcode.cn'), 0, 0],
        ['菜鸟教程', 'https://www.runoob.com', '学的不仅是技术，更是梦想', '教程,入门', fav('runoob.com'), 1, 0],
        ['Coursera', 'https://www.coursera.org', '全球名校在线课程', '课程,MOOC', fav('coursera.org'), 2, 0],
      ],
    },
  ];

  const tx = db.transaction(() => {
    seed.forEach((cat, ci) => {
      const { lastInsertRowid: cid } = insCat.run(cat.name, cat.icon, ci);
      cat.sites.forEach((s) => insSite.run(cid, ...s));
    });
  });
  tx();
  console.log('✓ 已写入示例数据（可在后台修改或删除）');
}

seedIfEmpty();

module.exports = db;
