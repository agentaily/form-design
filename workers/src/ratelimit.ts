// ratelimit.ts — type contracts for 公开端点限流 / 防刷（KV 固定窗口计数）.
// See SPEC.md §25 (后端 · 公开端点限流 / 防刷) + features/rate-limit.feature.
//
// 为什么只限公开端点（§25.1，对照 §11）：owner-only 端点各烧自己额度（§11，POST /api/chat
// 烧 owner 自己的 DeepSeek），被刷也只刷到 owner 本人 → 不限。真正要限的是**被匿名访客调用、
// 却消耗共享 / 别人资源**的公开端点：
//   - POST /api/submit                      → 写 owner 飞书表，烧 owner 飞书写额度（§15）。
//   - POST /api/auth/register               → 发验证邮件走共享 Resend 免费档 100/天（§22 / §23）。
//   - POST /api/auth/password-reset/request → 发 reset 邮件走同一把共享 Resend key（§24）。
//   - POST /api/auth/login                  → 密码爆破面（叠加 §17.3 的防枚举 + 等耗时）。
//
// 算法（§25.2，固定窗口 fixed-window）：把 now 按 windowSeconds 向下取整成窗口起点，同窗口内
// 所有请求落同一计数键；读 KV 计数 → ≥ limit 即拒、否则 +1 放行；KV 值 TTL = 窗口长度，到期
// 自动清（无需手动 GC）。选固定窗口是因为 KV 操作最少（每窗口每键一读一写）+ 天然契合 TTL；
// 代价是窗口边界可能短暂放过最多 2 倍配额，对「尽力防滥用」可接受。
//
// 隐私（§25.3）：计数键 = hash(ip) + bucket + windowStart，**绝不**把原始 IP 明文写进 KV
// 键 / 值；取 IP 用 CF-Connecting-IP（平台填充、不可伪造），缺失归一到常量兜底桶（仍限）。
//
// fail-open（§25.7，关键铁律）：限流是「尽力防滥用」不是「强一致门禁」——KV 读 / 写抛错一律
// **放行**（allowed:true），只记 err.name，绝不因限流器自身故障把正常请求打挂成 429 / 5xx。
//
// 挂载（§25.5）：rateLimit({ limit, windowSeconds, bucket }) 返回 Hono 中间件，**逐条**挂在
// §25.4 表里要限的那几条公开端点上（method + path 级），排在 §19 的 cors() **之后**——绝不
// 宽匹配 /api/*（会误伤 owner-only 与 /health），绝不在 OPTIONS 预检上触发（cors() 已短路应答）。
//
// Layering（测试 seam）：
//   - 纯 / 可 mock 原语（inner-loop 单测目标，给定 KV double + 固定 now 即可驱动窗口数学）：
//       windowStartFor   —— 纯函数：now + windowSeconds → 窗口起点（无副作用）。
//       rateLimitKeyFor  —— 纯函数：hash(ip) + bucket + windowStart + windowSeconds → KV 键（不含原始 IP）。
//       checkRateLimit   —— 在 KV 之上做「读计数 → 判 → 自增」+ fail-open 的固定窗口原语。
//   - Hono 中间件（outer-loop seam，SELF.fetch 经挂了限流的公开端点驱动）：
//       rateLimit        —— 中间件工厂：取 IP → checkRateLimit → 超限 429 + Retry-After / 放行。

import type { MiddlewareHandler } from "hono";

// ---------------------------------------------------------------------------
// 端点类别（bucket）
// ---------------------------------------------------------------------------

/**
 * 限流端点类别（§25.3）。挂载方按端点传入，让不同端点的计数互不串桶——刷 register 不该
 * 消耗 login 的配额。同端点的多窗口（submit 的分钟 + 小时）共用同一 bucket、靠 windowSeconds
 * 区分——**键里必须含 windowSeconds**：分钟桶与小时桶的 windowStart 在整点边界会撞成同一个
 * （`floor(now/60)*60 == floor(now/3600)*3600`），只有 windowSeconds 把它们分开（§25.3）。
 */
export type RateLimitBucket = "submit" | "register" | "pwreset" | "login";

// ---------------------------------------------------------------------------
// 默认限额常量（§25.4，写进契约、可在合约内调；语义不变）
// ---------------------------------------------------------------------------

/**
 * 一条固定窗口规则（§25.4）：在 `windowSeconds` 长的窗口内，单 IP 单 `bucket` 最多 `limit` 次。
 * 一个端点可挂多条规则（如 submit 的分钟 + 小时），命中**任一**即拒（§25.2 多窗口语义）。
 */
