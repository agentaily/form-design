import { describe, it, expect, vi } from "vitest";
import {
  reduceDelta,
  finalizeAccumulator,
  emptyAccumulator,
  consumeChatStream,
} from "../../src/core/openaiStream";

// Build a streaming Response from OpenAI chunk objects (one SSE event each).
function chatResponse(chunks) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const delta = (d) => ({ choices: [{ delta: d }] });

describe("openaiStream · reduceDelta", () => {
  it("concatenates streamed text fragments", () => {
    const acc = emptyAccumulator();
    reduceDelta(acc, { content: "你" });
    reduceDelta(acc, { content: "好" });
    expect(acc.text).toBe("你好");
  });

  it("assembles a tool call from id/name + fragmented arguments by index", () => {
    const acc = emptyAccumulator();
    reduceDelta(acc, { tool_calls: [{ index: 0, id: "call_1", function: { name: "add_field" } }] });
    reduceDelta(acc, { tool_calls: [{ index: 0, function: { arguments: '{"type":"text"' } }] });
    reduceDelta(acc, { tool_calls: [{ index: 0, function: { arguments: ',"label":"姓名"}' } }] });
    const { toolCalls } = finalizeAccumulator(acc);
    expect(toolCalls).toEqual([
      { id: "call_1", name: "add_field", argsRaw: '{"type":"text","label":"姓名"}' },
    ]);
  });

  it("keeps parallel tool calls separate by index", () => {
    const acc = emptyAccumulator();
    reduceDelta(acc, {
      tool_calls: [
        { index: 0, id: "a", function: { name: "add_field", arguments: "{}" } },
        { index: 1, id: "b", function: { name: "remove_field", arguments: "{}" } },
      ],
    });
    expect(finalizeAccumulator(acc).toolCalls.map((t) => t.name)).toEqual([
      "add_field",
      "remove_field",
    ]);
  });
});

describe("openaiStream · consumeChatStream", () => {
  it("streams text via onText and returns the assembled text", async () => {
    const onText = vi.fn();
    const res = await consumeChatStream(
      chatResponse([delta({ content: "搭" }), delta({ content: "好了" })]),
      { onText },
    );
    expect(onText.mock.calls.map((c) => c[0])).toEqual(["搭", "好了"]);
    expect(res).toEqual({ text: "搭好了", toolCalls: [] });
  });

  it("returns assembled tool calls and ignores the [DONE] sentinel", async () => {
    const res = await consumeChatStream(
      chatResponse([
        delta({ tool_calls: [{ index: 0, id: "c1", function: { name: "set_form_meta" } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"title":"报名"}' } }] }),
      ]),
    );
    expect(res.text).toBe("");
    expect(res.toolCalls).toEqual([
      { id: "c1", name: "set_form_meta", argsRaw: '{"title":"报名"}' },
    ]);
  });
});
