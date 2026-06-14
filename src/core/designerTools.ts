// designerTools.ts — the designer Agent's capability surface over the LIVE form
// model that preview.jsx renders (SPEC §3.2, §4). Three parts:
//   1. the UI field model (text/tel/email/textarea/radio/checks/select/consent),
//   2. an executor that mutates a FormModel in place (add/update/remove/duplicate/
//      reorder a field + set the form meta + read the schema), and
//   3. the OpenAI function-tool definitions + system prompt sent to /api/chat.
// Failures throw; the agent loop backfills them as tool errors so the model self-heals.

export type UiFieldType =
  | "text"
  | "tel"
  | "email"
  | "textarea"
  | "radio"
  | "checks"
  | "select"
  | "consent";

export const UI_FIELD_TYPES: UiFieldType[] = [
  "text",
  "tel",
  "email",
  "textarea",
  "radio",
  "checks",
  "select",
  "consent",
];

/** Types whose choices live in `options` (an array of label strings). */
const OPTION_TYPES = new Set<UiFieldType>(["radio", "checks", "select"]);

export interface UiField {
  id: string;
  type: UiFieldType;
  label: string;
  required?: boolean;
  placeholder?: string;
  options?: string[];
  /** Transient UI flag: drives the entrance animation; never sent to the model. */
  _new?: boolean;
}

export interface FormMeta {
  kicker?: string;
  title?: string;
  desc?: string;
  meta?: string[];
}

export interface FormModel {
  meta: FormMeta | null;
  fields: UiField[];
}

export function createFormModel(): FormModel {
  return { meta: null, fields: [] };
}

let _idCounter = 0;
/** Session-unique id (used for field ids, React keys, and chat message ids). */
export function uid(prefix = "id"): string {
  return `${prefix}_${(++_idCounter).toString(36)}`;
}

/** @internal Test hook: reset the id counter so id-dependent tests are deterministic. */
export function __resetUid(): void {
  _idCounter = 0;
}

/**
 * Advance the session id counter past any `<prefix>_<base36>` ids already present —
 * used when loading a stored form back into the designer for editing (PR-7), where the
 * loaded fields keep their ORIGINAL ids (e.g. `fld_5`) so the backend can match labels
 * for rename detection. Without this, the fresh session counter (starting at 0) would
 * hand the next added field a colliding id like `fld_1`. We read the base36 suffix and
 * bump `_idCounter` so every subsequent {@link uid} is strictly greater than all loaded
 * ids. Non-numeric or prefix-less ids are ignored (no suffix → skipped).
 */
export function reserveUidsFrom(ids: Iterable<string>): void {
  for (const id of ids) {
    const m = /_([0-9a-z]+)$/.exec(id);
    if (!m) continue;
    const n = parseInt(m[1], 36);
    if (Number.isFinite(n) && n > _idCounter) _idCounter = n;
  }
}

// ── validation helpers ──────────────────────────────────────────────────────
function assertType(type: unknown): asserts type is UiFieldType {
  if (!UI_FIELD_TYPES.includes(type as UiFieldType)) {
    throw new Error(`unknown field type "${type}"; use one of ${UI_FIELD_TYPES.join(", ")}`);
  }
}

function normalizeOptions(options: unknown): string[] | undefined {
  if (options == null) return undefined;
  if (!Array.isArray(options)) throw new Error("options must be an array of strings");
  return options.map((o) =>
    typeof o === "string" ? o : typeof o?.label === "string" ? o.label : String(o),
  );
}

function findIndexById(model: FormModel, id: string): number {
  const i = model.fields.findIndex((f) => f.id === id);
  if (i < 0) throw new Error(`field not found: ${id}`);
  return i;
}

/** A field as the model sees it, without transient UI flags. */
function publicField(f: UiField): Omit<UiField, "_new"> {
  const { _new, ...rest } = f;
  return rest;
}

// ── operations (each mutates `model` and returns a small result for the model) ─
export interface AddFieldInput {
  type: UiFieldType;
  label: string;
  required?: boolean;
  placeholder?: string;
  options?: string[];
  /** Insert position; default keeps a consent field last, else appends. */
  index?: number;
}

export function addField(model: FormModel, input: AddFieldInput): Omit<UiField, "_new"> {
  assertType(input.type);
  if (!input.label || !String(input.label).trim()) throw new Error("label is required");
  if (OPTION_TYPES.has(input.type) && !input.options?.length) {
    throw new Error(`field type "${input.type}" needs a non-empty options array`);
  }
  const field: UiField = {
    id: uid("fld"),
    type: input.type,
    label: String(input.label).trim(),
    required: !!input.required,
    _new: true,
  };
  if (input.placeholder) field.placeholder = input.placeholder;
  const options = normalizeOptions(input.options);
  if (options) field.options = options;

  let at = input.index;
  if (at == null) {
    const consentAt = model.fields.findIndex((f) => f.type === "consent");
    at = consentAt >= 0 ? consentAt : model.fields.length;
  }
  at = Math.max(0, Math.min(at, model.fields.length));
  model.fields.splice(at, 0, field);
  return publicField(field);
}

export interface UpdateFieldInput {
  id: string;
  patch: Partial<Omit<UiField, "id">>;
}

export function updateField(model: FormModel, input: UpdateFieldInput): Omit<UiField, "_new"> {
  const i = findIndexById(model, input.id);
  const patch = { ...input.patch } as Partial<UiField>;
  if (patch.type !== undefined) assertType(patch.type);
  if (patch.options !== undefined) patch.options = normalizeOptions(patch.options);
  delete (patch as { id?: string }).id;
  Object.assign(model.fields[i], patch, { _new: true });
  return publicField(model.fields[i]);
}

