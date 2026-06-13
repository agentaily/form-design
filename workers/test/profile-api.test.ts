import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  applySchema,
  resetConfig,
  resetForms,
  resetUsers,
  resetAuthTokens,
  testEnv,
  registerOwner,
  authHeader,
} from "./helpers";

// Outer-loop acceptance specs for owner 个人资料 (显示名 display_name), driven through
// the real Hono app in workerd via SELF.fetch. Realizes the §17 owner-profile contract:
//
//   GET /api/auth/me (扩展)
//     - 新账号 displayName 默认 null（未设置 → 回退用邮箱）
//   PUT /api/auth/profile (新增, owner-only)
//     - 设置显示名 → 200 { email, emailVerified, displayName }，并持久化（再 GET /me 可见）
//     - 显示名首尾空白被 trim 后存储
//     - 空 / 纯空白 → 存 NULL（清空，回退邮箱）
//     - 超长（> MAX_DISPLAY_NAME_LENGTH=64）→ 400，不改原值
//     - body 缺 displayName / 非 string → 400
//     - 无 token / 坏 token → 401（guard），且不泄漏敏感字段
//     - 隔离：owner A 改自己的显示名不影响 owner B
//
// 安全约定：返回体只投影 { email, emailVerified, displayName }，绝不出 password_hash /
// password_salt / iterations（与 GET /api/auth/me 同形，§17.12）。
//
// Contract: SPEC.md §17 (owner 个人资料 · 显示名).

const BASE = "https://api.local";

// The fixed test signing secret injected as a miniflare binding (vitest.config.ts).
// It must NEVER appear in any profile response, so we scan.
const AUTH_SECRET = testEnv.AUTH_SECRET;

