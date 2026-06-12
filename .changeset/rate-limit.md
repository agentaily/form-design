---
"agentaily-forms": minor
---

feat(ratelimit): 公开端点限流 / 防刷(KV 固定窗口,超限 429 + Retry-After,fail-open)

给 4 个公开端点加按 IP 的限流,在 BYOK 架构下堵住「匿名访客刷爆共享资源」的口子:

- **`POST /api/submit`**:10/分钟 + 100/小时(护 owner 飞书写额度)。
- **`POST /api/auth/register`**:5/小时;**`POST /api/auth/password-reset/request`**:4/小时(护那把**共享 Resend key**——被刷一波打满免费档,全员收不到验证/重置信)。
- **`POST /api/auth/login`**:10/分钟(防密码爆破)。

实现:Cloudflare **KV 固定窗口**计数,键 `rl:<bucket>:<SHA256(ip)>:<windowStart>`(**只存 IP 的哈希,不存原始 IP**),超限回 `429 { error }` + `Retry-After`,**KV 故障 fail-open**(限流器自身故障不拖垮正常请求)。挂在 `cors()` 之后、绝不碰 owner-only / `/health` / OPTIONS 预检;`/api/chat` 烧 owner 自己 DeepSeek 额度,不限。SPEC §25 + `features/rate-limit.feature`。
