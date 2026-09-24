# 参与贡献

感谢你考虑为 **NavHub** 做贡献！本项目欢迎多种方式参与：

## 一、推荐好站（无需写代码）
在前台右上角点「推荐好站」，填写网站名称和网址即可。
投稿会进入站长的审核队列，通过后在导航中展示。
- 接口：`POST /api/public/submit`
- 限制：每 IP 每小时最多 5 条，自动去重（已收录 / 已在审核队列的不会重复入）

## 二、反馈问题 / 提建议
- **Bug 或异常**：提交 *Bug 反馈* Issue，附复现步骤与环境。
- **新功能想法**：提交 *功能建议* Issue。

## 三、代码贡献
1. Fork 本仓库并 `git clone` 到本地。
2. 参考 README 的「Windows 环境搭建 / 部署指南」把项目跑起来。
3. 从 `main` 切出特性分支：`git checkout -b feat/你的特性`。
4. 本地验证：`npm start` → 前台 `http://localhost:3000`、后台 `/admin`。
5. 提交 Pull Request，并填写模板中的检查清单。

## 代码规范
- 后端 Node + Express + better-sqlite3，**SQL 一律参数化**（防注入）。
- 任何服务端对外请求（抓取 favicon / 页面元信息 / 链接体检）**必须**走
  `server/netguard.js` 的 `assertPublicUrl` / `safeFetch`，禁止请求内网 /
  回环 / 云元数据地址（SSRF 防护），且重定向需逐跳校验。
- 管理接口必须 `requireAuth`；**绝不提交密钥**，`.env` 与 `data/` 已在
  `.gitignore` 中排除。

## 安全
如发现安全漏洞，请按 [SECURITY.md](./SECURITY.md) 私戳披露，**不要**公开提交 Issue。
