import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { applySchema, resetConfig, resetForms, login, authHeader } from "./helpers";
import {
  FEISHU_BITABLE_RECORDS_URL,
  FEISHU_BITABLE_FIELDS_URL,
  FEISHU_CODE_FIELD_NOT_FOUND,
  FEISHU_CODE_FIELD_DUPLICATED,
} from "../src/submit";
import { FEISHU_BITABLE_FIELD_TYPE } from "../src/feishu-schema";
import { FEISHU_TENANT_TOKEN_URL } from "../src/feishu";

// Outer-loop acceptance specs realizing workers/features/feishu-typed-columns.feature
// (SPEC §16.8 发布即在飞书表 best-effort 预建带类型的列 + §15.8 升级 类型化写值/自愈)。
// Driven through the real Hono app in workerd via SELF.fetch with ALL Feishu upstreams
// mocked locally — never hits open.feishu.cn.
//
// 两条被验证的行为线：
//   1) 发布 / 编辑即预建：POST /api/forms / PATCH .../:slug（改了 fields）在
//      c.executionCtx.waitUntil 后台 best-effort 预建带类型的列——number→数字(2) /
//      date→日期(5) / select·radio→单选(3,带 options) / checkbox→多选(4,带 options) /
//      text·file·未知→文本(1)；已存在列幂等跳过不改类型；1254014 当幂等成功。owner 未配飞书 /
//      换 token 失败 / 列出失败 / 建列失败 → 发布仍 201、响应不变、日志不含凭据。
//   2) 提交按列真实类型写值（既有列冲突兜底方案 a）：先 GET .../fields 拿每列真实类型，再按
//      列真实类型把 answers 格成 typed fields——数字写 JS number、日期写毫秒时间戳、多选写
//      字符串数组；脏数字 / 坏日期 → 省略该格不整条失败；旧文本列按真实类型写文本；缺列自愈
//      建对应类型列后重试成功。提交响应只含 { ok, recordId }，绝不漏凭据。
//
// Contract: SPEC.md §16.8、§15.8、§15.5、§15.7.

const BASE = "https://api.local";

const { TEXT, NUMBER, SINGLE_SELECT, MULTI_SELECT, DATE } = FEISHU_BITABLE_FIELD_TYPE;

// Distinctive credential fixtures — long + unmistakable so a substring scan of any
// response body / message / header catches an accidental leak unambiguously (§15.7).
const OWNER_DEEPSEEK_KEY = "sk-owner-DEEPSEEK-secret-0123456789abcdef";
const OWNER_FEISHU_APP_ID = "cli_typedColsAppId9999";
const OWNER_FEISHU_APP_SECRET = "feishu-TYPED-APP-SECRET-qrstuvwxyz-7777-SHHH";
const OWNER_FEISHU_APP_TOKEN = "bascnTypedColsAppTokenXYZ";
const OWNER_FEISHU_TABLE_ID = "tblTypedCols123";

const UPSTREAM_TENANT_TOKEN = "t-typedcols-TENANTtoken-SECRET-9999";
const UPSTREAM_RECORD_ID = "rec-typedcols-xxxx";

const RECORDS_URL = FEISHU_BITABLE_RECORDS_URL.replace(
  "{app_token}",
  OWNER_FEISHU_APP_TOKEN,
).replace("{table_id}", OWNER_FEISHU_TABLE_ID);
const FIELDS_URL = FEISHU_BITABLE_FIELDS_URL.replace("{app_token}", OWNER_FEISHU_APP_TOKEN).replace(
  "{table_id}",
  OWNER_FEISHU_TABLE_ID,
);

/** origin + pathname (query/hash stripped) — matches the GET-with-?page_size lister. */
function pathKey(url: string): string {
  const u = new URL(url);
  return u.origin + u.pathname;
}
const FIELDS_PATH = pathKey(FIELDS_URL);

const FEISHU_TOKEN_OK_BODY = JSON.stringify({
  code: 0,
  msg: "ok",
  tenant_access_token: UPSTREAM_TENANT_TOKEN,
  expire: 7200,
});
const FEISHU_TOKEN_BAD_BODY = JSON.stringify({ code: 99991663, msg: "app ticket invalid" });

const BITABLE_OK_BODY = JSON.stringify({
  code: 0,
  msg: "success",
  data: { record: { record_id: UPSTREAM_RECORD_ID } },
});
const BITABLE_FIELD_MISSING_BODY = JSON.stringify({
  code: FEISHU_CODE_FIELD_NOT_FOUND,
  msg: "FieldNameNotFound",
});
const FIELD_CREATE_OK_BODY = JSON.stringify({ code: 0, msg: "success" });
const FIELD_CREATE_DUP_BODY = JSON.stringify({
  code: FEISHU_CODE_FIELD_DUPLICATED,
  msg: "FieldNameDuplicated",
});
const FIELD_CREATE_BAD_BODY = JSON.stringify({ code: 1254999, msg: "FieldCreateRejected" });

/** A list-fields OK body carrying each column's name AND real type (§15.8 升级). */
function fieldsListBody(cols: Array<{ name: string; type: number }>): string {
  return JSON.stringify({
    code: 0,
    msg: "success",
    data: { items: cols.map((c) => ({ field_name: c.name, type: c.type })) },
  });
}

