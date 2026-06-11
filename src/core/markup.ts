// markup.ts — pure logic for the preview "指向修改 / element targeting" tool
// (SPEC §10 Phase 3: inline comment / 元素选中改).
//
// This is a *personal locating* tool: instead of describing "右侧那个提交按钮"
// in words, the author points at a real preview element and sends a message that
// already carries that element's identity. No comments are persisted.
//
// Scope of this module: the DOM-free, testable bits only —
//   - mapping a schema field type to its Chinese `kind` label,
//   - stripping the trailing required-star off a field label,
//   - formatting the identity-tagged message that lands in the left chat.
// The DOM interactions (hover, elementFromPoint, highlight box, composer
// placement) live in the React `MarkupLayer` component, NOT here.

/** The schema field types that can be located in the preview. */
export type MarkupFieldType =
  | "text"
  | "tel"
  | "email"
  | "textarea"
  | "radio"
  | "checks"
  | "select"
  | "consent";

/**
 * The identity of a targetable element, as carried on its `data-mk-*` attributes.
 * `kind` is optional: some targets (e.g. the hero) may have only a label.
 */
export interface MarkupTarget {
  /** Human label, e.g. "姓名" or "提交按钮" (required-star already stripped). */
  label: string;
  /** Chinese kind label, e.g. "输入框" / "按钮"; omitted when the target has none. */
  kind?: string;
}

/**
 * Field type → Chinese `kind` label, used to tag each preview field with
 * `data-mk-kind`. This is the single source of truth for the mapping that the
 * preview and the markup tag both read.
 *
 * text/tel/email → 输入框, textarea → 多行文本, radio → 单选,
 * checks → 多选, select → 下拉选择, consent → 勾选项.
 */
export const FIELD_KIND_LABEL: Readonly<Record<MarkupFieldType, string>> = {
  text: "输入框",
  tel: "输入框",
  email: "输入框",
  textarea: "多行文本",
  radio: "单选",
  checks: "多选",
  select: "下拉选择",
  consent: "勾选项",
} as const;

/** Fallback `kind` for a field whose type is not in {@link FIELD_KIND_LABEL}. */
export const FIELD_KIND_FALLBACK = "字段";

/**
 * Resolve a field type to its Chinese `kind` label for the markup tag.
 * Unknown / unmapped types fall back to {@link FIELD_KIND_FALLBACK} ("字段").
 *
 * @example fieldKindLabel("textarea") === "多行文本"
 * @example fieldKindLabel("???" as MarkupFieldType) === "字段"
 */
export function fieldKindLabel(type: string): string {
  return (FIELD_KIND_LABEL as Record<string, string>)[type] ?? FIELD_KIND_FALLBACK;
}

/**
 * Strip a trailing required-star from a field label so the markup label reads
 * cleanly. Removes a final "*" plus any surrounding whitespace.
 *
 * @example mkLabel("手机号 *") === "手机号"
 * @example mkLabel("姓名") === "姓名"
 * @example mkLabel("") === "字段"   // empty/blank falls back to "字段"
 */
export function mkLabel(label: string): string {
  const cleaned = label.replace(/\s*\*\s*$/, "").trim();
  return cleaned || FIELD_KIND_FALLBACK;
}

/**
 * Format the identity-tagged chat message sent to the left conversation.
 *
 * With a kind:      `〔label · kind〕note`
 * Without a kind:   `〔label〕note`
 *
 * `note` is trimmed before composing. Callers must guard against an empty
 * trimmed `note` (the "发送到对话" button is disabled in that case); behavior
 * for an empty `note` here is unspecified and should not be relied upon.
 *
 * @example formatMarkupMessage("提交按钮", "按钮", "改成立即报名") === "〔提交按钮 · 按钮〕改成立即报名"
 * @example formatMarkupMessage("封面", undefined, "换个图") === "〔封面〕换个图"
 */
export function formatMarkupMessage(label: string, kind: string | undefined, note: string): string {
  const tag = kind ? `${label} · ${kind}` : label;
  return `〔${tag}〕${note.trim()}`;
}

/**
 * Convenience overload over {@link formatMarkupMessage} that takes a resolved
 * {@link MarkupTarget} (the shape the `MarkupLayer` already holds for the
 * selected element) plus the author's note.
 */
export function formatMarkupMessageForTarget(target: MarkupTarget, note: string): string {
  return formatMarkupMessage(target.label, target.kind, note);
}
