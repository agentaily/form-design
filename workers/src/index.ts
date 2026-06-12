import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { importConfigKey } from "./crypto";
import {
  ConfigValidationError,
  getMaskedConfig,
  getOwnerConfig,
  saveConfig,
  type OwnerConfigInput,
} from "./config";
import {
  DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  DeepSeekNotConfiguredError,
  parseChatRequest,
  type ChatRequest,
} from "./chat";
import { testDeepSeek, testFeishu, type ConnProbe, type ConnTestResult } from "./conntest";
import { getFeishuTenantToken, FeishuTokenError } from "./feishu";
import {
  answersToFields,
  parseSubmitRequest,
  validateAnswers,
  writeToBitable,
  BitableWriteError,
  FeishuNotConfiguredError,
  FormNotPublishedError,
  AnswersValidationError,
  type SubmitRequest,
} from "./submit";
import {
  parsePublishInput,
  parseUpdateInput,
  saveForm,
  getPublicForm,
  formExists,
  getFormStatus,
  getFormFields,
  getFormOwner,
  listForms,
  updateForm,
  deleteForm,
  FormValidationError,
  type PublishFormInput,
  type UpdateFormInput,
} from "./forms";
import {
  signSession,
  requireAuth,
  type AuthVariables,
  type LoginRequest,
  type RegisterRequest,
} from "./auth";
import { createUser, authenticateUser, EmailTakenError, UserValidationError } from "./users";
import { listSubmissions, BitableReadError } from "./submissions";

/** Worker bindings (see wrangler.toml + vitest.config.ts). */
interface Env {
  /** D1 binding for the owner_config / forms / users tables. */
  DB: D1Database;
  /** base64 256-bit AES-GCM master key (Worker secret in prod). */
  CONFIG_KEY: string;
  /** session JWT 的 HMAC 签名密钥（注册/登录签发、中间件验签，§17.5/§17.6）。Worker secret in prod. */
  AUTH_SECRET: string;
  /**
   * 已废弃（§17.8）：多用户改造后登录改为查 users 表 + 密码哈希校验，本绑定**不再用于鉴权**。
   * 保留为可选字段仅为兼容线上尚未 `wrangler secret delete` 的环境与测试注入；新代码不读它。
   */
  OWNER_PASSWORD?: string;
}

// Agentaily Forms backend. Routes get added per feature (owner config, LLM
// proxy, Feishu submit, owner auth, data backend, form management). See SPEC.md §12–§21.
const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// --- CORS (§19) ------------------------------------------------------------
//
// 允许的前端来源白名单（§19.2，单一真相）：生产 CF Pages + 本地 Vite dev。命中列表才回显
// Access-Control-Allow-Origin；不退化成 `*`，不开 credentials（token 走 Authorization 头、
// 非 cookie，§19.5）。如需从 env 读额外 origin（PR 预览域名）可在合约内扩展，但默认须含这两个。
const ALLOWED_ORIGINS = [
  "https://form-design.agentaily.com", // 生产前端（CF Pages）
  "http://localhost:5173", // 本地 dev（Vite 默认端口）
] as const;

// CORS 横切中间件挂在所有 /api/* 之上，且必须在 owner-only guard 之前生效（§19.1）——
// 浏览器 OPTIONS 预检不带 Authorization，若先被 guard 拦成 401 预检就失败、真实请求发不出来。
// hono/cors 自身会短路应答 OPTIONS（带 Access-Control-* 头的 2xx），不透到业务 handler（§19.4）。
app.use(
  "/api/*",
  cors({
    origin: [...ALLOWED_ORIGINS],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"], // §19.3（含 §21 CRUD 方法）
    allowHeaders: ["Authorization", "Content-Type"], // §19.3
    maxAge: 86400, // 预检缓存一天，减少预检次数（§19.3，值可调）
  }),
);

app.get("/health", (c) => c.json({ ok: true, service: "form-design-api" }));

// --- owner auth (§17) ------------------------------------------------------
//
// Cross-cutting: owner-only endpoints sit behind requireAuth, mounted at the
// method+path level so the shared /api/forms prefix never drags the PUBLIC
// `GET /api/forms/:slug` (or POST /api/submit, GET /health, the login route
// itself) behind the gate (§17.5 关键陷阱). Each guard below targets the exact
// owner-only route — never a broad `/api/forms/*`. The guard reads AUTH_SECRET
// from c.env at request time (bindings aren't available at module init).
const guard: MiddlewareHandler<{ Bindings: Env; Variables: AuthVariables }> = (c, next) =>
  requireAuth<{ Bindings: Env; Variables: AuthVariables }>(c.env.AUTH_SECRET)(c, next);

