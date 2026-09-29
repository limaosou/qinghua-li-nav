/**
 * 自动部署端点（可选能力，需配置 WEBHOOK_SECRET 才启用）
 *
 *   - GitHub Webhook：POST /api/deploy  （校验 x-hub-signature-256，仅 main 分支 push 触发）
 *   - 手动触发：       GET  /api/deploy?token=WEBHOOK_SECRET  （个人站临时用，token 会进日志）
 *
 * 校验通过后执行 `git pull --ff-only`，再由 PM2 重启加载新代码。
 * 未设置 WEBHOOK_SECRET 时本端点始终返回 403（默认关闭，零风险）。
 */
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');
const path = require('path');
const express = require('express');

const router = express.Router();
const REPO_ROOT = path.resolve(__dirname, '..'); // server/ 的上一级即仓库根

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifyGitHub(body, sigHeader, secret) {
  if (!sigHeader || typeof sigHeader !== 'string') return false;
  const i = sigHeader.indexOf('=');
  if (i < 0) return false;
  const alg = sigHeader.slice(0, i);
  const provided = sigHeader.slice(i + 1);
  if (alg !== 'sha256') return false;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return timingSafeEqual(provided, expected);
}

function doDeploy(res) {
  try {
    const out = execSync('git pull --ff-only', { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000 });
    res.json({ code: 0, message: '已拉取更新，正在重启服务', output: out.slice(0, 600) });
    // 延迟一点，确保响应已发出再重启
    setTimeout(() => {
      try {
        execSync('pm2 restart navhub', { timeout: 15000, stdio: 'ignore' });
      } catch {
        process.exit(0); // 未用 pm2 时直接退出，交给外部进程管理器拉起
      }
      // 部署后主动推送搜索引擎（需 .env 配 BAIDU_ZZ_TOKEN / BING_INDEXNOW_KEY）
      if (process.env.BAIDU_ZZ_TOKEN || process.env.BING_INDEXNOW_KEY) {
        setTimeout(() => {
          try {
            spawn('node', [path.join(REPO_ROOT, 'scripts', 'submit-index.js')],
              { detached: true, stdio: 'ignore' }).unref();
          } catch { /* 推送失败不影响部署 */ }
        }, 3000); // 等服务起来再抓 sitemap
      }
    }, 300);
  } catch (e) {
    const detail = String(e.stdout || e.stderr || e.message).slice(0, 600);
    res.status(500).json({
      code: 1,
      message: 'git pull 失败，未重启（可能本地有未提交改动或网络不通）',
      error: detail,
    });
  }
}

// GitHub Webhook：原始 body 用于 HMAC 校验
router.post('/', (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return res.status(403).json({ code: 1, message: 'webhook 未启用：请在 .env 设置 WEBHOOK_SECRET' });
  if (req.headers['x-github-event'] === 'ping') return res.json({ code: 0, message: 'pong' });
  if (req.headers['x-github-event'] !== 'push') return res.status(200).json({ code: 0, message: '忽略非 push 事件' });

  const body = req.body && Buffer.isBuffer(req.body) && req.body.length ? req.body : Buffer.from('');
  if (!verifyGitHub(body, req.headers['x-hub-signature-256'], secret)) {
    return res.status(401).json({ code: 1, message: '签名校验失败' });
  }
  // 仅 main 分支触发；其余分支静默跳过
  try {
    const payload = JSON.parse(body.toString('utf8'));
    if (payload.ref && payload.ref !== 'refs/heads/main') {
      return res.json({ code: 0, message: '非 main 分支，跳过部署', ref: payload.ref });
    }
  } catch { /* body 解析失败则按默认继续部署 */ }

  doDeploy(res);
});

// 手动触发（个人站友好，但 token 会出现在 URL 与服务器日志，仅建议临时使用）
router.get('/', (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return res.status(403).json({ code: 1, message: 'webhook 未启用：请在 .env 设置 WEBHOOK_SECRET' });
  if (!timingSafeEqual(req.query.token || '', secret)) return res.status(401).json({ code: 1, message: 'token 错误' });
  doDeploy(res);
});

module.exports = router;
