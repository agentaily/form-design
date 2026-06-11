// public-form.jsx — the PUBLIC fill page (答题者侧, 第 6 步). Contract stub: the body
// is left for `implementer`; this file fixes the component's props, behaviour, and
// the field-type → design-system input mapping it must honour. Behaviour spec:
// features/public-fill.feature.
//
// This is a STANDALONE answerer view. App mounts ONLY this (no chat / preview / login
// / settings / publish chrome) when matchPublicForm(pathname) matches /f/:slug
// (see src/core/router.ts + the 路由分流挂载点 note in App.jsx). It never holds the
// owner token; all I/O goes through publicClient (NO Bearer).
//
// Lifecycle:
//   1. On mount → getPublicForm(slug):
//        • 200  → render meta (title/description) + one input per field.
//        • 404  → friendly "表单不存在" page (NOT a designer error / not a thrown crash).
//        • other (network/5xx) → a retriable load-error state.
//      A spinner shows while the fetch is in flight.
//   2. Render each PublicField as a design-system control by type (PUBLIC_FIELD_RENDER
//      below) — NEVER hand-rolled inputs.
//   3. Required client-side pre-check before submit: required fields that are empty
//      block submit with an inline 必填 hint (mirrors §20.3 空值判定: empty string /
//      whitespace / empty array = 未填). This is a UX fast-path; the backend re-checks.
//   4. answers 收集约定 (§15.2/§16.5): map the filled values into
//        answers: [{ label: field.label, value }]
//      where `value` is a string for single-value fields and a string[] for multi
//      (checkbox). The submit body is { formSlug: slug, answers } (formSlug = the
//      route slug). Then → submitForm(slug, answers).
//   5. Submit outcomes:
//        • 200      → a 感谢 / 提交成功 state (no answerer sees the recordId; just success).
//        • 400      → surface 缺必填 / 形状错误 (backend `{ error }` message).
//        • 404      → "表单不存在"（this slug was deleted）.
//        • 409      → "该表单已停止收集" (form closed/draft, §20.2) or the owner-未配飞书
//                     message (§15.6) — taken from ApiError.message.
//        • 502 / 其它 → "提交失败，请稍后重试".
//
// All chrome from @agentaily/design-system (Form/Field/Input/Textarea/Select/
// RadioGroup/Checkbox/Button/Alert/Spinner/Empty). The existing designer preview
// (src/preview.jsx) renders the SAME field types over the UI vocabulary; this page
// renders the BACKEND vocabulary (PublicFieldType) and must reuse DS components, not
// re-vendor inputs.

import React, { useState, useEffect, useCallback } from "react";
import {
  Field,
  Input,
  Select,
  RadioGroup,
  Checkbox,
  Button,
  Alert,
  Spinner,
  Empty,
} from "@agentaily/design-system";
import { Icon } from "./chat.jsx";
import {
  getPublicForm as defaultGetPublicForm,
  submitForm as defaultSubmitForm,
} from "./core/publicClient";
import { ApiError } from "./core/apiClient";

/**
 * Map a backend PublicFieldType (SPEC §16.2) to the design-system control the public
 * page renders. The contract (implementer wires the actual JSX):
 *   text   → <Input type="text">
 *   number → <Input type="number">      (value collected as a string; §15.3 keeps it raw)
 *   date   → <Input type="date">
 *   select → <Select>      (single choice; options from field.options)
 *   radio  → <RadioGroup>  (single choice)
 *   checkbox →
 *      • with options    → a multi-checkbox group → value is string[] (multi-choice)
 *      • without options  → a single consent <Checkbox> → value is "" | the agreed value
 *   file   → out of scope for MVP submit (§15.3); render disabled / a note, do not block.
 *   group  → render its children recursively under a section (MVP may flatten; required
 *            validation stays top-level per §20.3).
 * Exported so the mapping is one source of truth + unit-checkable.
 */
export const PUBLIC_FIELD_RENDER = {
  text: "Input",
  number: "Input",
  date: "Input",
  select: "Select",
  radio: "RadioGroup",
  checkbox: "Checkbox",
  file: "Input",
  group: "group",
};

