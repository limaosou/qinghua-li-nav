# NavHub · 响应式网址导航系统

前台展示 + 后台管理，Node.js + Express + SQLite，开箱即部署。

## 功能一览

| 前台 `/` | 后台 `/admin` |
|---|---|
| 分类锚点导航（滚动高亮） | 账号密码登录（scrypt 哈希 + HMAC Token） |
| 百度 / Google / Bing / DuckDuckGo 引擎切换 | 分类增删改、上下移动排序 |
| 网址卡片：图标、描述、标签、置顶、新标签页打开 | 网址增删改、排序、置顶、隐藏 |
| 站内实时搜索过滤 | 填入网址后一键自动抓取 Favicon |
| 深色 / 浅色主题切换（记忆偏好） | 一键导出 JSON 备份 |
| 移动端 / PC 完全响应式 | 简单防暴力破解（10 分钟 5 次） |

## 目录结构

```
nav-system/
├── server/
│   ├── index.js          # Express 入口
│   ├── db.js             # SQLite 初始化（建表 + 首次示例数据）
│   ├── auth.js           # scrypt 密码校验 + HMAC Token 鉴权
│   ├── env.js            # 零依赖 .env 加载器
│   └── routes/
│       ├── public.js     # GET /api/public/nav
│       └── admin.js      # 登录 / 分类 / 网址 / favicon / 导出
├── public/
│   ├── index.html        # 前台展示页
│   └── admin.html        # 后台管理页
├── scripts/hash-password.js  # 生成密码哈希
├── data/                 # SQLite 数据文件（自动创建，需备份）
├── .env.example          # 环境变量模板
├── Dockerfile / docker-compose.yml
└── ecosystem.config.js   # PM2 配置
```

## 快速开始（本地）

```bash
npm install
cp .env.example .env
# 生成密码哈希并填入 .env 的 ADMIN_PASSWORD_HASH
npm run hash-password
npm start
# 前台 http://localhost:3000   后台 http://localhost:3000/admin
```

未配置密码时默认账号 `admin / admin123`（仅首次登录用，务必尽快配置）。

---

# Windows 环境搭建（换机器继续开发）

换到另一台 Windows 电脑开发完全没问题：本项目是纯 Node + Express + SQLite，没有平台相关代码。
唯一要注意的是 `better-sqlite3` 属于**原生模块**，不能从别的系统拷贝 `node_modules`，必须在本机重新安装。

## 1. 准备环境

- 安装 **Node.js 20 或 22 的 LTS x64 版**（官网 msi 安装包，一路下一步即可）。装完验证：
  ```powershell
  node -v
  npm -v
  ```
- 安装 **Git for Windows**（自带 Git Bash，也建议用）。
- 可选：安装 **VS Code**（改 `public/index.html`、`public/admin.html` 很顺手）。

> 若不想折腾原生模块编译，可直接用仓库里的 `docker-compose.yml`（装 Docker Desktop 后 `docker compose up -d --build`），跳过第 3 步。

## 2. 拉代码

```powershell
git clone https://github.com/limaosou/qinghua-nav.git nav-system
cd nav-system
```

## 3. 装依赖

```powershell
npm install
```

若 `better-sqlite3` 报编译错误（缺 C++ 构建工具），二选一：

```powershell
# 方案 A：安装构建工具后重试（需管理员 PowerShell）
npm install -g windows-build-tools
npm install

# 方案 B：改用 Docker，避开本机编译
docker compose up -d --build
```

## 4. 配置环境变量

```powershell
copy .env.example .env
npm run hash-password          # 输入管理员密码，把生成的哈希填进 .env
notepad .env                   # 填 ADMIN_USERNAME / ADMIN_PASSWORD_HASH / TOKEN_SECRET
```

`TOKEN_SECRET` 请换成一段随机长字符串（本机开发可与服务器不同，互不影响）。

## 5. 同步数据（重要）

`data/` 目录被 `.gitignore` 排除，**克隆下来是空的**，会生成一批示例数据。
想在本地看到和线上一样的站点，把服务器上的数据库拷过来放到 `data/` 下即可：

```powershell
# 在 Windows 上执行（需能 ssh 到服务器）
scp root@你的服务器:/www/wwwroot/qinghua-nav/data/nav.db .\data\nav.db
```

没有服务器权限也行：后台「数据备份」页导出 JSON，本地跑起来后再手动录入或写脚本导入。

## 6. 启动

```powershell
npm start
# 前台 http://localhost:3000    后台 http://localhost:3000/admin
```

## 7. 多台机器协作的工作流

```powershell
git pull            # 开工前先拉，绝不在旧代码上改
# …… 改代码 ……
git add .
git commit -m "说明改了什么"
git push
```

然后到服务器上更新：

```bash
cd /www/wwwroot/qinghua-nav && git pull && pm2 restart navhub
```

