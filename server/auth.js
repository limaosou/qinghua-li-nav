/**
 * 鉴权模块：
 * - 密码：scrypt 哈希校验（格式 scrypt$saltHex$hashHex）
 * - Token：HMAC-SHA256 签名的无状态令牌（payload.signature），有效期 7 天
 */
const crypto = require('crypto');

const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000; // 7 天

function getSecret() {
  return process.env.TOKEN_SECRET || 'navhub-dev-secret';
}

/** 校验 scrypt 哈希密码 */
function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const test = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 64);
    const real = Buffer.from(hashHex, 'hex');
    return test.length === real.length && crypto.timingSafeEqual(test, real);
  } catch {
    return false;
  }
}

/** 生成管理员 Token */
function signToken(username) {
  const payload = Buffer.from(
    JSON.stringify({ u: username, exp: Date.now() + TOKEN_TTL })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/** 校验 Token，返回 payload 或 null */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return null;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expect = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

/** Express 中间件：校验 Authorization: Bearer <token> */
function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ code: 1, message: '未登录或登录已过期' });
  req.admin = payload;
  next();
}

module.exports = { verifyPassword, signToken, verifyToken, requireAuth };
