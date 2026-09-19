// PM2 配置：pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'navhub',
      script: 'server/index.js',
      instances: 1,          // SQLite 单写者，保持单实例
      autorestart: true,
      max_memory_restart: '300M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
