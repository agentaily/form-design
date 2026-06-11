import { describe, it, expect, afterEach } from "vitest";
import { vi } from "vitest";
import {
  parseSubmitRequest,
  answersToFields,
  writeToBitable,
  BitableWriteError,
  FEISHU_BITABLE_RECORDS_URL,
  type SubmitAnswer,
} from "../src/submit";
import { getFeishuTenantToken, FeishuTokenError, FEISHU_TENANT_TOKEN_URL } from "../src/feishu";

// Inner-loop unit specs for the pure / single-upstream-call seams behind
// `POST /api/submit`. These are the building blocks the outer-loop
// submit-api.test.ts composes through the real Hono route; tested here in
// isolation — no D1, no Hono, fetch stubbed directly where an upstream call is
// involved. See SPEC.md §15.2 (parse), §15.3 (map), §15.5 (upstream calls),
// §15.7 (token/secret never leak into a thrown message).

// Distinctive credential fixtures: long + unmistakable so a substring scan of any
// thrown message catches an accidental leak unambiguously (SPEC.md §15.7).
const APP_ID = "cli_unitAppId0001";
const APP_SECRET = "feishu-UNIT-app-secret-zzzzzzzz-9999-SHHH";
const APP_TOKEN = "bascnUnitAppTokenXYZ";
const TABLE_ID = "tblUnit123";
const TENANT_TOKEN = "t-unit-TENANTtoken-abcdef0123456789";

interface CapturedCall {
  url: string;
  method: string;
  headers: Headers;
  bodyText: string;
  body: unknown;
}

/**
 * Stub global fetch to answer exactly one expected URL and record the call. Any
 * other URL throws — a helper that talks to the wrong endpoint fails loudly.
 */
function stubFetch(
  expectUrl: string,
  reply: { status: number; body: string; headers?: Record<string, string> },
): { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    if (req.url !== expectUrl) {
      throw new Error(`unexpected fetch to ${req.url} (expected ${expectUrl})`);
    }
    const bodyText = req.method === "GET" || req.method === "HEAD" ? "" : await req.clone().text();
    let parsed: unknown;
    try {
      parsed = bodyText.length > 0 ? JSON.parse(bodyText) : undefined;
    } catch {
      parsed = undefined;
    }
    calls.push({
      url: req.url,
      method: req.method,
      headers: new Headers(req.headers),
      bodyText,
      body: parsed,
    });
    return new Response(reply.body, {
      status: reply.status,
      headers: reply.headers ?? { "content-type": "application/json" },
    });
  });
  return { calls };
}

describe("parseSubmitRequest (SPEC.md §15.2 request shape)", () => {
  it("accepts a well-formed body with text + multi-select answers", () => {
    const body = {
      answers: [
        { label: "姓名", value: "张三" },
        { label: "兴趣", value: ["阅读", "运动"] },
      ],
    };

    const parsed = parseSubmitRequest(body);

    expect(parsed.answers).toHaveLength(2);
    expect(parsed.answers[0]).toEqual({ label: "姓名", value: "张三" });
    expect(parsed.answers[1]).toEqual({ label: "兴趣", value: ["阅读", "运动"] });
  });

  it("rejects an empty answers array", () => {
    // Empty answers → nothing to write → reject before any upstream call (§15.2).
    expect(() => parseSubmitRequest({ answers: [] })).toThrow();
  });

  it("rejects a body missing answers entirely", () => {
    expect(() => parseSubmitRequest({})).toThrow();
  });

  it("rejects when answers is not an array", () => {
    expect(() => parseSubmitRequest({ answers: "张三" })).toThrow();
  });

  it("rejects a single answer with an empty label", () => {
    expect(() => parseSubmitRequest({ answers: [{ label: "", value: "x" }] })).toThrow();
  });

  it("rejects a single answer whose value is neither string nor string[]", () => {
    // value:number is shape-illegal — only string | string[] allowed (§15.2).
    expect(() => parseSubmitRequest({ answers: [{ label: "年龄", value: 42 }] })).toThrow();
  });
});

