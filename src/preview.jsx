// preview.jsx — live form preview, composed from @agentaily/design-system inputs.
// Validation is driven by the design-system Form.useForm hook (per-field rules,
// focus-first-error on submit, live re-validation). Exports: FormPreview
import React, { useEffect } from "react";
import {
  Field,
  Input,
  Textarea,
  Select,
  RadioGroup,
  Checkbox,
  Button,
  Form,
} from "@agentaily/design-system";
import { fieldKindLabel, mkLabel } from "./core/markup";

// ── validation: one schema-style fn over the current (dynamic) fields ──
const PV_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PV_TEL_RE = /^1[3-9]\d{9}$/;

function pvIsEmpty(field, v) {
  if (field.type === "checks") return !(Array.isArray(v) && v.length);
  if (field.type === "consent") return !v;
  return v === undefined || v === null || v === "";
}

function pvValidate(fields, vals) {
  const errs = {};
  fields.forEach((f) => {
    const v = vals[f.id];
    if (f.required && pvIsEmpty(f, v)) {
      errs[f.id] =
        f.type === "consent"
          ? "请勾选后再提交"
          : f.type === "radio" || f.type === "select"
            ? "请选择一项"
            : f.type === "checks"
              ? "请至少选择一项"
              : "此项必填";
      return;
    }
    if (pvIsEmpty(f, v)) return; // optional + empty → skip format checks
    if (f.type === "email" && !PV_EMAIL_RE.test(String(v))) errs[f.id] = "请输入有效的邮箱地址";
    else if (f.type === "tel" && !PV_TEL_RE.test(String(v).replace(/[\s-]/g, "")))
      errs[f.id] = "请输入有效的 11 位手机号";
  });
  return errs;
}

// ── one field, bound to the form hook ──
function FieldView({ field, form }) {
  const { id, type, label, placeholder, required, options, _new } = field;
  // DS Field has no className prop, so the entrance animation lives on a wrapper.
  const cls = _new ? "pv-in" : undefined;

  // form.field() registers the control + returns { name, value/checked, onChange, onBlur, error }.
  // Build control props EXPLICITLY (never spread `error` onto a control, or it
  // double-renders the message — the outer <Field> owns the message).
  const b = form.field(id, type === "consent" ? { type: "checkbox" } : undefined);
  const err = b.error;

  let control;
  if (type === "consent") {
    control = (
      <Field error={err}>
        <Checkbox
          label={label + (required ? " *" : "")}
          name={b.name}
          checked={!!b.checked}
          onChange={b.onChange}
          onBlur={b.onBlur}
        />
      </Field>
    );
  } else if (type === "radio") {
    control = (
      <Field label={label} required={required} error={err}>
        <RadioGroup name={b.name} value={b.value || ""} options={options} onChange={b.onChange} />
      </Field>
    );
  } else if (type === "checks") {
    const arr = Array.isArray(form.values[id]) ? form.values[id] : [];
    const toggle = (o, on) =>
      form.setValue(id, on ? [...arr, o] : arr.filter((x) => x !== o), {
        shouldValidate: form.formState.isSubmitted,
      });
    control = (
      <Field label={label} required={required} error={err}>
        <div className="pv-checks">
          {options.map((o) => (
            <Checkbox
              key={o}
              label={o}
              checked={arr.includes(o)}
              onChange={(e) => toggle(o, e.target.checked)}
            />
          ))}
        </div>
      </Field>
    );
  } else if (type === "select") {
    const opts = [
      { value: "", label: placeholder || "请选择" },
      ...options.map((o) => ({ value: o, label: o })),
    ];
    control = (
      <Field label={label} required={required} error={err}>
        <Select
          options={opts}
          name={b.name}
          value={b.value || ""}
          onChange={b.onChange}
          onBlur={b.onBlur}
        />
      </Field>
    );
  } else if (type === "textarea") {
    control = (
      <Field label={label} required={required} error={err}>
        <Textarea
          rows={3}
          placeholder={placeholder}
          name={b.name}
          value={b.value || ""}
          onChange={b.onChange}
          onBlur={b.onBlur}
        />
      </Field>
    );
  } else {
    // text / tel / email
    control = (
      <Field label={label} required={required} error={err}>
        <Input
          type={type === "email" ? "email" : type === "tel" ? "tel" : "text"}
          placeholder={placeholder}
          className={err ? "ax-input--error" : ""}
          name={b.name}
          value={b.value || ""}
          onChange={b.onChange}
          onBlur={b.onBlur}
        />
      </Field>
    );
  }

  return (
    <div
      className={"pv-fieldwrap" + (cls ? " " + cls : "")}
      data-mk-label={mkLabel(label)}
      data-mk-kind={fieldKindLabel(type)}
    >
      {control}
    </div>
  );
}

