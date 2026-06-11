import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { createToolExecutor } from "../../src/core/tools";
import { createVfs } from "../../src/core/vfs";
import { createSchema, getFormSchema } from "../../src/core/schema";

const here = path.dirname(fileURLToPath(import.meta.url));
const feature = await loadFeature(path.join(here, "../../features/duplicate-field.feature"));

// Realize each scenario the way the Agent would: dispatch through the Tool
// Executor (`executeTool("duplicate_field", { id })`) over a real schema —
// integration-level (tool dispatch + schema), not calling duplicateField directly.

describeFeature(feature, ({ Scenario }) => {
  Scenario("复制字段在其后插入一个内容相同、id 不同的副本", ({ Given, When, Then, And }) => {
    let schema;
    let executeTool;
    let nameField;
    let copy;

    Given("一个含「姓名」「邮箱」两个字段的 schema", () => {
      schema = createSchema([
        { type: "text", label: "姓名" },
        { type: "text", label: "邮箱" },
      ]);
      executeTool = createToolExecutor({ vfs: createVfs(), schema });
      nameField = schema.fields[0];
    });

    When("作者复制「姓名」字段", async () => {
      copy = await executeTool("duplicate_field", { id: nameField.id });
    });

    Then("副本被插入到「姓名」字段之后", () => {
      const fields = getFormSchema(schema).fields;
      const original = fields.findIndex((f) => f.id === nameField.id);
      expect(fields[original + 1].id).toBe(copy.id);
    });

    And("副本与原字段内容相同", () => {
      const { id: _copyId, ...copyContent } = copy;
      const { id: _origId, ...origContent } = nameField;
      expect(copyContent).toEqual(origContent);
      expect(copy.label).toBe("姓名");
    });

    And("副本的 id 与原字段不同", () => {
      expect(copy.id).not.toBe(nameField.id);
    });

    And("schema 共有 3 个字段", () => {
      expect(getFormSchema(schema).fields).toHaveLength(3);
    });
  });

  Scenario("复制不存在的字段会报错", ({ Given, When, Then, And }) => {
    let schema;
    let executeTool;
    let countBefore;
    let thrown;

    Given("一个含「姓名」「邮箱」两个字段的 schema", () => {
      schema = createSchema([
        { type: "text", label: "姓名" },
        { type: "text", label: "邮箱" },
      ]);
      executeTool = createToolExecutor({ vfs: createVfs(), schema });
      countBefore = getFormSchema(schema).fields.length;
    });

    When("作者复制一个不存在的字段 id", async () => {
      thrown = await executeTool("duplicate_field", { id: "does_not_exist" }).then(
        () => null,
        (err) => err,
      );
    });

    Then("操作抛出「字段未找到」错误", () => {
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown.message).toMatch(/not found/i);
    });

    And("schema 字段数量保持不变", () => {
      expect(getFormSchema(schema).fields).toHaveLength(countBefore);
    });
  });
});
