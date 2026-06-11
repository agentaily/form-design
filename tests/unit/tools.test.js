import { describe, it, expect } from "vitest";
import { createToolExecutor, ALL_TOOLS, FILE_TOOLS, FORM_TOOLS } from "../../src/core/tools";
import { createVfs, readFile } from "../../src/core/vfs";
import { createSchema } from "../../src/core/schema";

function setup() {
  const vfs = createVfs({ "/form.jsx": "const Form = () => null;" });
  const schema = createSchema();
  const executeTool = createToolExecutor({ vfs, schema });
  return { vfs, schema, executeTool };
}

describe("tools · definitions", () => {
  it("declares the 5 file tools + 7 form tools as Anthropic tool schemas", () => {
    expect(FILE_TOOLS.map((t) => t.name)).toEqual([
      "list_files",
      "read_file",
      "write_file",
      "str_replace",
      "delete_file",
    ]);
    expect(FORM_TOOLS.map((t) => t.name)).toEqual([
      "get_form_schema",
      "add_field",
      "update_field",
      "remove_field",
      "duplicate_field",
      "reorder_fields",
      "set_validation",
    ]);
    expect(ALL_TOOLS).toHaveLength(12);
    for (const t of ALL_TOOLS) {
      expect(t).toHaveProperty("name");
      expect(t).toHaveProperty("description");
      expect(t.input_schema.type).toBe("object");
    }
  });
});

describe("tools · file-op dispatch mutates the VFS", () => {
  it("write_file then read_file", async () => {
    const { vfs, executeTool } = setup();
    await executeTool("write_file", { path: "/theme.jsx", content: "const t = {};" });
    expect(readFile(vfs, "/theme.jsx")).toBe("const t = {};");
    expect(await executeTool("read_file", { path: "/theme.jsx" })).toBe("const t = {};");
  });

  it("str_replace edits in place", async () => {
    const { vfs, executeTool } = setup();
    await executeTool("str_replace", { path: "/form.jsx", old_str: "null", new_str: "<div/>" });
    expect(readFile(vfs, "/form.jsx")).toContain("<div/>");
  });

  it("list_files returns the tree", async () => {
    const { executeTool } = setup();
    await executeTool("write_file", { path: "/a.jsx", content: "1" });
    expect(await executeTool("list_files", {})).toContain("/a.jsx");
  });
});

describe("tools · form-op dispatch mutates the schema", () => {
  it("add_field / update_field / set_validation / remove_field", async () => {
    const { schema, executeTool } = setup();
    await executeTool("add_field", { field: { id: "name", type: "text", label: "姓名" } });
    expect(schema.fields).toHaveLength(1);

    await executeTool("update_field", { id: "name", patch: { required: true } });
    expect(schema.fields[0].required).toBe(true);

    await executeTool("set_validation", { id: "name", rules: { min: 2 } });
    expect(schema.fields[0].validation).toEqual({ min: 2 });

    await executeTool("remove_field", { id: "name" });
    expect(schema.fields).toHaveLength(0);
  });

  it("duplicate_field inserts a same-content, fresh-id copy after the source", async () => {
    const { schema, executeTool } = setup();
    await executeTool("add_field", { field: { id: "name", type: "text", label: "姓名" } });
    await executeTool("add_field", { field: { id: "email", type: "text", label: "邮箱" } });

    const copy = await executeTool("duplicate_field", { id: "name" });
    expect(schema.fields).toHaveLength(3);
    expect(schema.fields.map((x) => x.id)).toEqual(["name", copy.id, "email"]);
    expect(copy.id).not.toBe("name");
    expect(copy.label).toBe("姓名");
  });

  it("get_form_schema returns the live schema", async () => {
    const { schema, executeTool } = setup();
    await executeTool("add_field", { field: { id: "a", type: "text", label: "A" } });
    expect(await executeTool("get_form_schema", {})).toBe(schema);
  });
});

describe("tools · errors", () => {
  it("unknown tool throws", async () => {
    const { executeTool } = setup();
    await expect(executeTool("frobnicate", {})).rejects.toThrow(/unknown tool/i);
  });

  it("operation failure propagates (loop turns it into is_error)", async () => {
    const { executeTool } = setup();
    await expect(executeTool("read_file", { path: "/ghost" })).rejects.toThrow(/not found/i);
  });
});