// /api/config covers both GET (read masked) + POST (save) — method-agnostic.
app.use("/api/config", guard);
app.post("/api/config/test", guard);
app.post("/api/chat", guard);
// /api/forms 前缀下鉴权与公开交错（§21.1 路由共存陷阱）——逐条点名 owner-only 的
// method+path，绝不用宽匹配 `app.use("/api/forms/*", guard)`（会误伤公开拉取）：
//   - GET  /api/forms              → owner-only 列表（§21.2）。注意它与 GET /api/forms/:slug
//     是两条不同路由（无 :slug 段 vs 有），guard 只挂前者；Hono 用精确路径区分二者。
//   - POST /api/forms              → owner-only 发布（§16）。
//   - PATCH/DELETE /api/forms/:slug → owner-only 编辑 / 删除（§21.3 / §21.4）。
//   - GET  /api/forms/:slug/submissions → owner-only 提交列表（§18）。
//   - GET  /api/forms/:slug        → PUBLIC 公开拉取（§16），**不挂 guard**，必须不受影响（§17.5）。
app.get("/api/forms", guard);
app.post("/api/forms", guard);
app.patch("/api/forms/:slug", guard);
app.delete("/api/forms/:slug", guard);
app.get("/api/forms/:slug/submissions", guard);

// POST /api/auth/register (public) — open registration (§17.2). body { email,
// password } → createUser (email-shape + ≥8 password validation; UNIQUE email is
// the final de-dup arbiter) → 注册即登录: sign a session JWT whose `sub` is the
// NEW user's real id. Taken email → 409; bad email / weak password / non-JSON →
// 400 (nothing persisted). Server misconfig (AUTH_SECRET unset) → 500. The
// plaintext password / signing secret never appear in the response (§17.2 / §17.6).
app.post("/api/auth/register", async (c) => {
  // Server misconfiguration is a deploy error, NOT a client error — never collapse
  // it into a 400/409 that misleads the caller.
  if (!c.env.AUTH_SECRET) {
    return c.json({ error: "服务端未配置鉴权" }, 500);
  }

  // A non-JSON body is a malformed request → 400, nothing created.
  let body: RegisterRequest;
  try {
    body = (await c.req.json()) as RegisterRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const email = (body as { email?: unknown })?.email;
  const password = (body as { password?: unknown })?.password;

  // createUser validates shape/strength and de-dups on the UNIQUE email constraint:
  //   - UserValidationError (bad email / weak password / missing) → 400, not stored.
  //   - EmailTakenError (UNIQUE collision) → 409, no user created, no token issued.
  let user: { id: string };
  try {
    user = await createUser(
      c.env.DB,
      typeof email === "string" ? email : "",
      typeof password === "string" ? password : "",
    );
  } catch (err) {
    if (err instanceof UserValidationError) {
      return c.json({ error: err.message }, 400);
    }
    if (err instanceof EmailTakenError) {
      return c.json({ error: err.message }, 409);
    }
    throw err;
  }

  // 注册即登录 (§17.2): the token's sub is the new user's real id — also the data
  // isolation key for every owner-only endpoint (§17.9). 201 Created.
  const token = await signSession(c.env.AUTH_SECRET, { sub: user.id });
  return c.json({ token }, 201);
});

// POST /api/auth/login (public) — verify email + password against the users table
// (§17.3) and issue a short-lived session JWT whose `sub` is the user's real id.
// Wrong email / wrong password / missing field / non-JSON body → a UNIFIED 401
// (no signal distinguishing 邮箱不存在 vs 密码错, anti-enumeration baked into
// authenticateUser). Server misconfig (AUTH_SECRET unset) → 500. The plaintext
// password / signing secret never appear in the response (§17.3 / §17.6).
app.post("/api/auth/login", async (c) => {
  // Server misconfiguration is a deploy error, NOT an auth failure — it must not
  // collapse into a 401 that would let everyone in or lock everyone out (§17.3).
  if (!c.env.AUTH_SECRET) {
    return c.json({ error: "服务端未配置鉴权" }, 500);
  }

  // A non-JSON / missing-field body is treated as an auth failure → unified 401,
  // nothing else leaked (§17.3).
  let body: LoginRequest;
  try {
    body = (await c.req.json()) as LoginRequest;
  } catch {
    return c.json({ error: "未授权" }, 401);
  }
  const email = (body as { email?: unknown })?.email;
  const password = (body as { password?: unknown })?.password;

  // authenticateUser converges every failure (no such email / wrong password) to
  // null — AND runs an equal-cost decoy hash on the user-absent path so latency
  // can't enumerate registered emails (§17.3).
  const authed = await authenticateUser(
    c.env.DB,
    typeof email === "string" ? email : "",
    typeof password === "string" ? password : "",
  );
  if (authed === null) {
    return c.json({ error: "未授权" }, 401);
  }

  // Credentials verified → sign a session token with the user's real id as sub.
  const token = await signSession(c.env.AUTH_SECRET, { sub: authed.id });
  return c.json({ token }, 200);
});

// POST /api/config — validate + persist the owner config, echo the masked view.
app.post("/api/config", async (c) => {
  let input: OwnerConfigInput;
  try {
    input = (await c.req.json()) as OwnerConfigInput;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof input !== "object" || input === null) {
    return c.json({ error: "body must be a JSON object" }, 400);
  }
  // owner-only: scope every read/write to the logged-in owner's real user id (§17.9).
  const ownerId = c.get("session").sub;
  const key = await importConfigKey(c.env.CONFIG_KEY);
  try {
    await saveConfig(c.env.DB, key, ownerId, input);
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      // Missing / invalid required field → 400, nothing written.
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
  const masked = await getMaskedConfig(c.env.DB, key, ownerId);
  return c.json(masked, 200);
});

// GET /api/config — read THIS owner's masked config (all-null skeleton when never set).
app.get("/api/config", async (c) => {
  const ownerId = c.get("session").sub;
  const key = await importConfigKey(c.env.CONFIG_KEY);
  const masked = await getMaskedConfig(c.env.DB, key, ownerId);
  return c.json(masked, 200);
});

// POST /api/chat — LLM proxy: decrypt owner DeepSeek key, forward to upstream
// /chat/completions with stream:true, and stream the SSE response through
// untouched. The owner key only ever rides the upstream Authorization header —
// it never appears in any response to the client. See SPEC.md §13.
app.post("/api/chat", async (c) => {
  // 1) Parse + validate the request body. Non-JSON / missing messages → 400,
  //    nothing forwarded upstream.
  let request: ChatRequest;
  try {
    const raw = await c.req.json();
    request = parseChatRequest(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid JSON body";
    // A JSON parse failure surfaces as a SyntaxError; map it to the spec's wording.
    const error = err instanceof SyntaxError ? "invalid JSON body" : message;
    return c.json({ error }, 400);
  }

  // 2) Read + decrypt THIS owner's config (plaintext, in-Worker view only, §17.9).
  const ownerId = c.get("session").sub;
  const key = await importConfigKey(c.env.CONFIG_KEY);
  const owner = await getOwnerConfig(c.env.DB, key, ownerId);

  // 3) No DeepSeek configured → 409, never touch upstream.
  try {
    if (owner.deepseek === null) {
      throw new DeepSeekNotConfiguredError();
    }
  } catch (err) {
    if (err instanceof DeepSeekNotConfiguredError) {
      return c.json({ error: err.message }, 409);
    }
    throw err;
  }
  const deepseek = owner.deepseek;

  // 4) Forward to upstream with the owner key, forcing stream:true. `messages` /
  //    `tools` pass through untouched; `model` falls back to the default.
  let upstream: Response;
  try {
    upstream = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deepseek.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: deepseek.model || DEFAULT_DEEPSEEK_MODEL,
        messages: request.messages,
        ...(request.tools !== undefined ? { tools: request.tools } : {}),
        stream: true,
      }),
    });
  } catch {
    // Upstream unreachable (network error / timeout) → 502, no key leakage.
    return c.json({ error: "上游 DeepSeek 不可达" }, 502);
  }

  // 5) Upstream error → recognizable JSON error, normalized to 502 for 5xx and
  //    passing the upstream status through for 4xx. The owner key is never echoed.
  if (!upstream.ok) {
    // upstream.status is a runtime number outside Hono's literal status union,
    // so we annotate it as a ContentfulStatusCode (all our codes carry a body).
    const status = (upstream.status >= 500 ? 502 : upstream.status) as ContentfulStatusCode;
    return c.json({ error: `上游 DeepSeek 返回错误（${upstream.status}）` }, status);
  }

  // 6) Success → stream the upstream SSE bytes through unchanged (no buffering,
  //    no rewriting). Content-Type is forced to text/event-stream.
  return new Response(upstream.body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
});

