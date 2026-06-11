import { describe, it, expect, vi } from "vitest";
import { runDesignerTurn } from "../../src/core/designerLoop";
import { createFormModel, applyDesignerTool } from "../../src/core/designerTools";

// Fake callChat: returns one scripted { text, toolCalls } per call, clamping on the last.
function fakeChat(script) {
  let i = 0;
  return vi.fn(async () => script[Math.min(i++, script.length - 1)]);
}
const tc = (id, name, args) => ({ id, name, argsRaw: JSON.stringify(args) });

describe("designerLoop · stop condition", () => {
  it("ends the turn when the LLM returns plain text (no tool calls)", async () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    const callChat = fakeChat([{ text: "好的，搭好了", toolCalls: [] }]);
    const res = await runDesignerTurn({ messages, callChat, executeTool: vi.fn() });
    expect(res).toEqual({ stopped: "text", iters: 1 });
    expect(messages.at(-1)).toEqual({ role: "assistant", content: "好的，搭好了" });
  });
});

describe("designerLoop · tool execution", () => {
  it("runs tool calls, mutates the model, backfills tool messages, then stops on text", async () => {
    const model = createFormModel();
    const messages = [{ role: "user", content: "加个姓名" }];
    const onPreview = vi.fn();
    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();
    const callChat = fakeChat([
      { text: "", toolCalls: [tc("t1", "add_field", { type: "text", label: "姓名" })] },
      { text: "加好了", toolCalls: [] },
    ]);

    const res = await runDesignerTurn({
      messages,
      callChat,
      executeTool: (name, input) => applyDesignerTool(model, name, input),
      onToolStart,
      onToolEnd,
      onPreview,
    });

    expect(res.stopped).toBe("text");
    expect(model.fields.map((f) => f.label)).toEqual(["姓名"]);
    expect(onPreview).toHaveBeenCalledTimes(1);

    // assistant tool-call turn recorded in OpenAI shape, then a matching tool message
    const assistant = messages.find((m) => m.role === "assistant" && m.tool_calls);
    expect(assistant.content).toBeNull();
    expect(assistant.tool_calls[0]).toMatchObject({ id: "t1", function: { name: "add_field" } });
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg.tool_call_id).toBe("t1");

    expect(onToolStart).toHaveBeenCalledWith(expect.objectContaining({ name: "add_field" }));
    expect(onToolEnd).toHaveBeenCalledWith(
      expect.objectContaining({ name: "add_field" }),
      expect.any(String),
    );
    expect(onToolEnd.mock.calls[0][0].error).toBeFalsy(); // success → no error flag
  });
});

describe("designerLoop · self-healing", () => {
  it("backfills a failed tool as an error result and lets the model recover next turn", async () => {
    const model = createFormModel();
    const messages = [{ role: "user", content: "删掉那个不存在的字段" }];
    const onToolEnd = vi.fn();
    const callChat = fakeChat([
      { text: "", toolCalls: [tc("t1", "remove_field", { id: "ghost" })] },
      { text: "", toolCalls: [tc("t2", "add_field", { type: "text", label: "姓名" })] },
      { text: "修好了", toolCalls: [] },
    ]);

    const res = await runDesignerTurn({
      messages,
      callChat,
      executeTool: (name, input) => applyDesignerTool(model, name, input),
      onToolEnd,
    });

    expect(res.stopped).toBe("text");
    expect(onToolEnd.mock.calls[0][0].error).toBe(true); // the bad remove failed
    expect(onToolEnd.mock.calls[0][1]).toMatch(/field not found/);
    expect(model.fields.map((f) => f.label)).toEqual(["姓名"]); // recovery applied
  });

  it("treats malformed tool arguments as a recoverable tool error", async () => {
    const messages = [{ role: "user", content: "x" }];
    const onToolEnd = vi.fn();
    const callChat = fakeChat([
      { text: "", toolCalls: [{ id: "t1", name: "add_field", argsRaw: "{ not json" }] },
      { text: "ok", toolCalls: [] },
    ]);
    await runDesignerTurn({ messages, callChat, executeTool: vi.fn(), onToolEnd });
    expect(onToolEnd.mock.calls[0][0].error).toBe(true);
    expect(onToolEnd.mock.calls[0][1]).toMatch(/invalid tool arguments/);
  });
});

describe("designerLoop · safety valve", () => {
  it("stops at maxIters if the model never stops calling tools", async () => {
    const messages = [{ role: "user", content: "go" }];
    const callChat = fakeChat([{ text: "", toolCalls: [tc("loop", "get_form_schema", {})] }]);
    const res = await runDesignerTurn({
      messages,
      callChat,
      executeTool: () => ({ ok: true }),
      maxIters: 3,
    });
    expect(res).toEqual({ stopped: "max_iters", iters: 3 });
    expect(callChat).toHaveBeenCalledTimes(3);
  });
});
