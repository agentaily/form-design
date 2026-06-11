import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { applySchema, resetConfig, testEnv, login, authHeader } from "./helpers";

// GET/POST /api/config are now owner-only (SPEC.md §17.1): every request must
// carry a `Authorization: Bearer <jwt>` obtained via login(). The §12 behaviour
// under test is unchanged — auth is just the new front gate, so each helper now
// attaches the token a beforeEach refreshes per scenario.

// Outer-loop acceptance specs for the owner-config feature at the API layer,
// driven through the real Hono app in workerd via SELF.fetch.
// Realizes workers/features/owner-config.feature scenarios:
//   - 保存配置后读回得到掩码视图
//   - 读取时密钥绝不以明文返回
//   - 未配置时读取返回空骨架
//   - 再次保存覆盖已有配置
//   - 缺少必填的 DeepSeek key 被拒绝
// (The encryption round-trip scenario is realized as a pure unit in crypto.test.ts.)
//
// Contract: SPEC.md §12.3.

const BASE = "https://api.local";

// Concrete fixture secrets. Long enough that maskSecret keeps head+tail, so we
// can both (a) assert plaintext never leaks and (b) assert the mask reflects the
// right key.
const DEEPSEEK_KEY = "sk-deepseek-abcdefghijklmnop-1234";
const DEEPSEEK_KEY_2 = "sk-deepseek-ZZZZZZZZZZZZZZZZ-9999";
const FEISHU_SECRET = "feishu-app-secret-qrstuvwxyz-7777";

interface MaskedConfig {
  deepseek: { apiKey: string | null; model: string | null };
  feishu: {
    appId: string | null;
    appSecret: string | null;
    appToken: string | null;
    tableId: string | null;
  };
  updatedAt: string | null;
}

const fullPayload = (apiKey: string = DEEPSEEK_KEY) => ({
  deepseek: { apiKey, model: "deepseek-chat" },
  feishu: {
    appId: "cli_fixtureAppId",
    appSecret: FEISHU_SECRET,
    appToken: "bascnFixtureToken",
    tableId: "tblFixture",
  },
});

// Owner-only (§17.1): attach the session token obtained in beforeEach.
let token: string;