describe("answersToFields (SPEC.md §15.3 answers → fields mapping)", () => {
  it("maps text answer as-is and multi-select as the same string[]", () => {
    const answers: SubmitAnswer[] = [
      { label: "姓名", value: "张三" },
      { label: "兴趣", value: ["阅读", "运动"] },
    ];

    const fields = answersToFields(answers);

    // key = label, value = value (string as-is, string[] as-is — no conversion).
    expect(fields).toEqual({ 姓名: "张三", 兴趣: ["阅读", "运动"] });
  });
});

describe("getFeishuTenantToken (SPEC.md §15.5 token exchange)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the tenant_access_token on HTTP 200 + body code:0 and sends creds only in the body", async () => {
    const { calls } = stubFetch(FEISHU_TENANT_TOKEN_URL, {
      status: 200,
      body: JSON.stringify({ code: 0, msg: "ok", tenant_access_token: TENANT_TOKEN, expire: 7200 }),
    });

    const token = await getFeishuTenantToken(APP_ID, APP_SECRET);

    expect(token).toBe(TENANT_TOKEN);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(FEISHU_TENANT_TOKEN_URL);
    // app_id / app_secret ride the JSON body, not the URL or headers.
    expect(calls[0].body).toMatchObject({ app_id: APP_ID, app_secret: APP_SECRET });
  });

  it("throws FeishuTokenError on a non-zero body code without leaking the app secret", async () => {
    // Feishu's quirk: HTTP 200 may still carry a non-zero business code (§15.5).
    stubFetch(FEISHU_TENANT_TOKEN_URL, {
      status: 200,
      body: JSON.stringify({ code: 99991663, msg: "app ticket invalid" }),
    });

    const err = await getFeishuTenantToken(APP_ID, APP_SECRET).then(
      () => {
        throw new Error("expected getFeishuTenantToken to reject");
      },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(FeishuTokenError);
    // The app_secret rode only the outgoing body — never the thrown message (§15.7).
    expect((err as Error).message).not.toContain(APP_SECRET);
  });
});

describe("writeToBitable (SPEC.md §15.5 add-record)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts {fields} to the app_token/table_id endpoint with Bearer token and returns the record_id", async () => {
    const url = FEISHU_BITABLE_RECORDS_URL.replace("{app_token}", APP_TOKEN).replace(
      "{table_id}",
      TABLE_ID,
    );
    const { calls } = stubFetch(url, {
      status: 200,
      body: JSON.stringify({ code: 0, msg: "success", data: { record: { record_id: "rec-xxx" } } }),
    });

    const fields = { 姓名: "张三", 兴趣: ["阅读", "运动"] };
    const result = await writeToBitable(TENANT_TOKEN, APP_TOKEN, TABLE_ID, fields);

    expect(result.recordId).toBe("rec-xxx");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    // URL is filled with the owner's app_token / table_id.
    expect(calls[0].url).toBe(url);
    // tenant_access_token rides only the Authorization header.
    expect(calls[0].headers.get("authorization")).toBe(`Bearer ${TENANT_TOKEN}`);
    // body is { fields } passed through untouched.
    expect(calls[0].body).toMatchObject({ fields });
  });

  it("throws BitableWriteError on a non-zero body code without leaking token or secret", async () => {
    const url = FEISHU_BITABLE_RECORDS_URL.replace("{app_token}", APP_TOKEN).replace(
      "{table_id}",
      TABLE_ID,
    );
    stubFetch(url, {
      status: 200,
      body: JSON.stringify({ code: 1254000, msg: "invalid field" }),
    });

    const err = await writeToBitable(TENANT_TOKEN, APP_TOKEN, TABLE_ID, { 姓名: "张三" }).then(
      () => {
        throw new Error("expected writeToBitable to reject");
      },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(BitableWriteError);
    // Neither the token nor the secret may appear in the thrown message (§15.7).
    expect((err as Error).message).not.toContain(TENANT_TOKEN);
    expect((err as Error).message).not.toContain(APP_SECRET);
  });
});
