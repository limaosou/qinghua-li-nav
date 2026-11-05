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
const deployRoutes = require('./routes/deploy');
const settings = require('./settings');
const { renderNavPage, renderCategoryPage, renderLLMsTxt, renderAboutPage, getNavData, renderSiteDetail, renderSitemapPage, renderSitemapXML } = require('./render');

const app = express();
app.disable('x-powered-by');
// 只信任本地反向代理（宝塔 Nginx）传来的 X-Forwarded-For，让 req.ip 拿到真实客户端 IP；
// 外部直连伪造 XFF 无效，从而保障登录限流与日志按真实来源统计
app.set('trust proxy', 'loopback');
// 自动部署 webhook：必须放在 express.json 之前，以拿到原始 body 做 HMAC 校验
app.use('/api/deploy', express.raw({ type: '*/*', limit: '2mb' }), deployRoutes);

app.use(express.json({ limit: '2mb' }));

// 基础安全响应头（站点用了 CDN 版 Tailwind 与内联脚本，故不启用严格 CSP，仅补无副作用的那几个）
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');       // 禁止 MIME 嗅探
  res.set('X-Frame-Options', 'SAMEORIGIN');           // 禁止被别的站点 iframe 嵌套（点击劫持）
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.set('X-XSS-Protection', '0');                   // 交给浏览器现代 XSS 过滤，避免旧过滤器引入问题
  if (req.headers['x-forwarded-proto'] === 'https') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains'); // 仅在 HTTPS（反代后）下发
  }
  next();
});

/**
 * 详情类页面的规范地址统一为 /cat/{id} 与 /site/{id}。
 * /site/12.html、/site/012、/site/12/ 都是同一页的不同写法，全部 301 到 /site/12；
 * 否则搜索引擎会把它们当成多个地址（.html 原本还会因为 id 解析失败落到“302 回首页”，即软 404）。
 * 已是规范地址时返回 false，交给调用方正常处理。
 */
function redirectToCanonical(req, res, prefix) {
  const raw = String(req.params.id);
  const m = /^0*(\d+?)(?:\.html?)?$/i.exec(raw);
  if (!m) return false;
  if (m[0] === m[1] && !req.path.endsWith('/')) return false;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  res.redirect(301, `${proto}://${host}${prefix}/${m[1]}`);
  return true;
}

// 首页 SSR：内容直接输出进 HTML，利于 SEO 与 AI 搜索抓取
app.get('/', (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.send(renderNavPage(req));
});
// 分类详情页：/cat/:id，展示该分类下全部站点（首页每个分类只展示前 20 个）
app.get('/cat/:id', (req, res) => {
  if (redirectToCanonical(req, res, '/cat')) return;
  const html = renderCategoryPage(req, String(req.params.id));
  if (!html) {
    // 分类不存在：404（原来 302 回首页会被搜索引擎记为软 404），内容给首页方便访客继续浏览
    res.status(404).set('Cache-Control', 'no-store');
    return res.send(renderNavPage(req));
  }
  res.set('Cache-Control', 'public, max-age=60');
  res.send(html);
});

// robots.txt：后台「站点配置」在线编辑；未写明 Sitemap 时自动补一行（否则爬虫不知道地图在哪）
app.get('/robots.txt', (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  let txt = String(settings.getSettings().robots_txt || '');
  if (!/^\s*sitemap:/im.test(txt)) {
    txt = txt.replace(/\s*$/, '\n') + `Sitemap: ${proto}://${host}/sitemap.xml\n`;
  }
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(txt);
});
// llms.txt：面向 AI 搜索引擎（GEO）的结构化内容清单
app.get('/llms.txt', (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(renderLLMsTxt(req));
});

// 品牌故事 / 收录规范页
app.get('/about', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.send(renderAboutPage(req));
});

// 站点详情页：/site/:id（站点信息 + 每日访问统计柱状图，单站 SEO 落地页）
app.get('/site/:id', (req, res) => {
  if (redirectToCanonical(req, res, '/site')) return;
  const html = renderSiteDetail(req, String(req.params.id));
  if (!html) {
    // 站点不存在或已隐藏：给 404 状态码（不再 302 回首页），同时渲染首页方便误点旧链接的访客继续浏览
    res.status(404).set('Cache-Control', 'no-store');
    return res.send(renderNavPage(req));
  }
  res.set('Cache-Control', 'public, max-age=60');
  res.send(html);
});

// sitemap.xml：首页 + 分类页 + 全部站点详情页 + 地图页/关于页
app.get('/sitemap.xml', (req, res) => {
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(renderSitemapXML(req));
});

// 网站地图（HTML 版）：百度只认 html，不认识 sitemap.xml 提交
app.get('/sitemap.html', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(renderSitemapPage(req));
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