export interface RateLimitRule {
  /** 端点类别（分桶键的一部分，§25.3）。 */
  bucket: RateLimitBucket;
  /** 窗口内允许的最大请求数（达到即拒；第 limit+1 次起 429）。 */
  limit: number;
  /** 固定窗口长度（秒）；同时用作 KV 值的 TTL（§25.2）。 */
  windowSeconds: number;
}

/** 一分钟 / 一小时的秒数常量（仅为下面限额表可读，避免魔法数字）。 */
export const ONE_MINUTE_SECONDS = 60;
export const ONE_HOUR_SECONDS = 60 * 60;

/**
 * POST /api/submit 的限额（§25.4）：per-IP `10/分钟` **且** `100/小时`，双窗口叠加、命中任一即拒。
 * 答题者正常一两次提交；分钟窗挡爆刷、小时窗挡慢速长刷，护 owner 飞书写额度（§15）。
 */
export const SUBMIT_RATE_LIMITS: readonly RateLimitRule[] = [
  { bucket: "submit", limit: 10, windowSeconds: ONE_MINUTE_SECONDS },
  { bucket: "submit", limit: 100, windowSeconds: ONE_HOUR_SECONDS },
];

/**
 * POST /api/auth/register 的限额（§25.4）：per-IP `5/小时`。护共享 Resend（注册即发验证邮件，
 * §23.2）；正常人一小时不会注册 5 个号。
 */
export const REGISTER_RATE_LIMIT: RateLimitRule = {
  bucket: "register",
  limit: 5,
  windowSeconds: ONE_HOUR_SECONDS,
};

/**
 * POST /api/auth/password-reset/request 的限额（§25.4）：per-IP `4/小时`。护共享 Resend（每次
 * 命中邮箱即发 reset 信，§24.1）。**本期仅 per-IP**——per-email 会引入「该邮箱是否被限 = 是否
 * 注册过」的枚举侧信道（与 §24.1 防枚举冲突），留作后续 feature（§25.4）。
 */
export const PASSWORD_RESET_RATE_LIMIT: RateLimitRule = {
  bucket: "pwreset",
  limit: 4,
  windowSeconds: ONE_HOUR_SECONDS,
};

/**
 * POST /api/auth/login 的限额（§25.4）：per-IP `10/分钟`。防密码爆破，叠加 §17.3 已有的防枚举
 * + 等耗时（authenticateUser 对 user-absent 路径跑等价 decoy hash）。
 */
export const LOGIN_RATE_LIMIT: RateLimitRule = {
  bucket: "login",
  limit: 10,
  windowSeconds: ONE_MINUTE_SECONDS,
};

/**
 * 公开 GET 端点本期**不限**（§25.4）：`GET /api/forms/:slug`（只读、廉价，一次 D1 读，无上游 /
 * 无发信 / 无写）、`GET /api/auth/verify-email/confirm`（token 自证、幂等、廉价）。被刷代价仅
 * Worker CPU + 一次廉价 D1 读，平台层已兜底大流量；本期把限流预算花在烧共享 / 别人资源的 4 个
 * POST 上。若将来要防爬，可给 forms/:slug 加一个很高的桶（如 300/分钟），但**不在本期契约**。
 */

/** IP 缺失（无 CF-Connecting-IP）时归一的常量兜底桶标识（§25.3）。该桶下仍限流（宁可误伤、不开天窗）。 */
export const UNKNOWN_IP_BUCKET = "unknown";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 一次限流判定的结果（§25.2 / §25.6）。`checkRateLimit` 的返回；中间件据此放行或回 429。
 */
export interface RateLimitDecision {
  /** 是否放行。`false` ⇒ 已达上限，中间件回 429 + Retry-After、不进 handler（§25.8）。 */
  allowed: boolean;
  /**
   * 本窗口内的剩余可用次数（放行后视图，≥ 0）。被拒时为 `0`。仅供实现 / 调试参考；
   * **默认不回给客户端**（§25.8：不回显剩余次数，避免给刷子反馈精确卡线）。
   */
  remaining: number;
  /**
   * 到当前窗口重置的剩余秒数（非负整数，§25.2）。被拒时写进 `Retry-After` 头。放行时此值
   * 仍可填（= 窗口剩余秒数），但中间件只在被拒时用它。
   */
  retryAfter: number;
}

