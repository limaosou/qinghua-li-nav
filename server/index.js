/**
 * NavHub 入口：Express 服务
 */
const { loadEnv } = require('./env');
loadEnv();

const express = require('express');
const path = require('path');
require('./db'); // 初始化数据库（建表 + 首次示例数据）

const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const settings = require('./settings');
const { renderNavPage, renderLLMsTxt } = require('./render');

const app = express();
app.disable('x-powered-by');
// 只信任本地反向代理（宝塔 Nginx）传来的 X-Forwarded-For，让 req.ip 拿到真实客户端 IP；
// 外部直连伪造 XFF 无效，从而保障登录限流与日志按真实来源统计
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '2mb' }));

// 首页 SSR：内容直接输出进 HTML，利于 SEO 与 AI 搜索抓取
app.get('/', (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.send(renderNavPage(req));
});
// robots.txt：后台「站点配置」在线编辑
app.get('/robots.txt', (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(settings.getSettings().robots_txt);
});
// llms.txt：面向 AI 搜索引擎（GEO）的结构化内容清单
app.get('/llms.txt', (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(renderLLMsTxt(req));
});

// sitemap.xml：单页导航站，列出首页
app.get('/sitemap.xml', (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const base = `${proto}://${host}`;
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>
</urlset>`);
});

// 静态资源（前台 + 后台页面）
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));
app.get('/admin', (req, res) => res.sendFile(path.join(publicDir, 'admin.html')));

// API
app.use('/api/public', publicRoutes);
app.use('/api/admin', adminRoutes);

// 404 & 错误兜底
app.use((req, res) => res.status(404).json({ code: 1, message: 'Not Found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ code: 1, message: '服务器内部错误' });
});

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

if (!process.env.ADMIN_PASSWORD_HASH && !process.env.ADMIN_PASSWORD) {
  console.warn('⚠️  未配置管理员密码，默认账号 admin / admin123（仅用于首次登录，请尽快在 .env 配置 ADMIN_PASSWORD_HASH）');
}

app.listen(PORT, HOST, () => {
  console.log(`✓ NavHub 已启动:  前台 http://localhost:${PORT}   后台 http://localhost:${PORT}/admin`);
});
