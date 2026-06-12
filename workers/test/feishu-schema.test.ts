import { describe, it, expect, afterEach } from "vitest";
import { vi } from "vitest";
import {
  toBitableFieldType,
  buildFieldProperty,
  formatValueForBitable,
  listBitableColumns,
  preCreateBitableColumns,
  FEISHU_BITABLE_FIELD_TYPE,
  type FeishuFieldType,
} from "../src/feishu-schema";
import {
  FEISHU_BITABLE_FIELDS_URL,
  FEISHU_CODE_FIELD_DUPLICATED,
  BitableWriteError,
} from "../src/submit";
import type { Field } from "../src/forms";

// Inner-loop unit specs for the PURE mapping / formatting seams + the fetch-bearing
// list / pre-create seams in feishu-schema.ts (SPEC.md §16.8 发布即预建带类型列 / §15.8
// 升级 类型化写值). The pure functions (toBitableFieldType / buildFieldProperty /
// formatValueForBitable) are network-free — type / value in → bitable-shaped out.
// listBitableColumns / preCreateBitableColumns make upstream calls; fetch is stubbed
// directly here (no D1, no Hono). The best-effort outer wrapper
// (preCreateBitableColumnsBestEffort) reads + decrypts owner config, so it is left to
// the outer loop. See SPEC.md §16.8 mapping table + §15.7 (token/secret never leak).

// Distinctive credential fixtures: long + unmistakable so a substring scan of any
// thrown message catches an accidental leak unambiguously (SPEC.md §15.7).
const APP_TOKEN = "bascnUnitAppTokenXYZ";
const TABLE_ID = "tblUnit123";
const TENANT_TOKEN = "t-unit-TENANTtoken-abcdef0123456789";

const { TEXT, NUMBER, SINGLE_SELECT, MULTI_SELECT, DATE } = FEISHU_BITABLE_FIELD_TYPE;

interface CapturedCall {
  url: string;
  method: string;
  headers: Headers;
  bodyText: string;
  body: unknown;
}

