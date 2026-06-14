import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  parsePublishInput,
  parseUpdateInput,
  generateSlug,
  listForms,
  MAX_FIELD_DEPTH,
  FormValidationError,
  type PublishFormInput,
} from "../src/forms";
import { applySchema, resetForms, testEnv } from "./helpers";

// Inner-loop unit specs for the pure seams behind 表单发布 + 公开拉取:
//   - parsePublishInput: shape validation (meta.title 非空 + fields 是数组 + 每个
//                        field 形状合法) → PublishFormInput or FormValidationError.
//   - generateSlug:      a fresh, URL-safe, high-entropy, non-guessable slug.
// No D1, no Hono — these compose into saveForm / the route, exercised by the
// outer loop in form-publish-api.test.ts. See SPEC.md §16.2、§16.3、§16.5.

// A representative valid publish body: meta + a couple of fields covering a
// plain text field and a checkbox field with options (§16.2 example shape).
const VALID_INPUT: PublishFormInput = {
  meta: { title: "活动报名表", description: "请填写你的报名信息" },
  fields: [
    { id: "f_name", type: "text", label: "姓名", required: true },
    {
      id: "f_hobby",
      type: "checkbox",
      label: "兴趣",
      options: [
        { label: "阅读", value: "read" },
        { label: "运动", value: "sport" },
      ],
    },
  ],
};

describe("parsePublishInput (workers/features/form-publish.feature)", () => {
  it("accepts a well-formed publish body and returns meta + fields", () => {
    const parsed = parsePublishInput(structuredClone(VALID_INPUT));
    // meta.title preserved; fields透传 (整体透传，不做字段级语义校验，§16.5).
    expect(parsed.meta.title).toBe("活动报名表");
    expect(parsed.meta.description).toBe("请填写你的报名信息");
    expect(parsed.fields).toHaveLength(2);
    expect(parsed.fields[0]).toMatchObject({ id: "f_name", type: "text", label: "姓名" });
    expect(parsed.fields[1].options).toEqual([
      { label: "阅读", value: "read" },
      { label: "运动", value: "sport" },
    ]);
  });

  it("accepts an empty fields array (空表单的发布约定，§16.5)", () => {
    const parsed = parsePublishInput({ meta: { title: "空表单" }, fields: [] });
    expect(parsed.meta.title).toBe("空表单");
    expect(parsed.fields).toEqual([]);
  });

  it("rejects when meta.title is missing", () => {
    expect(() => parsePublishInput({ meta: { description: "无标题" }, fields: [] })).toThrow(
      FormValidationError,
    );
  });

  it("rejects when meta.title is empty", () => {
    expect(() => parsePublishInput({ meta: { title: "" }, fields: [] })).toThrow(
      FormValidationError,
    );
  });

  it("rejects when meta itself is missing", () => {
    expect(() => parsePublishInput({ fields: [] })).toThrow(FormValidationError);
  });

  it("rejects when fields is not an array", () => {
    expect(() => parsePublishInput({ meta: { title: "x" }, fields: { id: "f1" } })).toThrow(
      FormValidationError,
    );
  });

  it("rejects when fields is missing", () => {
    expect(() => parsePublishInput({ meta: { title: "x" } })).toThrow(FormValidationError);
  });

  it("rejects a field that is missing id / type / label", () => {
    expect(() =>
      parsePublishInput({ meta: { title: "x" }, fields: [{ type: "text", label: "无 id" }] }),
    ).toThrow(FormValidationError);
  });

  it("rejects a field whose type is not a valid FieldType", () => {
    expect(() =>
      parsePublishInput({
        meta: { title: "x" },
        fields: [{ id: "f1", type: "bogus", label: "非法类型" }],
      }),
    ).toThrow(FormValidationError);
  });

  it("rejects a non-object body", () => {
    expect(() => parsePublishInput(null)).toThrow(FormValidationError);
    expect(() => parsePublishInput("not an object")).toThrow(FormValidationError);
    expect(() => parsePublishInput([])).toThrow(FormValidationError);
  });
});

