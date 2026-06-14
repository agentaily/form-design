import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { applySchema, resetConfig, resetForms, login, authHeader } from "./helpers";
import { FEISHU_BITABLE_FIELDS_URL, FEISHU_FIELDS_LIST_PAGE_SIZE } from "../src/submit";
import {
  FEISHU_BITABLE_FIELD_TYPE,
  FEISHU_BITABLE_FIELD_BY_ID_URL,
  FEISHU_BITABLE_APPS_URL,
  FEISHU_BITABLE_TABLES_URL,
} from "../src/feishu-schema";
import { FEISHU_TENANT_TOKEN_URL } from "../src/feishu";

// Outer-loop acceptance specs realizing features/feishu-column-rename.feature
// (SPEC §16.8.7 改字段标签 → 同步把飞书对应列改名而非新建一列，best-effort，v1 只改名).
//
// Driven through the real Hono app in workerd via SELF.fetch with ALL Feishu upstreams
// mocked locally — never hits open.feishu.cn. The edit path (PATCH /api/forms/:slug 带
// fields) reads the OLD fields from D1 (落库前), then in ONE waitUntil continuation runs
//   ① syncBitableColumnRenamesBestEffort(oldFields → newFields)  —— 先改名
//   ② preCreateBitableColumnsBestEffort(newFields)               —— 后预建
// so a renamed column is改名 (PUT) before pre-create lists existing columns and skips it.
//
// 被验证的行为线（§16.8.7）：
//   - 改 label → PUT .../fields/{field_id} 把那一列改名（body 带原 type）、不 POST 新建同名列。
//   - 改名先于预建：同批又改名又新增 → 先 PUT 后 POST；被改名列不被预建重复建。
//   - 按 field.id 配对（非按 label 文本），分组子字段经摊平照样改名。
//   - v1 范围：删字段 → 列不动（无 PUT/DELETE）；仅改类型 / 仅改 status → 不触发改名链；
//     新增 → 照常 POST 建列、不触发改名。
//   - 冲突逐项跳过：撞名 → 不 PUT 覆盖；旧 label 找不到列 → 跳过；单项 PUT 失败 → 不影响其它项 +
//     编辑仍 200。
//   - best-effort：未配飞书 / 飞书连不上 / 换 token 失败 → 编辑仍 200、静默跳过、日志不漏凭据。
//   - 凭据边界：编辑响应 / 改名相关日志绝不含 app_secret / tenant_access_token / 列值。
//
// Contract: SPEC.md §16.8.7、§16.8.1、§15.7.

const BASE = "https://api.local";

const { TEXT, NUMBER } = FEISHU_BITABLE_FIELD_TYPE;

// Distinctive credential fixtures — long + unmistakable so a substring scan of any
// response body / message / log line catches an accidental leak unambiguously (§15.7).
const OWNER_DEEPSEEK_KEY = "sk-owner-DEEPSEEK-secret-0123456789abcdef";
const OWNER_FEISHU_APP_ID = "cli_renameAppId9999";
const OWNER_FEISHU_APP_SECRET = "feishu-RENAME-APP-SECRET-qrstuvwxyz-7777-SHHH";
const OWNER_FEISHU_APP_TOKEN = "bascnRenameAppTokenXYZ";
const OWNER_FEISHU_TABLE_ID = "tblRename123";

const UPSTREAM_TENANT_TOKEN = "t-rename-TENANTtoken-SECRET-9999";

const FIELDS_URL = FEISHU_BITABLE_FIELDS_URL.replace("{app_token}", OWNER_FEISHU_APP_TOKEN).replace(
  "{table_id}",
  OWNER_FEISHU_TABLE_ID,
);
// The rename single-column endpoint base (sans {field_id}); the actual PUT URL is
// `${RENAME_BASE}/<fieldId>`. We match the rename call by detecting this prefix + PUT.
const RENAME_BASE = FEISHU_BITABLE_FIELD_BY_ID_URL.replace("{app_token}", OWNER_FEISHU_APP_TOKEN)
  .replace("{table_id}", OWNER_FEISHU_TABLE_ID)
  .replace("/{field_id}", "");

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

const FIELD_CREATE_OK_BODY = JSON.stringify({ code: 0, msg: "success" });
const RENAME_OK_BODY = JSON.stringify({ code: 0, msg: "success" });
const RENAME_BAD_BODY = JSON.stringify({ code: 1254005, msg: "FieldNameDuplicated" });

// §16.9 发布即自动建表端点 + OK 夹具：建 app 返回 OWNER_FEISHU_APP_TOKEN、建表返回
// OWNER_FEISHU_TABLE_ID，使发布把 per-form 表落成既有 FIELDS_URL/RENAME_BASE 那一对，
// 编辑改名据 form 行读到这张表（§16.9）。
const TABLES_URL = FEISHU_BITABLE_TABLES_URL.replace("{app_token}", OWNER_FEISHU_APP_TOKEN);
const APP_CREATE_OK_BODY = JSON.stringify({
  code: 0,
  msg: "success",
  data: { app: { app_token: OWNER_FEISHU_APP_TOKEN } },
});
const TABLE_CREATE_OK_BODY = JSON.stringify({
  code: 0,
  msg: "success",
  data: { table_id: OWNER_FEISHU_TABLE_ID },
});

