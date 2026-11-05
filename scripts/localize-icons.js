#!/usr/bin/env node
/**
 * 站点图标本地化（命令行版）
 *
 * 内核在 server/icons.js，与后台「图标本地化」面板、后台保存网址时的自动下载
 * 共用同一套逻辑。
 *
 * 用法（必须在项目根目录执行，数据库路径依赖当前工作目录）：
 *   npm run icons                 # 只补还没本地化的
 *   npm run icons -- --force      # 全部重新下载（换图标后刷新用）
 *   npm run icons -- --limit=30   # 只处理前 30 个（先试水）
 *   npm run icons -- --dry        # 只看有多少要处理，不下载不改库
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
if (!fs.existsSync(path.join(process.cwd(), 'data'))) {
  console.error('✗ 请在项目根目录执行（当前目录下没有 data/，数据库会读错地方）');
  console.error('  正确做法：cd /www/wwwroot/<项目目录> && npm run icons');
  process.exit(1);
}

const db = require(path.join(ROOT, 'server', 'db'));
const icons = require(path.join(ROOT, 'server', 'icons'));

const argv = process.argv.slice(2);
const limitArg = argv.find((a) => a.startsWith('--limit'));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) || 0 : 0;
const FORCE = argv.includes('--force');
const DRY = argv.includes('--dry');

(async () => {
  let sites = db.prepare('SELECT id, title, url, icon FROM sites WHERE is_hidden = 0 ORDER BY id ASC').all();
  if (!FORCE) sites = sites.filter((s) => icons.needsLocalize(s));
  if (LIMIT > 0) sites = sites.slice(0, LIMIT);

  console.log(
    `待处理 ${sites.length} 个图标${FORCE ? '（--force 全部重下）' : ''}${DRY ? '（--dry 仅统计）' : ''}\n`
  );
  if (DRY) return;

  const t0 = Date.now();
  const r = await icons.localizeMany(sites, {
    force: FORCE,
    concurrency: 8,
    onProgress: (acc, site) => {
      const total = acc.ok + acc.skipped + acc.fail;
      if (total % 20 === 0) process.stdout.write(`\r  进度 ${total}/${sites.length}`);
    },
  });
  process.stdout.write('\r');

  console.log(`完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  成功 ${r.ok}   已有跳过 ${r.skipped}   失败 ${r.fail}`);
  if (r.failures.length) {
    console.log('\n失败清单（后台「图标本地化 → 补全缺失」或重跑本命令即可再试）：');
    r.failures.forEach((f) => console.log(`  [${f.id}] ${String(f.title).slice(0, 20)} —— ${f.reason}`));
  }
})();