// --- Four-endpoint Feishu fetch mock (default-deny) ---------------------------
//
// Endpoints: ① token exchange, ② add-record (POST records), ③ list-fields (GET
// fields), ④ create-field (POST fields). We dispatch on exact URL / pathname +
// method. Each create-field call gets the SAME configured reply; the record + list
// endpoints take a SEQUENCE of replies (one per call, in order) so the self-heal
// retry path can be scripted. Any unmatched call THROWS (talking to the wrong place
// fails loudly). Replies default to success so the common publish path "just works".

interface UpstreamReply {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

interface FeishuMockOpts {
  /** Reply for the token exchange. Default OK. Set `null` to forbid (must NOT call). */
  token?: UpstreamReply | null;
  /** Sequenced replies for add-record (POST records). Default [OK]. */
  record?: UpstreamReply[];
  /** Sequenced replies for list-fields (GET fields). Default [empty list]. */
  fieldsList?: UpstreamReply[];
  /** Reply for each create-field (POST fields). Default OK. */
  fieldCreate?: UpstreamReply;
}

interface CapturedCall {
  url: string;
  method: string;
  headers: Headers;
  bodyText: string;
  body: unknown;
}

interface FeishuMock {
  readonly tokenCalls: CapturedCall[];
  readonly recordCalls: CapturedCall[];
  readonly fieldsListCalls: CapturedCall[];
  readonly fieldCreateCalls: CapturedCall[];
  resetCalls(): void;
  restore(): void;
}

function installFeishuMock(opts: FeishuMockOpts = {}): FeishuMock {
  const tokenCalls: CapturedCall[] = [];
  const recordCalls: CapturedCall[] = [];
  const fieldsListCalls: CapturedCall[] = [];
  const fieldCreateCalls: CapturedCall[] = [];

  const tokenReply: UpstreamReply | null =
    opts.token === undefined ? { status: 200, body: FEISHU_TOKEN_OK_BODY } : opts.token;
  const recordReplies: UpstreamReply[] = opts.record ?? [{ status: 200, body: BITABLE_OK_BODY }];
  const fieldsListReplies: UpstreamReply[] = opts.fieldsList ?? [
    { status: 200, body: fieldsListBody([]) },
  ];
  const fieldCreateReply: UpstreamReply = opts.fieldCreate ?? {
    status: 200,
    body: FIELD_CREATE_OK_BODY,
  };

  // Persistent per-endpoint sequence cursors — these advance across the WHOLE mock
  // lifetime (publish pre-create + the submit/edit under test) and are NOT rewound by
  // resetCalls(). That lets a test give the publish list one reply and the PATCH /
  // submit list the NEXT reply, even though the captured-call arrays get reset between
  // the two phases. (The captured arrays are for assertion; the cursors drive replies.)
  let recordSeq = 0;
  let fieldsListSeq = 0;

  const realFetch = globalThis.fetch;
  const reply = (r: UpstreamReply): Response =>
    new Response(r.body, {
      status: r.status,
      headers: r.headers ?? { "content-type": "application/json" },
    });
  // The Nth call to a sequenced endpoint gets the Nth reply; once exhausted, the
  // LAST reply repeats (so unbounded background lists don't run dry).
  const seqReply = (seq: UpstreamReply[], n: number): Response =>
    reply(seq[Math.min(n, seq.length - 1)]);

  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input as RequestInfo, init);
    const bodyText = req.method === "GET" || req.method === "HEAD" ? "" : await req.clone().text();
    let parsed: unknown;
    try {
      parsed = bodyText.length > 0 ? JSON.parse(bodyText) : undefined;
    } catch {
      parsed = undefined;
    }
    const captured: CapturedCall = {
      url: req.url,
      method: req.method,
      headers: new Headers(req.headers),
      bodyText,
      body: parsed,
    };