export function FormPreview({ meta, fields, values, setValue, style, building }) {
  // The DS validation hook owns field state; validation runs over the live `fields`.
  const form = Form.useForm({
    mode: "onSubmit", // quiet until first submit
    reValidateMode: "onChange",
    validate: (vals) => pvValidate(fields, vals),
  });

  const submitted = form.formState.isSubmitted && form.formState.isValid;

  // Mirror the hook's values up to the app shell (kept in sync for schema/markup).
  useEffect(() => {
    const fv = form.values;
    for (const k in fv) {
      if (values[k] !== fv[k]) setValue(k, fv[k]);
    }
  }, [form.values]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live re-validation after the first submit. The hook's own onChange path reads
  // the field value before React commits it (one change stale), so we re-run
  // validation here, after values have actually committed.
  useEffect(() => {
    if (form.formState.isSubmitted) form.trigger();
  }, [form.values]); // eslint-disable-line react-hooks/exhaustive-deps

  if (submitted) {
    const firstName = form.getValues(fields[0]?.id) || "你";
    return (
      <div className={"pv-card pv-card--" + style + " pv-done"}>
        <div className="pv-done__mark">
          <svg
            viewBox="0 0 24 24"
            width="26"
            height="26"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </div>
        <h3 className="pv-done__h">报名成功</h3>
        <p className="pv-done__p">
          我们已收到 <strong>{firstName}</strong>{" "}
          的报名，确认信会发送到你的邮箱。现场签到请出示手机号。
        </p>
        <div className="pv-done__code">
          CONFIRM · AGS-2026-0628-{String(Math.floor(Math.random() * 900) + 100)}
        </div>
        <Button
          variant="secondary"
          full
          onClick={() => {
            form.reset({});
          }}
        >
          再填一份
        </Button>
      </div>
    );
  }

  return (
    <div className={"pv-card pv-card--" + style}>
      {meta ? (
        <header className="pv-hero pv-in" data-mk-label="表单标题与介绍" data-mk-kind="标题">
          <div className="pv-hero__kicker ax-label">{meta.kicker}</div>
          <h2 className="pv-hero__title">{meta.title}</h2>
          <p className="pv-hero__desc">{meta.desc}</p>
          <div className="pv-hero__meta">
            {/* meta.meta (要点标签) is optional on FormMeta — a form loaded back for editing
                (PR-7) carries only title+desc (tags weren't stored at publish), and the agent
                may set meta without tags. Guard so a tag-less meta renders instead of crashing. */}
            {(meta.meta || []).map((m, i) => (
              <span key={i} className="pv-hero__tag">
                {m}
              </span>
            ))}
          </div>
        </header>
      ) : null}

      {fields.length === 0 && !meta ? (
        <div className="pv-blank ax-dotgrid">
          <div className="pv-blank__txt">表单预览</div>
          <div className="pv-blank__sub">发送需求后，字段会实时出现在这里</div>
        </div>
      ) : null}

      <div className="pv-fields">
        {fields.map((f) => (
          <FieldView key={f.id} field={f} form={form} />
        ))}
        {building ? (
          <div className="pv-building">
            <span className="pv-building__dot" />
            <span className="pv-building__dot" />
            <span className="pv-building__dot" /> 正在挂载字段…
          </div>
        ) : null}
      </div>

      {fields.length > 0 ? (
        <div className="pv-footer" data-mk-label="提交按钮" data-mk-kind="按钮">
          <Button variant="primary" size="lg" full disabled={building} onClick={form.handleSubmit}>
            提交报名
          </Button>
          <p className="pv-footer__note">提交即表示同意活动须知 · Powered by Agentaily Forms</p>
        </div>
      ) : null}
    </div>
  );
}