/**
 * Collect the page's filled values into the §15.2 answers wire shape. Pure helper
 * (no React/DOM) so it is unit-testable on its own:
 *   - one entry per field that has a value: { label: field.label, value }
 *   - single-value fields → value: string; checkbox-with-options → value: string[]
 *   - empty values (empty string / whitespace-only / empty array) are omitted (an
 *     unanswered optional field contributes no answer; required emptiness is caught
 *     by the pre-check, step 3 above).
 * Stub.
 *
 * @param {import("./core/publicClient").PublicField[]} fields
 * @param {Record<string, string | string[]>} values  field.id → current value
 * @returns {import("./core/publicClient").Answer[]}
 */
// §20.3 空值判定: an answer is "empty" (→ omitted) when it's an empty/whitespace-only
// string or an empty array.
function isEmptyValue(v) {
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "string") return v.trim() === "";
  return v === undefined || v === null;
}

export function collectAnswers(fields, values) {
  const out = [];
  for (const field of fields) {
    const v = values[field.id];
    if (isEmptyValue(v)) continue;
    out.push({ label: field.label, value: v });
  }
  return out;
}

/**
 * The public fill page (SPEC §16.4.1, 第 6 步). Mounted by App at /f/:slug.
 *
 * @param {object} props
 * @param {string} props.slug                       the slug parsed from /f/:slug
 * @param {(slug: string) => Promise<import("./core/publicClient").PublicForm>} [props.getPublicForm]
 *        injected for tests; defaults to the real publicClient.getPublicForm (NO Bearer)
 * @param {(slug: string, answers: import("./core/publicClient").Answer[]) =>
 *          Promise<import("./core/publicClient").SubmitResult>} [props.submitForm]
 *        injected for tests; defaults to the real publicClient.submitForm (NO Bearer)
 */
// §20.3 空值判定 — used by the required pre-check (mirrors collectAnswers's isEmptyValue).
function isAnswered(field, v) {
  if (field.type === "checkbox" && Array.isArray(field.options)) {
    return Array.isArray(v) && v.length > 0;
  }
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "string") return v.trim() !== "";
  return v !== undefined && v !== null && v !== "";
}

// HTML input type for the Input-rendered field kinds.
const INPUT_TYPE = { text: "text", number: "number", date: "date", file: "file" };

/**
 * One published field → its design-system control (PUBLIC_FIELD_RENDER mapping).
 * Controlled: reads `value` (string | string[]) and reports changes via `onChange`.
 */
