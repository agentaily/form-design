// schema.js — Form schema operations (SPEC §3.2).
// Schema is the data source of truth: fields / types / validation / field id.
// Operations mutate the schema object in place.

/**
 * @typedef {{
 *   id: string,
 *   type: 'text'|'number'|'select'|'date'|'checkbox'|'radio'|'file'|'group',
 *   label: string,
 *   required?: boolean,
 *   options?: { label: string, value: string }[],
 *   validation?: { pattern?: string, min?: number, max?: number, message?: string },
 *   children?: Field[],
 * }} Field
 * @typedef {{ fields: Field[] }} Schema
 */

export const FIELD_TYPES = ["text", "number", "select", "date", "checkbox", "radio", "file", "group"];

let _idCounter = 0;
/** Deterministic-ish id generator; pass an explicit `field.id` when you need a stable value. */
export function genFieldId() {
  return `field_${(++_idCounter).toString(36)}`;
}

function normalizeField(f) {
  if (!f || typeof f !== "object") throw new Error("field must be an object");
  if (!FIELD_TYPES.includes(f.type)) throw new Error(`Unknown field type: ${f.type}`);
  if (!f.label) throw new Error("field.label is required");
  return { required: false, ...f, id: f.id || genFieldId() };
}

/** Create a schema, optionally seeded with fields. */
export function createSchema(fields = []) {
  return { fields: fields.map(normalizeField) };
}

/** Return the current schema (the source of truth). */
export function getFormSchema(schema) {
  return schema;
}

function indexOf(schema, id) {
  return schema.fields.findIndex((f) => f.id === id);
}
function mustFind(schema, id) {
  const i = indexOf(schema, id);
  if (i < 0) throw new Error(`Field not found: ${id}`);
  return schema.fields[i];
}

/** Add a field. Optional `index` inserts at a position (default: append). */
export function addField(schema, field, index) {
  const f = normalizeField(field);
  if (indexOf(schema, f.id) >= 0) throw new Error(`Duplicate field id: ${f.id}`);
  if (index == null) schema.fields.push(f);
  else schema.fields.splice(index, 0, f);
  return f;
}

/** Patch a field's properties. */
export function updateField(schema, id, patch) {
  const f = mustFind(schema, id);
  if (patch && patch.type && !FIELD_TYPES.includes(patch.type)) {
    throw new Error(`Unknown field type: ${patch.type}`);
  }
  Object.assign(f, patch, { id: f.id });
  return f;
}

/** Remove a field by id. Returns the removed field. */
export function removeField(schema, id) {
  const i = indexOf(schema, id);
  if (i < 0) throw new Error(`Field not found: ${id}`);
  return schema.fields.splice(i, 1)[0];
}

/** Reorder fields. `ids` must be a permutation of the existing field ids. */
export function reorderFields(schema, ids) {
  const existing = schema.fields.map((f) => f.id);
  const sameSize = ids.length === existing.length;
  const sameSet = sameSize && ids.every((id) => existing.includes(id));
  if (!sameSet) throw new Error("reorder ids must be a permutation of existing field ids");
  schema.fields.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  return schema.fields.map((f) => f.id);
}

/** Merge validation rules onto a field. */
export function setValidation(schema, id, rules) {
  const f = mustFind(schema, id);
  f.validation = { ...(f.validation || {}), ...rules };
  return f.validation;
}

/**
 * Validate a value against a field's rules. Returns null when valid, else a message.
 * Used by both the live preview and the published renderer.
 */
export function validateValue(field, value) {
  const empty = value == null || value === "" || (Array.isArray(value) && value.length === 0);
  if (field.required && empty) return field.validation?.message || "此项必填";
  if (empty) return null;
  const v = field.validation || {};
  if (v.pattern && !new RegExp(v.pattern).test(String(value))) return v.message || "格式不正确";
  if (field.type === "number") {
    const n = Number(value);
    if (v.min != null && n < v.min) return v.message || `不能小于 ${v.min}`;
    if (v.max != null && n > v.max) return v.message || `不能大于 ${v.max}`;
  }
  return null;
}
