/**
 * 出站请求安全闸门（SSRF 防护）
 *
 * 背景：后台「抓取图标 / 抓取元信息 / 链接体检」都会让服务器去请求用户填写的网址。
 * 若不加限制，填入 http://127.0.0.1:3000/admin、http://192.168.x.x/、http://169.254.169.254/
 * 就能让服务器替访问者去碰内网服务或云厂商元数据接口——这就是 SSRF。
 * 而 fetch 默认 redirect:'follow' 会无校验地跟随跳转，即使首跳是公网，302 一指就进内网。
 *
 * 策略：
 *   1. 只允许 http/https
 *   2. 解析 DNS，命中私网 / 回环 / 链路本地 / 云元数据地址一律拒绝
 *   3. 重定向改为手动逐跳处理，每一跳重新校验（防止「公网域名 302 → 内网」）
 *   4. 本地开发可用 ALLOW_PRIVATE_FETCH=1 关闭（生产环境切勿开启）
 */
const dns = require('dns').promises;

/** 本地开发开关：需要抓 localhost / 内网站点时置 1 */
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_FETCH === '1';

function ipv4Private(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true; // 非法即拒绝
  const [a, b] = p;
  if (a === 10) return true;                          // 10.0.0.0/8
  if (a === 127) return true;                         // 127.0.0.0/8 回环
  if (a === 0) return true;                           // 0.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  if (a === 169 && b === 254) return true;            // 169.254.0.0/16 链路本地（含 169.254.169.254 云元数据）
  if (a === 100 && b === 100) return true;            // 100.100.100.200 阿里云元数据
  if (a === 192 && b === 0 && p[2] === 0) return true;// 192.0.0.0/24
  if (a === 192 && b === 0 && p[2] === 2) return true;// 192.0.2.0/24 TEST-NET
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 基准测试
  if (a === 198 && b === 51 && p[2] === 100) return true; // 198.51.100.0/24
  if (a === 203 && b === 0 && p[2] === 113) return true;  // 203.0.113.0/24
  if (a >= 224) return true;                          // 组播 / 保留
  return false;
}

function ipv6Private(ip) {
  const s = String(ip).toLowerCase().split('%')[0];
  if (s === '::' || s === '::1') return true;                       // 回环 / 未指定
  if (/^f[cd][0-9a-f]{2}:/.test(s)) return true;                    // fc00::/7 唯一本地
  if (/^fe[89ab][0-9a-f]:/.test(s)) return true;                    // fe80::/10 链路本地
  if (/^::ffff:/.test(s)) return ipv4Private(s.slice(7));           // IPv4 映射地址
  if (/^::ffff:[0-9.]+$/.test(s)) return ipv4Private(s.split(':').pop());
  return false;
}

function isPrivateAddress(ip) {
  const s = String(ip || '').trim();
  if (!s) return true;
  return s.includes(':') ? ipv6Private(s) : ipv4Private(s);
}

/**
 * 校验 URL 是否允许出站：协议白名单 + 目标地址非内网。
 * 通过返回 URL 对象，拒绝则抛错。
 */
async function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('无效的网址');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('仅支持 http/https 网址');
  }
  if (ALLOW_PRIVATE) return u;

  const host = u.hostname.replace(/^\[|\]$/g, '');
  // 直接写 IP 的，立即判定
  if (/^[0-9.]+$/.test(host) || host.includes(':')) {
    if (isPrivateAddress(host)) throw new Error('禁止访问内网或保留地址');
    return u;
  }
  // 域名：解析后逐个地址判定（防域名指向 127.0.0.1 这类手法）
  let addrs = [];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new Error('域名解析失败');
  }
  if (!addrs.length) throw new Error('域名解析失败');
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) throw new Error('禁止访问内网或保留地址');
  }
  return u;
}

/**
 * 受控出站请求：手动跟随重定向，每一跳都重新校验目标地址。
 * 返回值是最终那一跳的 Response；可通过返回的 finalUrl 拿到落点（供域名漂移检测）。
 */
async function safeFetch(url, options = {}, maxRedirects = 5) {
  let current = String(url);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, { ...options, redirect: 'manual' });
    const isRedirect = [301, 302, 303, 307, 308].includes(res.status);
    const loc = isRedirect ? res.headers.get('location') : null;
    if (!isRedirect || !loc) {
      res.finalUrl = current; // 附带最终落点，便于上层做域名漂移判断
      return res;
    }
    try {
      res.body?.cancel?.();
    } catch { /* 释放重定向响应体，忽略 */ }
    let next;
    try {
      next = new URL(loc, current).href;
    } catch {
      throw new Error('无效的重定向地址');
    }
    current = next;
  }
  throw new Error('重定向次数过多');
}

module.exports = { assertPublicUrl, safeFetch, isPrivateAddress };
