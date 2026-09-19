/**
 * 极简 .env 加载器（不依赖 dotenv，部署更省事）
 * 已存在的系统环境变量优先级更高，不会被 .env 覆盖。
 */
const fs = require('fs');
const path = require('path');

function loadEnv(file = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

module.exports = { loadEnv };
