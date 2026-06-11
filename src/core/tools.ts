// tools.ts — Tool definitions (Anthropic tool-use schema) + client-side Tool
// Executor (SPEC §3). Our program executes the tools; the model only returns
// structured tool_use blocks. The executor dispatches to VFS / schema ops.

import { listFiles, readFile, writeFile, strReplace, deleteFile } from "./vfs";
import type { VFS } from "./vfs";
import {
  getFormSchema,
  addField,
  updateField,
  removeField,
  reorderFields,
  setValidation,
} from "./schema";
import type { Schema } from "./schema";

export interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type ExecuteTool = (name: string, input?: Record<string, any>) => Promise<unknown>;

export interface ToolContext {
  vfs: VFS;
  schema: Schema;
}

const str = { type: "string" } as const;

/** File-operation tools (SPEC §3.1) — the baseline. */
export const FILE_TOOLS: ToolDef[] = [
  {
    name: "list_files",
    description: "返回文件树。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "read_file",
    description: "返回文件内容。",
    input_schema: { type: "object", properties: { path: str }, required: ["path"] },
  },
  {
    name: "write_file",
    description: "创建或全量覆盖文件。",
    input_schema: {
      type: "object",
      properties: { path: str, content: str },
      required: ["path", "content"],
    },
  },
  {
    name: "str_replace",
    description: "替换文件中唯一匹配的字符串。old_str 必须在文件中恰好出现一次。",
    input_schema: {
      type: "object",
      properties: { path: str, old_str: str, new_str: str },
      required: ["path", "old_str", "new_str"],
    },
  },
  {
    name: "delete_file",
    description: "删除文件。",
    input_schema: { type: "object", properties: { path: str }, required: ["path"] },
  },
];

/** Form-operation tools (SPEC §3.2) — the form-collection backbone. */
export const FORM_TOOLS: ToolDef[] = [
  {
    name: "get_form_schema",
    description: "返回当前 schema。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "add_field",
    description: "增加字段。",
    input_schema: {
      type: "object",
      properties: { field: { type: "object" } },
      required: ["field"],
    },
  },
  {
    name: "update_field",
    description: "改字段属性。",
    input_schema: {
      type: "object",
      properties: { id: str, patch: { type: "object" } },
      required: ["id", "patch"],
    },
  },
  {
    name: "remove_field",
    description: "删字段。",
    input_schema: { type: "object", properties: { id: str }, required: ["id"] },
  },
  {
    name: "reorder_fields",
    description: "排序字段。",
    input_schema: {
      type: "object",
      properties: { ids: { type: "array", items: str } },
      required: ["ids"],
    },
  },
  {
    name: "set_validation",
    description: "设校验规则。",
    input_schema: {
      type: "object",
      properties: { id: str, rules: { type: "object" } },
      required: ["id", "rules"],
    },
  },
];

export const ALL_TOOLS: ToolDef[] = [...FILE_TOOLS, ...FORM_TOOLS];

/**
 * Build a Tool Executor bound to a VFS + schema.
 * Returns `executeTool(name, input)` which mutates the bound state and resolves
 * with the tool's output. Throws on unknown tool or operation failure — the
 * agent loop wraps the throw into an `is_error` tool_result (self-healing).
 */
export function createToolExecutor({ vfs, schema }: ToolContext): ExecuteTool {
  const handlers: Record<string, (input: any) => unknown> = {
    list_files: () => listFiles(vfs),
    read_file: ({ path }) => readFile(vfs, path),
    write_file: ({ path, content }) => {
      writeFile(vfs, path, content);
      return `wrote ${path}`;
    },
    str_replace: ({ path, old_str, new_str }) => {
      strReplace(vfs, path, old_str, new_str);
      return `edited ${path}`;
    },
    delete_file: ({ path }) => {
      deleteFile(vfs, path);
      return `deleted ${path}`;
    },
    get_form_schema: () => getFormSchema(schema),
    add_field: ({ field }) => addField(schema, field),
    update_field: ({ id, patch }) => updateField(schema, id, patch),
    remove_field: ({ id }) => removeField(schema, id),
    reorder_fields: ({ ids }) => reorderFields(schema, ids),
    set_validation: ({ id, rules }) => setValidation(schema, id, rules),
  };

  return async function executeTool(name: string, input?: Record<string, any>): Promise<unknown> {
    const handler = handlers[name];
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    return handler(input || {});
  };
}