    if (req.url === FEISHU_TENANT_TOKEN_URL) {
      if (!tokenReply) {
        throw new Error(`unexpected token-exchange call to ${req.url} (forbidden)`);
      }
      tokenCalls.push(captured);
      return reply(tokenReply);
    }
    if (req.url === RECORDS_URL) {
      const r = seqReply(recordReplies, recordSeq++);
      recordCalls.push(captured);
      return r;
    }
    if (pathKey(req.url) === FIELDS_PATH) {
      if (req.method === "GET") {
        const r = seqReply(fieldsListReplies, fieldsListSeq++);
        fieldsListCalls.push(captured);
        return r;
      }
      if (req.method === "POST") {
        fieldCreateCalls.push(captured);
        return reply(fieldCreateReply);
      }
      throw new Error(`unexpected method ${req.method} on fields endpoint ${req.url}`);
    }
    // Default-deny: only the configured Feishu upstreams are allowed.
    throw new Error(`unexpected outbound fetch to ${req.method} ${req.url}`);
  };

  globalThis.fetch = stub as typeof fetch;
  return {
    tokenCalls,
    recordCalls,
    fieldsListCalls,
    fieldCreateCalls,
    resetCalls: () => {
      tokenCalls.length = 0;
      recordCalls.length = 0;
      fieldsListCalls.length = 0;
      fieldCreateCalls.length = 0;
    },
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

// --- setup helpers ------------------------------------------------------------

// Owner-only setup token (§17.1) for POST /api/config + POST /api/forms + PATCH.
let token: string;

async function configureOwner(opts: { feishu: boolean }): Promise<void> {
  const body: Record<string, unknown> = {
    deepseek: { apiKey: OWNER_DEEPSEEK_KEY, model: "deepseek-chat" },
  };
  if (opts.feishu) {
    body.feishu = {
      appId: OWNER_FEISHU_APP_ID,
      appSecret: OWNER_FEISHU_APP_SECRET,
      appToken: OWNER_FEISHU_APP_TOKEN,
      tableId: OWNER_FEISHU_TABLE_ID,
    };
  }
  const res = await SELF.fetch(`${BASE}/api/config`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) {
    throw new Error(`setup configureOwner failed: ${res.status} ${await res.text()}`);
  }
}

interface FieldDef {
  id: string;
  type: string;
  label: string;
  required?: boolean;
  options?: Array<{ label: string; value: string }>;
  /** group 子字段（§16.8 / Bug #2 分组缺列自愈场景用）。 */
  children?: FieldDef[];
}

async function publishForm(fields: FieldDef[]): Promise<Response> {
  return SELF.fetch(`${BASE}/api/forms`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify({ meta: { title: "类型列测试表单" }, fields }),
  });
}

