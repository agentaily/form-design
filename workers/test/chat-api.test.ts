import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  applySchema,
  resetConfig,
  testEnv,
  installUpstreamMock,
  DEEPSEEK_BASE_URL,
  login,
  authHeader,
  type UpstreamMock,
} from "./helpers";

// POST /api/chat is now owner-only (SPEC.md §17.1): it consumes the owner's
// DeepSeek quota and is only used in the designer, so it sits behind requireAuth.
// Every request (and the POST /api/config setup) carries `Authorization: Bearer
// <jwt>` from login(); the §13 behaviour under test is unchanged.

// Outer-loop acceptance specs for the LLM proxy `POST /api/chat`, driven through
// the real Hono app in workerd via SELF.fetch, with the upstream DeepSeek call
// mocked locally (never hits api.deepseek.com — see installUpstreamMock).
//
// Realizes every scenario of workers/features/llm-proxy.feature:
//   1. owner 已配 key 时代理用其 key 调上游并流式返回
//   2. tools 被原样透传给上游
//   3. owner 未配 key 时返回 409 且不打上游
//   4. messages 缺失时返回 400 且不打上游
//   5. 上游报错时返回错误且不泄漏 owner key
//   6. model 缺省时上游请求使用默认 DeepSeek-V4-Flash
//   7. 已配 model 时上游请求使用 owner 的 model
//   8. per-request 白名单 model 优先于 owner.model（对话级模型芯片，§13.6 / PR #65）
//   9. 非白名单 model → 400 unsupported model 且不打上游（§13.6 / PR #65）
//
// Contract: SPEC.md §13 / §13.6.

const BASE = "https://api.local";

// Concrete owner DeepSeek key fixture. Distinctive + long enough that, were it to
// ever leak into a response body/header, we'd catch the substring unmistakably.
const OWNER_KEY = "sk-owner-DEEPSEEK-secret-0123456789abcdef";
const OWNER_KEY_2 = "sk-owner-DEEPSEEK-rotated-ZZZZZZZZ99999999";

const FEISHU = {
  appId: "cli_fixtureAppId",
  appSecret: "feishu-app-secret-qrstuvwxyz-7777",
  appToken: "bascnFixtureToken",
  tableId: "tblFixture",
};

// A representative SSE transcript like DeepSeek's OpenAI-compatible stream:
// a couple of chat.completion.chunk events then the [DONE] sentinel.
const UPSTREAM_SSE =
  'data: {"id":"x","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant","content":""}}]}\n\n' +
  'data: {"id":"x","object":"chat.completion.chunk","choices":[{"delta":{"content":"好的"}}]}\n\n' +
  'data: {"id":"x","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  "data: [DONE]\n\n";

const MESSAGES = [{ role: "user", content: "帮我加一个邮箱字段" }];

const TOOLS = [
  {
    type: "function",
    function: {
      name: "add_field",
      description: "add a field to the form",
      parameters: { type: "object", properties: { kind: { type: "string" } } },
    },
  },
];

// Owner-only (§17.1): attach the session token obtained in beforeEach.
let token: string;

/** Configure the owner's DeepSeek (and Feishu) via the real, already-implemented POST /api/config. */
async function configureOwner(opts: { apiKey: string; model?: string }): Promise<void> {
  const deepseek: Record<string, unknown> = { apiKey: opts.apiKey };
  if (opts.model !== undefined) deepseek.model = opts.model;
  const res = await SELF.fetch(`${BASE}/api/config`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify({ deepseek, feishu: FEISHU }),
  });
  if (res.status !== 200) {
    throw new Error(`setup configureOwner failed: ${res.status} ${await res.text()}`);
  }
}

function postChat(body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify(body),
  });
}