describe("generateSlug (workers/features/form-publish.feature, §16.3)", () => {
  it("returns a non-empty string", () => {
    const slug = generateSlug();
    expect(slug).toBeTypeOf("string");
    expect(slug.length).toBeGreaterThan(0);
  });

  it("uses only URL-safe characters (no枚举 / 不可猜 random串)", () => {
    // URL-safe: unreserved chars only — alnum plus '-' / '_' (base32/base36/base64url).
    // Notably NO '/', '+', '=', whitespace, or '%' that would need escaping in a path.
    const URL_SAFE = /^[A-Za-z0-9_-]+$/;
    for (let i = 0; i < 50; i++) {
      expect(generateSlug()).toMatch(URL_SAFE);
    }
  });

  it("does not produce a trivially short / low-entropy slug", () => {
    // Enough entropy that slugs are not guessable / enumerable (§16.3). A
    // crypto-random base32/36 串 is comfortably longer than this floor.
    expect(generateSlug().length).toBeGreaterThanOrEqual(8);
  });

  it("produces distinct slugs across many calls (high entropy, no collisions)", () => {
    const n = 1000;
    const slugs = new Set<string>();
    for (let i = 0; i < n; i++) {
      slugs.add(generateSlug());
    }
    // All distinct: a low-entropy / sequential generator would collide here.
    expect(slugs.size).toBe(n);
  });
});

// --- §16.2 安全 nit：parseField 的嵌套深度上限 -------------------------------
//
// group 字段的 `children` 递归不得超过 MAX_FIELD_DEPTH 层。parseField 是模块私有，
// 经由 parsePublishInput（顶层 fields.map → parseField，深度从 0 起算）间接驱动。
// 一份深到超过上限的 group 链应被当成形状非法 → FormValidationError；恰好在上限内的
// 仍应被接受。
describe("parseField nesting depth limit (workers/features/form-publish.feature, §16.2)", () => {
  // 构造一条 group → group → … 的嵌套链，最内层挂一个普通 text 字段。`depth` 个 group
  // 嵌套意味着最内层那个 text 字段的递归 depth = 链上 group 的层数。
  function nestedGroups(depth: number) {
    let node: Record<string, unknown> = { id: "f_leaf", type: "text", label: "叶子" };
    for (let i = depth; i > 0; i--) {
      node = { id: `f_group_${i}`, type: "group", label: `组 ${i}`, children: [node] };
    }
    return node;
  }

  it("accepts nesting up to MAX_FIELD_DEPTH", () => {
    // 顶层 fields[0] 处于 depth 0；其下 (MAX_FIELD_DEPTH) 层 group 把叶子推到
    // depth = MAX_FIELD_DEPTH，正好踩在上限上（depth > MAX_FIELD_DEPTH 才拒）。
    const parsed = parsePublishInput({
      meta: { title: "深嵌套（界内）" },
      fields: [nestedGroups(MAX_FIELD_DEPTH)],
    });
    expect(parsed.fields).toHaveLength(1);
    expect(parsed.fields[0].type).toBe("group");
  });

  it("rejects nesting deeper than MAX_FIELD_DEPTH with FormValidationError", () => {
    // 再多一层就把叶子推到 depth = MAX_FIELD_DEPTH + 1 → 形状非法（route → 400，不落库）。
    expect(() =>
      parsePublishInput({
        meta: { title: "深嵌套（超限）" },
        fields: [nestedGroups(MAX_FIELD_DEPTH + 1)],
      }),
    ).toThrow(FormValidationError);
  });
});

