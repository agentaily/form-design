// preview.jsx — live form preview, composed from @agentaily/design-system inputs.
// Exports: FormPreview
import React, { useState } from "react";
import { Field, Input, Textarea, Select, RadioGroup, Checkbox, Button } from "@agentaily/design-system";

function FieldView({ field, value, onChange, error }) {
  const { type, label, placeholder, required, options, _new } = field;
  // DS Field has no className prop, so the entrance animation lives on a wrapper.
  const cls = _new ? "pv-in" : undefined;
  const errText = error ? "此项必填" : undefined;

  let control;
  if (type === "consent") {
    control = (
      <Field error={errText}>
        <Checkbox label={label + (required ? " *" : "")} checked={!!value} onChange={(e) => onChange(e.target.checked)} />
      </Field>
    );
  } else if (type === "radio") {
    control = (
      <Field label={label} required={required} error={errText}>
        <RadioGroup name={field.id} value={value || ""} options={options} onChange={(v) => onChange(v)} />
      </Field>
    );
  } else if (type === "checks") {
    const arr = Array.isArray(value) ? value : [];
    const toggle = (o, on) => onChange(on ? [...arr, o] : arr.filter((x) => x !== o));
    control = (
      <Field label={label} required={required} error={errText}>
        <div className="pv-checks">
          {options.map((o) => (
            <Checkbox key={o} label={o} checked={arr.includes(o)} onChange={(e) => toggle(o, e.target.checked)} />
          ))}
        </div>
      </Field>
    );
  } else if (type === "select") {
    const opts = [{ value: "", label: placeholder || "请选择" }, ...options.map((o) => ({ value: o, label: o }))];
    control = (
      <Field label={label} required={required} error={errText}>
        <Select options={opts} value={value || ""} onChange={(e) => onChange(e.target.value)} />
      </Field>
    );
  } else if (type === "textarea") {
    control = (
      <Field label={label} required={required} error={errText}>
        <Textarea rows={3} placeholder={placeholder} value={value || ""} onChange={(e) => onChange(e.target.value)} />
      </Field>
    );
  } else {
    // text / tel / email
    control = (
      <Field label={label} required={required} error={errText}>
        <Input type={type === "email" ? "email" : type === "tel" ? "tel" : "text"}
          placeholder={placeholder} value={value || ""} onChange={(e) => onChange(e.target.value)} />
      </Field>
    );
  }

  return <div className={cls}>{control}</div>;
}

export function FormPreview({ meta, fields, values, setValue, style, building }) {
  const [submitted, setSubmitted] = useState(false);
  const [errors, setErrors] = useState({});

  const submit = () => {
    const errs = {};
    fields.forEach((f) => {
      if (!f.required) return;
      const v = values[f.id];
      const empty = f.type === "checks" ? !(Array.isArray(v) && v.length) : !v;
      if (empty) errs[f.id] = true;
    });
    setErrors(errs);
    if (Object.keys(errs).length === 0) setSubmitted(true);
  };

  if (submitted) {
    return (
      <div className={"pv-card pv-card--" + style + " pv-done"}>
        <div className="pv-done__mark">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
        </div>
        <h3 className="pv-done__h">报名成功</h3>
        <p className="pv-done__p">我们已收到 <strong>{values[fields[0]?.id] || "你"}</strong> 的报名，确认信会发送到你的邮箱。现场签到请出示手机号。</p>
        <div className="pv-done__code">CONFIRM · AGS-2026-0628-{String(Math.floor(Math.random() * 900) + 100)}</div>
        <Button variant="secondary" full onClick={() => setSubmitted(false)}>再填一份</Button>
      </div>
    );
  }

  return (
    <div className={"pv-card pv-card--" + style}>
      {meta ? (
        <header className="pv-hero pv-in">
          <div className="pv-hero__kicker ax-label">{meta.kicker}</div>
          <h2 className="pv-hero__title">{meta.title}</h2>
          <p className="pv-hero__desc">{meta.desc}</p>
          <div className="pv-hero__meta">{meta.meta.map((m, i) => <span key={i} className="pv-hero__tag">{m}</span>)}</div>
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
          <FieldView key={f.id} field={f} value={values[f.id]} error={errors[f.id]}
            onChange={(v) => { setValue(f.id, v); if (errors[f.id]) setErrors((e) => { const n = { ...e }; delete n[f.id]; return n; }); }} />
        ))}
        {building ? <div className="pv-building"><span className="pv-building__dot" /><span className="pv-building__dot" /><span className="pv-building__dot" /> 正在挂载字段…</div> : null}
      </div>

      {fields.length > 0 ? (
        <div className="pv-footer">
          <Button variant="primary" size="lg" full disabled={building} onClick={submit}>提交报名</Button>
          <p className="pv-footer__note">提交即表示同意活动须知 · Powered by Agentaily Forms</p>
        </div>
      ) : null}
    </div>
  );
}
