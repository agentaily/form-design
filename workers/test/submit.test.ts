import { describe, it, expect, afterEach } from "vitest";
import { vi } from "vitest";
import {
  parseSubmitRequest,
  answersToFields,
  answersToTypedFields,
  validateAnswers,
  writeToBitable,
  ensureBitableFields,
  writeRecordWithFieldEnsure,
  AnswersValidationError,
  BitableWriteError,
  BitableFieldMissingError,
  FEISHU_BITABLE_RECORDS_URL,
  FEISHU_BITABLE_FIELDS_URL,
  FEISHU_CODE_FIELD_NOT_FOUND,
  FEISHU_CODE_FIELD_DUPLICATED,
  type SubmitAnswer,
} from "../src/submit";
import type { Field } from "../src/forms";
import { FEISHU_BITABLE_FIELD_TYPE, type BitableColumnTypes } from "../src/feishu-schema";
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

interface StubReply {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

/**
 * Stub global fetch with a per-URL handler that, per URL, returns a SEQUENCE of
 * replies (one per call, in order) — enough to drive the §15.8 self-heal seams
 * (list-fields GET + create-field POST + a record write that fails then succeeds)
 * without a third-party lib. Records every call; URLs are matched by `origin +
 * pathname` so a `?page_size=...` query still lands on the bare-URL handler. An
 * unconfigured URL throws (talking to the wrong endpoint fails loudly).
 */
function stubFetchByPath(handlers: Record<string, StubReply[]>): { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const counts: Record<string, number> = {};
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const u = new URL(req.url);
    const key = u.origin + u.pathname;
    const seq = handlers[key];
    if (!seq) {
      throw new Error(`unexpected fetch to ${req.url} (no handler for ${key})`);
    }
    const idx = counts[key] ?? 0;
    if (idx >= seq.length) {
      throw new Error(`fetch to ${key} called ${idx + 1} times but only ${seq.length} reply(ies)`);
    }
    counts[key] = idx + 1;
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
    const reply = seq[idx];
    return new Response(reply.body, {
      status: reply.status,
      headers: reply.headers ?? { "content-type": "application/json" },
    });
  });
  return { calls };
}

/** origin + pathname (query/hash stripped) — matches the GET-with-?page_size lister. */
function pathOf(url: string): string {
  const u = new URL(url);
  return u.origin + u.pathname;
}

const RECORDS_URL = FEISHU_BITABLE_RECORDS_URL.replace("{app_token}", APP_TOKEN).replace(
  "{table_id}",
  TABLE_ID,
);
const FIELDS_PATH = pathOf(
  FEISHU_BITABLE_FIELDS_URL.replace("{app_token}", APP_TOKEN).replace("{table_id}", TABLE_ID),
);

function recordOkBody(recordId: string): string {
  return JSON.stringify({ code: 0, msg: "success", data: { record: { record_id: recordId } } });
}
const RECORD_MISSING_BODY = JSON.stringify({
  code: FEISHU_CODE_FIELD_NOT_FOUND,
  msg: "FieldNameNotFound",
});
function fieldsListBody(names: string[]): string {
  return JSON.stringify({
    code: 0,
    msg: "success",
    data: { items: names.map((n) => ({ field_name: n })) },
  });
}
const FIELD_CREATE_OK_BODY = JSON.stringify({ code: 0, msg: "success" });
const FIELD_CREATE_DUP_BODY = JSON.stringify({
  code: FEISHU_CODE_FIELD_DUPLICATED,
  msg: "FieldNameDuplicated",
});

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

  it("throws BitableFieldMissingError (a BitableWriteError) on code 1254045 (列不存在) — the §15.8 self-heal signal", async () => {
    const url = FEISHU_BITABLE_RECORDS_URL.replace("{app_token}", APP_TOKEN).replace(
      "{table_id}",
      TABLE_ID,
    );
    // HTTP 200 carrying the FieldNameNotFound business code; the write made no record.
    stubFetch(url, {
      status: 200,
      body: JSON.stringify({ code: FEISHU_CODE_FIELD_NOT_FOUND, msg: "FieldNameNotFound" }),
    });

    const err = await writeToBitable(TENANT_TOKEN, APP_TOKEN, TABLE_ID, { 姓名: "张三" }).then(
      () => {
        throw new Error("expected writeToBitable to reject");
      },
      (e: unknown) => e,
    );

    // The specialized subclass is the recoverable signal, and still an instanceof the
    // base error so the route's BitableWriteError → 502 branch covers a still-failing retry.
    expect(err).toBeInstanceOf(BitableFieldMissingError);
    expect(err).toBeInstanceOf(BitableWriteError);
    expect((err as Error).message).not.toContain(TENANT_TOKEN);
    expect((err as Error).message).not.toContain(APP_SECRET);
  });
});

