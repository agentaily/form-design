// chatModels.ts — conversation-level model choice for the designer chat
// (SPEC §13.6 / §26.9, PR #65). Framework-agnostic, unit-testable.
//
// WHAT THIS IS: the chat's per-conversation 模型(型号)选择器 — the owner picks which
// DeepSeek model THIS conversation drives (V4-Flash 通用·快 vs V4-Pro 更强·深度推理). The
// selection rides into the proxy as the per-request `model` param on `POST /api/chat`
// (§13.6), which the backend validates against its whitelist (workers/src/chat.ts
// `DEEPSEEK_MODELS`) and otherwise backstops with the owner's saved model / default.
//
// MODEL NAMES (manager from-parent-1/2, 2026-06): DeepSeek now ships exactly two 型号 —
// `DeepSeek-V4-Flash`(通用·快,默认)and `DeepSeek-V4-Pro`(更强·深度推理). The old
// `deepseek-chat`/`deepseek-reasoner` ids are retired; these `value`s are what go upstream.
//
// DISTINCT FROM 集成设置 CREDENTIALS (§12): this is NOT the owner's saved DeepSeek model
// on owner_config — that is the persisted credential/default. This selector is a transient,
// per-conversation override surfaced in the chat composer; it is persisted only as a UI
// preference (localStorage, {@link CHAT_MODEL_STORAGE_KEY}), never as a credential, and
// never carries any key.

/** One selectable chat model for the conversation-level 选择器 (SPEC §13.6). */
export interface ChatModelOption {
  /** The wire value sent as `POST /api/chat`'s `model` param (∈ backend `DEEPSEEK_MODELS`). */
  value: string;
  /** Menu-row label (the dropdown option title), e.g. "DeepSeek-V4-Flash". */
  label: string;
  /** Menu-row one-line description (speed / capability tradeoff), e.g. "通用 · 快". */
  hint: string;
  /** Collapsed-state pill text shown on the composer chip, e.g. "DeepSeek · V4-Flash". */
  pill: string;
}

/**
 * The conversation-level model options (SPEC §13.6, manager final spec from-parent-2).
 * `value`s MUST stay in lockstep with the backend whitelist (workers/src/chat.ts
 * `DEEPSEEK_MODELS`) — an option whose value is not whitelisted upstream would 400 on send.
 * Order = display order; the first is the default (V4-Flash).
 */
export const CHAT_MODELS: ChatModelOption[] = [
  {
    value: "DeepSeek-V4-Flash",
    label: "DeepSeek-V4-Flash",
    hint: "通用 · 快",
    pill: "DeepSeek · V4-Flash",
  },
  {
    value: "DeepSeek-V4-Pro",
    label: "DeepSeek-V4-Pro",
    hint: "更强 · 深度推理",
    pill: "DeepSeek · V4-Pro",
  },
];

/** Default chat model when the owner has not picked one (mirrors backend default, §13.6). */
export const DEFAULT_CHAT_MODEL = "DeepSeek-V4-Flash";

/** localStorage key holding the owner's last-picked conversation model (a UI preference). */
export const CHAT_MODEL_STORAGE_KEY = "agentaily_forms_chat_model";

/**
 * Type guard: is `v` one of the selectable {@link CHAT_MODELS} `value`s (§13.6)? Used to
 * sanitize a value read back from localStorage / the chip before sending it as the
 * per-request `model` — an unknown value must NOT be forwarded (the backend would 400).
 *
 * @param v an untrusted candidate model value.
 * @returns true iff `v` is a known chat-model value.
 */
export function isValidChatModel(v: unknown): v is string {
  return typeof v === "string" && CHAT_MODELS.some((m) => m.value === v);
}

/**
 * The collapsed pill text for a model `value` (e.g. "DeepSeek · V4-Flash"). Falls back to
 * the default model's pill when `value` is unknown (so a stale localStorage value never
 * renders a blank chip). See {@link CHAT_MODELS}.
 *
 * @param value a model value (trusted or not).
 * @returns the pill text to render on the composer chip.
 */
export function chatModelPill(value: unknown): string {
  const match = CHAT_MODELS.find((m) => m.value === value);
  if (match) return match.pill;
  // Unknown / stale value → the default model's pill (never a blank chip).
  const fallback = CHAT_MODELS.find((m) => m.value === DEFAULT_CHAT_MODEL);
  // CHAT_MODELS always contains DEFAULT_CHAT_MODEL, but guard the lookup for type-safety.
  return fallback ? fallback.pill : "";
}
