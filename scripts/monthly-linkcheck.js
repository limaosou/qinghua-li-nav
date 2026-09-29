#!/usr/bin/env node
/**
 * 每月死链扫描：触发后台「链接体检」并产出报告
 *
 * 设计：
 *  - 在服务器本机运行（与站点同机），默认打 127.0.0.1:3000，避免公网 DNS / 反代干扰。
 *  - 用 ADMIN_USERNAME + 口令登录拿到 Token，再调用 /api/admin/check-links/start。
 *    口令优先级：NAV_CRON_PASSWORD > ADMIN_PASSWORD（明文）。若仅配置了 ADMIN_PASSWORD_HASH，
 *    请在 .env 里加一行 NAV_CRON_PASSWORD=你的明文口令（仅供本脚本定时任务使用）。
 *  - 轮询 /status 直至结束，打印 ok/warn/fail 统计，并把明细写入 data/linkcheck-report.json。
 *
 * 用法：
 *   node scripts/monthly-linkcheck.js
 * 建议服务器 crontab（每月 1 日 03:10）：
 *   10 3 1 * * cd /www/wwwroot/qinghua-li-nav && /usr/bin/node scripts/monthly-linkcheck.js >> data/linkcheck.log 2>&1
 */
'use strict';
const fs = require('fs');
const path = require('path');

// 极简 .env 读取（与 server/env.js 行为一致：KEY=VALUE，忽略注释与空行）
function loadEnv() {
  const file = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const k = m[1], v = m[2].replace(/^["']|["']$/g, '');
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnv();

const BASE = (process.env.NAV_BASE || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const USER = process.env.ADMIN_USERNAME || 'admin';
const PASS = process.env.NAV_CRON_PASSWORD || process.env.ADMIN_PASSWORD || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[linkcheck ${new Date().toISOString()}]`, ...a);

async function main() {
  if (!PASS) {
    log('未找到口令：请在 .env 设置 NAV_CRON_PASSWORD（或保留 ADMIN_PASSWORD 明文）后再运行。');
    log('若无服务器权限，也可直接在后台「链接体检」手动点「开始检测」。');
    process.exit(2);
  }
  // 1) 登录
  let token;
  try {
    const r = await fetch(`${BASE}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASS }),
    });
    const j = await r.json();
    if (j.code !== 0 || !j.data?.token) throw new Error(j.message || '登录失败');
    token = j.data.token;
    log('登录成功');
  } catch (e) {
    log('登录失败：', e.message);
    process.exit(1);
  }

  const auth = { Authorization: `Bearer ${token}` };
  // 2) 开始检测
  const start = await fetch(`${BASE}/api/admin/check-links/start`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' });
  const sj = await start.json();
  if (sj.code !== 0) { log('启动检测失败：', sj.message); process.exit(1); }
  log(`检测已启动，共 ${sj.data?.total || '?'} 个站点`);

  // 3) 轮询
  let last = 0;
  for (let i = 0; i < 360; i++) { // 最多 30 分钟
    await sleep(5000);
    const st = await fetch(`${BASE}/api/admin/check-links/status`, { headers: auth }).then((r) => r.json());
    const d = st.data || {};
    if (d.done !== last) { last = d.done; log(`进度 ${d.done}/${d.total}`); }
    if (d.finishedAt) break;
    if (!d.running && d.finishedAt) break;
  }

  // 4) 汇总
  const fin = await fetch(`${BASE}/api/admin/check-links/status`, { headers: auth }).then((r) => r.json());
  const results = (fin.data?.results) || [];
  const ok = results.filter((r) => r.status === 'ok').length;
  const warn = results.filter((r) => r.status === 'warn').length;
  const fail = results.filter((r) => r.status === 'fail');
  log(`完成：ok=${ok} warn=${warn} fail=${fail.length}`);
  if (fail.length) {
    log('失效站点（建议处理）：');
    for (const f of fail) log(`  - [${f.code || f.kind || 'err'}] ${f.title}  ${f.url}  ${f.message || ''}`);
  }

  // 5) 写报告
  try {
    const out = path.resolve(process.cwd(), 'data', 'linkcheck-report.json');
    fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), ok, warn, fail: fail.length, failures: fail }, null, 2));
    log('报告已写入', out);
  } catch (e) { log('写报告失败（忽略）：', e.message); }
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { log('异常：', e.message); process.exit(1); });