describe("ensureBitableFields (SPEC.md §15.8 + §16.8 升级：列出 + 只建缺失列，按字段 type 建对应类型)", () => {
  afterEach(() => vi.unstubAllGlobals());

  // 自愈现在收 Field[]（label↔type），按字段 type 建对应类型列（§16.8 升级），不再一律文本。
  const NAME_FIELD: Field = { id: "f_name", type: "text", label: "姓名" };
  const AGE_FIELD: Field = { id: "f_age", type: "number", label: "年龄" };
  const CITY_FIELD: Field = {
    id: "f_city",
    type: "select",
    label: "城市",
    options: [
      { label: "北京", value: "bj" },
      { label: "上海", value: "sh" },
    ],
  };

  it("lists existing columns with ?page_size and Bearer token, then creates only the missing ones with the mapped type", async () => {
    // 「姓名」已存在、「年龄」缺失 → 只对「年龄」建一次列，按字段 type 建成数字列(2)。
    const { calls } = stubFetchByPath({
      [FIELDS_PATH]: [
        { status: 200, body: fieldsListBody(["姓名"]) },
        { status: 200, body: FIELD_CREATE_OK_BODY },
      ],
    });

    await ensureBitableFields(TENANT_TOKEN, APP_TOKEN, TABLE_ID, [NAME_FIELD, AGE_FIELD]);

    // First call is the GET lister carrying ?page_size and the token only on the header.
    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe("GET");
    expect(new URL(calls[0].url).searchParams.get("page_size")).toBe("100");
    expect(calls[0].headers.get("authorization")).toBe(`Bearer ${TENANT_TOKEN}`);

    // Second call creates the missing column as a NUMBER column (type 2), not text.
    expect(calls[1].method).toBe("POST");
    expect(calls[1].body).toMatchObject({
      field_name: "年龄",
      type: FEISHU_BITABLE_FIELD_TYPE.NUMBER,
    });
    expect(calls[1].headers.get("authorization")).toBe(`Bearer ${TENANT_TOKEN}`);
  });

  it("creates a single/multi-select missing column with its property.options (§16.8)", async () => {
    const { calls } = stubFetchByPath({
      [FIELDS_PATH]: [
        { status: 200, body: fieldsListBody([]) },
        { status: 200, body: FIELD_CREATE_OK_BODY },
      ],
    });

    await ensureBitableFields(TENANT_TOKEN, APP_TOKEN, TABLE_ID, [CITY_FIELD]);

    const create = calls.find((c) => c.method === "POST");
    expect(create?.body).toEqual({
      field_name: "城市",
      type: FEISHU_BITABLE_FIELD_TYPE.SINGLE_SELECT,
      property: { options: [{ name: "北京" }, { name: "上海" }] },
    });
  });

  it("creates one column per missing field (all missing → list once + create twice)", async () => {
    const { calls } = stubFetchByPath({
      [FIELDS_PATH]: [
        { status: 200, body: fieldsListBody([]) },
        { status: 200, body: FIELD_CREATE_OK_BODY },
        { status: 200, body: FIELD_CREATE_OK_BODY },
      ],
    });

    await ensureBitableFields(TENANT_TOKEN, APP_TOKEN, TABLE_ID, [NAME_FIELD, AGE_FIELD]);

    const created = calls
      .filter((c) => c.method === "POST")
      .map((c) => (c.body as { field_name?: string }).field_name);
    expect(created).toEqual(["姓名", "年龄"]);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
  });

  it("treats a create returning 1254014 (FieldNameDuplicated) as idempotent success", async () => {
    // 列出为空 → 尝试建「姓名」→ 上游 1254014（并发别处刚建）→ 视为成功、不抛。
    stubFetchByPath({
      [FIELDS_PATH]: [
        { status: 200, body: fieldsListBody([]) },
        { status: 200, body: FIELD_CREATE_DUP_BODY },
      ],
    });

    await expect(
      ensureBitableFields(TENANT_TOKEN, APP_TOKEN, TABLE_ID, [NAME_FIELD]),
    ).resolves.toBeUndefined();
  });

  it("makes no upstream call when fields is empty", async () => {
    const { calls } = stubFetchByPath({ [FIELDS_PATH]: [] });
    await ensureBitableFields(TENANT_TOKEN, APP_TOKEN, TABLE_ID, []);
    expect(calls).toHaveLength(0);
  });

  it("throws BitableWriteError when listing fields fails, without leaking the token", async () => {
    stubFetchByPath({
      [FIELDS_PATH]: [{ status: 200, body: JSON.stringify({ code: 1254000, msg: "boom" }) }],
    });

    const err = await ensureBitableFields(TENANT_TOKEN, APP_TOKEN, TABLE_ID, [NAME_FIELD]).then(
      () => {
        throw new Error("expected ensureBitableFields to reject");
      },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(BitableWriteError);
    expect((err as Error).message).not.toContain(TENANT_TOKEN);
    expect((err as Error).message).not.toContain(APP_SECRET);
  });

  it("throws BitableWriteError when creating a column fails (非 1254014), without leaking the token", async () => {
    stubFetchByPath({
      [FIELDS_PATH]: [
        { status: 200, body: fieldsListBody([]) },
        { status: 200, body: JSON.stringify({ code: 1254999, msg: "create failed" }) },
      ],
    });

    const err = await ensureBitableFields(TENANT_TOKEN, APP_TOKEN, TABLE_ID, [NAME_FIELD]).then(
      () => {
        throw new Error("expected ensureBitableFields to reject");
      },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(BitableWriteError);
    expect((err as Error).message).not.toContain(TENANT_TOKEN);
    expect((err as Error).message).not.toContain(APP_SECRET);
  });
});

describe("writeRecordWithFieldEnsure (SPEC.md §15.8 + §16.8 升级：写 → 按字段 type 建 → 重试一次)", () => {
  afterEach(() => vi.unstubAllGlobals());

  // 自愈现在收 fieldDefs: Field[]（该 form 字段定义，label↔type），据此把缺列建成对应类型。
  const NAME_FIELD: Field = { id: "f_name", type: "text", label: "姓名" };
  const CITY_FIELD: Field = { id: "f_city", type: "text", label: "城市" };
  const FIELD_DEFS: Field[] = [NAME_FIELD, CITY_FIELD];

  it("returns on the first write with NO field-endpoint traffic when columns already exist (稳态零开销)", async () => {
    // FIELDS_PATH omitted → any list/create THROWS, proving the steady path skips it.
    const { calls } = stubFetchByPath({
      [RECORDS_URL]: [{ status: 200, body: recordOkBody("rec-steady") }],
    });

    const result = await writeRecordWithFieldEnsure(
      TENANT_TOKEN,
      APP_TOKEN,
      TABLE_ID,
      { 姓名: "张三" },
      FIELD_DEFS,
    );

    expect(result.recordId).toBe("rec-steady");
    // Exactly one record write; no fields traffic at all.
    expect(calls.filter((c) => pathOf(c.url) === pathOf(RECORDS_URL))).toHaveLength(1);
    expect(calls.filter((c) => pathOf(c.url) === FIELDS_PATH)).toHaveLength(0);
  });

  it("on 1254045 back-fills the missing columns then retries the write exactly once → success", async () => {
    const { calls } = stubFetchByPath({
      [RECORDS_URL]: [
        { status: 200, body: RECORD_MISSING_BODY },
        { status: 200, body: recordOkBody("rec-healed") },
      ],
      [FIELDS_PATH]: [
        { status: 200, body: fieldsListBody([]) },
        { status: 200, body: FIELD_CREATE_OK_BODY },
        { status: 200, body: FIELD_CREATE_OK_BODY },
      ],
    });

    const result = await writeRecordWithFieldEnsure(
      TENANT_TOKEN,
      APP_TOKEN,
      TABLE_ID,
      { 姓名: "张三", 城市: "北京" },
      FIELD_DEFS,
    );

    expect(result.recordId).toBe("rec-healed");
    // write ×2 (fail-with-missing then retry-success), list ×1, create ×2 (both missing).
    expect(calls.filter((c) => pathOf(c.url) === pathOf(RECORDS_URL))).toHaveLength(2);
    expect(calls.filter((c) => c.method === "GET" && pathOf(c.url) === FIELDS_PATH)).toHaveLength(
      1,
    );
    expect(calls.filter((c) => c.method === "POST" && pathOf(c.url) === FIELDS_PATH)).toHaveLength(
      2,
    );
  });

  it("only back-fills the columns this write needs (fieldDefs whose label is a write key)", async () => {
    // fields 只写「姓名」一格，fieldDefs 含「姓名」+「城市」——自愈只补「姓名」对应的列。
    const { calls } = stubFetchByPath({
      [RECORDS_URL]: [
        { status: 200, body: RECORD_MISSING_BODY },
        { status: 200, body: recordOkBody("rec-healed") },
      ],
      [FIELDS_PATH]: [
        { status: 200, body: fieldsListBody([]) },
        { status: 200, body: FIELD_CREATE_OK_BODY },
      ],
    });

    await writeRecordWithFieldEnsure(
      TENANT_TOKEN,
      APP_TOKEN,
      TABLE_ID,
      { 姓名: "张三" },
      FIELD_DEFS,
    );

    const created = calls
      .filter((c) => c.method === "POST" && pathOf(c.url) === FIELDS_PATH)
      .map((c) => (c.body as { field_name?: string }).field_name);
    // 只补这次写入涉及的「姓名」，不强建未写到的「城市」。
    expect(created).toEqual(["姓名"]);
  });

  it("self-heals a MISSING column nested inside a group, creating it with the child's mapped type (Bug #2)", async () => {
    // fieldDefs 顶层只有一个 group「成绩」(无值、label 不是写入键)，其 number 子字段「分数」是
    // 真正的写入键。自愈必须先 flattenLeafFields 摊平 group 才能把「分数」纳入要补建的列，
    // 否则按顶层 label 过滤会漏掉它 → 重试仍缺列。建出的列须是数字列(2)，不是文本。
    const GROUP_DEFS: Field[] = [
      {
        id: "g_scores",
        type: "group",
        label: "成绩",
        children: [{ id: "f_score", type: "number", label: "分数" }],
      },
    ];
    const { calls } = stubFetchByPath({
      [RECORDS_URL]: [
        { status: 200, body: RECORD_MISSING_BODY },
        { status: 200, body: recordOkBody("rec-healed") },
      ],
      [FIELDS_PATH]: [
        { status: 200, body: fieldsListBody([]) },
        { status: 200, body: FIELD_CREATE_OK_BODY },
      ],
    });

    // fields 写「分数」一格（已类型化为 number），fieldDefs 是含 group 的定义。
    const result = await writeRecordWithFieldEnsure(
      TENANT_TOKEN,
      APP_TOKEN,
      TABLE_ID,
      { 分数: 88 },
      GROUP_DEFS,
    );

    expect(result.recordId).toBe("rec-healed");
    // 自愈建出了分组子字段「分数」对应的列，且类型是 NUMBER（2），不是文本。
    const create = calls.find((c) => c.method === "POST" && pathOf(c.url) === FIELDS_PATH);
    expect(create?.body).toMatchObject({
      field_name: "分数",
      type: FEISHU_BITABLE_FIELD_TYPE.NUMBER,
    });
  });

  it("retries at most once: a still-1254045 retry rethrows BitableFieldMissingError (route → 502), no 3rd write", async () => {
    // record handler holds exactly 2 replies; a 3rd write attempt would THROW.
    stubFetchByPath({
      [RECORDS_URL]: [
        { status: 200, body: RECORD_MISSING_BODY },
        { status: 200, body: RECORD_MISSING_BODY },
      ],
      [FIELDS_PATH]: [
        { status: 200, body: fieldsListBody([]) },
        { status: 200, body: FIELD_CREATE_OK_BODY },
      ],
    });

    const err = await writeRecordWithFieldEnsure(
      TENANT_TOKEN,
      APP_TOKEN,
      TABLE_ID,
      { 姓名: "张三" },
      FIELD_DEFS,
    ).then(
      () => {
        throw new Error("expected writeRecordWithFieldEnsure to reject");
      },
      (e: unknown) => e,
    );

    // Still a BitableWriteError → the route's existing 502 branch covers it.
    expect(err).toBeInstanceOf(BitableWriteError);
    expect((err as Error).message).not.toContain(TENANT_TOKEN);
    expect((err as Error).message).not.toContain(APP_SECRET);
  });

  it("does NOT self-heal a first write that fails for a non-missing-column reason (no field traffic)", async () => {
    // First (and only) write fails with a plain code → propagates, ensureBitableFields not called.
    // FIELDS_PATH omitted → any list/create would THROW; record handler holds ONE reply →
    // a (wrong) retry would THROW too.
    stubFetchByPath({
      [RECORDS_URL]: [{ status: 200, body: JSON.stringify({ code: 1254000, msg: "invalid" }) }],
    });

    const err = await writeRecordWithFieldEnsure(
      TENANT_TOKEN,
      APP_TOKEN,
      TABLE_ID,
      { 姓名: "张三" },
      FIELD_DEFS,
    ).then(
      () => {
        throw new Error("expected writeRecordWithFieldEnsure to reject");
      },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(BitableWriteError);
    expect(err).not.toBeInstanceOf(BitableFieldMissingError);
  });
});

describe("answersToTypedFields (SPEC.md §16.8 / §15.8 升级：按列真实类型格式化值)", () => {
  const { TEXT, NUMBER, DATE, MULTI_SELECT } = FEISHU_BITABLE_FIELD_TYPE;

  // 字段定义（label↔type）：缺列的格式化按这里的字段映射类型（§16.8.4 修订）。
  const NAME_DEF: Field = { id: "f_name", type: "text", label: "姓名" };
  const AGE_DEF: Field = { id: "f_age", type: "number", label: "年龄" };
  const BIRTH_DEF: Field = { id: "f_birth", type: "date", label: "生日" };
  const HOBBY_DEF: Field = { id: "f_hobby", type: "checkbox", label: "兴趣" };
  const ALL_DEFS: Field[] = [NAME_DEF, AGE_DEF, BIRTH_DEF, HOBBY_DEF];

  it("formats each answer by the column's REAL type from the listed columnTypes (方案 a)", () => {
    const columnTypes: BitableColumnTypes = new Map([
      ["姓名", TEXT],
      ["年龄", NUMBER],
      ["兴趣", MULTI_SELECT],
    ]);
    const answers: SubmitAnswer[] = [
      { label: "姓名", value: "张三" },
      { label: "年龄", value: "28" },
      { label: "兴趣", value: ["阅读", "运动"] },
    ];

    const fields = answersToTypedFields(answers, columnTypes, ALL_DEFS);

    // 年龄按 NUMBER 列 → JS number(28)；兴趣按 MULTI_SELECT → string[]；姓名按 TEXT → string。
    expect(fields).toEqual({ 姓名: "张三", 年龄: 28, 兴趣: ["阅读", "运动"] });
  });

  it("omits a key whose value cannot be safely formatted (dirty number dropped, others written)", () => {
    const columnTypes: BitableColumnTypes = new Map([
      ["姓名", TEXT],
      ["年龄", NUMBER],
    ]);
    const answers: SubmitAnswer[] = [
      { label: "姓名", value: "张三" },
      { label: "年龄", value: "不是数字" },
    ];

    const fields = answersToTypedFields(answers, columnTypes, ALL_DEFS);

    // 脏数字 → undefined → 省略该键；其余字段照常写。
    expect(fields).toEqual({ 姓名: "张三" });
    expect("年龄" in fields).toBe(false);
  });

  it("formats a date answer to a millisecond timestamp for a DATE column", () => {
    const columnTypes: BitableColumnTypes = new Map([["生日", DATE]]);
    const fields = answersToTypedFields(
      [{ label: "生日", value: "2024-01-15" }],
      columnTypes,
      ALL_DEFS,
    );
    expect(fields).toEqual({ 生日: Date.parse("2024-01-15") });
  });

  it("treats a column declared as TEXT as text even when the answer looks numeric (旧文本列兜底)", () => {
    // 旧文本列：年龄列真实类型是文本 → 按文本写「28」而非 number，飞书不因类型不符整条拒。
    const columnTypes: BitableColumnTypes = new Map([["年龄", TEXT]]);
    const fields = answersToTypedFields([{ label: "年龄", value: "28" }], columnTypes, ALL_DEFS);
    expect(fields).toEqual({ 年龄: "28" });
    expect(typeof fields.年龄).toBe("string");
  });

  // —— Bug #1 回归：缺列(不在 columnTypes)按字段自身映射类型格式化，而非兜底文本 ——
  // 自愈正会把缺列建成字段映射类型（number→数字列…），故首写就要带类型化值，重试才能命中。

  it("formats a MISSING number column's answer as a JS number, not a text string (Bug #1)", () => {
    // 「年龄」不在 columnTypes（列还不存在）→ 按字段映射类型 NUMBER 格式化 → JS number(95)。
    const fields = answersToTypedFields(
      [{ label: "年龄", value: "95" }],
      new Map() as BitableColumnTypes,
      ALL_DEFS,
    );
    expect(fields.年龄).toBe(95);
    expect(typeof fields.年龄).toBe("number");
  });

  it("formats a MISSING date column's answer as a millisecond timestamp (Bug #1)", () => {
    const fields = answersToTypedFields(
      [{ label: "生日", value: "2024-03-15" }],
      new Map() as BitableColumnTypes,
      ALL_DEFS,
    );
    expect(fields.生日).toBe(Date.parse("2024-03-15"));
    expect(typeof fields.生日).toBe("number");
  });

  it("formats a MISSING checkbox column's answer as a string[] (Bug #1)", () => {
    const fields = answersToTypedFields(
      [{ label: "兴趣", value: ["阅读", "运动"] }],
      new Map() as BitableColumnTypes,
      ALL_DEFS,
    );
    expect(fields.兴趣).toEqual(["阅读", "运动"]);
    expect(Array.isArray(fields.兴趣)).toBe(true);
  });

  it("formats a MISSING text column's answer as a joined string (Bug #1 文本字段仍走文本)", () => {
    // 文本字段缺列 → 映射类型仍是 TEXT → string[] 按文本 join（与升级前同形，但来由是字段映射）。
    const NEW_TEXT_DEF: Field = { id: "f_new", type: "text", label: "新列" };
    const fields = answersToTypedFields(
      [{ label: "新列", value: ["a", "b"] }],
      new Map() as BitableColumnTypes,
      [NEW_TEXT_DEF],
    );
    expect(fields).toEqual({ 新列: "a, b" });
  });

  it("formats a MISSING group child column's answer by ITS type via flattenLeafFields (Bug #2 缺列+分组)", () => {
    // 「分数」是 group「成绩」的 number 子字段；列还不存在 → 必须按子字段映射类型 NUMBER 格式化
    // （flattenLeafFields 摊平 group 才能查到它的 type），否则文本 "88" 会塞进自愈建的数字列。
    const GROUP_DEFS: Field[] = [
      {
        id: "g_scores",
        type: "group",
        label: "成绩",
        children: [{ id: "f_score", type: "number", label: "分数" }],
      },
    ];
    const fields = answersToTypedFields(
      [{ label: "分数", value: "88" }],
      new Map() as BitableColumnTypes,
      GROUP_DEFS,
    );
    expect(fields.分数).toBe(88);
    expect(typeof fields.分数).toBe("number");
  });

  it("falls back to TEXT only when a missing column has NO field def (异常态兜底)", () => {
    // 列缺失且 fieldDefs 里也无此 label → 退化文本兜底（最稳）。
    const fields = answersToTypedFields(
      [{ label: "幽灵列", value: ["a", "b"] }],
      new Map() as BitableColumnTypes,
      ALL_DEFS,
    );
    expect(fields).toEqual({ 幽灵列: "a, b" });
  });
});
