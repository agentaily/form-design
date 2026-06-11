import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { runAgentTurn } from "../../src/core/agentLoop";
import { createToolExecutor } from "../../src/core/tools";
import { createVfs, readFile } from "../../src/core/vfs";
import { createSchema } from "../../src/core/schema";

const here = path.dirname(fileURLToPath(import.meta.url));
const feature = await loadFeature(path.join(here, "features/agent-self-heal.feature"));

const text = (t) => ({ type: "text", text: t });
const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });

function fakeLLM(script) {
  let i = 0;
  return vi.fn(async () => ({ content: script[Math.min(i++, script.length - 1)] }));
}

describeFeature(feature, ({ Scenario }) => {
  Scenario("失败的编辑被回填为错误并自动修复", ({ Given, When, Then, And }) => {
    let vfs;
    let messages;
    let res;

    Given("一个含 form.jsx 的虚拟文件系统", () => {
      vfs = createVfs({ "/form.jsx": "const Form = () => null;" });
      messages = [];
    });

    When("Agent 先发出一个会失败的 str_replace 再发出修正的 write_file", async () => {
      const executeTool = createToolExecutor({ vfs, schema: createSchema() });
      const callLLM = fakeLLM([
        [toolUse("t1", "str_replace", { path: "/form.jsx", old_str: "NOPE", new_str: "X" })],
        [toolUse("t2", "write_file", { path: "/form.jsx", content: "const Form = () => <div/>;" })],
        [text("修好了")],
      ]);
      res = await runAgentTurn({ userText: "改表单", messages, callLLM, executeTool });
    });

    Then("第一次工具结果被标记为错误", () => {
      const results = messages.flatMap((m) =>
        Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result") : [],
      );
      expect(results[0].is_error).toBe(true);
    });

    And("最终文件被成功修复", () => {
      expect(readFile(vfs, "/form.jsx")).toContain("<div/>");
    });

    And("本回合以纯文本结束", () => {
      expect(res.stopped).toBe("text");
    });
  });
});
