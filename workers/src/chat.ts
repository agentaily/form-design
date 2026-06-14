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

// MODEL NAMES (2026-06): DeepSeek ships exactly two 型号 — V4-Flash(通用·快,默认)and
// V4-Pro(更强·深度推理). The API model id is **case-sensitive lowercase** — the
// OpenAI-compatible `/chat/completions` endpoint 400s on a camelCase display name
// (`"DeepSeek-V4-Flash"`) or an unknown/retired id. So these whitelist strings — what go
// upstream as-is — MUST be the lowercase ids. Display names (`DeepSeek-V4-Flash`) live only
// in the frontend's chatModels.ts label/pill. The old `deepseek-chat`/`deepseek-reasoner`
// ids are retired. See the deepseek-api skill for the authoritative ids.

/** Default model when the owner left `deepseek.model` unspecified. SPEC.md §13.1. */
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";

/**
 * Allowed per-request DeepSeek models (SPEC.md §13.6, PR #65) — the lowercase API ids.
 * The conversation-level 模型(型号)选择器 sends one of these as `ChatRequest.model`; the
 * proxy accepts it ONLY if it is in this whitelist (else 400 — never forwards an arbitrary
 * model string upstream). Owner credential / default still backstop when no per-request
 * model is sent (§13.6); a stored value is run through {@link normalizeDeepSeekModel} first.
 */
export const DEEPSEEK_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;

/** A whitelisted per-request DeepSeek model (a member of {@link DEEPSEEK_MODELS}). */
export type DeepSeekModel = (typeof DEEPSEEK_MODELS)[number];

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
 * Request body for `POST /api/chat`. The proxy accepts `messages` (required),
 * `tools` (optional), and an optional whitelisted `model` (the conversation-level
 * model chip, §13.6 / PR #65); temperature etc. are still filled by the backend.
 * `stream` is always forced to `true` by the Worker regardless of the body.
 * See SPEC.md §13.2.
 */
export interface ChatRequest {
  /** Required, non-empty array of chat messages. Forwarded to upstream. */
  messages: ChatMessage[];
  /** Optional function-calling tools. Forwarded to upstream when present. */
  tools?: ChatTool[];
  /**
   * Optional per-request model from the conversation-level chip (§13.6). When present it
   * MUST be a whitelisted {@link DeepSeekModel} (∈ {@link DEEPSEEK_MODELS}); an unknown
   * model is rejected (the route maps the rejection to `400 { error: "unsupported model" }`).
   * When absent it is OMITTED here, and the proxy falls back to the owner's saved model /
   * {@link DEFAULT_DEEPSEEK_MODEL} (§13.6 priority order). Never a free-form string upstream.
   */
  model?: DeepSeekModel;
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

/** Type guard: is `v` a whitelisted per-request DeepSeek model (§13.6)? */
export function isDeepSeekModel(v: unknown): v is DeepSeekModel {
  return typeof v === "string" && (DEEPSEEK_MODELS as readonly string[]).includes(v);
}

/**
 * Coerce an arbitrary stored/forwarded model string into a valid lowercase DeepSeek id
 * before it ever reaches upstream — the last line of defense against a 400 from a bad
 * `model`. The DeepSeek API id is case-sensitive lowercase; a camelCase display name
 * (`"DeepSeek-V4-Flash"`) or a wrong-cased variant 400s. This BACKSTOPS dirty owner config
 * persisted before the id casing was fixed (D1 may hold `deepseek_model = "DeepSeek-V4-Flash"`),
 * so old owners need not re-save their config:
 *
 *  1. Already a whitelisted lowercase id → returned unchanged.
 *  2. A known model in any other casing (e.g. the camelCase display name) → its lowercase
 *     id (`"DeepSeek-V4-Pro"` → `"deepseek-v4-pro"`), since lowercasing a display name lands
 *     exactly on the whitelist id.
 *  3. Anything else (retired `deepseek-chat`/`deepseek-reasoner`, junk, non-string) →
 *     {@link DEFAULT_DEEPSEEK_MODEL}.
 */
export function normalizeDeepSeekModel(model: unknown): DeepSeekModel {
  if (isDeepSeekModel(model)) return model;
  if (typeof model === "string") {
    const lower = model.toLowerCase();
    if (isDeepSeekModel(lower)) return lower;
  }
  return DEFAULT_DEEPSEEK_MODEL;
}

/**
 * Validate + normalize a parsed JSON body into a {@link ChatRequest}.
 *
 * - `messages` must be a non-empty array; otherwise reject (the route maps the
 *   rejection to `400 { error: "messages is required" }`, nothing forwarded).
 * - `tools`, when present, must be an array (else omitted / rejected per impl).
 * - `model`, when present, must be a whitelisted {@link DeepSeekModel} (∈
 *   {@link DEEPSEEK_MODELS}); an unknown / non-string model is rejected (the route maps
 *   the rejection to `400 { error: "unsupported model" }`). When absent it is OMITTED
 *   from the result, so the proxy falls back to the owner's saved model / default (§13.6).
 * - Does NOT inspect the inner shape of messages/tools — those stay opaque and
 *   are forwarded to upstream untouched. See SPEC.md §13.2.
 *
 * @throws if `messages` is missing / not an array / empty, or `model` is an unknown value.
 */
export function parseChatRequest(body: unknown): ChatRequest {
  if (typeof body !== "object" || body === null) {
    throw new Error("messages is required");
  }

  const { messages, tools, model } = body as {
    messages?: unknown;
    tools?: unknown;
    model?: unknown;
  };

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

  // `model` is optional; when present it must be a whitelisted DeepSeekModel (§13.6).
  // Unknown / non-string → reject (route → 400 "unsupported model"); absent → omit so the
  // proxy backstops with owner.deepseek.model / DEFAULT_DEEPSEEK_MODEL.
  if (model !== undefined) {
    if (!isDeepSeekModel(model)) {
      throw new Error("unsupported model");
    }
    request.model = model;
  }

  return request;
}
