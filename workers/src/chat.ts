// chat.ts — type contracts for the LLM proxy `POST /api/chat`.
// See SPEC.md §13 (后端 · LLM 代理：用 owner key 直连 DeepSeek，流式透传).
//
// This module holds the *shapes* the proxy works against; the orchestration
// (read+decrypt owner config → fetch upstream → stream-through) is owned by
// `implementer` in index.ts / a proxy helper, and exercised by `outer-tester`
// via SELF.fetch with a mocked api.deepseek.com.
//
// The proxy is a thin forwarder: `messages` / `tools` are opaque to it (passed
// through to upstream untouched), so we model them loosely on purpose — the
// proxy must not couple to DeepSeek's evolving request/stream schema.

/** Upstream DeepSeek base URL — OpenAI-compatible `/chat/completions`. SPEC.md §13.1. */
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/** Default model when the owner left `deepseek.model` unspecified. SPEC.md §13.1. */
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";

/**
 * A single OpenAI-style chat message. Opaque to the proxy: it is forwarded to
 * upstream untouched. Modeled loosely so the proxy never couples to the upstream
 * message schema (roles, content parts, tool-call fields all live upstream).
 */
export interface ChatMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

/**
 * A function-calling tool entry. Opaque to the proxy — forwarded to upstream
 * as-is. Its inner shape (DeepSeek/OpenAI function schema) is upstream's concern.
 */
export type ChatTool = Record<string, unknown>;

/**
 * Request body for `POST /api/chat`. The proxy accepts only `messages` (required)
 * and `tools` (optional); `model` / temperature etc. are filled by the backend.
 * `stream` is always forced to `true` by the Worker regardless of the body.
 * See SPEC.md §13.2.
 */
export interface ChatRequest {
  /** Required, non-empty array of chat messages. Forwarded to upstream. */
  messages: ChatMessage[];
  /** Optional function-calling tools. Forwarded to upstream when present. */
  tools?: ChatTool[];
}

/**
 * The JSON error shape for the non-streaming error branches of `POST /api/chat`
 * (missing config, bad request, upstream failure). Success responses are an SSE
 * stream, never this shape. The `error` string MUST NOT contain the owner's
 * DeepSeek key or anything that could reconstruct it. See SPEC.md §13.4, §13.5.
 */
export interface ChatErrorBody {
  error: string;
}

/**
 * Thrown when `POST /api/chat` is invoked but the owner has no DeepSeek key
 * configured (`OwnerConfig.deepseek === null`). The route surfaces this as a
 * `409 { error: "owner 未配置 DeepSeek" }` and never calls upstream, letting the
 * frontend route the owner to 集成设置 (§12). See SPEC.md §13.4.
 */
export class DeepSeekNotConfiguredError extends Error {
  constructor(message = "owner 未配置 DeepSeek") {
    super(message);
    this.name = "DeepSeekNotConfiguredError";
  }
}

/**
 * Validate + normalize a parsed JSON body into a {@link ChatRequest}.
 *
 * - `messages` must be a non-empty array; otherwise reject (the route maps the
 *   rejection to `400 { error: "messages is required" }`, nothing forwarded).
 * - `tools`, when present, must be an array (else omitted / rejected per impl).
 * - Does NOT inspect the inner shape of messages/tools — those stay opaque and
 *   are forwarded to upstream untouched. See SPEC.md §13.2.
 *
 * @throws if `messages` is missing / not an array / empty.
 */
export function parseChatRequest(body: unknown): ChatRequest {
  if (typeof body !== "object" || body === null) {
    throw new Error("messages is required");
  }

  const { messages, tools } = body as { messages?: unknown; tools?: unknown };

  // `messages` must be a non-empty array. We do NOT inspect inner shape — it is
  // opaque and forwarded to upstream untouched (SPEC.md §13.2).
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("messages is required");
  }

  const request: ChatRequest = { messages: messages as ChatMessage[] };

  // `tools` is optional; when present it must be an array (passed through as-is).
  if (tools !== undefined) {
    if (!Array.isArray(tools)) {
      throw new Error("tools must be an array");
    }
    request.tools = tools as ChatTool[];
  }

  return request;
}