// POST /api/config/test — probe whether the SAVED owner config can connect.
// Reads + decrypts the stored config (credentials are NOT taken from the request
// body), then probes DeepSeek and Feishu INDEPENDENTLY: an unconfigured block is
// reported as ok:false "未配置" without touching its upstream, and one probe's
// failure never blocks the other. HTTP is always 200 — "can't connect" is a
// normal result, not an HTTP error. The owner key / app_secret never appear in
// any message, header, or body. See SPEC.md §14.
app.post("/api/config/test", async (c) => {
  const ownerId = c.get("session").sub;
  const key = await importConfigKey(c.env.CONFIG_KEY);
  const owner = await getOwnerConfig(c.env.DB, key, ownerId);

  // DeepSeek: unconfigured → "未配置" (no upstream call); otherwise probe.
  const deepseek: ConnProbe =
    owner.deepseek === null
      ? { ok: false, message: "未配置" }
      : await testDeepSeek(owner.deepseek.apiKey);

  // Feishu: independent of DeepSeek's outcome. Unconfigured → "未配置" (no
  // upstream call); otherwise probe with the saved app_id + app_secret.
  const feishu: ConnProbe =
    owner.feishu === null
      ? { ok: false, message: "未配置" }
      : await testFeishu(owner.feishu.appId, owner.feishu.appSecret);

  const result: ConnTestResult = { deepseek, feishu };
  return c.json(result, 200);
});