function PublicField({ field, value, onChange }) {
  const { type, label, required, options } = field;

  // checkbox WITH options → a multi-checkbox group → string[] of selected values.
  if (type === "checkbox" && Array.isArray(options)) {
    const selected = Array.isArray(value) ? value : [];
    const toggle = (optValue, on) =>
      onChange(on ? [...selected, optValue] : selected.filter((x) => x !== optValue));
    return (
      <Field label={label} required={required}>
        <div className="pf-checks">
          {options.map((o) => (
            <Checkbox
              key={o.value}
              label={o.label}
              checked={selected.includes(o.value)}
              onChange={(e) => toggle(o.value, e.target.checked)}
            />
          ))}
        </div>
      </Field>
    );
  }

  // checkbox WITHOUT options → a single consent box → "" | the agreed value (its label).
  if (type === "checkbox") {
    return (
      <Field>
        <Checkbox
          label={label}
          checked={!!value}
          onChange={(e) => onChange(e.target.checked ? label : "")}
        />
      </Field>
    );
  }

  if (type === "radio") {
    return (
      <Field label={label} required={required}>
        <RadioGroup
          name={field.id}
          value={typeof value === "string" ? value : ""}
          options={options || []}
          onChange={(v) => onChange(v)}
        />
      </Field>
    );
  }

  if (type === "select") {
    const opts = [{ value: "", label: "请选择" }, ...(options || [])];
    return (
      <Field label={label} required={required}>
        <Select
          options={opts}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      </Field>
    );
  }

  // text / number / date / file → a single-line Input (its own accessible label).
  return (
    <Input
      label={label}
      required={required}
      type={INPUT_TYPE[type] || "text"}
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function PublicFormPage({
  slug,
  getPublicForm = defaultGetPublicForm,
  submitForm = defaultSubmitForm,
} = {}) {
  // Load lifecycle: loading → loaded | notFound (404) | loadError (other).
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);
  const [loadState, setLoadState] = useState("loading"); // loading | ok | notfound | error
  // Per-field value map keyed by field.id (collectAnswers's value shape).
  const [values, setValues] = useState({});
  // Inline required pre-check message (UX fast-path; backend re-checks).
  const [requiredError, setRequiredError] = useState("");
  // Submit lifecycle + the backend's rejection message to surface verbatim.
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadState("loading");
    Promise.resolve()
      .then(() => getPublicForm(slug))
      .then((f) => {
        if (!alive) return;
        setForm(f);
        setLoadState("ok");
      })
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 404) setLoadState("notfound");
        else setLoadState("error");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // getPublicForm is injected per-mount and stable; re-fetch only on slug change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const setValue = useCallback((id, v) => setValues((s) => ({ ...s, [id]: v })), []);

  const onSubmit = async () => {
    if (submitting || !form) return;
    // Required client-side pre-check: any required + empty field blocks submit.
    const fields = form.fields || [];
    const missing = fields.find((f) => f.required && !isAnswered(f, values[f.id]));
    if (missing) {
      setRequiredError(`「${missing.label}」为必填项，请填写后再提交。`);
      return;
    }
    setRequiredError("");
    setSubmitError("");
    setSubmitting(true);
    try {
      const answers = collectAnswers(fields, values);
      await submitForm(slug, answers);
      setDone(true);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 400 || e.status === 409) {
          // surface the backend message verbatim (缺必填 / 已停止收集 / 未配飞书)
          setSubmitError(e.message || "提交失败，请稍后重试。");
        } else if (e.status === 404) {
          setSubmitError("该表单不存在或已被删除。");
        } else {
          setSubmitError("提交失败，请稍后重试。");
        }
      } else {
        setSubmitError("提交失败，请稍后重试。");
      }
    } finally {
      setSubmitting(false);
    }
  };

  let body;
  if (loading) {
    body = (
      <div className="pf-loading">
        <Spinner size="md" />
      </div>
    );
  } else if (loadState === "notfound") {
    body = (
      <Empty
        icon={<Icon name="layout" size={18} />}
        title="表单不存在"
        description="这个链接可能已失效，或表单已被删除。请向分享给你的人确认。"
      />
    );
  } else if (loadState === "error" || !form) {
    body = (
      <Alert variant="danger" title="加载失败">
        无法加载这个表单，请稍后重试。
      </Alert>
    );
  } else if (done) {
    body = (
      <div className="pf-done">
        <Empty
          icon={<Icon name="check" size={18} />}
          title="提交成功"
          description="我们已经收到你的填写内容，可以关闭页面了。"
        />
      </div>
    );
  } else {
    body = (
      <div className="pf-form">
        {form.fields.map((f) => (
          <PublicField
            key={f.id}
            field={f}
            value={values[f.id]}
            onChange={(v) => setValue(f.id, v)}
          />
        ))}
        {requiredError ? (
          <Alert variant="warn" title="还差一点">
            {requiredError}
          </Alert>
        ) : null}
        {submitError ? (
          <Alert variant="danger" title="无法提交">
            {submitError}
          </Alert>
        ) : null}
        <div className="pf-actions">
          <Button variant="primary" size="lg" full disabled={submitting} onClick={onSubmit}>
            {submitting ? "提交中…" : "提交"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="pf-page">
      <div className="pf-card">
        {form && loadState === "ok" ? (
          <header className="pf-head">
            <h1 className="pf-title">{form.meta?.title}</h1>
            {form.meta?.description ? <p className="pf-desc">{form.meta.description}</p> : null}
          </header>
        ) : null}
        {body}
        <p className="pf-foot ax-label">Powered by agentaily forms</p>
      </div>
    </div>
  );
}