⚠️ **不要两台机器同时改同一个文件**：未 pull 就改会覆盖对方的提交，已踩过坑。
`node_modules/` 也别跨机器复制（原生模块与平台绑定），每台机器各自 `npm install`。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/public/nav` | 前台公开分类与网址（不含隐藏） |
| POST | `/api/admin/login` | `{username, password}` → `{token}` |
| GET | `/api/admin/data` | 全量数据（需 Token） |
| POST | `/api/admin/categories` | `action: create/update/delete/reorder` |
| POST | `/api/admin/sites` | `action: create/update/delete/reorder/toggle` |
| POST | `/api/admin/fetch-favicon` | `{url}` → `{icon}`（base64 或外链） |
| GET | `/api/admin/export` | 导出 JSON 备份（附件下载） |

管理接口需请求头 `Authorization: Bearer <token>`，Token 有效期 7 天。

---

# 部署指南（Linux 服务器）

## 方式一：宝塔面板（BT-Panel）

1. **上传代码**：宝塔「文件」中把项目上传到如 `/www/wwwroot/qinghua-nav`；或终端 git 拉取：
   ```bash
   cd /www/wwwroot
   git clone git@github.com:<你的用户名>/qinghua-nav.git qinghua-nav
   cd qinghua-nav
   ```
2. **安装 PM2 管理器**：宝塔「软件商店」搜索安装 `PM2管理器`（自带 Node 环境，建议 Node ≥ 18）。
3. **安装依赖**：
   - 若用 Node 项目管理器：添加项目 → 启动文件选 `server/index.js`，运行目录为项目根，端口 `3000`，自动执行 `npm install`。
   - 或终端方式：
     ```bash
     cd /www/wwwroot/qinghua-nav
     npm install --omit=dev
     ```
4. **配置环境变量**：
   ```bash
   cp .env.example .env
   node scripts/hash-password.js   # 按提示输入管理员密码，把生成的哈希填入 .env
   vim .env                        # 修改 ADMIN_USERNAME / ADMIN_PASSWORD_HASH / TOKEN_SECRET
   ```
   ⚠️ `TOKEN_SECRET` 必须换成随机长字符串（`openssl rand -hex 32`），否则 Token 可被伪造。
5. **PM2 启动**：
   ```bash
   npm install -g pm2        # 若 PM2 管理器已带可跳过
   pm2 start ecosystem.config.js
   pm2 save && pm2 startup   # 开机自启
   ```
6. **域名 + 反向代理**：宝塔「网站」→ 添加站点（纯静态即可）→ 设置 → 反向代理 → 目标 URL `http://127.0.0.1:3000`，并申请 SSL 证书。
   **HTTPS 站点必须**在反向代理配置里加上（否则前台 canonical 链接会变成 http）：
   ```nginx
   proxy_set_header X-Forwarded-Proto $scheme;
   proxy_set_header X-Forwarded-Host $host;
   ```
7. **首次验证**：访问 `https://你的域名` 看前台，`/admin` 登录后台（用第 4 步配置的账号），进「站点配置」改公告/导航链接等。
8. **备份**：宝塔「计划任务」加一条每日 Shell：
   ```bash
   cp -r /www/wwwroot/qinghua-nav/data /www/backup/qinghua-nav-$(date +\%F)
   ```
   `data/` 里是 SQLite 数据库（含分类/网址/投稿/站点配置），拷走即全量备份。

## 方式二：PM2 裸机部署

```bash
# 1. 安装 Node 18+（以 Node 20 为例）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. 拉代码、装依赖
git clone <你的仓库> /opt/nav-system && cd /opt/nav-system
npm install --omit=dev
cp .env.example .env && vim .env      # 修改密钥与密码

# 3. PM2 启动 + 开机自启
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save && pm2 startup

# 4. Nginx 反向代理（可选，配域名时）
#    在 server{} 中加入：
#    location / { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; }
```

常用命令：`pm2 list` / `pm2 logs navhub` / `pm2 restart navhub`

## 方式三：Docker / Docker Compose

```bash
cd nav-system
cp .env.example .env && vim .env   # 配置密码与密钥

# Docker Compose（推荐，含数据卷持久化）
docker compose up -d --build
docker compose logs -f

# 或纯 docker 命令
docker build -t navhub .
docker run -d --name navhub -p 3000:3000 \
  -v $(pwd)/data:/app/data --env-file .env --restart always navhub
```

更新版本：`git pull && docker compose up -d --build`

## 数据备份

- **文件级**：直接备份 `data/` 目录（`nav.db` + WAL 文件），恢复时放回原处重启即可。
- **JSON 级**：后台「数据备份」页一键导出 `navhub-backup.json`。

## 安全建议

1. 生产环境务必用 `npm run hash-password` 生成 `ADMIN_PASSWORD_HASH`，删掉 `.env` 中的明文 `ADMIN_PASSWORD`。
2. `TOKEN_SECRET` 用长随机串：`openssl rand -hex 32`。
3. 建议套 Nginx + HTTPS，并可在 Nginx 层限制 `/admin` 与 `/api/admin` 的访问 IP。