describe("LLM proxy POST /api/chat (workers/features/llm-proxy.feature)", () => {
  let upstream: UpstreamMock;

  beforeAll(async () => {
    await applySchema();
  });

  beforeEach(async () => {
    await resetConfig();
    // owner-only endpoint (POST /api/chat + POST /api/config setup) needs a token.
    token = await login();
  });

  afterEach(() => {
    // Always restore the real fetch even if a test installed no mock.
    upstream?.restore();
    upstream = undefined as unknown as UpstreamMock;
  });

  it("Scenario: owner 已配 key 时代理用其 key 调上游并流式返回", async () => {
    // Given 一个已配置 DeepSeek key 的 owner
    await configureOwner({ apiKey: OWNER_KEY });
    upstream = installUpstreamMock({ body: UPSTREAM_SSE });

    // When 前端向 /api/chat 发送一组对话消息
    const res = await postChat({ messages: MESSAGES });

    // Then 代理用该 owner 的 key 作为上游 Authorization 调用 DeepSeek
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0];
    expect(call.url).toBe(`${DEEPSEEK_BASE_URL}/chat/completions`);
    expect(call.method).toBe("POST");
    expect(call.headers.get("authorization")).toBe(`Bearer ${OWNER_KEY}`);

    // And 代理向上游请求时开启流式
    expect(call.body).toMatchObject({ stream: true });
    // And messages 原样透传给上游
    expect((call.body as { messages: unknown }).messages).toEqual(MESSAGES);

    // And 响应以 text/event-stream 流式透传上游内容
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // Upstream SSE bytes透传 unchanged (proxy does not buffer/rewrite the stream).
    expect(await res.text()).toBe(UPSTREAM_SSE);
  });

  it("Scenario: tools 被原样透传给上游", async () => {
    // Given 一个已配置 DeepSeek key 的 owner
    await configureOwner({ apiKey: OWNER_KEY });
    upstream = installUpstreamMock({ body: UPSTREAM_SSE });

    // When 前端向 /api/chat 发送带 tools 的对话消息
    const res = await postChat({ messages: MESSAGES, tools: TOOLS });
    expect(res.status).toBe(200);

    expect(upstream.calls).toHaveLength(1);
    const body = upstream.calls[0].body as { tools: unknown; messages: unknown };
    // Then 上游请求体里包含原样透传的 tools
    expect(body.tools).toEqual(TOOLS);
    // And 上游请求体里包含原样透传的 messages
    expect(body.messages).toEqual(MESSAGES);
  });

  it("Scenario: owner 未配 key 时返回 409 且不打上游", async () => {
    // Given 一个从未配置 DeepSeek key 的 owner (resetConfig in beforeEach, no configure)
    upstream = installUpstreamMock({ body: UPSTREAM_SSE });

    // When 前端向 /api/chat 发送一组对话消息
    const res = await postChat({ messages: MESSAGES });

    // Then 响应状态码为 409 并提示 owner 未配置 DeepSeek
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");
    expect(body.error).toContain("DeepSeek");

    // And 代理没有向上游发起任何请求
    expect(upstream.called()).toBe(false);
  });

  it("Scenario: messages 缺失时返回 400 且不打上游", async () => {
    // Given 一个已配置 DeepSeek key 的 owner
    await configureOwner({ apiKey: OWNER_KEY });
    upstream = installUpstreamMock({ body: UPSTREAM_SSE });

    // When 前端向 /api/chat 发送缺少 messages 的请求
    const res = await postChat({ tools: TOOLS });

    // Then 响应状态码为 400
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");

    // And 代理没有向上游发起任何请求
    expect(upstream.called()).toBe(false);
  });

  it("Scenario: 上游报错时返回错误且不泄漏 owner key", async () => {
    // Given 一个已配置 DeepSeek key 的 owner
    await configureOwner({ apiKey: OWNER_KEY });
    // And 上游 DeepSeek 将以错误状态码响应 (e.g. 401 invalid key — body mentions the upstream error).
    upstream = installUpstreamMock({
      status: 401,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        error: { message: "Authentication Fails", type: "authentication_error" },
      }),
    });

    // When 前端向 /api/chat 发送一组对话消息
    const res = await postChat({ messages: MESSAGES });

    // The upstream was contacted with the owner key (proves the error is upstream's,
    // not the proxy refusing to call).
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0].headers.get("authorization")).toBe(`Bearer ${OWNER_KEY}`);

    // Then 代理返回可辨识的错误响应: a recognizable error status (not a 2xx success
    // stream), as JSON { error } per §13.4. Implementer may passthrough the upstream
    // code or normalize to 502; either way it must be a 4xx/5xx error, not 200.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const raw = await res.clone().text();
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");

    // And 错误响应里不包含 owner 的明文 DeepSeek key — not in the body...
    expect(raw).not.toContain(OWNER_KEY);
    // ...and not echoed back through any response header either (§13.5).
    for (const [, value] of res.headers) {
      expect(value).not.toContain(OWNER_KEY);
    }
  });

  it("Scenario: model 缺省时上游请求使用默认 deepseek-v4-flash", async () => {
    // Given 一个已配置 DeepSeek key 但未指定 model 的 owner
    await configureOwner({ apiKey: OWNER_KEY }); // no model
    upstream = installUpstreamMock({ body: UPSTREAM_SSE });

    // When 前端向 /api/chat 发送一组对话消息（不带 per-request model）
    const res = await postChat({ messages: MESSAGES });
    expect(res.status).toBe(200);

    // Then 上游请求体里的 model 为全局默认 deepseek-v4-flash（小写 wire id，§13.6 兜底）。
    expect(upstream.calls).toHaveLength(1);
    expect((upstream.calls[0].body as { model: string }).model).toBe("deepseek-v4-flash");
  });

  it("Scenario: 已配 model 时上游请求使用 owner 的 model", async () => {
    // Given 一个已配置 DeepSeek key 且保存了（合法小写 id）model 的 owner（无 per-request 时由它兜底）。
    await configureOwner({ apiKey: OWNER_KEY_2, model: "deepseek-v4-pro" });
    upstream = installUpstreamMock({ body: UPSTREAM_SSE });

    // When 前端向 /api/chat 发送一组对话消息（不带 per-request model）
    const res = await postChat({ messages: MESSAGES });
    expect(res.status).toBe(200);

    // Then 上游请求体里的 model 为 owner 配置的 model（§13.6：无 per-request 时取 owner.model）。
    expect(upstream.calls).toHaveLength(1);
    expect((upstream.calls[0].body as { model: string }).model).toBe("deepseek-v4-pro");
    // And the owner's (rotated) key, not a stale one, reached upstream.
    expect(upstream.calls[0].headers.get("authorization")).toBe(`Bearer ${OWNER_KEY_2}`);
  });

  it("Scenario: owner 存了旧驼峰显示名脏配置 → 归一化成小写 id 再发上游（老用户不用重存）", async () => {
    // Given D1 里把 deepseek_model 存成旧驼峰显示名 "DeepSeek-V4-Pro" 的 owner（casing 修复前
    // 存的脏数据）。未归一化直接发上游会 400 —— 这正是本 PR 兜的回归。
    await configureOwner({ apiKey: OWNER_KEY, model: "DeepSeek-V4-Pro" });
    upstream = installUpstreamMock({ body: UPSTREAM_SSE });

    // When 不带 per-request model 发送（回退到 owner 保存的脏 model）
    const res = await postChat({ messages: MESSAGES });
    expect(res.status).toBe(200);

    // Then 上游收到的是归一化后的小写 id，而非驼峰显示名（兜住脏配置，避免 400）。
    expect(upstream.calls).toHaveLength(1);
    expect((upstream.calls[0].body as { model: string }).model).toBe("deepseek-v4-pro");
  });

  it("Scenario: per-request 白名单 model 优先于 owner 的 model (§13.6)", async () => {
    // Given 一个 owner 保存的 model 是 Flash，但本次对话级芯片选了 Pro。
    await configureOwner({ apiKey: OWNER_KEY, model: "deepseek-v4-flash" });
    upstream = installUpstreamMock({ body: UPSTREAM_SSE });

    // When 请求带上白名单内的 per-request model
    const res = await postChat({ messages: MESSAGES, model: "deepseek-v4-pro" });
    expect(res.status).toBe(200);

    // Then 上游用的是 per-request model（优先于 owner.model）。
    expect(upstream.calls).toHaveLength(1);
    expect((upstream.calls[0].body as { model: string }).model).toBe("deepseek-v4-pro");
  });

  it("Scenario: 非白名单 model → 400 unsupported model 且不打上游 (§13.6)", async () => {
    // Given 一个已配置 DeepSeek key 的 owner
    await configureOwner({ apiKey: OWNER_KEY });
    upstream = installUpstreamMock({ body: UPSTREAM_SSE });

    // When 请求带上一个不在白名单内的 model（如 OpenAI 的 gpt-4）
    const res = await postChat({ messages: MESSAGES, model: "gpt-4" });

    // Then 代理拒绝该请求并返回 400 { error: "unsupported model" }
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("unsupported model");

    // And 绝不向上游转发该请求（白名单守在 parse 阶段，§13.6）。
    expect(upstream.called()).toBe(false);
  });
});