export function removeField(model: FormModel, id: string): { removed: string } {
  const i = findIndexById(model, id);
  model.fields.splice(i, 1);
  return { removed: id };
}

export function duplicateField(model: FormModel, id: string): Omit<UiField, "_new"> {
  const i = findIndexById(model, id);
  const src = model.fields[i];
  const copy: UiField = {
    ...src,
    id: uid("fld"),
    options: src.options ? [...src.options] : undefined,
    _new: true,
  };
  if (!copy.options) delete copy.options;
  model.fields.splice(i + 1, 0, copy);
  return publicField(copy);
}

export function reorderFields(model: FormModel, ids: string[]): { ids: string[] } {
  const existing = model.fields.map((f) => f.id);
  const samePermutation =
    Array.isArray(ids) &&
    ids.length === existing.length &&
    ids.every((id) => existing.includes(id));
  if (!samePermutation) throw new Error("ids must be a permutation of the current field ids");
  model.fields.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  return { ids: model.fields.map((f) => f.id) };
}

export function setFormMeta(model: FormModel, patch: FormMeta): FormMeta {
  model.meta = { ...(model.meta || {}), ...patch };
  return model.meta;
}

export function getFormSchema(model: FormModel): {
  meta: FormMeta | null;
  fields: Omit<UiField, "_new">[];
} {
  return { meta: model.meta, fields: model.fields.map(publicField) };
}

/**
 * Execute a tool by name against the model. Unknown tool / bad input throws — the
 * loop turns the throw into an `is_error` tool result so the agent can recover.
 */
export function applyDesignerTool(
  model: FormModel,
  name: string,
  input: Record<string, unknown> = {},
): unknown {
  switch (name) {
    case "set_form_meta":
      return setFormMeta(model, input as FormMeta);
    case "add_field":
      return addField(model, input as unknown as AddFieldInput);
    case "update_field":
      return updateField(model, input as unknown as UpdateFieldInput);
    case "remove_field":
      return removeField(model, String((input as { id?: string }).id));
    case "duplicate_field":
      return duplicateField(model, String((input as { id?: string }).id));
    case "reorder_fields":
      return reorderFields(model, (input as { ids?: string[] }).ids as string[]);
    case "get_form_schema":
      return getFormSchema(model);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ── OpenAI function-tool definitions (passed through /api/chat to DeepSeek) ────
const fieldTypeEnum = { type: "string", enum: UI_FIELD_TYPES };

export const DESIGNER_TOOLS = [
  {
    type: "function",
    function: {
      name: "set_form_meta",
      description: "设置表单封面信息（标题/介绍/角标/要点标签）。搭表单时先调用它，再逐个加字段。",
      parameters: {
        type: "object",
        properties: {
          kicker: { type: "string", description: "小标题/角标，如 ACTIVITY · REGISTRATION" },
          title: { type: "string", description: "表单主标题" },
          desc: { type: "string", description: "一两句介绍" },
          meta: {
            type: "array",
            items: { type: "string" },
            description: "要点标签，如时间、地点",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_field",
      description:
        "向表单追加一个字段，实时渲染到右侧预览。radio/checks/select 必须给非空 options 字符串数组。consent 用于「同意条款」勾选，通常放最后。",
      parameters: {
        type: "object",
        properties: {
          type: fieldTypeEnum,
          label: { type: "string", description: "字段标签（简短中文）" },
          required: { type: "boolean" },
          placeholder: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          index: { type: "integer", description: "插入位置；省略则放在同意条款之前/末尾" },
        },
        required: ["type", "label"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_field",
      description: "按 id 修改字段属性（如设为必填、改标签、改 options）。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          patch: {
            type: "object",
            properties: {
              type: fieldTypeEnum,
              label: { type: "string" },
              required: { type: "boolean" },
              placeholder: { type: "string" },
              options: { type: "array", items: { type: "string" } },
            },
          },
        },
        required: ["id", "patch"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_field",
      description: "按 id 删除一个字段。",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "duplicate_field",
      description: "按 id 复制一个字段，副本插入到原字段之后。",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "reorder_fields",
      description: "用一个完整的 id 排列重排字段顺序。",
      parameters: {
        type: "object",
        properties: { ids: { type: "array", items: { type: "string" } } },
        required: ["ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_form_schema",
      description: "读取当前表单的 meta 与字段列表（含每个字段的 id），用于决定如何修改。",
      parameters: { type: "object", properties: {} },
    },
  },
];

export const DESIGNER_SYSTEM = `你是 Agentaily Forms 的对话式表单设计助手。用户用自然语言描述想要的表单，你通过调用工具把字段实时搭到右侧预览。

可用字段类型：text（单行文本）、tel（手机号）、email（邮箱）、textarea（多行文本）、radio（单选，需 options）、checks（多选，需 options）、select（下拉，需 options）、consent（同意条款勾选）。

工作方式：
- 新建表单时，先调用 set_form_meta 设置封面，再用 add_field 逐个加字段；同意条款用 consent 类型放最后。
- 修改时先用 get_form_schema 拿到字段 id，再调用 update_field/remove_field/duplicate_field/reorder_fields。
- 字段标签用简短中文。手机号用 tel、邮箱用 email，并按需设 required。
- 工具调用完成后，用一两句中文向用户说明你做了什么、可以怎么继续改。不要输出代码或 JSON，把结构变更都交给工具。`;