/** GET /api/auth/me with an optional Authorization header. */
function getMe(headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${BASE}/api/auth/me`, { headers });
}

/** PUT /api/auth/profile with a JSON body + optional Authorization header. */
function putProfile(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${BASE}/api/auth/profile`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** Read display_name straight out of D1 for an owner id (null = unset). */
async function displayNameForId(id: string): Promise<string | null> {
  const row = await testEnv.DB.prepare("SELECT display_name FROM users WHERE id = ?")
    .bind(id)
    .first<{ display_name: string | null }>();
  return row?.display_name ?? null;
}

describe("owner profile / display name (SPEC.md §17 个人资料)", () => {
  beforeAll(async () => {
    await applySchema();
  });

  beforeEach(async () => {
    await resetConfig();
    await resetForms();
    await resetUsers();
    await resetAuthTokens();
  });

  // --- GET /api/auth/me (扩展) -----------------------------------------------

  it("Scenario: 新注册的 owner 默认没有显示名（GET /me 返回 displayName: null）", async () => {
    // Given 一个刚注册的 owner（未设置过显示名）
    const { token, email } = await registerOwner();

    // When 该 owner 拉取自己的身份摘要
    const res = await getMe(authHeader(token));

    // Then 200，displayName 为 null（未设置 → 前端回退用邮箱）
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      email?: string;
      emailVerified?: number;
      displayName?: string | null;
    };
    expect(body.email).toBe(email);
    expect(body.emailVerified).toBe(0);
    expect(body.displayName).toBeNull();
  });

  // --- PUT /api/auth/profile (新增) ------------------------------------------

  it("Scenario: owner 设置显示名并持久化（PUT → 200，再 GET /me 可见）", async () => {
    // Given 一个已登录的 owner
    const { token, email } = await registerOwner();

    // When 该 owner 把显示名设为「陈伟」
    const res = await putProfile({ displayName: "陈伟" }, authHeader(token));

    // Then 200，返回 owner 摘要（与 /me 同形，含新显示名）
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      email?: string;
      emailVerified?: number;
      displayName?: string | null;
    };
    expect(body.email).toBe(email);
    expect(body.emailVerified).toBe(0);
    expect(body.displayName).toBe("陈伟");

    // And 已持久化 — 随后 GET /api/auth/me 也返回新显示名
    const meRes = await getMe(authHeader(token));
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { displayName?: string | null };
    expect(me.displayName).toBe("陈伟");
  });

  it("Scenario: 显示名首尾空白被 trim 后存储", async () => {
    const { token } = await registerOwner();

    // When 提交带首尾空白的显示名
    const res = await putProfile({ displayName: "  陈伟  " }, authHeader(token));

    // Then 200，存的是 trim 后的「陈伟」
    expect(res.status).toBe(200);
    const body = (await res.json()) as { displayName?: string | null };
    expect(body.displayName).toBe("陈伟");

    const me = (await (await getMe(authHeader(token))).json()) as { displayName?: string | null };
    expect(me.displayName).toBe("陈伟");
  });

  it("Scenario: 提交空 / 纯空白显示名 → 清空为 null（回退用邮箱）", async () => {
    const { token } = await registerOwner();
    // 先设一个非空显示名
    expect((await putProfile({ displayName: "陈伟" }, authHeader(token))).status).toBe(200);

    // When 提交空字符串
    const emptyRes = await putProfile({ displayName: "" }, authHeader(token));
    // Then 200，displayName 清空为 null
    expect(emptyRes.status).toBe(200);
    expect(((await emptyRes.json()) as { displayName?: string | null }).displayName).toBeNull();
    expect(
      ((await (await getMe(authHeader(token))).json()) as { displayName?: string | null })
        .displayName,
    ).toBeNull();

    // 纯空白同样清空为 null
    expect((await putProfile({ displayName: "陈伟" }, authHeader(token))).status).toBe(200);
    const blankRes = await putProfile({ displayName: "   " }, authHeader(token));
    expect(blankRes.status).toBe(200);
    expect(((await blankRes.json()) as { displayName?: string | null }).displayName).toBeNull();
  });

  it("Scenario: 超长显示名（> 64 字符）→ 400，且不改原值", async () => {
    const { token } = await registerOwner();
    // Given 已有一个有效显示名
    expect((await putProfile({ displayName: "陈伟" }, authHeader(token))).status).toBe(200);

    // When 提交一个 65 字符的超长显示名
    const tooLong = "a".repeat(65);
    const res = await putProfile({ displayName: tooLong }, authHeader(token));

    // Then 400 带 error，且原显示名未被改动
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; displayName?: string | null };
    expect(body.error).toBeTypeOf("string");
    // 再 GET /me 仍是旧值（不落库）
    const me = (await (await getMe(authHeader(token))).json()) as { displayName?: string | null };
    expect(me.displayName).toBe("陈伟");
  });

  it("Scenario: 正好 64 字符的显示名被接受", async () => {
    const { token } = await registerOwner();
    const exact = "a".repeat(64);
    const res = await putProfile({ displayName: exact }, authHeader(token));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { displayName?: string | null }).displayName).toBe(exact);
  });

  it("Scenario: body 缺 displayName 或非 string → 400", async () => {
    const { token } = await registerOwner();

    // 缺字段
    const missing = await putProfile({}, authHeader(token));
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error?: string }).error).toBeTypeOf("string");

    // 非 string（number）
    const notString = await putProfile({ displayName: 123 }, authHeader(token));
    expect(notString.status).toBe(400);
    expect(((await notString.json()) as { error?: string }).error).toBeTypeOf("string");

    // null displayName 也算非 string → 400
    const nullVal = await putProfile({ displayName: null }, authHeader(token));
    expect(nullVal.status).toBe(400);

    // 整个 body 非 JSON → 400（不落库）
    const badJson = await SELF.fetch(`${BASE}/api/auth/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...authHeader(token) },
      body: "not-json{",
    });
    expect(badJson.status).toBe(400);
  });

  // --- owner-only 门 ---------------------------------------------------------

  it("Scenario: 不带 token / 坏 token 访问 PUT /api/auth/profile → 401（guard），不泄漏敏感字段", async () => {
    // 不带 token
    const noToken = await putProfile({ displayName: "黑客" });
    expect(noToken.status).toBe(401);
    const noTokenRaw = await noToken.clone().text();
    expect(((await noToken.json()) as { error?: string }).error).toBeTypeOf("string");
    expect(noTokenRaw).not.toContain(AUTH_SECRET);

    // 坏 token
    const badToken = await putProfile({ displayName: "黑客" }, authHeader("not.a.valid-jwt"));
    expect(badToken.status).toBe(401);
    const badRaw = await badToken.clone().text();
    expect(badRaw).not.toContain(AUTH_SECRET);
  });

  // --- 隔离 ------------------------------------------------------------------

  it("Scenario: owner A 改自己的显示名不影响 owner B", async () => {
    // Given 两个独立的 owner
    const a = await registerOwner();
    const b = await registerOwner();
    const aId = await (async () => {
      const row = await testEnv.DB.prepare("SELECT id FROM users WHERE email = ?")
        .bind(a.email)
        .first<{ id: string }>();
      return row!.id;
    })();
    const bId = await (async () => {
      const row = await testEnv.DB.prepare("SELECT id FROM users WHERE email = ?")
        .bind(b.email)
        .first<{ id: string }>();
      return row!.id;
    })();

    // When A 设自己的显示名
    expect((await putProfile({ displayName: "甲" }, authHeader(a.token))).status).toBe(200);

    // Then 只有 A 的行被改；B 仍是 null
    expect(await displayNameForId(aId)).toBe("甲");
    expect(await displayNameForId(bId)).toBeNull();

    // And 各自的 /me 只看到自己的值
    const aMe = (await (await getMe(authHeader(a.token))).json()) as {
      displayName?: string | null;
    };
    const bMe = (await (await getMe(authHeader(b.token))).json()) as {
      displayName?: string | null;
    };
    expect(aMe.displayName).toBe("甲");
    expect(bMe.displayName).toBeNull();
  });

  it("Scenario: PUT /api/auth/profile 响应里不泄漏签名密钥", async () => {
    const { token } = await registerOwner();
    const res = await putProfile({ displayName: "扫描标记" }, authHeader(token));
    expect(res.status).toBe(200);
    const raw = await res.clone().text();
    expect(raw).not.toContain(AUTH_SECRET);
    for (const [, value] of res.headers) {
      expect(value).not.toContain(AUTH_SECRET);
    }
  });
});
