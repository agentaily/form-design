---
"agentaily-forms": minor
---

feat: 邮箱注册验证 + 找回密码,真实发信接入 Resend

- **注册软验证**:注册即 best-effort 发验证邮件(发信失败不挂注册),点链接置 `email_verified=1`,不门禁功能;前端「邮箱未验证 · 重新发送」banner 依 `GET /api/auth/me` 真状态、跨刷新权威。
- **找回密码**:发起永远 200 防邮箱枚举、确认凭一次性 reset token 重置密码;前端 `/reset-password` 落地页。
- **防占座别人邮箱**:注册去重改为「未验证可覆盖 / 已验证锁死」。
- 一次性 token 只存 SHA-256、单次使用、限时(verify 24h / reset 1h),新表 `auth_tokens`(D1 migration 0002)。
- 发信走 Resend 纯 HTTP API(无 SDK),已验证发件域 `mail.agentaily.com`,`RESEND_API_KEY` 走 Worker secret。
