/**
 * 生成管理员密码的 scrypt 哈希，粘贴到 .env 的 ADMIN_PASSWORD_HASH
 * 用法：npm run hash-password
 */
const crypto = require('crypto');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('请输入管理员密码: ', (pw) => {
  if (!pw || pw.length < 6) {
    console.error('✗ 密码至少 6 位');
    rl.close();
    process.exit(1);
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  console.log('\n✓ 生成成功，将下面这一行粘贴到 .env 中：\n');
  console.log(`ADMIN_PASSWORD_HASH=scrypt$${salt.toString('hex')}$${hash.toString('hex')}\n`);
  rl.close();
});