interface StubReply {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

/**
 * Stub global fetch with a per-path SEQUENCE of replies (one per call, in order),
 * matching URLs by origin + pathname so a `?page_size=` query still lands on the
 * bare-template handler. An unconfigured path throws (talking to the wrong endpoint
 * fails loudly). Mirrors the helper in submit.test.ts.
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

const FIELDS_PATH = pathOf(
  FEISHU_BITABLE_FIELDS_URL.replace("{app_token}", APP_TOKEN).replace("{table_id}", TABLE_ID),
);

/** A list-fields response carrying each column's name AND its real type (§15.8 升级). */
function fieldsListTypedBody(cols: Array<{ name: string; type: FeishuFieldType }>): string {
  return JSON.stringify({
    code: 0,
    msg: "success",
    data: { items: cols.map((c) => ({ field_name: c.name, type: c.type })) },
  });
}
const FIELD_CREATE_OK_BODY = JSON.stringify({ code: 0, msg: "success" });
const FIELD_CREATE_DUP_BODY = JSON.stringify({
  code: FEISHU_CODE_FIELD_DUPLICATED,
  msg: "FieldNameDuplicated",
});

describe("toBitableFieldType (SPEC.md §16.8 字段 type → 飞书列类型映射)", () => {
  it("maps text/file/group → 文本(1)", () => {
    expect(toBitableFieldType("text")).toBe(TEXT);
    expect(toBitableFieldType("file")).toBe(TEXT);
    expect(toBitableFieldType("group")).toBe(TEXT);
  });

  it("maps number → 数字(2)", () => {
    expect(toBitableFieldType("number")).toBe(NUMBER);
  });

  it("maps date → 日期(5)", () => {
    expect(toBitableFieldType("date")).toBe(DATE);
  });

  it("maps select/radio → 单选(3)", () => {
    expect(toBitableFieldType("select")).toBe(SINGLE_SELECT);
    expect(toBitableFieldType("radio")).toBe(SINGLE_SELECT);
  });

  it("maps checkbox → 多选(4)", () => {
    expect(toBitableFieldType("checkbox")).toBe(MULTI_SELECT);
  });

  it("falls back to 文本(1) for an unknown / unsupported type, never throwing", () => {
    expect(toBitableFieldType("password")).toBe(TEXT);
    expect(toBitableFieldType("")).toBe(TEXT);
    expect(toBitableFieldType("anything-weird")).toBe(TEXT);
  });
});

describe("buildFieldProperty (SPEC.md §16.8 单选/多选建列 property.options)", () => {
  it("returns { options:[{name}] } from option.label for a single-select", () => {
    const field: Field = {
      id: "f_city",
      type: "select",
      label: "城市",
      options: [
        { label: "北京", value: "bj" },
        { label: "上海", value: "sh" },
      ],
    };
    expect(buildFieldProperty(field)).toEqual({ options: [{ name: "北京" }, { name: "上海" }] });
  });

  it("returns { options:[{name}] } from option.label for a multi-select", () => {
    const field: Field = {
      id: "f_hobby",
      type: "checkbox",
      label: "兴趣",
      options: [
        { label: "阅读", value: "read" },
        { label: "运动", value: "sport" },
      ],
    };
    expect(buildFieldProperty(field)).toEqual({ options: [{ name: "阅读" }, { name: "运动" }] });
  });

  it("de-duplicates options sharing the same label (Feishu rejects duplicate option names)", () => {
    const field: Field = {
      id: "f_city",
      type: "radio",
      label: "城市",
      options: [
        { label: "北京", value: "bj" },
        { label: "北京", value: "bj2" },
        { label: "上海", value: "sh" },
      ],
    };
    expect(buildFieldProperty(field)).toEqual({ options: [{ name: "北京" }, { name: "上海" }] });
  });

  it("returns empty options for a single/multi-select with no / empty options", () => {
    expect(buildFieldProperty({ id: "f", type: "select", label: "城市" })).toEqual({ options: [] });
    expect(buildFieldProperty({ id: "f", type: "checkbox", label: "兴趣", options: [] })).toEqual({
      options: [],
    });
  });

  it("returns undefined (no property) for text / number / date columns", () => {
    expect(buildFieldProperty({ id: "a", type: "text", label: "姓名" })).toBeUndefined();
    expect(buildFieldProperty({ id: "b", type: "number", label: "年龄" })).toBeUndefined();
    expect(buildFieldProperty({ id: "c", type: "date", label: "生日" })).toBeUndefined();
    expect(buildFieldProperty({ id: "d", type: "file", label: "附件" })).toBeUndefined();
  });
});

describe("formatValueForBitable (SPEC.md §16.8 / §15.8 升级 按目标列真实类型格式化)", () => {
  it("文本(1): passes a string through, joins a string[] into one string", () => {
    expect(formatValueForBitable("张三", TEXT)).toBe("张三");
    expect(formatValueForBitable(["阅读", "运动"], TEXT)).toBe("阅读, 运动");
  });

  it("数字(2): parses a numeric string to a JS number", () => {
    expect(formatValueForBitable("28", NUMBER)).toBe(28);
    expect(formatValueForBitable("3.14", NUMBER)).toBe(3.14);
    expect(formatValueForBitable("-5", NUMBER)).toBe(-5);
  });

  it("数字(2): a non-numeric / empty value is dropped (undefined → caller omits the key)", () => {
    expect(formatValueForBitable("abc", NUMBER)).toBeUndefined();
    expect(formatValueForBitable("", NUMBER)).toBeUndefined();
    expect(formatValueForBitable("   ", NUMBER)).toBeUndefined();
    expect(formatValueForBitable("12abc", NUMBER)).toBeUndefined();
  });

  it("日期(5): parses a date string into a millisecond timestamp", () => {
    const expected = Date.parse("2024-01-15");
    expect(formatValueForBitable("2024-01-15", DATE)).toBe(expected);
  });

  it("日期(5): a pure numeric string (already a ms timestamp) is taken as-is", () => {
    expect(formatValueForBitable("1700000000000", DATE)).toBe(1700000000000);
  });

  it("日期(5): an unparseable date is dropped (undefined)", () => {
    expect(formatValueForBitable("not-a-date", DATE)).toBeUndefined();
    expect(formatValueForBitable("", DATE)).toBeUndefined();
  });

  it("单选(3): takes the string (first element of a string[]) as the option name", () => {
    expect(formatValueForBitable("北京", SINGLE_SELECT)).toBe("北京");
    expect(formatValueForBitable(["北京", "上海"], SINGLE_SELECT)).toBe("北京");
  });

  it("单选(3): an empty value is dropped (undefined)", () => {
    expect(formatValueForBitable("", SINGLE_SELECT)).toBeUndefined();
    expect(formatValueForBitable([], SINGLE_SELECT)).toBeUndefined();
  });

  it("多选(4): keeps a string[] (filtering empties); wraps a single string into [value]", () => {
    expect(formatValueForBitable(["阅读", "运动"], MULTI_SELECT)).toEqual(["阅读", "运动"]);
    expect(formatValueForBitable("阅读", MULTI_SELECT)).toEqual(["阅读"]);
    expect(formatValueForBitable(["阅读", "", "运动"], MULTI_SELECT)).toEqual(["阅读", "运动"]);
  });

  it("多选(4): an empty / all-blank value is dropped (undefined)", () => {
    expect(formatValueForBitable([], MULTI_SELECT)).toBeUndefined();
    expect(formatValueForBitable("", MULTI_SELECT)).toBeUndefined();
    expect(formatValueForBitable(["", "  "], MULTI_SELECT)).toBeUndefined();
  });

  it("文本(1): an empty string answer is dropped (undefined → key omitted)", () => {
    expect(formatValueForBitable("", TEXT)).toBeUndefined();
  });
});

describe("listBitableColumns (SPEC.md §15.8 升级：列出列名 → 真实类型)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs ?page_size with the Bearer token and returns a name → type Map", async () => {
    const { calls } = stubFetchByPath({
      [FIELDS_PATH]: [
        {
          status: 200,
          body: fieldsListTypedBody([
            { name: "姓名", type: TEXT },
            { name: "年龄", type: NUMBER },
            { name: "兴趣", type: MULTI_SELECT },
          ]),
        },
      ],
    });

    const cols = await listBitableColumns(TENANT_TOKEN, APP_TOKEN, TABLE_ID);

    expect(cols.get("姓名")).toBe(TEXT);
    expect(cols.get("年龄")).toBe(NUMBER);
    expect(cols.get("兴趣")).toBe(MULTI_SELECT);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(new URL(calls[0].url).searchParams.get("page_size")).toBe("100");
    expect(calls[0].headers.get("authorization")).toBe(`Bearer ${TENANT_TOKEN}`);
  });

