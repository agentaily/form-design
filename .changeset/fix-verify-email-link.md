---
"agentaily-forms": patch
---

fix(auth): 验证邮件确认链接指向 worker 自身 origin,而非前端域

注册 / 重发的验证邮件里 `verify-email/confirm` 链接此前拼成 `APP_BASE_URL`(前端域 `form-design.agentaily.com`)+ `/api/...`,但该确认端点在 worker 上、前端站不 serve `/api`,点开是死链(落到 SPA fallback、验证不了)。改用请求自身 origin(`new URL(c.req.url).origin`)——链接 host 必须是浏览器能到达本 API 的那个 host,将来绑自定义域也自动跟随。reset 邮件指向前端落地页,仍用 `APP_BASE_URL`(正确)。加回归断言锁住验证链接 host。