/**
 * `checkRateLimit` 的入参（§25.6）。`ip` 由中间件从 `CF-Connecting-IP` 取（缺失传
 * {@link UNKNOWN_IP_BUCKET}）；`bucket` + `limit` + `windowSeconds` 来自挂载该端点的 {@link RateLimitRule}。
 */
export interface RateLimitCheckInput {
  /** 客户端标识：CF-Connecting-IP 真实访客 IP，或缺失时的 {@link UNKNOWN_IP_BUCKET}（§25.3）。 */
  ip: string;
  /** 端点类别（分桶，§25.3）。 */
  bucket: RateLimitBucket;
  /** 窗口内最大请求数（§25.4）。 */
  limit: number;
  /** 固定窗口长度（秒）= KV 值 TTL（§25.2）。 */
  windowSeconds: number;
}

// ---------------------------------------------------------------------------
// 纯逻辑：窗口数学 + 键派生（inner-loop 单测目标；实现留给 implementer）
// ---------------------------------------------------------------------------

/**
 * 把当前时刻向下取整成**固定窗口起点**（§25.2）。同一窗口内所有请求落同一 windowStart →
 * 同一计数键；跨入下一窗口即换新键、计数从 0 起。
 *
 * 契约（实现在合约内）：
 * - `windowStart = floor(now / windowSeconds) * windowSeconds`（`now` 为 Unix 秒）。
 * - 纯函数、无副作用、确定性（同 now 同 windowSeconds 恒得同结果）；不读 KV / 不读时钟（now 由调用方传入，便于测试注入固定时间推进窗口）。
 *
 * @param nowSeconds 当前时刻（Unix 秒）。
 * @param windowSeconds 窗口长度（秒）。
 * @returns 当前窗口起点（Unix 秒，可被 windowSeconds 整除）。
 */
export function windowStartFor(nowSeconds: number, windowSeconds: number): number {
  // floor(now / windowSeconds) * windowSeconds（§25.2）。纯函数、确定性、无副作用。
  return Math.floor(nowSeconds / windowSeconds) * windowSeconds;
}

/**
 * SHA-256(ip) 的十六进制摘要（§25.3）。单向、确定性（同 ip 恒同输出）；仅用于把原始 IP 收敛成
 * 一个**不可回指**的匿名分桶标识，绝不把原始 IP 写进 KV 键。哈希用途仅为分桶去重、不需抗碰撞强度。
 */
