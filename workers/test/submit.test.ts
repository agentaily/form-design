import { describe, it, expect, afterEach } from "vitest";
import { vi } from "vitest";
import {
  parseSubmitRequest,
  answersToFields,
  validateAnswers,
  writeToBitable,
  AnswersValidationError,
  BitableWriteError,
  FEISHU_BITABLE_RECORDS_URL,
  type SubmitAnswer,
} from "../src/submit";
import type { Field } from "../src/forms";
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
  it("accepts a well-formed body with formSlug + text + multi-select answers", () => {
    // §16.5 made formSlug a required, non-empty field on the submit body.
    const body = {
      formSlug: "f8Kq2pXa",
      answers: [
        { label: "姓名", value: "张三" },
        { label: "兴趣", value: ["阅读", "运动"] },
      ],
    };

    const parsed = parseSubmitRequest(body);

    expect(parsed.formSlug).toBe("f8Kq2pXa");
    expect(parsed.answers).toHaveLength(2);
    expect(parsed.answers[0]).toEqual({ label: "姓名", value: "张三" });
    expect(parsed.answers[1]).toEqual({ label: "兴趣", value: ["阅读", "运动"] });
  });

  it("rejects a body missing formSlug (now required, §16.5)", () => {
    expect(() => parseSubmitRequest({ answers: [{ label: "姓名", value: "张三" }] })).toThrow();
  });

  it("rejects an empty formSlug (now required non-empty, §16.5)", () => {
    expect(() =>
      parseSubmitRequest({ formSlug: "", answers: [{ label: "姓名", value: "张三" }] }),
    ).toThrow();
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

describe("validateAnswers (SPEC.md §20.3 必填校验)", () => {
  // 一个必填文本字段 + 一个非必填文本字段。匹配键是 label（§15.3 / §20.3 约定）。
  const FIELDS: Field[] = [
    { id: "f_name", type: "text", label: "姓名", required: true },
    { id: "f_age", type: "number", label: "年龄" },
  ];
  // 一个必填多选字段，用于「空数组视为未填」一支。
  const MULTI_FIELDS: Field[] = [
    { id: "f_hobby", type: "checkbox", label: "兴趣", required: true },
  ];

  it("does not throw when every required field has a non-empty answer", () => {
    expect(() => validateAnswers(FIELDS, [{ label: "姓名", value: "张三" }])).not.toThrow();
  });

  it("does not throw when an OPTIONAL field is omitted (only required is enforced)", () => {
    // 年龄非必填、整条缺失 → 仍通过（只校验 required）。
    expect(() => validateAnswers(FIELDS, [{ label: "姓名", value: "张三" }])).not.toThrow();
  });

  it("throws AnswersValidationError when a required field's answer is missing", () => {
    // answers 里没有「姓名」这条 → 漏填必填 → 抛错。
    expect(() => validateAnswers(FIELDS, [{ label: "年龄", value: "30" }])).toThrow(
      AnswersValidationError,
    );
  });

  it("throws AnswersValidationError when a required field's value is an empty string", () => {
    expect(() => validateAnswers(FIELDS, [{ label: "姓名", value: "" }])).toThrow(
      AnswersValidationError,
    );
  });

  it("treats a whitespace-only value as empty for a required field", () => {
    expect(() => validateAnswers(FIELDS, [{ label: "姓名", value: "   " }])).toThrow(
      AnswersValidationError,
    );
  });

  it("throws AnswersValidationError when a required multi-select value is an empty array", () => {
    expect(() => validateAnswers(MULTI_FIELDS, [{ label: "兴趣", value: [] }])).toThrow(
      AnswersValidationError,
    );
  });

  it("does not throw when a required multi-select has at least one selection", () => {
    expect(() => validateAnswers(MULTI_FIELDS, [{ label: "兴趣", value: ["阅读"] }])).not.toThrow();
  });

  it("does not throw on a form with no required fields even when answers are sparse", () => {
    const noRequired: Field[] = [{ id: "f_age", type: "number", label: "年龄" }];
    expect(() => validateAnswers(noRequired, [{ label: "年龄", value: "30" }])).not.toThrow();
  });

  it("the thrown message names the offending field but carries no owner credential", () => {
    const err = (() => {
      try {
        validateAnswers(FIELDS, [{ label: "年龄", value: "30" }]);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(AnswersValidationError);
    // 非敏感的字段名可入文案（帮答题者修正，§20.4）。
    expect((err as Error).message).toContain("姓名");
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
