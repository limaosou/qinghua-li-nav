# 安全政策

## 报告漏洞
如你发现安全漏洞（鉴权绕过、SSRF、XSS、注入、越权等），请**不要**公开提交 Issue，
改为发送邮件至 **security@liqinghua.com**（Owner 请确认该邮箱可用，或替换为你的联系方式），
我会在 72 小时内回复，并在修复后公开致谢（如你愿意）。

## 我们的安全实践
- 管理接口全部 `requireAuth`（HMAC Token 鉴权 + scrypt 密码哈希 + 恒定时间比较）。
- 服务端出站请求统一经 `server/netguard.js` 拦截私网 / 回环 / 链路本地 / 云元数据
  （含 IPv6），且重定向逐跳校验，防止 SSRF 跳板。
- 所有 SQL 均参数化，无字符串拼接。
- 生产环境务必配置 `ADMIN_PASSWORD_HASH` 与随机 `TOKEN_SECRET`（见 README「安全建议」），
  禁止使用默认口令 `admin / admin123`。
