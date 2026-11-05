/**
 * 站点访问统计（展示口径）
 *
 * 数据来源：daily_visits(site_id, day, pc_hits, mobile_hits)
 * 但站点上线初期真实访问极少，图上全是空柱子很难看，因此这里做一层「展示口径」：
 *   - 某天真实访问 < 阈值（默认 5 次）→ 用该天的演示值填充
 *   - 某天真实访问 >= 阈值        → 展示真实值
 * 演示值由 site_id + day 做哈希生成，同一天无论刷新多少次都是同一个数（不会跳动），
 * 且各站点量级不同、有自然起伏；今天按已过时段折算，符合「当天还没过完」的观感。
 * 后台「站点配置 → 访问数据演示」可整体关闭，或调整阈值。
 */
const db = require('./db');
const settings = require('./settings');

const DAYS = 15;                 // 图表展示天数
const TZ_MS = 8 * 3600 * 1000;   // 按东八区（北京时间）切日，避免早上 8 点前的访问算到昨天
const DEFAULT_THRESHOLD = 5;     // 单日真实访问达到该值即改用真实数据

/** 北京时间「今天往前 daysAgo 天」的 YYYY-MM-DD */
function todayKey(daysAgo = 0) {
  return new Date(Date.now() + TZ_MS - daysAgo * 86400000).toISOString().slice(0, 10);
}

/** FNV-1a 32 位哈希：用于生成稳定的伪随机数 */
function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 某站点某一天的演示值（PC / 移动端） */
function demoDay(siteId, day) {
  const h = hash32(siteId + '|' + day);
  // 每个站点一个固定的规模系数，让不同站点的柱子量级有差异
  const scale = 0.72 + ((hash32('n' + siteId) % 1000) / 1000) * 0.53; // 0.72 ~ 1.25
  const base = 7 + Math.round(((h % 997) / 997) * 15);                // 7 ~ 22
  let total = base * scale;
  if (day === todayKey(0)) {
    // 今天还没过完，按已过时段折算（至少 30%），避免早上就显示满量
    const hour = new Date(Date.now() + TZ_MS).getUTCHours();
    total *= Math.max(0.3, (hour + 1) / 24);
  }
  total = Math.max(2, Math.round(total));
  const pcRatio = 0.52 + (((h >>> 11) % 27) / 100);                   // 0.52 ~ 0.78
  const pc = Math.max(1, Math.round(total * pcRatio));
  return { pc, mb: Math.max(0, total - pc) };
}

function demoConfig() {
  const s = settings.getSettings();
  return {
    enabled: s.stats_demo_enabled !== false,
    threshold: Math.max(1, Number(s.stats_demo_threshold) || DEFAULT_THRESHOLD),
  };
}

/**
 * 取某站点近 15 天的展示数据
 * @returns {{series: Array, total15: number, totalPc: number, totalMb: number, real15: number, demoDays: number}}
 */
function getSiteStats(siteId) {
  const id = Number(siteId) || 0;
  const { enabled, threshold } = demoConfig();
  const rows = db
    .prepare('SELECT day, pc_hits, mobile_hits FROM daily_visits WHERE site_id = ? AND day >= ?')
    .all(id, todayKey(DAYS - 1));
  const map = new Map(rows.map(r => [r.day, r]));

  const series = [];
  let real15 = 0;
  let demoDays = 0;
  for (let i = DAYS - 1; i >= 0; i--) {
    const day = todayKey(i);
    const r = map.get(day);
    const rp = r ? r.pc_hits || 0 : 0;
    const rm = r ? r.mobile_hits || 0 : 0;
    real15 += rp + rm;
    let pc = rp;
    let mb = rm;
    let demo = false;
    if (enabled && rp + rm < threshold) {
      const d = demoDay(id, day);
      // 真实值哪怕只有 1 次也保留，演示值只做「抬高」，不抹掉真实痕迹
      pc = Math.max(rp, d.pc);
      mb = Math.max(rm, d.mb);
      demo = true;
      demoDays++;
    }
    series.push({ day, pc, mb, hits: pc + mb, real: rp + rm, demo });
  }

  const totalPc = series.reduce((a, x) => a + x.pc, 0);
  const totalMb = series.reduce((a, x) => a + x.mb, 0);
  return { series, total15: totalPc + totalMb, totalPc, totalMb, real15, demoDays };
}

/**
 * 累计点击数的展示口径
 * 演示期：真实累计 + 演示多出来的部分 + 一段「15 天之前的历史量」，
 * 否则「累计点击」和「近 15 天访问」会正好相等，一眼就看出是新的。
 * 真实数据接管后（demoExtra = 0）直接返回真实累计。
 */
function displayClicks(realClicks, stats, siteId) {
  const base = Number(realClicks) || 0;
  const demoExtra = Math.max(0, stats.total15 - stats.real15);
  if (demoExtra <= 0) return base;
  const historyDays = 30 + (hash32('h' + siteId) % 61); // 30~90 天的历史
  const history = Math.round((stats.total15 / DAYS) * historyDays);
  return base + demoExtra + history;
}

/** 是否为搜索引擎 / 监控 / 脚本类 UA（不计入访问统计） */
function isBotUA(uaRaw) {
  const ua = String(uaRaw || '');
  if (!ua) return true; // 空 UA 基本都是脚本，直接丢
  if (/cubot/i.test(ua)) return false; // CUBOT 手机被 \bbot\b 误伤，单独放过
  // bot\b 可覆盖 Googlebot/Bingbot/YandexBot 等；CUBOT 手机已在上面放过
  return /bot\b|spider|crawl|slurp|bingpreview|baiduspider|semrush|ahrefs|mj12|petalbot|bytespider|facebookexternalhit|headless|phantom|puppeteer|playwright|python-requests|scrapy|curl\/|wget\/|go-http-client|java\/|okhttp|libwww|httpclient/i.test(ua);
}

module.exports = { DAYS, todayKey, demoDay, getSiteStats, displayClicks, isBotUA, demoConfig };
