// designerChat.ts — the real `callChat` for the designer loop: POST the OpenAI-
// shaped message history + tool defs to the backend proxy (SPEC §13), then consume
// the streamed response into assembled text + tool calls. This is the production
// wiring injected into runDesignerTurn; tests inject a fake callChat instead.

import { apiStream } from "./apiClient";
import { consumeChatStream, type RawToolCall } from "./openaiStream";
import { DESIGNER_TOOLS } from "./designerTools";
import type { ChatMessage } from "./designerLoop";

export interface StreamDesignerChatArgs {
  messages: ChatMessage[];
  tools?: unknown[];
  /** Live text fragments, for streaming the assistant bubble. */
  onText?: (delta: string) => void;
  signal?: AbortSignal;
}

/**
 * Stream one designer LLM turn through `POST /api/chat`. The proxy is owner-only
 * (§17), so the request carries the Bearer token; a non-2xx (e.g. 401 不登录,
 * 409 未配置 DeepSeek, 502 上游) surfaces as an ApiError for the caller to show.
 */
export async function streamDesignerChat({
  messages,
  tools = DESIGNER_TOOLS,
  onText,
  signal,
}: StreamDesignerChatArgs): Promise<{ text: string; toolCalls: RawToolCall[] }> {
  const res = await apiStream("/api/chat", {
    body: { messages, tools },
    auth: true,
    signal,
  });
  return consumeChatStream(res, { onText, signal });
}