// POST /api/submit — write one answerer's submission into the owner's Feishu
// Bitable. Reads the owner's SAVED Feishu creds (never from the request body),
// exchanges them for a tenant_access_token, then writes one record. The owner's
// app_secret / tenant_access_token stay in-Worker and never appear in any
// response, header, or log. See SPEC.md §15.
app.post("/api/submit", async (c) => {
  // 1) Parse + validate the request body. Non-JSON / missing / empty / mis-shaped
  //    answers → 400, nothing forwarded upstream.
  let request: SubmitRequest;
  try {
    const raw = await c.req.json();
    request = parseSubmitRequest(raw);
  } catch (err) {
    const error = err instanceof SyntaxError ? "invalid JSON body" : "answers is required";
    return c.json({ error }, 400);
  }

  // 1.5) Associate the submission to a published form (§16.5): the form must
  //      exist BEFORE we read owner config or touch any Feishu upstream. An
  //      unknown slug → 404, nothing forwarded (no token exchange, no record
  //      write) — never write a stranger's slug into the owner's table.
  if (!(await formExists(c.env.DB, request.formSlug))) {
    return c.json({ error: "form not found" }, 404);
  }

  // 1.6) Status gate (§20.2): the form must be 'published' to accept submissions.
  //      'draft' / 'closed' → 409, BEFORE reading owner config / any Feishu upstream.
  //      (getFormStatus + getFormFields MAY be one D1 read; see §20.1.)
  const status = await getFormStatus(c.env.DB, request.formSlug);
  if (status !== "published") {
    return c.json({ error: new FormNotPublishedError().message }, 409);
  }

  // 1.7) answers ↔ schema validation (§20.3): required fields must have non-empty
  //      answers. Failure → 400, nothing forwarded. Reads the form's fields, then
  //      validateAnswers throws AnswersValidationError on a missing/empty required.
  const fieldsDef = await getFormFields(c.env.DB, request.formSlug);
  if (fieldsDef === null) {
    // 与 1.5 一致地兜底：状态门通过后 fields 仍取不到属异常态 → 404。
    return c.json({ error: "form not found" }, 404);
  }
  try {
    validateAnswers(fieldsDef, request.answers);
  } catch (err) {
    if (err instanceof AnswersValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }

  // 2) PUBLIC endpoint — there is no "current owner". Reverse-look up the form's
  //    owning owner_id by slug (§17.9 第 5 条) so the answer lands in THAT owner's
  //    Feishu tenant, not a fixed / arbitrary one. (formExists already passed, so
  //    a null here is an anomaly — treat it as not-found, never touch upstream.)
  const formOwnerId = await getFormOwner(c.env.DB, request.formSlug);
  if (formOwnerId === null) {
    return c.json({ error: "form not found" }, 404);
  }

  // 3) Read + decrypt the FORM-OWNER's config (plaintext, in-Worker view only).
  const key = await importConfigKey(c.env.CONFIG_KEY);
  const owner = await getOwnerConfig(c.env.DB, key, formOwnerId);

  // 4) No Feishu configured → 409, never touch upstream.
  try {
    if (owner.feishu === null) {
      throw new FeishuNotConfiguredError();
    }
  } catch (err) {
    if (err instanceof FeishuNotConfiguredError) {
      return c.json({ error: err.message }, 409);
    }
    throw err;
  }
  const feishu = owner.feishu;

  // 4) Exchange the owner's saved app_id/app_secret for a tenant_access_token.
  //    The plaintext app_secret rides ONLY this request body (§15.7); any failure
  //    surfaces as 502 with no credential in the error.
  let token: string;
  try {
    token = await getFeishuTenantToken(feishu.appId, feishu.appSecret);
  } catch (err) {
    if (err instanceof FeishuTokenError) {
      return c.json({ error: err.message }, 502);
    }
    throw err;
  }

  // 5) Map answers → Feishu fields and write one record. The tenant_access_token
  //    rides ONLY the add-record Authorization header (§15.7); any failure
  //    surfaces as 502 with neither token nor secret in the error.
  const fields = answersToFields(request.answers);
  let recordId: string;
  try {
    ({ recordId } = await writeToBitable(token, feishu.appToken, feishu.tableId, fields));
  } catch (err) {
    if (err instanceof BitableWriteError) {
      return c.json({ error: err.message }, 502);
    }
    throw err;
  }

  // 6) Success → only ok + recordId; never the written fields, token, or creds.
  return c.json({ ok: true, recordId }, 200);
});

// POST /api/forms — 发布表单：校验形状 → 生成 slug + 存 D1 → 201 { slug }。
// 形状非法（缺 meta.title / fields 非数组 / field 形状非法）→ 400，不落库（§16.2、§16.5）。
app.post("/api/forms", async (c) => {
  // 1) Parse + shape-validate the publish body. Non-JSON → 400, nothing written.
  let input: PublishFormInput;
  try {
    const raw = await c.req.json();
    input = parsePublishInput(raw);
  } catch (err) {
    // FormValidationError → the spec's shape-error message; a JSON parse failure
    // (SyntaxError) → "invalid JSON body". Either way nothing is persisted.
    if (err instanceof FormValidationError) {
      return c.json({ error: err.message }, 400);
    }
    const error = err instanceof SyntaxError ? "invalid JSON body" : "invalid request";
    return c.json({ error }, 400);
  }

  // 2) Persist one forms row owned by the logged-in owner (status 'published') → { slug }.
  const ownerId = c.get("session").sub;
  const { slug } = await saveForm(c.env.DB, ownerId, input);
  return c.json({ slug }, 201);
});

// GET /api/forms — owner 列出自己的表单（owner-only，已挂 guard）。返回 { forms, count }，
// 每项 { slug, meta, status, createdAt }（不含 fields 全量；submissionCount 可选）。owner-only
// 列表可回 status / createdAt 这类私有维度，但仍不含任何 owner 凭据（§21.2）。**注意**：这条
// 路由与公开的 GET /api/forms/:slug 是两条不同路由（无 :slug 段 vs 有），guard 只挂这条列表。
app.get("/api/forms", async (c) => {
  // owner-only: list only THIS owner's forms (§17.9 第 6 条) — never leak another owner's.
  const ownerId = c.get("session").sub;
  const forms = await listForms(c.env.DB, ownerId);
  return c.json({ forms, count: forms.length }, 200);
});

// PATCH /api/forms/:slug — 编辑表单（owner-only，已挂 guard，§21.3）。部分更新：至少支持改
// status（published ↔ closed），可选编辑 meta / fields。非法 JSON / 非法 status → 400；slug
// 不存在 → 404；成功 → 200 更新后视图。
app.patch("/api/forms/:slug", async (c) => {
  const slug = c.req.param("slug");
  let input: UpdateFormInput;
  try {
    const raw = await c.req.json();
    input = parseUpdateInput(raw);
  } catch (err) {
    if (err instanceof FormValidationError) {
      return c.json({ error: err.message }, 400);
    }
    const error = err instanceof SyntaxError ? "invalid JSON body" : "invalid request";
    return c.json({ error }, 400);
  }
  // owner-only + 横向越权防护 (§17.9 第 2 条): updateForm filters WHERE owner_id=? —
  // a cross-owner slug updates 0 rows → null → 404 (same code as not-found, no
  // existence leak).
  const ownerId = c.get("session").sub;
  const updated = await updateForm(c.env.DB, slug, ownerId, input);
  if (updated === null) {
    return c.json({ error: "form not found" }, 404);
  }
  return c.json(updated, 200);
});

// DELETE /api/forms/:slug — 硬删表单（owner-only，已挂 guard，§21.4）。删后该 slug 的公开
// 拉取 / submit 都变 404；不联动删 owner 飞书表里已收集的记录。slug 不存在 → 404（严格语义）；
// 成功 → 200 { ok:true, slug }。
app.delete("/api/forms/:slug", async (c) => {
  const slug = c.req.param("slug");
  // owner-only + 横向越权防护 (§17.9 第 3 条): deleteForm filters WHERE owner_id=? —
  // a cross-owner slug deletes 0 rows → false → 404 (same code as not-found).
  const ownerId = c.get("session").sub;
  const deleted = await deleteForm(c.env.DB, slug, ownerId);
  if (!deleted) {
    return c.json({ error: "form not found" }, 404);
  }
  return c.json({ ok: true, slug }, 200);
});

// GET /api/forms/:slug — 公开拉取（无鉴权）：命中 → 200 PublicForm（只含 slug + meta
// + fields）；未命中 → 404 { error }。响应绝不含 owner_id / status / created_at 或任何
// owner 凭据（凭据根本不在 forms 表里，PublicForm 类型也没有承载它们的字段，§16.4）。
app.get("/api/forms/:slug", async (c) => {
  const slug = c.req.param("slug");
  const form = await getPublicForm(c.env.DB, slug);
  if (form === null) {
    return c.json({ error: "form not found" }, 404);
  }
  return c.json(form, 200);
});

// GET /api/forms/:slug/submissions — 数据后台提交列表（owner-only，已挂 requireAuth）。
// 命中流程（§18.1）：form 存在校验（404，不打上游）→ 读 + 解密 owner 配置 → 未配飞书
// (409，不打上游) → 换 tenant_access_token（失败 502）→ GET 多维表格记录列表（失败 502）
// → 200 { submissions, count }。owner 的 app_secret / tenant_access_token 全程留在
// Worker 内，绝不进响应、头或日志；响应也不含 app_token / table_id / owner_id（§18.6）。
app.get("/api/forms/:slug/submissions", async (c) => {
  const slug = c.req.param("slug");
  const ownerId = c.get("session").sub;

  // 1) Ownership gate (§17.9 第 4 条): the form must belong to the LOGGED-IN owner.
  //    Reverse-look up its owner_id; a slug that doesn't exist OR exists but belongs
  //    to a DIFFERENT owner both → the SAME 404, with NO Feishu upstream touched —
  //    a cross-owner 404 must be indistinguishable from a not-found 404 (no
  //    existence leak). 403 / a different body / a different code would leak that
  //    "this slug exists, just not yours".
  const formOwnerId = await getFormOwner(c.env.DB, slug);
  if (formOwnerId !== ownerId) {
    return c.json({ error: "form not found" }, 404);
  }

  // 2) Ownership confirmed → read + decrypt THIS owner's config (the form belongs
  //    to them, so we read their own Feishu creds — never another owner's, §17.9 第 4 条).
  const key = await importConfigKey(c.env.CONFIG_KEY);
  const owner = await getOwnerConfig(c.env.DB, key, ownerId);

  // 3) No Feishu configured → 409, never touch upstream (§18.1 step 4).
  if (owner.feishu === null) {
    return c.json({ error: "owner 未配置飞书" }, 409);
  }
  const feishu = owner.feishu;

  // 4) Exchange the owner's saved app_id/app_secret for a tenant_access_token.
  //    The plaintext app_secret rides ONLY this request body (§18.6); any failure
  //    surfaces as 502 with no credential in the error.
  let token: string;
  try {
    token = await getFeishuTenantToken(feishu.appId, feishu.appSecret);
  } catch (err) {
    if (err instanceof FeishuTokenError) {
      return c.json({ error: err.message }, 502);
    }
    throw err;
  }

  // 5) GET the Bitable record list with the token; map items → submissions. The
  //    tenant_access_token rides ONLY the read Authorization header (§18.6); any
  //    failure surfaces as 502 with neither token nor secret in the error.
  let submissions;
  try {
    submissions = await listSubmissions(token, feishu.appToken, feishu.tableId);
  } catch (err) {
    if (err instanceof BitableReadError) {
      return c.json({ error: err.message }, 502);
    }
    throw err;
  }

  // 6) Success → only the projected submissions + count; never owner creds,
  //    tenant_access_token, app_token / table_id, or owner_id (§18.6).
  return c.json({ submissions, count: submissions.length }, 200);
});

export default app;
