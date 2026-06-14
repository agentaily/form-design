// Unit specs for src/core/designerChat.ts — the real `callChat` for the designer loop.
// Realizes the unit-altitude slice of features/chat-multi-session.feature 「对话级模型芯片」:
// when the owner has picked a conversation model, streamDesignerChat forwards it as the
// per-request `model` on POST /api/chat (§13.6); when absent, no `model` key rides along
// (the proxy backstops with the owner's saved / default model).
//
// We mock the lowest seam (global `fetch`) and assert the request body, then feed a minimal
// SSE stream so consumeChatStream resolves cleanly.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { streamDesignerChat } from "../../src/core/designerChat";
import { setToken, clearToken } from "../../src/core/apiClient";

// A minimal valid OpenAI-style SSE stream: one content delta + [DONE].
function sseResponse() {
  const body =
    `data: ${JSON.stringify({ choices: [{ delta: { content: "好的" } }] })}\n\n` +
    `data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

beforeEach(() => {
  setToken("jwt-owner");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearToken();
});

describe("designerChat · streamDesignerChat model passthrough", () => {
  const messages = [{ role: "user", content: "做一个报名表" }];

  it("forwards the per-request `model` in the POST body when provided (§13.6)", async () => {
    const fetchMock = vi.fn(async () => sseResponse());
    vi.stubGlobal("fetch", fetchMock);

    await streamDesignerChat({ messages, model: "deepseek-v4-pro" });

    const [, init] = fetchMock.mock.calls[0];
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe("deepseek-v4-pro");
    // it still carries the messages + tools (model is additive).
    expect(sent.messages).toEqual(messages);
    expect(Array.isArray(sent.tools)).toBe(true);
  });

  it("omits `model` from the body when none is provided (proxy backstops with owner/default)", async () => {
    const fetchMock = vi.fn(async () => sseResponse());
    vi.stubGlobal("fetch", fetchMock);

    await streamDesignerChat({ messages });

    const [, init] = fetchMock.mock.calls[0];
    const sent = JSON.parse(init.body);
    expect("model" in sent).toBe(false);
  });
});