function postConfig(body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/api/config`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify(body),
  });
}

function getConfig(): Promise<Response> {
  return SELF.fetch(`${BASE}/api/config`, { headers: authHeader(token) });
}

/** Assert that no plaintext secret appears anywhere in a raw response body. */
function expectNoPlaintextSecrets(raw: string) {
  expect(raw).not.toContain(DEEPSEEK_KEY);
  expect(raw).not.toContain(DEEPSEEK_KEY_2);
  expect(raw).not.toContain(FEISHU_SECRET);
}

describe("owner config API (workers/features/owner-config.feature)", () => {
  beforeAll(async () => {
    await applySchema();
  });

  beforeEach(async () => {
    await resetConfig();
    // owner-only endpoints need a valid session token (§17). resetConfig wipes
    // owner_config, not the auth secrets (those are env bindings), so login works.
    token = await login();
  });

  it("Scenario: 保存配置后读回得到掩码视图", async () => {
    // Given 一个空的 owner 配置 (resetConfig in beforeEach)
    // When owner 提交含 DeepSeek key 与完整飞书凭据的配置
    const postRes = await postConfig(fullPayload());

    // Then 配置保存成功
    expect(postRes.status).toBe(200);
    const postRaw = await postRes.clone().text();
    const saved = (await postRes.json()) as MaskedConfig;

    // And 读回的 DeepSeek key 是掩码串 (POST echoes the MaskedConfig per §12.3)
    expect(saved.deepseek.apiKey).toBeTypeOf("string");
    expect(saved.deepseek.apiKey).not.toBe(DEEPSEEK_KEY);
    expect(saved.deepseek.apiKey).toContain("…");
    // And 读回的飞书 app secret 是掩码串
    expect(saved.feishu.appSecret).toBeTypeOf("string");
    expect(saved.feishu.appSecret).not.toBe(FEISHU_SECRET);
    expect(saved.feishu.appSecret).toContain("…");
    // The POST echo must also be free of plaintext secrets.
    expectNoPlaintextSecrets(postRaw);

    // Read back via GET and assert the full masked view.
    const getRes = await getConfig();
    expect(getRes.status).toBe(200);
    const getRaw = await getRes.clone().text();
    const view = (await getRes.json()) as MaskedConfig;

    // And 读回的 DeepSeek model 与飞书 app id、app token、table id 为明文回显
    expect(view.deepseek.model).toBe("deepseek-chat");
    expect(view.feishu.appId).toBe("cli_fixtureAppId");
    expect(view.feishu.appToken).toBe("bascnFixtureToken");
    expect(view.feishu.tableId).toBe("tblFixture");
    // Secret fields are masked, never plaintext.
    expect(view.deepseek.apiKey).toContain("…");
    expect(view.feishu.appSecret).toContain("…");
    expectNoPlaintextSecrets(getRaw);

    // And 读回带有更新时间
    expect(view.updatedAt).toBeTypeOf("string");
    expect(Number.isNaN(Date.parse(view.updatedAt as string))).toBe(false);
  });

  it("Scenario: 读取时密钥绝不以明文返回", async () => {
    // Given 一个已保存的 owner 配置
    expect((await postConfig(fullPayload())).status).toBe(200);

    // When owner 读取当前配置
    const getRes = await getConfig();
    expect(getRes.status).toBe(200);
    const raw = await getRes.text();

    // Then 响应里不包含 DeepSeek key 的明文
    expect(raw).not.toContain(DEEPSEEK_KEY);
    // And 响应里不包含飞书 app secret 的明文
    expect(raw).not.toContain(FEISHU_SECRET);

    // Defense in depth: the ciphertext/plaintext must not have leaked into D1's
    // plaintext columns either — the stored secret columns hold cipher, not the key.
    const row = await testEnv.DB.prepare(
      "SELECT deepseek_key_cipher, deepseek_model, feishu_secret_cipher FROM owner_config WHERE owner_id = 'default'",
    ).first<{
      deepseek_key_cipher: string;
      deepseek_model: string;
      feishu_secret_cipher: string;
    }>();
    expect(row).not.toBeNull();
    expect(row?.deepseek_key_cipher).not.toBe(DEEPSEEK_KEY);
    expect(row?.feishu_secret_cipher).not.toBe(FEISHU_SECRET);
    // Non-secret field stays plaintext as designed.
    expect(row?.deepseek_model).toBe("deepseek-chat");
  });

  it("Scenario: 未配置时读取返回空骨架", async () => {
    // Given 一个从未配置过的 owner (resetConfig in beforeEach, no POST)
    // When owner 读取当前配置
    const getRes = await getConfig();

    // And 请求被视为正常态而非错误
    expect(getRes.status).toBe(200);
    const view = (await getRes.json()) as MaskedConfig;

    // Then 返回结构完整但各字段为空的骨架
    expect(view).toEqual({
      deepseek: { apiKey: null, model: null },
      feishu: { appId: null, appSecret: null, appToken: null, tableId: null },
      updatedAt: null,
    });
  });

  it("Scenario: 再次保存覆盖已有配置", async () => {
    // Given 一个已保存的 owner 配置
    const firstRes = await postConfig(fullPayload(DEEPSEEK_KEY));
    expect(firstRes.status).toBe(200);
    const first = (await firstRes.json()) as MaskedConfig;
    const firstMask = first.deepseek.apiKey;
    const firstUpdatedAt = ((await (await getConfig()).json()) as MaskedConfig).updatedAt;
    expect(firstMask).toBeTypeOf("string");

    // When owner 用新的 DeepSeek key 再次保存配置
    const secondRes = await postConfig(fullPayload(DEEPSEEK_KEY_2));
    expect(secondRes.status).toBe(200);
    const second = (await secondRes.json()) as MaskedConfig;

    // Then 读回的掩码反映新的 DeepSeek key
    const view = (await getConfig().then((r) => r.json())) as MaskedConfig;
    expect(view.deepseek.apiKey).toBe(second.deepseek.apiKey);
    expect(view.deepseek.apiKey).not.toBe(firstMask);
    expect(view.deepseek.apiKey).toContain("…");
    // Mask reflects the NEW key deterministically: carries the new key's tail
    // ("9999"), not the old key's ("1234"). Proves the new key was actually
    // persisted — not merely that any re-save changed the stored value.
    expect(view.deepseek.apiKey).toContain("9999");
    expect(view.deepseek.apiKey).not.toContain("1234");
    // Single-row upsert: still exactly one row.
    const count = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM owner_config").first<{
      n: number;
    }>();
    expect(count?.n).toBe(1);

    // And 更新时间被刷新
    expect(view.updatedAt).toBeTypeOf("string");
    expect(Date.parse(view.updatedAt as string)).toBeGreaterThanOrEqual(
      Date.parse(firstUpdatedAt as string),
    );
  });

  it("Scenario: 缺少必填的 DeepSeek key 被拒绝", async () => {
    // Given 一个空的 owner 配置 (beforeEach)
    // When owner 提交缺少 DeepSeek key 的配置
    const res = await postConfig({
      deepseek: { model: "deepseek-chat" },
      feishu: fullPayload().feishu,
    });

    // Then 保存被拒绝并提示 DeepSeek key 为必填
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTypeOf("string");
    expect(body.error?.toLowerCase()).toContain("apikey");

    // And 配置未被写入 (a subsequent GET still returns the empty skeleton)
    const after = (await getConfig().then((r) => r.json())) as MaskedConfig;
    expect(after.deepseek.apiKey).toBeNull();
    expect(after.updatedAt).toBeNull();
    const count = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM owner_config").first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
  });

  it("rejects an empty-string DeepSeek key the same way (boundary of 必填)", async () => {
    const res = await postConfig({ deepseek: { apiKey: "" } });
    expect(res.status).toBe(400);
    const count = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM owner_config").first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
  });

  it("rejects a half-filled feishu block (all-or-nothing, SPEC §12.1)", async () => {
    // valid DeepSeek key, but feishu only has appId → 400, nothing written
    // (must not silently encrypt `undefined` into the secret column).
    const res = await postConfig({
      deepseek: { apiKey: DEEPSEEK_KEY },
      feishu: { appId: "cli_only" },
    });
    expect(res.status).toBe(400);
    const after = (await getConfig().then((r) => r.json())) as MaskedConfig;
    expect(after.deepseek.apiKey).toBeNull();
    const count = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM owner_config").first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
  });
});