async function hashIp(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * 派生一个**不含原始 IP 明文**的 KV 计数键（§25.3）。
 *
 * 契约（实现在合约内）：
 * - 键 = `rl:<bucket>:<hash(ip)>:<windowStart>:<windowSeconds>`（具体分隔 / 前缀由实现定，但全表统一）。
 * - `hash(ip)` 是 IP 的**单向哈希**（如 SHA-256 截断的十六进制串）；**绝不**把原始 IP 明文写进
 *   键（KV 里只留「某匿名标识在某窗口的计数」，隐私最小化，§25.3）。哈希仅为分桶去重、不需抗
 *   碰撞强度，但必须**确定性**（同 ip 同 bucket 同 windowStart 同 windowSeconds 恒得同键）。
 * - 同端点多窗口（submit 分钟 + 小时）用同一 bucket、不同 windowSeconds：**键里必须含 windowSeconds**
 *   把两个窗口分开。**不能只靠 windowStart 区分**——当 now 落在整点后头一分钟内（`now % 3600 < 60`），
 *   `floor(now/60)*60` 与 `floor(now/3600)*3600` 都等于该整点时刻，分钟窗与小时窗的 windowStart 会
 *   撞成同一个值；若键不含 windowSeconds，两窗口就共用同一计数键 → 每次提交被双计 → 分钟限额在第
 *   ~5 次提交就被提前打满、误回 429（线上墙钟落到整点头一分钟时偶发，§25.3 回归点）。
 *
 * @param ip 客户端标识（CF-Connecting-IP，或缺失时的 {@link UNKNOWN_IP_BUCKET}）。
 * @param bucket 端点类别。
 * @param windowStart 窗口起点（来自 {@link windowStartFor}）。
 * @param windowSeconds 固定窗口长度（秒）；编进键以分开同端点的多个窗口（分钟 vs 小时），见上。
 * @returns KV 计数键（不含原始 IP 明文）。
 */
export async function rateLimitKeyFor(
  ip: string,
  bucket: RateLimitBucket,
  windowStart: number,
  windowSeconds: number,
): Promise<string> {
  // hash(ip)（SHA-256 hex，确定性、单向）→ 拼 `rl:<bucket>:<hash>:<windowStart>:<windowSeconds>`（§25.3）。
  // 绝不把原始 IP 明文写进键——KV 里只留「某匿名标识在某窗口的计数」。windowSeconds 在键里，确保
  // 分钟桶与小时桶即便在整点边界（windowStart 相同）也落不同键、互不串计。
  const hash = await hashIp(ip);
  return `rl:${bucket}:${hash}:${windowStart}:${windowSeconds}`;
}

// ---------------------------------------------------------------------------
// 固定窗口原语：读计数 → 判 → 自增（带 fail-open）（实现留给 implementer）
// ---------------------------------------------------------------------------

/**
 * 固定窗口限流原语（§25.2 / §25.6 / §25.7）：算窗口起点 → 派生计数键 → 读 KV 计数 →
 * `≥ limit` 拒、否则 `+1` 放行。
 *
 * 契约（实现在合约内）：
 * - {@link windowStartFor}(now, windowSeconds) → 窗口起点；{@link rateLimitKeyFor} → 键。
 * - 读 KV 当前计数（缺键视为 0）：
 *     · `count >= limit` → `{ allowed:false, remaining:0, retryAfter:窗口剩余秒数 }`（不自增）。
 *     · 否则 → 把计数写成 `count + 1`、设 `expirationTtl = windowSeconds`（到期自动清，§25.2）→
 *       `{ allowed:true, remaining: limit - (count+1), retryAfter:窗口剩余秒数 }`。
 * - **`Retry-After` / retryAfter** = `windowStart + windowSeconds - now`（非负整数，到窗口重置剩余秒，§25.2）。
 * - **fail-open（铁律，§25.7）：** 整个 KV 读 / 写用 `try/catch` 兜住——**任何** KV 异常（不可用 /
 *   超时 / 配额）一律返回 `{ allowed:true, remaining:limit, retryAfter:0 }`（当作未命中、放行）。
 *   异常路径只 `console.error("rate-limit fail-open", err.name)`，**绝不**把 KV 内容 / 原始 IP /
 *   键写进日志或返回值（§25.7）。
 * - 计数自增的并发竞争（两个并发请求同时读到 count、都 +1）在 KV 的最终一致下可能少计一两次——
 *   对「尽力防滥用」可接受，**不**为此引入分布式锁 / Durable Object（保持 KV 简单、低成本）。
 *
 * @param kv RATE_LIMIT KV binding（见 index.ts Env / wrangler.toml；测试由 miniflare 提供本地 KV）。
 * @param input {@link RateLimitCheckInput}（ip + bucket + limit + windowSeconds）。
 * @param nowSeconds 当前时刻（Unix 秒，默认取系统时钟；测试可注入以推进 / 对齐窗口）。
 * @returns {@link RateLimitDecision}（allowed / remaining / retryAfter）。KV 故障时 fail-open 放行。
 */
export async function checkRateLimit(
  kv: KVNamespace,
  input: RateLimitCheckInput,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<RateLimitDecision> {
  const { ip, bucket, limit, windowSeconds } = input;
  try {
    // 窗口对齐 → 计数键 → 到窗口重置的剩余秒数（§25.2）。
    const windowStart = windowStartFor(nowSeconds, windowSeconds);
    const key = await rateLimitKeyFor(ip, bucket, windowStart, windowSeconds);
    const retryAfter = windowStart + windowSeconds - nowSeconds;

    // 读当前计数（缺键 / 非数视为 0）。
    const raw = await kv.get(key);
    const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
    const count = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;

    // ≥ limit → 拒（不自增）：第 limit+1 次起 429（§25.2）。
    if (count >= limit) {
      return { allowed: false, remaining: 0, retryAfter };
    }

    // 否则 +1 写回，TTL=windowSeconds（到期自动清，无需手动 GC，§25.2）。计数自增的并发竞争
    // 在 KV 最终一致下可能少计一两次——对「尽力防滥用」可接受，不引分布式锁 / DO（§25.6）。
    const next = count + 1;
    await kv.put(key, String(next), { expirationTtl: windowSeconds });
    return { allowed: true, remaining: limit - next, retryAfter };
  } catch (err) {
    // fail-open（铁律，§25.7）：任何 KV 异常（不可用 / 超时 / 配额）一律放行，当作未命中。
    // 只记 err.name，**绝不**把 KV 内容 / 原始 IP / 键写进日志或返回值（§25.7）。
    console.error("rate-limit fail-open", err instanceof Error ? err.name : "unknown");
    return { allowed: true, remaining: limit, retryAfter: 0 };
  }
}

// ---------------------------------------------------------------------------
// Hono 中间件工厂（横切，逐条挂在公开端点上，§25.5 / §25.6）（实现留给 implementer）
// ---------------------------------------------------------------------------

/**
 * 限流中间件的环境约束：实现从 `c.env.RATE_LIMIT` 取 KV。用一个最小结构约束（而非 import
 * index.ts 的 Env，避免循环依赖）；index.ts 的 Env 含 `RATE_LIMIT: KVNamespace`，满足之。
 */
export interface RateLimitEnv {
  Bindings: { RATE_LIMIT: KVNamespace };
}

/**
 * 公开端点限流中间件工厂（§25.5 / §25.6）。返回一个 Hono 中间件：
 *
 * - 从 `c.req.header('CF-Connecting-IP')` 取真实访客 IP；缺失 → 归一到 {@link UNKNOWN_IP_BUCKET}
 *   （兜底桶下仍限，§25.3）。
 * - 调 {@link checkRateLimit}(c.env.RATE_LIMIT, { ip, ...rule })：
 *     · `allowed === false` → `c.json({ error }, 429)` + 设 `Retry-After: <decision.retryAfter>`
 *       头，**不**调 `next()`（不进 handler）。`{ error }` 文案中性（不必回显限额 / 剩余，§25.8）。
 *     · 否则 → `await next()`，把控制权交给端点 handler；放行路径除一次 KV 自增外不改任何响应语义（§25.8）。
 * - **超限固定 429**（不是 503，§25.8）；正常请求状态码 / 体 / 其它头与未挂限流时一致（§25.8）。
 * - **fail-open**：KV 故障由 {@link checkRateLimit} 内部兜成 allowed:true → 此中间件照常放行，
 *   端点正常 200 / 201（§25.7）。
 *
 * 挂载（§25.5，关键纪律）：**逐条**挂在 §25.4 要限的公开端点上（method + path 级），与 §17.7
 * requireAuth 同样「点名、绝不宽匹配」；排在 §19 的 cors() **之后**——cors() 先短路应答 OPTIONS
 * 预检（预检不被计数 / 不触发限流），429 响应也因排在 cors 之后天然带上 CORS 头。**绝不**
 * `app.use("/api/*", rateLimit(...))`（会误伤 owner-only、/health、所有 OPTIONS 预检）。
 *
 * submit 的双窗口（§25.4）：挂**两个** rateLimit（同 bucket "submit"、不同 windowSeconds + limit），
 * 任一拒即短路 429；或由实现把多窗口收进一次调用（对外行为一致：命中任一窗口即拒，§25.5）。
 *
 * @param rule 该端点的 {@link RateLimitRule}（bucket + limit + windowSeconds，来自 §25.4 默认常量）。
 * @returns 一个固定窗口限流的 Hono 中间件（KV 故障 fail-open）。
 */
export function rateLimit<E extends RateLimitEnv = RateLimitEnv>(
  rule: RateLimitRule,
): MiddlewareHandler<E> {
  return async (c, next) => {
    // 取真实访客 IP（CF-Connecting-IP，平台填充、不可伪造，§25.3）；缺失 → 常量兜底桶（仍限）。
    const ip = c.req.header("CF-Connecting-IP") ?? UNKNOWN_IP_BUCKET;
    // checkRateLimit 内部带 fail-open：KV 故障 → allowed:true，照常放行（§25.7）。
    const decision = await checkRateLimit(c.env.RATE_LIMIT, {
      ip,
      bucket: rule.bucket,
      limit: rule.limit,
      windowSeconds: rule.windowSeconds,
    });
    if (!decision.allowed) {
      // 超限固定 429（不是 503，§25.8）+ Retry-After（到窗口重置剩余秒）。文案中性、不回显
      // 限额 / 剩余（避免给刷子精确卡线，§25.8）。不调 next() → 不进 handler。429 因本中间件
      // 排在 cors() 之后，天然带上 CORS 头（§25.5）。
      c.header("Retry-After", String(decision.retryAfter));
      return c.json({ error: "请求过于频繁，请稍后再试" }, 429);
    }
    // 放行：除一次 KV 自增外不改任何响应语义，端点状态码 / 体 / 头与未挂限流时一致（§25.8）。
    await next();
  };
}