// --- §21.3：parseUpdateInput（PATCH /api/forms/:slug 的部分更新形状校验）------
//
// 部分更新：所有键可选；空体 {} 合法（no-op）。status 只接受 'published' / 'closed'
// （拒绝 'draft' 与任意乱值 → FormValidationError → route 400）。meta / fields 若给则
// 复用 §16 的形状约定（title 非空 / parseField + 深度上限）。
describe("parseUpdateInput (workers/features/form-management.feature, §21.3)", () => {
  it("accepts an empty body as a no-op update", () => {
    const parsed = parseUpdateInput({});
    expect(parsed).toEqual({});
  });

  it("accepts status 'closed'", () => {
    const parsed = parseUpdateInput({ status: "closed" });
    expect(parsed.status).toBe("closed");
  });

  it("accepts status 'published'", () => {
    const parsed = parseUpdateInput({ status: "published" });
    expect(parsed.status).toBe("published");
  });

  it("rejects status 'draft' (PATCH 不允许回退草稿，§21.3)", () => {
    expect(() => parseUpdateInput({ status: "draft" })).toThrow(FormValidationError);
  });

  it("rejects a bogus status value", () => {
    expect(() => parseUpdateInput({ status: "open" })).toThrow(FormValidationError);
    expect(() => parseUpdateInput({ status: 123 })).toThrow(FormValidationError);
  });

  it("rejects a non-object body", () => {
    expect(() => parseUpdateInput(null)).toThrow(FormValidationError);
    expect(() => parseUpdateInput("closed")).toThrow(FormValidationError);
    expect(() => parseUpdateInput([])).toThrow(FormValidationError);
  });

  it("rejects a malformed meta (title 缺失/空) when provided", () => {
    expect(() => parseUpdateInput({ meta: { description: "无标题" } })).toThrow(
      FormValidationError,
    );
  });

  it("rejects a malformed fields entry when provided", () => {
    expect(() => parseUpdateInput({ fields: [{ type: "text", label: "无 id" }] })).toThrow(
      FormValidationError,
    );
  });
});

// listForms projects the per-form 飞书表 locator only when BOTH columns are non-null
// (§16.9). D1-backed inner-loop unit: insert forms rows directly + assert the shape.
describe("listForms feishuTable projection (§16.9)", () => {
  const OWNER = "owner-feishu-projection";

  beforeAll(async () => {
    await applySchema();
  });

  beforeEach(async () => {
    await resetForms();
  });

  /** Insert one forms row directly, optionally with the per-form 飞书表 columns set. */
  async function insertForm(
    slug: string,
    feishu: { appToken: string; tableId: string } | null,
  ): Promise<void> {
    await testEnv.DB.prepare(
      `INSERT INTO forms (slug, owner_id, meta_json, schema_json, status, created_at,
         feishu_app_token, feishu_table_id)
       VALUES (?, ?, ?, ?, 'published', ?, ?, ?)`,
    )
      .bind(
        slug,
        OWNER,
        JSON.stringify({ title: `表单 ${slug}` }),
        JSON.stringify([]),
        new Date().toISOString(),
        feishu?.appToken ?? null,
        feishu?.tableId ?? null,
      )
      .run();
  }

  it("carries feishuTable when both feishu columns are non-null", async () => {
    await insertForm("slug-with-table", { appToken: "bascnTOKEN123", tableId: "tblABC" });

    const forms = await listForms(testEnv.DB, OWNER);
    expect(forms).toHaveLength(1);
    expect(forms[0].slug).toBe("slug-with-table");
    expect(forms[0].feishuTable).toEqual({ appToken: "bascnTOKEN123", tableId: "tblABC" });
  });

  it("omits feishuTable when the form has no per-form 飞书表 (both columns NULL)", async () => {
    await insertForm("slug-no-table", null);

    const forms = await listForms(testEnv.DB, OWNER);
    expect(forms).toHaveLength(1);
    expect(forms[0].slug).toBe("slug-no-table");
    expect(forms[0].feishuTable).toBeUndefined();
    // The key must be entirely absent (not present-with-undefined) so the wire JSON
    // never carries an empty feishuTable for an un-built form.
    expect(Object.keys(forms[0])).not.toContain("feishuTable");
  });
});