async function publishFormAndGetSlug(fields: FieldDef[]): Promise<string> {
  const res = await publishForm(fields);
  if (res.status !== 201) {
    throw new Error(`setup publishForm failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { slug?: string };
  if (typeof json.slug !== "string" || json.slug.length === 0) {
    throw new Error(`setup publishForm returned no slug: ${JSON.stringify(json)}`);
  }
  return json.slug;
}

function patchForm(slug: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/api/forms/${slug}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify(body),
  });
}

// POST /api/submit is PUBLIC (§17.1) → no Authorization header.
function postSubmit(body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/api/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Wait until the background `preCreateBitableColumnsBestEffort` (§16.8, runs in
 * c.executionCtx.waitUntil) has reached its first upstream hop — the token exchange
 * — then settle so the list/create POSTs that follow also land. After this returns,
 * the mock's captured arrays hold the COMPLETE pre-create fan-out for assertions.
 * `expectToken=false` is used when the owner is NOT configured (no fan-out at all):
 * we just give the background a beat and assert it stayed quiet.
 */
async function waitForPreCreate(mock: FeishuMock, expectToken = true): Promise<void> {
  const deadline = Date.now() + 1000;
  if (expectToken) {
    while (mock.tokenCalls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  // Settle so list + create POSTs that follow the token also land before asserting.
  await new Promise((r) => setTimeout(r, 40));
}

// A multi-type form: 姓名(text) 年龄(number) 生日(date) 城市(单选) 兴趣(多选).
const MULTI_TYPE_FIELDS: FieldDef[] = [
  { id: "f_name", type: "text", label: "姓名" },
  { id: "f_age", type: "number", label: "年龄" },
  { id: "f_birth", type: "date", label: "生日" },
  {
    id: "f_city",
    type: "select",
    label: "城市",
    options: [
      { label: "北京", value: "bj" },
      { label: "上海", value: "sh" },
      { label: "广州", value: "gz" },
    ],
  },
  {
    id: "f_hobby",
    type: "checkbox",
    label: "兴趣",
    options: [
      { label: "阅读", value: "read" },
      { label: "运动", value: "sport" },
    ],
  },
];

/** Find the create-field POST body for a given column name (or undefined). */
function createdField(
  mock: FeishuMock,
  name: string,
):
  | { field_name?: string; type?: number; property?: { options?: Array<{ name: string }> } }
  | undefined {
  const call = mock.fieldCreateCalls.find(
    (c) => (c.body as { field_name?: string }).field_name === name,
  );
  return call?.body as
    | { field_name?: string; type?: number; property?: { options?: Array<{ name: string }> } }
    | undefined;
}

describe("发布预建带类型列 + 提交按类型写值 (workers/features/feishu-typed-columns.feature)", () => {
  let mock: FeishuMock | undefined;

  beforeAll(async () => {
    await applySchema();
  });

  beforeEach(async () => {
    await resetConfig();
    await resetForms();
    token = await login();
  });

  afterEach(() => {
    mock?.restore();
    mock = undefined;
  });

  // ===========================================================================
  // 发布即预建：POST /api/forms 在 waitUntil 后台按字段 type 预建全部列
  // ===========================================================================

  it("Scenario: 发布一份多类型字段的表单即预建对应类型的列", async () => {
    // Given owner 已配置可用的飞书多维表格凭据
    await configureOwner({ feishu: true });
    // 列出为空 → 每个字段都要新建。先装 mock 再发布，让后台预建落在 mock 上。
    mock = installFeishuMock({ fieldsList: [{ status: 200, body: fieldsListBody([]) }] });

    // When owner 发布该表单（含 姓名/年龄/生日/城市/兴趣）
    const res = await publishForm(MULTI_TYPE_FIELDS);

    // Then 发布成功并返回该表单的 slug
    expect(res.status).toBe(201);
    const slug = ((await res.json()) as { slug?: string }).slug;
    expect(slug).toBeTypeOf("string");
    expect(slug && slug.length).toBeGreaterThan(0);

    // And 飞书表里按字段类型预建出对应的列（后台 waitUntil 跑完后断言）。
    await waitForPreCreate(mock);
    // 列出过一次现有列（决定建哪些缺列）。
    expect(mock.fieldsListCalls.length).toBeGreaterThanOrEqual(1);
    expect(mock.fieldsListCalls[0].method).toBe("GET");
    // 五个字段都建了列。
    const created = mock.fieldCreateCalls.map(
      (c) => (c.body as { field_name?: string }).field_name,
    );
    expect(created).toEqual(expect.arrayContaining(["姓名", "年龄", "生日", "城市", "兴趣"]));

    // And 数字字段建成数字列、日期字段建成日期列、单选带 options、多选带 options。
    expect(createdField(mock, "年龄")?.type).toBe(NUMBER);
    expect(createdField(mock, "生日")?.type).toBe(DATE);
    const city = createdField(mock, "城市");
    expect(city?.type).toBe(SINGLE_SELECT);
    expect(city?.property?.options?.map((o) => o.name)).toEqual(
      expect.arrayContaining(["北京", "上海", "广州"]),
    );
    const hobby = createdField(mock, "兴趣");
    expect(hobby?.type).toBe(MULTI_SELECT);
    expect(hobby?.property?.options?.map((o) => o.name)).toEqual(
      expect.arrayContaining(["阅读", "运动"]),
    );
    // And 文本字段建成文本列。
    expect(createdField(mock, "姓名")?.type).toBe(TEXT);

    // 每个建列请求只在 Authorization 头带 token（§15.7）。
    for (const c of mock.fieldCreateCalls) {
      expect(c.headers.get("authorization")).toBe(`Bearer ${UPSTREAM_TENANT_TOKEN}`);
    }
  });

  it("Scenario: 单选与多选字段预建时带上其选项", async () => {
    // Given owner 已配置可用的飞书凭据
    await configureOwner({ feishu: true });
    mock = installFeishuMock();

    // And 设计器里有一个单选字段「城市」其选项为「北京、上海、广州」
    // When owner 发布该表单
    const res = await publishForm([
      {
        id: "f_city",
        type: "select",
        label: "城市",
        options: [
          { label: "北京", value: "bj" },
          { label: "上海", value: "sh" },
          { label: "广州", value: "gz" },
        ],
      },
    ]);
    expect(res.status).toBe(201);
    await waitForPreCreate(mock);

    // Then 飞书表里建出一个单选列「城市」
    const city = createdField(mock, "城市");
    expect(city).toBeDefined();
    expect(city?.type).toBe(SINGLE_SELECT);
    // And 该列的候选项包含「北京、上海、广州」
    expect(city?.property?.options?.map((o) => o.name)).toEqual(
      expect.arrayContaining(["北京", "上海", "广州"]),
    );
  });

  it("Scenario: 未知或不支持的字段类型预建为文本列", async () => {
    // Given owner 已配置可用的飞书凭据
    await configureOwner({ feishu: true });
    mock = installFeishuMock();

    // And 设计器里有一个文件上传字段
    // When owner 发布该表单
    const res = await publishForm([{ id: "f_file", type: "file", label: "附件" }]);

    // Then 该字段在飞书表里建成文本列而非报错（发布仍 201）。
    expect(res.status).toBe(201);
    await waitForPreCreate(mock);
    const file = createdField(mock, "附件");
    expect(file).toBeDefined();
    expect(file?.type).toBe(TEXT);
    // 文本列建列不带 property（仅单选 / 多选带 options）。
    expect(file?.property).toBeUndefined();
  });

  // ===========================================================================
  // best-effort 失败策略：预建出任何岔子都不拖垮发布
  // ===========================================================================

  it("Scenario: owner 未配飞书时发布仍成功且静默跳过预建", async () => {
    // Given owner 尚未配置飞书凭据（DeepSeek only）
    await configureOwner({ feishu: false });
    // token 设 null：任何飞书调用都会 THROW —— 证明未配飞书时零上游流量。
    mock = installFeishuMock({ token: null });

    // When owner 发布一份可发布的表单
    const res = await publishForm([{ id: "f_name", type: "text", label: "姓名" }]);

    // Then 发布成功并返回该表单的 slug
    expect(res.status).toBe(201);
    const slug = ((await res.json()) as { slug?: string }).slug;
    expect(slug).toBeTypeOf("string");

    // And 不向飞书发起任何调用 And 预建被静默跳过且不产生任何错误。
    await waitForPreCreate(mock, false);
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.fieldsListCalls).toHaveLength(0);
    expect(mock.fieldCreateCalls).toHaveLength(0);
  });

  it("Scenario: 飞书连不上时发布仍成功且静默跳过预建", async () => {
    // Given owner 已配置飞书凭据但飞书上游不可达（fetch 抛网络错误）。
    await configureOwner({ feishu: true });
    const realFetch = globalThis.fetch;
    // 自建 stub：token 端点抛（模拟不可达），其它一律抛——验证失败被静默吞且不泄漏凭据。
    let errLogs: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errLogs.push(args.map((a) => String(a)).join(" "));
    };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new Request(input as RequestInfo).url;
      if (url === FEISHU_TENANT_TOKEN_URL) {
        throw new Error("ECONNREFUSED open.feishu.cn unreachable");
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    try {
      // When owner 发布该表单
      const res = await publishForm([{ id: "f_name", type: "text", label: "姓名" }]);
      // Then 发布成功并返回该表单的 slug
      expect(res.status).toBe(201);
      expect(((await res.json()) as { slug?: string }).slug).toBeTypeOf("string");
      // 让后台 best-effort 跑完。
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      globalThis.fetch = realFetch;
      console.error = origError;
    }

    // And 预建被静默跳过且不产生任何错误（发布响应已 201，无异常冒泡到此）。
    // And 日志只记录错误名而绝不记录 app_secret 或 tenant_access_token（§15.7）。
    const allLogs = errLogs.join("\n");
    expect(allLogs).not.toContain(OWNER_FEISHU_APP_SECRET);
    expect(allLogs).not.toContain(UPSTREAM_TENANT_TOKEN);
    expect(allLogs).not.toContain(OWNER_FEISHU_APP_ID);
    expect(allLogs).not.toContain(OWNER_FEISHU_APP_TOKEN);
  });

  it("Scenario: 换取 tenant_access_token 失败时发布仍成功", async () => {
    // Given owner 已配置飞书凭据但换取 token 失败（code≠0）。
    await configureOwner({ feishu: true });
    mock = installFeishuMock({ token: { status: 200, body: FEISHU_TOKEN_BAD_BODY } });

    // When owner 发布该表单
    const res = await publishForm([{ id: "f_name", type: "text", label: "姓名" }]);

    // Then 发布成功并返回该表单的 slug
    expect(res.status).toBe(201);
    expect(((await res.json()) as { slug?: string }).slug).toBeTypeOf("string");

    // And 预建被静默跳过：探了一次 token（失败），但绝不进列出 / 建列。
    await waitForPreCreate(mock);
    expect(mock.tokenCalls).toHaveLength(1);
    expect(mock.fieldsListCalls).toHaveLength(0);
    expect(mock.fieldCreateCalls).toHaveLength(0);
  });

  it("Scenario: 某一列建列失败时发布仍成功", async () => {
    // Given owner 已配置可用凭据但其中一列建列被飞书拒绝。
    await configureOwner({ feishu: true });
    mock = installFeishuMock({
      fieldsList: [{ status: 200, body: fieldsListBody([]) }],
      fieldCreate: { status: 200, body: FIELD_CREATE_BAD_BODY },
    });

    // When owner 发布该表单
    const res = await publishForm([{ id: "f_name", type: "text", label: "姓名" }]);

    // Then 发布成功并返回该表单的 slug — 建列失败被静默吞掉、不影响发布响应。
    expect(res.status).toBe(201);
    expect(((await res.json()) as { slug?: string }).slug).toBeTypeOf("string");
    // 后台确实尝试了建列（被拒，best-effort 吞掉）。
    await waitForPreCreate(mock);
    expect(mock.fieldCreateCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ===========================================================================
  // 幂等 / 不改既有列：预建只对缺列生效
  // ===========================================================================

  it("Scenario: 预建跳过已存在的列且绝不改其类型", async () => {
    // Given owner 的飞书表里已存在一个名为「姓名」的文本列。
    await configureOwner({ feishu: true });
    mock = installFeishuMock({
      fieldsList: [{ status: 200, body: fieldsListBody([{ name: "姓名", type: TEXT }]) }],
    });

    // And 设计器里有一份含「姓名」字段的表单 When owner 发布该表单
    const res = await publishForm([{ id: "f_name", type: "text", label: "姓名" }]);
    expect(res.status).toBe(201);
    await waitForPreCreate(mock);

    // Then 名为「姓名」的列被跳过、其类型保持不变 And 不向已存在的列发起改类型调用
    // （绝无任何建列 / 改类型请求）。
    expect(mock.fieldCreateCalls).toHaveLength(0);
  });

  it("Scenario: 并发下重复建列被当作幂等成功", async () => {
    // Given owner 发布表单时某列恰被另一处并发建好。
    await configureOwner({ feishu: true });
    // 列出为空 → 预建尝试建「姓名」「城市」；建列收到飞书的重复列码 1254014。
    mock = installFeishuMock({
      fieldsList: [{ status: 200, body: fieldsListBody([]) }],
      fieldCreate: { status: 200, body: FIELD_CREATE_DUP_BODY },
    });

    // When 预建尝试建该列收到飞书的重复列码（发布该多字段表单）
    const res = await publishForm([
      { id: "f_name", type: "text", label: "姓名" },
      { id: "f_city", type: "text", label: "城市" },
    ]);

    // Then 该列被视为已建成而非失败（发布仍 201、不抛）。
    expect(res.status).toBe(201);
    await waitForPreCreate(mock);
    // And 预建继续建其余缺列：两列都被尝试建（各命中 1254014 当幂等成功）。
    const created = mock.fieldCreateCalls.map(
      (c) => (c.body as { field_name?: string }).field_name,
    );
    expect(created).toEqual(expect.arrayContaining(["姓名", "城市"]));
  });

  // ===========================================================================
  // 编辑增量：PATCH /api/forms/:slug 改了 fields 只增量补建新增列
  // ===========================================================================

  it("Scenario: 编辑给表单新增一个数字字段时增量补建对应列", async () => {
    // Given owner 已发布过一份表单且飞书表里已有它原有字段的列。
    await configureOwner({ feishu: true });
    mock = installFeishuMock({
      // 发布时列出为空 → 建「姓名」；编辑后列出时「姓名」已存在 → 只建新增的「分数」。
      fieldsList: [
        { status: 200, body: fieldsListBody([]) },
        { status: 200, body: fieldsListBody([{ name: "姓名", type: TEXT }]) },
      ],
    });
    const slug = await publishFormAndGetSlug([{ id: "f_name", type: "text", label: "姓名" }]);
    await waitForPreCreate(mock);
    mock.resetCalls();

    // When owner 编辑该表单新增一个数字字段「分数」并保存。
    const res = await patchForm(slug, {
      fields: [
        { id: "f_name", type: "text", label: "姓名" },
        { id: "f_score", type: "number", label: "分数" },
      ],
    });

    // Then 编辑成功。
    expect(res.status).toBe(200);
    await waitForPreCreate(mock);

    // And 飞书表里增量补建出一个数字列「分数」And 原有已存在的列被跳过、未被改动。
    const created = mock.fieldCreateCalls.map(
      (c) => (c.body as { field_name?: string }).field_name,
    );
    expect(created).toEqual(["分数"]);
    expect(created).not.toContain("姓名");
    expect(createdField(mock, "分数")?.type).toBe(NUMBER);
  });

  it("Scenario: 编辑未改动 fields 时不触发预建", async () => {
    // Given owner 已发布过一份表单。
    await configureOwner({ feishu: true });
    mock = installFeishuMock();
    const slug = await publishFormAndGetSlug([{ id: "f_name", type: "text", label: "姓名" }]);
    await waitForPreCreate(mock);
    mock.resetCalls();

    // When owner 仅把该表单状态改为关闭而未改动字段。
    const res = await patchForm(slug, { status: "closed" });

    // Then 编辑成功。
    expect(res.status).toBe(200);
    // And 不触发任何预建调用（PATCH 未带 fields → route 不调 preCreate）。
    await waitForPreCreate(mock, false);
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.fieldsListCalls).toHaveLength(0);
    expect(mock.fieldCreateCalls).toHaveLength(0);
  });

  // ===========================================================================
  // 提交按列真实类型写值落库（既有列冲突兜底方案 a）
  // ===========================================================================

  it("Scenario: 提交把数字答案按数字列写入", async () => {
    // Given 一份已发布表单的飞书表里「年龄」是数字列。
    await configureOwner({ feishu: true });
    mock = installFeishuMock({
      // 提交时列出：年龄 是数字列(2)。
      fieldsList: [{ status: 200, body: fieldsListBody([{ name: "年龄", type: NUMBER }]) }],
    });
    const slug = await publishFormAndGetSlug([{ id: "f_age", type: "number", label: "年龄" }]);
    await waitForPreCreate(mock);
    mock.resetCalls();

    // When 答题者提交「年龄」为「28」
    const res = await postSubmit({ formSlug: slug, answers: [{ label: "年龄", value: "28" }] });

    // Then 提交成功并返回 recordId
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; recordId?: string };
    expect(body.ok).toBe(true);
    expect(body.recordId).toBe(UPSTREAM_RECORD_ID);

    // And 「年龄」以数字而非文本写入飞书（fields.年龄 === 28，JS number）。
    expect(mock.recordCalls).toHaveLength(1);
    const fields = (mock.recordCalls[0].body as { fields?: Record<string, unknown> }).fields;
    expect(fields?.["年龄"]).toBe(28);
    expect(typeof fields?.["年龄"]).toBe("number");
  });

  it("Scenario: 提交把日期答案按毫秒时间戳写入日期列", async () => {
    // Given 一份已发布表单的飞书表里「生日」是日期列。
    await configureOwner({ feishu: true });
    mock = installFeishuMock({
      fieldsList: [{ status: 200, body: fieldsListBody([{ name: "生日", type: DATE }]) }],
    });
    const slug = await publishFormAndGetSlug([{ id: "f_birth", type: "date", label: "生日" }]);
    await waitForPreCreate(mock);
    mock.resetCalls();

    // When 答题者提交「生日」为一个日期串。
    const dateStr = "2024-03-15";
    const res = await postSubmit({ formSlug: slug, answers: [{ label: "生日", value: dateStr }] });

    // Then 提交成功并返回 recordId。
    expect(res.status).toBe(200);
    expect(((await res.json()) as { recordId?: string }).recordId).toBe(UPSTREAM_RECORD_ID);

    // And 「生日」以毫秒时间戳写入日期列（=== Date.parse(dateStr)，JS number）。
    const fields = (mock.recordCalls[0].body as { fields?: Record<string, unknown> }).fields;
    expect(fields?.["生日"]).toBe(Date.parse(dateStr));
    expect(typeof fields?.["生日"]).toBe("number");
  });

  it("Scenario: 提交把多选答案按多选列写入字符串数组", async () => {
    // Given 一份已发布表单的飞书表里「兴趣」是多选列。
    await configureOwner({ feishu: true });
    mock = installFeishuMock({
      fieldsList: [{ status: 200, body: fieldsListBody([{ name: "兴趣", type: MULTI_SELECT }]) }],
    });
    const slug = await publishFormAndGetSlug([
      {
        id: "f_hobby",
        type: "checkbox",
        label: "兴趣",
        options: [
          { label: "阅读", value: "read" },
          { label: "运动", value: "sport" },
        ],
      },
    ]);
    await waitForPreCreate(mock);
    mock.resetCalls();

    // When 答题者提交「兴趣」为「阅读、运动」。
    const res = await postSubmit({
      formSlug: slug,
      answers: [{ label: "兴趣", value: ["阅读", "运动"] }],
    });

    // Then 提交成功并返回 recordId。
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok?: boolean }).ok).toBe(true);

    // And 「兴趣」以字符串数组写入多选列。
    const fields = (mock.recordCalls[0].body as { fields?: Record<string, unknown> }).fields;
    expect(fields?.["兴趣"]).toEqual(["阅读", "运动"]);
  });

  it("Scenario: 数字列收到非数字脏值时跳过该格而不整条失败", async () => {
    // Given 一份已发布表单的飞书表里「年龄」是数字列、「姓名」是文本列。
    await configureOwner({ feishu: true });
    mock = installFeishuMock({
      fieldsList: [
        {
          status: 200,
          body: fieldsListBody([
            { name: "姓名", type: TEXT },
            { name: "年龄", type: NUMBER },
          ]),
        },
      ],
    });
    const slug = await publishFormAndGetSlug([
      { id: "f_name", type: "text", label: "姓名" },
      { id: "f_age", type: "number", label: "年龄" },
    ]);
    await waitForPreCreate(mock);
    mock.resetCalls();

    // When 答题者在「年龄」里填了一个非数字串（其余字段正常）。
    const res = await postSubmit({
      formSlug: slug,
      answers: [
        { label: "姓名", value: "张三" },
        { label: "年龄", value: "不是数字" },
      ],
    });

    // Then 其余字段照常写入且提交成功。
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok?: boolean }).ok).toBe(true);
    const fields = (mock.recordCalls[0].body as { fields?: Record<string, unknown> }).fields;
    // And 该非数字的「年龄」格被跳过不写入（键不在 fields 里）。
    expect(fields).not.toHaveProperty("年龄");
    // 姓名 照常写入。
    expect(fields?.["姓名"]).toBe("张三");
  });

  it("Scenario: 旧文本列按其真实类型写值而非按字段声明类型", async () => {
    // Given 一份表单的飞书表里「年龄」此前被自愈建成了文本列(type 1)。
    await configureOwner({ feishu: true });
    mock = installFeishuMock({
      // 列出时「年龄」真实类型是文本(1)，即便字段声明是 number。
      fieldsList: [{ status: 200, body: fieldsListBody([{ name: "年龄", type: TEXT }]) }],
    });
    // And 该表单的「年龄」字段声明类型现在是数字。
    const slug = await publishFormAndGetSlug([{ id: "f_age", type: "number", label: "年龄" }]);
    await waitForPreCreate(mock);
    mock.resetCalls();

    // When 答题者提交「年龄」。
    const res = await postSubmit({ formSlug: slug, answers: [{ label: "年龄", value: "28" }] });

    // Then 提交成功并返回 recordId。
    expect(res.status).toBe(200);
    expect(((await res.json()) as { recordId?: string }).recordId).toBe(UPSTREAM_RECORD_ID);

    // And 「年龄」按列的真实类型(文本)写入（值为字符串 "28" 而非数字 28），不被飞书因类型
    // 不符整条拒掉（验方案 a：按列真实类型而非字段声明类型写）。
    const fields = (mock.recordCalls[0].body as { fields?: Record<string, unknown> }).fields;
    expect(fields?.["年龄"]).toBe("28");
    expect(typeof fields?.["年龄"]).toBe("string");
  });

  // ===========================================================================
  // 提交路径的自愈兜底升级：缺列时按字段 type 建对应类型列再重试一次
  // ===========================================================================

  it("Scenario: 提交遇缺列时按字段类型自愈建列再重试", async () => {
    // Given 一份已发布表单的飞书表里还缺一个数字字段对应的列。
    await configureOwner({ feishu: true });
    mock = installFeishuMock({
      // 提交时两次列出都为空（稳态写值前 + 自愈补列前）→ 缺「分数」列。
      fieldsList: [
        { status: 200, body: fieldsListBody([]) },
        { status: 200, body: fieldsListBody([]) },
      ],
      // 首写缺列(1254045) → 自愈建列 → 重试写成功。
      record: [
        { status: 200, body: BITABLE_FIELD_MISSING_BODY },
        { status: 200, body: BITABLE_OK_BODY },
      ],
    });
    const slug = await publishFormAndGetSlug([
      { id: "f_score", type: "number", label: "分数", required: true },
    ]);
    await waitForPreCreate(mock);
    mock.resetCalls();

    // When 答题者首次提交触发该列缺失。
    const res = await postSubmit({ formSlug: slug, answers: [{ label: "分数", value: "95" }] });

    // Then 后端按该字段类型把缺列建成数字列。
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok?: boolean }).ok).toBe(true);
    const score = createdField(mock, "分数");
    expect(score).toBeDefined();
    expect(score?.type).toBe(NUMBER);

    // And 补列后重试一次写入并提交成功（add-record 恰好两次）。
    expect(mock.recordCalls).toHaveLength(2);

    // And 重试写入携带**类型化值**（Bug #1）：缺列按字段映射类型(number)格式化，故两次写入的
    // 「分数」都是 JS number 95（而非文本 "95"），重试才能命中自愈建好的数字列、不被飞书拒。
    const firstFields = (mock.recordCalls[0].body as { fields?: Record<string, unknown> }).fields;
    const retryFields = (mock.recordCalls[1].body as { fields?: Record<string, unknown> }).fields;
    expect(firstFields?.["分数"]).toBe(95);
    expect(typeof firstFields?.["分数"]).toBe("number");
    expect(retryFields?.["分数"]).toBe(95);
    expect(typeof retryFields?.["分数"]).toBe("number");
  });

  it("Scenario: 分组字段缺列自愈——group 里的 number 子字段缺列时建数字列再重试 (Bug #2)", async () => {
    // Given 一份表单含一个 group「成绩」其 number 子字段「分数」，飞书表里还缺「分数」列。
    await configureOwner({ feishu: true });
    mock = installFeishuMock({
      // 提交时两次列出都为空（稳态写值前 + 自愈补列前）→ 缺「分数」列。
      fieldsList: [
        { status: 200, body: fieldsListBody([]) },
        { status: 200, body: fieldsListBody([]) },
      ],
      // 首写缺列(1254045) → 自愈建列 → 重试写成功。
      record: [
        { status: 200, body: BITABLE_FIELD_MISSING_BODY },
        { status: 200, body: BITABLE_OK_BODY },
      ],
    });
    const slug = await publishFormAndGetSlug([
      {
        id: "g_scores",
        type: "group",
        label: "成绩",
        children: [{ id: "f_score", type: "number", label: "分数" }],
      },
    ]);
    await waitForPreCreate(mock);
    mock.resetCalls();

    // When 答题者提交分组子字段「分数」为「88」触发缺列。
    const res = await postSubmit({ formSlug: slug, answers: [{ label: "分数", value: "88" }] });

    // Then 后端把缺的分组子字段列「分数」自愈建成数字列（NUMBER），而非漏建 / 文本列。
    // 这正是 Bug #2 的回归点：自愈过滤前必须 flattenLeafFields 摊平 group，否则顶层 label「成绩」
    // 不是写入键、子字段「分数」埋在 children 里 → 漏建 → 重试仍缺列。
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok?: boolean }).ok).toBe(true);
    const score = createdField(mock, "分数");
    expect(score).toBeDefined();
    expect(score?.type).toBe(NUMBER);

    // And 补列后重试一次写入并提交成功，且写入的「分数」是类型化的 JS number 88（Bug #1）。
    expect(mock.recordCalls).toHaveLength(2);
    const retryFields = (mock.recordCalls[1].body as { fields?: Record<string, unknown> }).fields;
    expect(retryFields?.["分数"]).toBe(88);
    expect(typeof retryFields?.["分数"]).toBe("number");
  });

  // ===========================================================================
  // 凭据边界：全程不出网
  // ===========================================================================

  it("Scenario: 提交成功响应只含 ok 与 recordId", async () => {
    // Given 一份可正常写入的已发布表单。
    await configureOwner({ feishu: true });
    mock = installFeishuMock({
      fieldsList: [{ status: 200, body: fieldsListBody([{ name: "年龄", type: NUMBER }]) }],
    });
    const slug = await publishFormAndGetSlug([{ id: "f_age", type: "number", label: "年龄" }]);
    await waitForPreCreate(mock);
    mock.resetCalls();

    // When 答题者提交。
    const res = await postSubmit({ formSlug: slug, answers: [{ label: "年龄", value: "28" }] });
    expect(res.status).toBe(200);

    // Then 响应只含 ok 与 recordId（键集合恰为 {ok, recordId}）。
    const raw = await res.clone().text();
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["ok", "recordId"]);
    expect(body.ok).toBe(true);
    expect(body.recordId).toBe(UPSTREAM_RECORD_ID);

    // And 响应里绝不含写入的字段值、tenant_access_token 或 app_secret。
    expect(raw).not.toContain("28"); // 写入的字段值不回显
    expect(raw).not.toContain(UPSTREAM_TENANT_TOKEN);
    expect(raw).not.toContain(OWNER_FEISHU_APP_SECRET);
    expect(raw).not.toContain(OWNER_FEISHU_APP_TOKEN);
    for (const [, value] of res.headers) {
      expect(value).not.toContain(UPSTREAM_TENANT_TOKEN);
      expect(value).not.toContain(OWNER_FEISHU_APP_SECRET);
    }
  });
});
