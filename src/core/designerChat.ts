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
  /**
   * Optional conversation-level model (§13.6): the per-request `model` the owner picked
   * via the composer chip (∈ chatModels.CHAT_MODELS `value`s). When present it rides into
   * `POST /api/chat`'s body, taking precedence per-request; when absent, the proxy
   * backstops with the owner's saved model / global default. The caller is responsible for
   * only passing a whitelisted value (chatModels.isValidChatModel).
   */
  model?: string;
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
  model,
  onText,
  signal,
}: StreamDesignerChatArgs): Promise<{ text: string; toolCalls: RawToolCall[] }> {
  // `model` is additive + optional: only spread it when present so an unselected
  // conversation sends NO `model` key (the proxy then backstops with owner/default, §13.6).
  const res = await apiStream("/api/chat", {
    body: { messages, tools, ...(model ? { model } : {}) },
    auth: true,
    signal,
  });
  return consumeChatStream(res, { onText, signal });
}