/**
 * A list-fields OK body carrying each column's name, real type AND飞书 `field_id`
 * (§16.8.7：改名链路靠 field_id 定位列；listBitableColumnsDetailed 只取有 field_id 的列).
 */
function fieldsListBody(cols: Array<{ name: string; type: number; fieldId: string }>): string {
  return JSON.stringify({
    code: 0,
    msg: "success",
    data: {
      items: cols.map((c) => ({ field_name: c.name, type: c.type, field_id: c.fieldId })),
    },
  });
}

// --- Feishu fetch mock for the rename chain (default-deny) ---------------------
//
// Endpoints: ① token exchange, ② list-fields (GET .../fields), ③ rename one column
// (PUT .../fields/{field_id}), ④ create-field (POST .../fields). We dispatch on URL /
// pathname + method. list-fields takes a SEQUENCE of replies (one per call) so the
// publish-list and the edit-list can differ; rename + create get the SAME configured
// reply each call (unless an `onRename` hook overrides per field_id). Any unmatched
// call THROWS — talking to the wrong place / origin fails loudly (never hits the net).

interface UpstreamReply {
  status: number;
  body: string;
}

interface FeishuMockOpts {
  /** Reply for the token exchange. Default OK. Set `null` to forbid (must NOT call). */
  token?: UpstreamReply | null;
  /** Sequenced replies for list-fields (GET .../fields). Default [empty list]. */
  fieldsList?: UpstreamReply[];
  /** Reply for each rename (PUT .../fields/{field_id}). Default OK. */
  rename?: UpstreamReply;
  /**
   * Per-field_id rename reply override (e.g. one rename rejected). Keyed by the
   * field_id segment of the PUT URL. Falls back to {@link FeishuMockOpts.rename}.
   */
  renameByFieldId?: Record<string, UpstreamReply>;
  /** Reply for each create-field (POST .../fields). Default OK. */
  fieldCreate?: UpstreamReply;
}

interface CapturedCall {
  url: string;
  method: string;
  headers: Headers;
  bodyText: string;
  body: unknown;
  /** For rename calls: the `{field_id}` segment from the PUT URL. */
  fieldId?: string;
}

interface FeishuMock {
  readonly tokenCalls: CapturedCall[];
  readonly fieldsListCalls: CapturedCall[];
  readonly renameCalls: CapturedCall[];
  readonly fieldCreateCalls: CapturedCall[];
  /** Every captured call, in real fan-out order (to assert PUT-before-POST ordering). */
  readonly allCalls: CapturedCall[];
  resetCalls(): void;
  restore(): void;
}