  it("returns an empty Map for a table with no columns", async () => {
    stubFetchByPath({ [FIELDS_PATH]: [{ status: 200, body: fieldsListTypedBody([]) }] });
    const cols = await listBitableColumns(TENANT_TOKEN, APP_TOKEN, TABLE_ID);
    expect(cols.size).toBe(0);
  });

  it("throws BitableWriteError on a non-zero body code without leaking the token", async () => {
    stubFetchByPath({
      [FIELDS_PATH]: [{ status: 200, body: JSON.stringify({ code: 1254000, msg: "boom" }) }],
    });

    const err = await listBitableColumns(TENANT_TOKEN, APP_TOKEN, TABLE_ID).then(
      () => {
        throw new Error("expected listBitableColumns to reject");
      },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(BitableWriteError);
    expect((err as Error).message).not.toContain(TENANT_TOKEN);
  });
});

describe("preCreateBitableColumns (SPEC.md §16.8 发布即按类型预建缺列)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists existing columns then creates only the missing ones with the mapped type + options", async () => {
    // 「姓名」已存在(文本) → 跳过；「年龄」(数字) / 「城市」(单选带 options) 缺失 → 建。
    const { calls } = stubFetchByPath({
      [FIELDS_PATH]: [
        { status: 200, body: fieldsListTypedBody([{ name: "姓名", type: TEXT }]) },
        { status: 200, body: FIELD_CREATE_OK_BODY },
        { status: 200, body: FIELD_CREATE_OK_BODY },
      ],
    });

    const fields: Field[] = [
      { id: "f_name", type: "text", label: "姓名" },
      { id: "f_age", type: "number", label: "年龄" },
      {
        id: "f_city",
        type: "select",
        label: "城市",
        options: [
          { label: "北京", value: "bj" },
          { label: "上海", value: "sh" },
        ],
      },
    ];
    await preCreateBitableColumns(TENANT_TOKEN, APP_TOKEN, TABLE_ID, fields);

    // one GET (list) + two POST (年龄, 城市); 姓名 skipped (already exists).
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
    const created = calls.filter((c) => c.method === "POST").map((c) => c.body);
    expect(created).toEqual([
      { field_name: "年龄", type: NUMBER },
      {
        field_name: "城市",
        type: SINGLE_SELECT,
        property: { options: [{ name: "北京" }, { name: "上海" }] },
      },
    ]);
  });

  it("does not create any column when all fields already exist (绝不改既有列)", async () => {
    const { calls } = stubFetchByPath({
      [FIELDS_PATH]: [
        {
          status: 200,
          // 既有「姓名」是文本列；即便字段声明是 number 也不动它（只对缺列生效）。
          body: fieldsListTypedBody([{ name: "姓名", type: TEXT }]),
        },
      ],
    });

    await preCreateBitableColumns(TENANT_TOKEN, APP_TOKEN, TABLE_ID, [
      { id: "f_name", type: "number", label: "姓名" },
    ]);

    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("treats a create returning 1254014 (并发重复) as idempotent success", async () => {
    stubFetchByPath({
      [FIELDS_PATH]: [
        { status: 200, body: fieldsListTypedBody([]) },
        { status: 200, body: FIELD_CREATE_DUP_BODY },
      ],
    });

    await expect(
      preCreateBitableColumns(TENANT_TOKEN, APP_TOKEN, TABLE_ID, [
        { id: "f", type: "text", label: "姓名" },
      ]),
    ).resolves.toBeUndefined();
  });

  it("expands a group field into its leaf children (the container itself gets no column)", async () => {
    const { calls } = stubFetchByPath({
      [FIELDS_PATH]: [
        { status: 200, body: fieldsListTypedBody([]) },
        { status: 200, body: FIELD_CREATE_OK_BODY },
        { status: 200, body: FIELD_CREATE_OK_BODY },
      ],
    });

    const fields: Field[] = [
      {
        id: "g",
        type: "group",
        label: "联系方式",
        children: [
          { id: "f_phone", type: "text", label: "电话" },
          { id: "f_age", type: "number", label: "年龄" },
        ],
      },
    ];
    await preCreateBitableColumns(TENANT_TOKEN, APP_TOKEN, TABLE_ID, fields);

    const created = calls.filter((c) => c.method === "POST").map((c) => c.body);
    // The group container itself is NOT created as a column; only its leaf children are.
    expect(created).toEqual([
      { field_name: "电话", type: TEXT },
      { field_name: "年龄", type: NUMBER },
    ]);
  });
});
