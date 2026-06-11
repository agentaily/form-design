import { describe, it, expect, vi } from "vitest";
import { runAgentTurn } from "../../src/core/agentLoop";
import { createToolExecutor } from "../../src/core/tools";
import { createVfs, readFile } from "../../src/core/vfs";
import { createSchema } from "../../src/core/schema";

const text = (t) => ({ type: "text", text: t });
const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });

// Fake LLM: returns one scripted content array per call, clamping on the last.
function fakeLLM(script) {
  let i = 0;
  return vi.fn(async () => ({ content: script[Math.min(i++, script.length - 1)] }));
}

describe("agentLoop · stop condition", () => {
  it("ends the turn when the LLM returns plain text (no tool_use)", async () => {
    const messages = [];
    const onAssistantText = vi.fn();
    const callLLM = fakeLLM([[text("好的，搭好了")]]);

    const res = await runAgentTurn({
      userText: "做个报名表",
      messages,
      callLLM,
      executeTool: vi.fn(),
      onAssistantText,
    });

    expect(res).toEqual({ stopped: "text", iters: 1 });
    expect(onAssistantText).toHaveBeenCalledOnce();
    expect(messages[0]).toEqual({ role: "user", content: "做个报名表" });
  });
});

describe("agentLoop · tool execution", () => {
  it("runs tool_use blocks, backfills tool_result, rerenders, then stops on text", async () => {
    const schema = createSchema();
    const vfs = createVfs();
    const executeTool = createToolExecutor({ vfs, schema });
    const onPreview = vi.fn();
    const messages = [];

    const callLLM = fakeLLM([
      [toolUse("t1", "add_field", { field: { id: "name", type: "text", label: "姓名" } })],
      [text("加好了")],
    ]);

    const res = await runAgentTurn({
      userText: "加个姓名",
      messages,
      callLLM,
      executeTool,
      onPreview,
    });

    expect(res.stopped).toBe("text");
    expect(schema.fields.map((f) => f.id)).toEqual(["name"]); // tool mutated state
    expect(onPreview).toHaveBeenCalledTimes(1); // one rerender after the tool batch

    // a tool_result was backfilled into the message list
    const toolResults = messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result") : [],
    );
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].tool_use_id).toBe("t1");
    expect(toolResults[0].is_error).toBeUndefined();
  });
});

describe("agentLoop · error self-healing", () => {
  it("a failed tool comes back as is_error, and the Agent fixes it next iteration", async () => {
    const vfs = createVfs({ "/form.jsx": "const Form = () => null;" });
    const executeTool = createToolExecutor({ vfs, schema: createSchema() });
    const messages = [];

    const callLLM = fakeLLM([
      // 1) bad edit — old_str not present → throws → is_error
      [toolUse("t1", "str_replace", { path: "/form.jsx", old_str: "NOPE", new_str: "X" })],
      // 2) recover — full rewrite
      [toolUse("t2", "write_file", { path: "/form.jsx", content: "const Form = () => <div/>;" })],
      // 3) done
      [text("修好了")],
    ]);

    const res = await runAgentTurn({ userText: "改表单", messages, callLLM, executeTool });

    expect(res.stopped).toBe("text");
    const results = messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result") : [],
    );
    expect(results[0].is_error).toBe(true); // first edit failed
    expect(results[1].is_error).toBeUndefined(); // recovery succeeded
    expect(readFile(vfs, "/form.jsx")).toContain("<div/>"); // self-healed
  });
});

describe("agentLoop · safety valve", () => {
  it("stops at max_iters if the LLM never stops calling tools", async () => {
    const executeTool = createToolExecutor({ vfs: createVfs(), schema: createSchema() });
    const callLLM = fakeLLM([[toolUse("loop", "list_files", {})]]); // always a tool_use
    const messages = [];

    const res = await runAgentTurn({ userText: "go", messages, callLLM, executeTool, maxIters: 3 });

    expect(res).toEqual({ stopped: "max_iters", iters: 3 });
    expect(callLLM).toHaveBeenCalledTimes(3);
  });
});