function installFeishuMock(opts: FeishuMockOpts = {}): FeishuMock {
  const tokenCalls: CapturedCall[] = [];
  const fieldsListCalls: CapturedCall[] = [];
  const renameCalls: CapturedCall[] = [];
  const fieldCreateCalls: CapturedCall[] = [];
  const allCalls: CapturedCall[] = [];

  const tokenReply: UpstreamReply | null =
    opts.token === undefined ? { status: 200, body: FEISHU_TOKEN_OK_BODY } : opts.token;
  const fieldsListReplies: UpstreamReply[] = opts.fieldsList ?? [
    { status: 200, body: fieldsListBody([]) },
  ];
  const renameReply: UpstreamReply = opts.rename ?? { status: 200, body: RENAME_OK_BODY };
  const renameByFieldId = opts.renameByFieldId ?? {};
  const fieldCreateReply: UpstreamReply = opts.fieldCreate ?? {
    status: 200,
    body: FIELD_CREATE_OK_BODY,
  };

  // Persistent list-fields cursor — advances across the WHOLE mock lifetime (publish
  // pre-create list + the PATCH rename/pre-create lists) and is NOT rewound by
  // resetCalls(), so a test can give publish one list reply and the edit the NEXT.
  let fieldsListSeq = 0;

  const realFetch = globalThis.fetch;
  const reply = (r: UpstreamReply): Response =>
    new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
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
      allCalls.push(captured);
      return reply(tokenReply);
    }
    // §16.9 发布即自动建表：建 app（POST /apps）/ 建数据表（POST /apps/{token}/tables）恒 OK，
    // 让发布把 per-form 表落进 form 行；编辑改名据此定位该表。两端点在发布后台 best-effort 调用。
    if (req.url === FEISHU_BITABLE_APPS_URL && req.method === "POST") {
      allCalls.push(captured);
      return reply({ status: 200, body: APP_CREATE_OK_BODY });
    }
    if (req.url === TABLES_URL && req.method === "POST") {
      allCalls.push(captured);
      return reply({ status: 200, body: TABLE_CREATE_OK_BODY });
    }
    // Rename single column: PUT .../fields/{field_id}. Its pathname has an extra segment
    // beyond the bare fields endpoint, so match it FIRST (before the bare-fields branch).
    if (req.method === "PUT" && req.url.startsWith(`${RENAME_BASE}/`)) {
      captured.fieldId = req.url.slice(`${RENAME_BASE}/`.length).split(/[?#]/)[0];
      renameCalls.push(captured);
      allCalls.push(captured);
      return reply(renameByFieldId[captured.fieldId] ?? renameReply);
    }
    if (pathKey(req.url) === FIELDS_PATH) {
      if (req.method === "GET") {
        const r = seqReply(fieldsListReplies, fieldsListSeq++);
        fieldsListCalls.push(captured);
        allCalls.push(captured);
        return r;
      }
      if (req.method === "POST") {
        fieldCreateCalls.push(captured);
        allCalls.push(captured);
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
    fieldsListCalls,
    renameCalls,
    fieldCreateCalls,
    allCalls,
    resetCalls: () => {
      tokenCalls.length = 0;
      fieldsListCalls.length = 0;
      renameCalls.length = 0;
      fieldCreateCalls.length = 0;
      allCalls.length = 0;
    },
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

// --- setup helpers ------------------------------------------------------------

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
  children?: FieldDef[];
}

async function publishFormAndGetSlug(fields: FieldDef[]): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/forms`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader(token) },
    body: JSON.stringify({ meta: { title: "改名同步测试表单" }, fields }),
  });
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

/**
 * Wait until the background best-effort sync (§16.8.7, runs in c.executionCtx.waitUntil)
 * has reached its first upstream hop — the token exchange — then settle so the list /
 * rename / create calls that follow also land. After this returns, the mock's captured
 * arrays hold the COMPLETE fan-out for assertions. `expectToken=false` is used when the
 * owner is NOT configured / no fields change (no fan-out at all): we just give the
 * background a beat and assert it stayed quiet.
 */
async function waitForSync(mock: FeishuMock, expectToken = true): Promise<void> {
  const deadline = Date.now() + 1000;
  if (expectToken) {
    while (mock.tokenCalls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  // Settle so list + rename + create calls that follow the token also land.
  await new Promise((r) => setTimeout(r, 50));
}

/** The rename PUT body for a given target column name (or undefined). */
function renamedTo(
  mock: FeishuMock,
  newLabel: string,
): { field_name?: string; type?: number } | undefined {
  const call = mock.renameCalls.find(
    (c) => (c.body as { field_name?: string }).field_name === newLabel,
  );
  return call?.body as { field_name?: string; type?: number } | undefined;
}

/** Names of all create-field POSTs the mock saw. */
function createdNames(mock: FeishuMock): string[] {
  return mock.fieldCreateCalls.map((c) => (c.body as { field_name?: string }).field_name ?? "");
}

describe("改字段标签同步飞书列改名 (features/feishu-column-rename.feature)", () => {
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
  // 核心：改 label → 改名那一列、不新建
  // ===========================================================================

  it("Scenario: 改一个字段的标签时飞书把对应列改名而不新建列", async () => {
    // Given owner 已配置可用的飞书多维表格凭据
    await configureOwner({ feishu: true });
    // And owner 已发布过一份含字段「电话」的表单且飞书表里有一个名为「电话」的列。
    mock = installFeishuMock({
      // 发布时列出为空（建「电话」）；编辑链路列出两次：
      //   ① 改名同步列出 → 含「电话」列（带 field_id 供定位）；
      //   ② 改名 PUT 后、预建再列出 → 那列已是「联系电话」（faithful 飞书的改名后状态），
      //      故预建看到它已存在便跳过、绝不重复建。
      fieldsList: [
        { status: 200, body: fieldsListBody([]) },
        { status: 200, body: fieldsListBody([{ name: "电话", type: TEXT, fieldId: "fld_phone" }]) },
        {
          status: 200,
          body: fieldsListBody([{ name: "联系电话", type: TEXT, fieldId: "fld_phone" }]),
        },
      ],
    });
    const slug = await publishFormAndGetSlug([{ id: "f_phone", type: "text", label: "电话" }]);
    await waitForSync(mock);
    mock.resetCalls();

    // When owner 编辑该表单把「电话」字段（同 id）的标签改为「联系电话」并保存。
    const res = await patchForm(slug, {
      fields: [{ id: "f_phone", type: "text", label: "联系电话" }],
    });

    // Then 编辑成功。
    expect(res.status).toBe(200);
    await waitForSync(mock);

    // And 飞书表里那一列被改名为「联系电话」（PUT .../fields/fld_phone，body.field_name 新名）。
    expect(mock.renameCalls).toHaveLength(1);
    expect(mock.renameCalls[0].method).toBe("PUT");
    expect(mock.renameCalls[0].fieldId).toBe("fld_phone");
    expect(renamedTo(mock, "联系电话")?.field_name).toBe("联系电话");

    // And 系统不在飞书新建名为「联系电话」的列（预建看到改名后的列已存在便跳过）。
    expect(createdNames(mock)).not.toContain("联系电话");
    // 改名前已收集到「电话」列里的数据仍在这一列里——改名只动列名 / 不动列里的记录(无删列调用)。
    expect(mock.allCalls.every((c) => c.method !== "DELETE")).toBe(true);
  });

  it("Scenario: 改名按字段 id 配对而非按标签文本匹配", async () => {
    // Given owner 已配置可用的飞书凭据 And 已发布表单，某字段 id 不变但标签从「旧名」改成「新名」。
    await configureOwner({ feishu: true });
    mock = installFeishuMock({
      // ① 改名同步列出含「旧名」列；② 改名后预建列出 → 已是「新名」(同 field_id) → 预建跳过。
      fieldsList: [
        { status: 200, body: fieldsListBody([]) },
        { status: 200, body: fieldsListBody([{ name: "旧名", type: TEXT, fieldId: "fld_keep" }]) },
        { status: 200, body: fieldsListBody([{ name: "新名", type: TEXT, fieldId: "fld_keep" }]) },
      ],
    });
    const slug = await publishFormAndGetSlug([{ id: "f_keep", type: "text", label: "旧名" }]);
    await waitForSync(mock);
    mock.resetCalls();

    // When owner 保存该编辑（同 id，label 旧名→新名）。
    const res = await patchForm(slug, {
      fields: [{ id: "f_keep", type: "text", label: "新名" }],
    });
    expect(res.status).toBe(200);
    await waitForSync(mock);

    // Then 系统据不变的 id 认出是同一字段被改名 And 用旧标签「旧名」定位列并改名为「新名」。
    expect(mock.renameCalls).toHaveLength(1);
    // 定位的是「旧名」那列的 field_id（按 id 配对 → 旧 label 定位列 → 改成新 label）。
    expect(mock.renameCalls[0].fieldId).toBe("fld_keep");
    expect(renamedTo(mock, "新名")?.field_name).toBe("新名");
    // 绝不按「新名」这个文本去匹配 / 新建一列。
    expect(createdNames(mock)).not.toContain("新名");
  });

  it("Scenario: 改名时带回该列原有类型只改名不改类型", async () => {
    // Given owner 的飞书表里「年龄」是一个数字列(2)。
    await configureOwner({ feishu: true });
    mock = installFeishuMock({
      fieldsList: [
        { status: 200, body: fieldsListBody([]) },
        // ① 改名同步列出「年龄」的真实类型是数字(2)，带 field_id；
        // ② 改名后预建列出 → 已是「周岁」(同 field_id, 仍 NUMBER) → 跳过、不重复建。
        { status: 200, body: fieldsListBody([{ name: "年龄", type: NUMBER, fieldId: "fld_age" }]) },
        { status: 200, body: fieldsListBody([{ name: "周岁", type: NUMBER, fieldId: "fld_age" }]) },
      ],
    });
    const slug = await publishFormAndGetSlug([{ id: "f_age", type: "number", label: "年龄" }]);
    await waitForSync(mock);
    mock.resetCalls();

    // And owner 把「年龄」字段的标签改为「周岁」 When owner 保存该编辑。
    const res = await patchForm(slug, {
      fields: [{ id: "f_age", type: "number", label: "周岁" }],
    });
    expect(res.status).toBe(200);
    await waitForSync(mock);

    // Then 飞书改名调用带上该列原有的数字类型(2)（只改名不改类型；带回列现有类型）。
    expect(mock.renameCalls).toHaveLength(1);
    const body = renamedTo(mock, "周岁");
    expect(body?.field_name).toBe("周岁");
    // And 该列改名为「周岁」后仍是数字列——PUT body.type 带回原 NUMBER。
    expect(body?.type).toBe(NUMBER);
    // 改名后预建看到「周岁」已存在 → 跳过、绝不按新 label 重复建一个数字列。
    expect(createdNames(mock)).not.toContain("周岁");
  });

  // ===========================================================================
  // 顺序铁律：改名先于预建
  // ===========================================================================

  it("Scenario: 改名先于预建因而被改名的列不会被预建重复建出", async () => {
    // Given owner 已配置可用凭据 And 把「电话」改名为「联系电话」并同时新增字段「邮箱」。
    await configureOwner({ feishu: true });
    mock = installFeishuMock({
      // 发布时列出为空（建「电话」）；编辑链路里：改名同步先列出含「电话」列；
      // 改名后预建再列出时，「电话」已改名为「联系电话」、缺「邮箱」。
      fieldsList: [
        { status: 200, body: fieldsListBody([]) },
        { status: 200, body: fieldsListBody([{ name: "电话", type: TEXT, fieldId: "fld_phone" }]) },
        {
          status: 200,
          body: fieldsListBody([{ name: "联系电话", type: TEXT, fieldId: "fld_phone" }]),
        },
      ],
    });
    const slug = await publishFormAndGetSlug([{ id: "f_phone", type: "text", label: "电话" }]);
    await waitForSync(mock);
    mock.resetCalls();

    // When owner 保存该编辑（电话→联系电话 + 新增 邮箱）。
    const res = await patchForm(slug, {
      fields: [
        { id: "f_phone", type: "text", label: "联系电话" },
        { id: "f_email", type: "text", label: "邮箱" },
      ],
    });
    expect(res.status).toBe(200);
    await waitForSync(mock);

    // Then 系统先把「电话」列改名为「联系电话」再做预建（PUT 早于 POST 建列）。
    expect(mock.renameCalls).toHaveLength(1);
    expect(renamedTo(mock, "联系电话")?.field_name).toBe("联系电话");
    const firstRenameIdx = mock.allCalls.findIndex((c) => c.method === "PUT");
    const firstCreateIdx = mock.allCalls.findIndex(
      (c) => c.method === "POST" && pathKey(c.url) === FIELDS_PATH,
    );
    expect(firstRenameIdx).toBeGreaterThanOrEqual(0);
    expect(firstCreateIdx).toBeGreaterThan(firstRenameIdx);

    // And 预建看到「联系电话」列已存在便跳过它 And 只为新增的「邮箱」建出一个新列。
    expect(createdNames(mock)).toEqual(["邮箱"]);
    // And 飞书表里不存在两个「联系电话」列——绝无按新 label 重复建「联系电话」。
    expect(createdNames(mock)).not.toContain("联系电话");
  });

  // ===========================================================================
  // 分组子字段改名
  // ===========================================================================

  it("Scenario: 分组里的子字段改名也同步到飞书列", async () => {
    // Given owner 已配置可用凭据 And 表单某分组里有一个子字段其飞书列名为「街道」。
    await configureOwner({ feishu: true });
    mock = installFeishuMock({
      fieldsList: [
        { status: 200, body: fieldsListBody([]) },
        // ① 改名同步列出含「街道」列；② 改名后预建列出 → 已是「详细地址」(同 field_id) → 跳过。
        {
          status: 200,
          body: fieldsListBody([{ name: "街道", type: TEXT, fieldId: "fld_street" }]),
        },
        {
          status: 200,
          body: fieldsListBody([{ name: "详细地址", type: TEXT, fieldId: "fld_street" }]),
        },
      ],
    });
    const slug = await publishFormAndGetSlug([
      {
        id: "g_addr",
        type: "group",
        label: "地址",
        children: [{ id: "f_street", type: "text", label: "街道" }],
      },
    ]);
    await waitForSync(mock);
    mock.resetCalls();

    // When owner 把该子字段标签从「街道」改为「详细地址」并保存（group 经摊平参与改名）。
    const res = await patchForm(slug, {
      fields: [
        {
          id: "g_addr",
          type: "group",
          label: "地址",
          children: [{ id: "f_street", type: "text", label: "详细地址" }],
        },
      ],
    });
    expect(res.status).toBe(200);
    await waitForSync(mock);

    // Then 飞书表里「街道」列被改名为「详细地址」（定位 fld_street → PUT 改名）。
    expect(mock.renameCalls).toHaveLength(1);
    expect(mock.renameCalls[0].fieldId).toBe("fld_street");
    expect(renamedTo(mock, "详细地址")?.field_name).toBe("详细地址");
    expect(createdNames(mock)).not.toContain("详细地址");
  });

  // ===========================================================================
  // v1 范围：删 / 改类型 / 新增照常 / 排序不同步
  // ===========================================================================

  it("Scenario: 删字段时飞书那一列保留不动且不删已收数据", async () => {
    // Given owner 已配置可用凭据 And 已发布含字段「备注」的表单且飞书「备注」列里已有数据。
    await configureOwner({ feishu: true });
    mock = installFeishuMock({
      fieldsList: [
        { status: 200, body: fieldsListBody([]) },
        {
          status: 200,
          body: fieldsListBody([
            { name: "姓名", type: TEXT, fieldId: "fld_name" },
            { name: "备注", type: TEXT, fieldId: "fld_note" },
          ]),
        },
      ],
    });
    const slug = await publishFormAndGetSlug([
      { id: "f_name", type: "text", label: "姓名" },
      { id: "f_note", type: "text", label: "备注" },
    ]);
    await waitForSync(mock);
    mock.resetCalls();

    // When owner 编辑该表单删除「备注」字段并保存（新 fields 不含 f_note）。
    const res = await patchForm(slug, {
      fields: [{ id: "f_name", type: "text", label: "姓名" }],
    });

    // Then 编辑成功。
    expect(res.status).toBe(200);
    await waitForSync(mock);

    // And 飞书表里「备注」列仍在且其中数据未被删除 And 系统不向飞书发起任何删列调用。
    // 删字段不在 v1 同步范围：既无改名(无 PUT 针对它)、也无任何删列(无 DELETE)。
    expect(mock.renameCalls).toHaveLength(0);
    expect(mock.allCalls.every((c) => c.method !== "DELETE")).toBe(true);
  });

  it("Scenario: 新增字段照常预建对应列且不触发改名", async () => {
    // Given owner 已配置可用凭据 And 已发布过一份表单。
    await configureOwner({ feishu: true });
    mock = installFeishuMock({
      fieldsList: [
        { status: 200, body: fieldsListBody([]) },
        { status: 200, body: fieldsListBody([{ name: "姓名", type: TEXT, fieldId: "fld_name" }]) },
      ],
    });
    const slug = await publishFormAndGetSlug([{ id: "f_name", type: "text", label: "姓名" }]);
    await waitForSync(mock);
    mock.resetCalls();

    // When owner 编辑该表单仅新增一个字段「分数」并保存。
    const res = await patchForm(slug, {
      fields: [
        { id: "f_name", type: "text", label: "姓名" },
        { id: "f_score", type: "number", label: "分数" },
      ],
    });

    // Then 编辑成功。
    expect(res.status).toBe(200);
    await waitForSync(mock);

    // And 飞书表里增量建出一个「分数」列 And 系统不发起任何改名调用。
    expect(createdNames(mock)).toEqual(["分数"]);
    expect(mock.renameCalls).toHaveLength(0);
  });

  it("Scenario: 仅改字段类型而标签不变时不触发改名", async () => {
    // Given owner 已配置可用凭据 And 把某字段类型从文本改成数字但标签保持不变。
    await configureOwner({ feishu: true });
    mock = installFeishuMock({
      fieldsList: [
        { status: 200, body: fieldsListBody([]) },
        { status: 200, body: fieldsListBody([{ name: "数量", type: TEXT, fieldId: "fld_qty" }]) },
      ],
    });
    const slug = await publishFormAndGetSlug([{ id: "f_qty", type: "text", label: "数量" }]);
    await waitForSync(mock);
    mock.resetCalls();

    // When owner 保存该编辑（同 id 同 label，仅 type text→number）。
    const res = await patchForm(slug, {
      fields: [{ id: "f_qty", type: "number", label: "数量" }],
    });
    expect(res.status).toBe(200);
    await waitForSync(mock);

    // Then 系统不向飞书发起任何改名调用 And 飞书那一列保持不动（label 没变 → diff 无改名项）。
    expect(mock.renameCalls).toHaveLength(0);
  });

  // ===========================================================================
  // 不触发改名的编辑形态
  // ===========================================================================

  it("Scenario: 只改状态不改 fields 时不触发改名", async () => {
    // Given owner 已配置可用凭据 And 已发布过一份表单。
    await configureOwner({ feishu: true });
    // 发布阶段允许正常列出 / 建列；发布后台 drain 完再 resetCalls，编辑阶段独立断言。
    mock = installFeishuMock({
      fieldsList: [{ status: 200, body: fieldsListBody([]) }],
    });
    const slug = await publishFormAndGetSlug([{ id: "f_name", type: "text", label: "姓名" }]);
    await waitForSync(mock);
    mock.resetCalls();

    // When owner 仅把该表单状态改为关闭而未在请求里带 fields。
    const res = await patchForm(slug, { status: "closed" });

    // Then 编辑成功。
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status?: string }).status).toBe("closed");
    // And 系统既不预建也不改名（PATCH 未带 fields → route 完全不调飞书同步：无 token / 列出 / 改名 / 建列）。
    await waitForSync(mock, false);
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.fieldsListCalls).toHaveLength(0);
    expect(mock.renameCalls).toHaveLength(0);
    expect(mock.fieldCreateCalls).toHaveLength(0);
  });

  it("Scenario: 编辑带了 fields 但没有任何标签变更时不发改名调用", async () => {
    // Given owner 已配置可用凭据 And 编辑里带了 fields 但所有字段标签都和原来一样。
    await configureOwner({ feishu: true });
    mock = installFeishuMock({
      fieldsList: [
        { status: 200, body: fieldsListBody([]) },
        { status: 200, body: fieldsListBody([{ name: "姓名", type: TEXT, fieldId: "fld_name" }]) },
      ],
    });
    const slug = await publishFormAndGetSlug([{ id: "f_name", type: "text", label: "姓名" }]);
    await waitForSync(mock);
    mock.resetCalls();

    // When owner 保存该编辑（带 fields，但 label 不变；这里改了 required 触发一次落库）。
    const res = await patchForm(slug, {
      fields: [{ id: "f_name", type: "text", label: "姓名", required: true }],
    });
    expect(res.status).toBe(200);
    await waitForSync(mock);

    // Then 系统不发起任何改名调用（diff 无改名项 → 不 PUT）。预建仍会列出 / 但无新列要建。
    expect(mock.renameCalls).toHaveLength(0);
    expect(createdNames(mock)).toHaveLength(0);
  });

  // ===========================================================================
  // 冲突 / 边界：逐项跳过、互不影响、绝不报错
  // ===========================================================================

  it("Scenario: 改名撞上已存在的另一个列名时跳过且不强改", async () => {
    // Given owner 已配置可用凭据 And 把「电话」改名为「邮箱」但飞书表里已另有一个不同的「邮箱」列。
    await configureOwner({ feishu: true });
    const errLogs: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errLogs.push(args.map((a) => String(a)).join(" "));
    };
    mock = installFeishuMock({
      fieldsList: [
        { status: 200, body: fieldsListBody([]) },
        // 编辑链路列出：既有「电话」(fld_phone) 又有一个不同的「邮箱」(fld_email)列。
        {
          status: 200,
          body: fieldsListBody([
            { name: "电话", type: TEXT, fieldId: "fld_phone" },
            { name: "邮箱", type: TEXT, fieldId: "fld_email" },
          ]),
        },
      ],
    });
    try {
      const slug = await publishFormAndGetSlug([
        { id: "f_phone", type: "text", label: "电话" },
        { id: "f_email", type: "text", label: "邮箱" },
      ]);
      await waitForSync(mock);
      mock.resetCalls();

      // When owner 保存该编辑（把「电话」字段改名为「邮箱」——会撞上已存在的另一个「邮箱」列）。
      const res = await patchForm(slug, {
        fields: [
          { id: "f_phone", type: "text", label: "邮箱" },
          { id: "f_email", type: "text", label: "邮箱" },
        ],
      });
      // Then 编辑成功。
      expect(res.status).toBe(200);
      await waitForSync(mock);

      // And 系统跳过这次会撞名的改名且不覆盖已存在的「邮箱」列（不对 fld_phone 发 PUT 改成「邮箱」）。
      const renamedPhone = mock.renameCalls.find((c) => c.fieldId === "fld_phone");
      expect(renamedPhone).toBeUndefined();
      // And 跳过被记入日志且日志不含任何凭据。
      const allLogs = errLogs.join("\n");
      expect(allLogs).toMatch(/skip|already exists|跳过/i);
      expect(allLogs).not.toContain(OWNER_FEISHU_APP_SECRET);
      expect(allLogs).not.toContain(UPSTREAM_TENANT_TOKEN);
    } finally {
      console.error = origError;
    }
  });

  it("Scenario: 旧标签在飞书找不到对应列时跳过该项改名", async () => {
    // Given owner 把某字段改名但其旧标签在飞书表里根本没有对应列。
    await configureOwner({ feishu: true });
    mock = installFeishuMock({
      fieldsList: [
        { status: 200, body: fieldsListBody([]) },
        // 编辑链路列出：飞书表里压根没有「电话」这一列（从没建过 / 已被改过）。
        {
          status: 200,
          body: fieldsListBody([{ name: "别的列", type: TEXT, fieldId: "fld_other" }]),
        },
      ],
    });
    const slug = await publishFormAndGetSlug([{ id: "f_phone", type: "text", label: "电话" }]);
    await waitForSync(mock);
    mock.resetCalls();

    // When owner 保存该编辑（「电话」→「联系电话」，但飞书无「电话」列可定位）。
    const res = await patchForm(slug, {
      fields: [{ id: "f_phone", type: "text", label: "联系电话" }],
    });
    // Then 编辑成功。
    expect(res.status).toBe(200);
    await waitForSync(mock);

    // And 系统跳过这一项改名而不报错（旧 label 定位不到列 → 不发 PUT）。
    expect(mock.renameCalls).toHaveLength(0);
  });

  it("Scenario: 多项改名中某一项失败不影响其它项与编辑", async () => {
    // Given owner 在一次编辑里改了两个字段的标签 And 其中一项的改名被飞书拒绝。
    await configureOwner({ feishu: true });
    mock = installFeishuMock({
      fieldsList: [
        { status: 200, body: fieldsListBody([]) },
        {
          status: 200,
          body: fieldsListBody([
            { name: "甲", type: TEXT, fieldId: "fld_a" },
            { name: "乙", type: TEXT, fieldId: "fld_b" },
          ]),
        },
      ],
      // fld_a 的改名被飞书拒绝（code≠0），fld_b 照常成功。
      renameByFieldId: { fld_a: { status: 200, body: RENAME_BAD_BODY } },
    });
    const slug = await publishFormAndGetSlug([
      { id: "f_a", type: "text", label: "甲" },
      { id: "f_b", type: "text", label: "乙" },
    ]);
    await waitForSync(mock);
    mock.resetCalls();

    // When owner 保存该编辑（甲→甲改、乙→乙改，两项改名，甲那项会被飞书拒）。
    const res = await patchForm(slug, {
      fields: [
        { id: "f_a", type: "text", label: "甲改" },
        { id: "f_b", type: "text", label: "乙改" },
      ],
    });
    // Then 编辑成功。
    expect(res.status).toBe(200);
    await waitForSync(mock);

    // 两项都尝试了改名（各发一次 PUT）。
    expect(mock.renameCalls).toHaveLength(2);
    // And 另一项改名照常生效（乙→乙改成功），失败那一项被静默跳过、不外抛、不影响编辑。
    const renamedB = mock.renameCalls.find((c) => c.fieldId === "fld_b");
    expect((renamedB?.body as { field_name?: string }).field_name).toBe("乙改");
  });

  // ===========================================================================
  // best-effort：未配飞书 / 连不上 / 换 token 失败 → 编辑仍 200
  // ===========================================================================

  it("Scenario: owner 未配飞书时改名静默跳过且编辑仍成功", async () => {
    // Given owner 尚未配置飞书凭据（DeepSeek only） And 编辑某表单改了一个字段的标签。
    await configureOwner({ feishu: false });
    // token 设 null：任何飞书调用都会 THROW —— 证明未配飞书时零上游流量。
    mock = installFeishuMock({ token: null });
    const slug = await publishFormAndGetSlug([{ id: "f_phone", type: "text", label: "电话" }]);
    await waitForSync(mock, false);
    mock.resetCalls();

    // When owner 保存该编辑。
    const res = await patchForm(slug, {
      fields: [{ id: "f_phone", type: "text", label: "联系电话" }],
    });

    // Then 编辑成功并返回更新后的表单。
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug?: string; fields?: Array<{ label?: string }> };
    expect(body.slug).toBe(slug);
    expect(body.fields?.[0]?.label).toBe("联系电话");

    // And 不向飞书发起任何调用（未配飞书 → 读配置见 feishu===null 直接 return）。
    await waitForSync(mock, false);
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.fieldsListCalls).toHaveLength(0);
    expect(mock.renameCalls).toHaveLength(0);
  });

  it("Scenario: 飞书连不上时改名静默跳过且编辑仍成功", async () => {
    // Given owner 已配置飞书凭据但飞书上游不可达（fetch 抛网络错误）。
    await configureOwner({ feishu: true });
    // 先用正常 mock 发布建好列，再切到「连不上」的 stub 做编辑。
    mock = installFeishuMock({
      fieldsList: [{ status: 200, body: fieldsListBody([]) }],
    });
    const slug = await publishFormAndGetSlug([{ id: "f_phone", type: "text", label: "电话" }]);
    await waitForSync(mock);
    mock.restore();
    mock = undefined;

    const realFetch = globalThis.fetch;
    const errLogs: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errLogs.push(args.map((a) => String(a)).join(" "));
    };
    // token 端点抛（模拟不可达），其它一律抛 —— 验证失败被静默吞且不泄漏凭据。
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new Request(input as RequestInfo).url;
      if (url === FEISHU_TENANT_TOKEN_URL) {
        throw new Error("ECONNREFUSED open.feishu.cn unreachable");
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    try {
      // And owner 编辑某表单改了一个字段的标签 When owner 保存该编辑。
      const res = await patchForm(slug, {
        fields: [{ id: "f_phone", type: "text", label: "联系电话" }],
      });
      // Then 编辑成功并返回更新后的表单。
      expect(res.status).toBe(200);
      const body = (await res.json()) as { fields?: Array<{ label?: string }> };
      expect(body.fields?.[0]?.label).toBe("联系电话");
      // 让后台 best-effort 跑完（吞掉连不上的错）。
      await new Promise((r) => setTimeout(r, 80));
    } finally {
      globalThis.fetch = realFetch;
      console.error = origError;
    }

    // And 改名被静默跳过且不产生任何错误（编辑响应已 200，无异常冒泡到此）。
    // And 日志只记录错误名而绝不记录 app_secret 或 tenant_access_token（§15.7）。
    const allLogs = errLogs.join("\n");
    expect(allLogs).not.toContain(OWNER_FEISHU_APP_SECRET);
    expect(allLogs).not.toContain(UPSTREAM_TENANT_TOKEN);
    expect(allLogs).not.toContain(OWNER_FEISHU_APP_ID);
    expect(allLogs).not.toContain(OWNER_FEISHU_APP_TOKEN);
  });

  it("Scenario: 换取 tenant_access_token 失败时改名静默跳过且编辑仍成功", async () => {
    // Given owner 已配置飞书凭据但换取 token 失败（code≠0）。
    await configureOwner({ feishu: true });
    mock = installFeishuMock({
      fieldsList: [{ status: 200, body: fieldsListBody([]) }],
    });
    const slug = await publishFormAndGetSlug([{ id: "f_phone", type: "text", label: "电话" }]);
    await waitForSync(mock);
    // 切到「换 token 失败」：之后 token 端点回 code≠0，不会进列出 / 改名。
    mock.restore();
    mock = installFeishuMock({ token: { status: 200, body: FEISHU_TOKEN_BAD_BODY } });

    // And owner 编辑某表单改了一个字段的标签 When owner 保存该编辑。
    const res = await patchForm(slug, {
      fields: [{ id: "f_phone", type: "text", label: "联系电话" }],
    });
    // Then 编辑成功并返回更新后的表单。
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fields?: Array<{ label?: string }> };
    expect(body.fields?.[0]?.label).toBe("联系电话");
    await waitForSync(mock);

    // And 改名被静默跳过：探了一次 token（失败）后绝不进列出 / 改名。
    expect(mock.tokenCalls.length).toBeGreaterThanOrEqual(1);
    expect(mock.fieldsListCalls).toHaveLength(0);
    expect(mock.renameCalls).toHaveLength(0);
  });

  // ===========================================================================
  // 凭据边界
  // ===========================================================================

  it("Scenario: 改名全程不把凭据或列值写进响应或日志", async () => {
    // Given owner 已配置可用凭据。
    await configureOwner({ feishu: true });
    const errLogs: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errLogs.push(args.map((a) => String(a)).join(" "));
    };
    mock = installFeishuMock({
      fieldsList: [
        { status: 200, body: fieldsListBody([]) },
        { status: 200, body: fieldsListBody([{ name: "电话", type: TEXT, fieldId: "fld_phone" }]) },
      ],
    });
    try {
      const slug = await publishFormAndGetSlug([{ id: "f_phone", type: "text", label: "电话" }]);
      await waitForSync(mock);
      mock.resetCalls();

      // When owner 编辑某表单改了一个字段的标签并保存。
      const res = await patchForm(slug, {
        fields: [{ id: "f_phone", type: "text", label: "联系电话" }],
      });
      expect(res.status).toBe(200);
      const raw = await res.clone().text();
      await waitForSync(mock);

      // Then 编辑响应只含更新后的表单视图而不含任何凭据。
      expect(raw).not.toContain(UPSTREAM_TENANT_TOKEN);
      expect(raw).not.toContain(OWNER_FEISHU_APP_SECRET);
      expect(raw).not.toContain(OWNER_FEISHU_APP_TOKEN);
      expect(raw).not.toContain(OWNER_DEEPSEEK_KEY);
      for (const [, value] of res.headers) {
        expect(value).not.toContain(UPSTREAM_TENANT_TOKEN);
        expect(value).not.toContain(OWNER_FEISHU_APP_SECRET);
      }
      // 改名确实发生了（响应里的更新视图带新 label；上游有一次 PUT）。
      const body = (await res.json()) as { fields?: Array<{ label?: string }> };
      expect(body.fields?.[0]?.label).toBe("联系电话");
      expect(mock.renameCalls).toHaveLength(1);

      // And 任何改名相关日志都不含 app_secret、tenant_access_token 或被改的列值。
      const allLogs = errLogs.join("\n");
      expect(allLogs).not.toContain(OWNER_FEISHU_APP_SECRET);
      expect(allLogs).not.toContain(UPSTREAM_TENANT_TOKEN);
      expect(allLogs).not.toContain(OWNER_FEISHU_APP_TOKEN);
      // 被改的列值（新 / 旧 label）也不该出现在日志里（成功路径本不该记任何东西）。
      expect(allLogs).not.toContain("联系电话");
      expect(allLogs).not.toContain("电话");
    } finally {
      console.error = origError;
    }
  });
});
