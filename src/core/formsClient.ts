// formsClient.ts — frontend seam for form publishing + management (SPEC §16 + §21).
// Four calls behind apiClient's Bearer injection (§17). Owner-only, so every one
// carries `auth: true`; a missing/expired session surfaces as a 401 ApiError for
// the caller to route into the login flow (§17, same onNeedLogin pattern as
// configClient/auth):
//
//   publishForm(meta, fields) → POST   /api/forms        → { slug } (+ optional url)
//   listForms()               → GET    /api/forms        → owner's forms (summaries)
//   updateForm(slug, patch)   → PATCH  /api/forms/:slug  → updated owner view
//   deleteForm(slug)          → DELETE /api/forms/:slug  → { ok, slug }
//
// Two shape boundaries this module owns so callers (App / forms-panel) never touch
// the wire format:
//   1. PUBLISH MAPPING — the designer's live model is FormMeta + UiField[] (the UI
//      render shape from designerTools, where choice fields carry `options: string[]`
//      and use the UI type set text/tel/email/textarea/radio/checks/select/consent).
//      The publish wire contract (PublishFormInput, §16.2, aligned to SPEC §3.2
//      Field[]) uses `{ id, type, label, required?, options?: {label,value}[] }` over
//      the canonical type set. publishForm takes the designer shape and maps it to the
//      wire shape internally — App passes exactly what it already holds (meta, fields).
//   2. PUBLIC URL — the frontend only ever holds the high-entropy `slug` (§16.3); the
//      public fill link lives at `/f/:slug` (see PUBLIC_FORM_PATH / publicFormUrl).
//      POST /api/forms MAY return a `url`; when present prefer it, else build from slug.
//
// LIST vs PUBLIC FETCH: listForms returns owner summaries (slug/meta/status/createdAt,
// §21.2) and intentionally OMITS `fields` — the list is an overview only; the public
// projection GET /api/forms/:slug (slug+meta+fields, §16.4) is the 公开页's job (第6步),
// NOT this module. Callers must not assume a FormSummary carries fields.

import { apiFetch } from "./apiClient";
import type { FormMeta, UiField, UiFieldType } from "./designerTools";

/** Public fill-page path (SPEC §16 URL 约定). A published form lives at `/f/:slug`. */
export const PUBLIC_FORM_PATH = "/f/";

/** Owner-only forms endpoint base (SPEC §16.1 / §21.1). */
const FORMS_PATH = "/api/forms";

/**
 * Backend Field type set (SPEC §3.2): the canonical types the publish wire (§16.2)
 * accepts. The designer UI uses a richer presentation set (UiFieldType); publish maps
 * UI → backend so callers never touch the wire vocabulary.
 */
type WireFieldType =
  | "text"
  | "number"
  | "select"
  | "date"
  | "checkbox"
  | "radio"
  | "file"
  | "group";

/**
 * UI field type → §3.2 backend FieldType mapping for publish (§16.2).
 *   text/tel/email/textarea → text   (backend has one free-text type; tel/email are
 *                                      UI-level affordances, not distinct backend types)
 *   radio                   → radio  (single choice)
 *   select                  → select (single choice via dropdown)
 *   checks                  → checkbox (multi-choice; matches the §16.2 example)
 *   consent                 → checkbox (a single must-agree box is a boolean checkbox)
 */
const FIELD_TYPE_MAP: Record<UiFieldType, WireFieldType> = {
  text: "text",
  tel: "text",
  email: "text",
  textarea: "text",
  radio: "radio",
  checks: "checkbox",
  select: "select",
  consent: "checkbox",
};

/**
 * §3.2 backend FieldType → designer UI type, for loading a stored form back into the
 * designer (PR-7 编辑). The publish mapping above is MANY-to-one (tel/email/textarea →
 * text; checks/consent → checkbox), so this reverse is INHERENTLY LOSSY: a stored
 * `text` lands back as plain `text` (the tel/email/textarea affordance can't be
 * recovered) and a stored `checkbox` lands back as multi-choice `checks` (never the
 * single-box `consent`). That loss lives in the existing wire contract (the DB only
 * stores §3.2 types), NOT here — fixing it would need backend schema enrichment, which
 * is out of PR-7 scope. `number`/`date`/`file`/`group` aren't producible by the
 * designer (it never emits them); they degrade to free-text `text` as a best effort so
 * the loaded model always carries a valid {@link UiFieldType} the designer can render.
 */
const WIRE_TO_UI_FIELD_TYPE: Record<WireFieldType, UiFieldType> = {
  text: "text",
  number: "text",
  date: "text",
  file: "text",
  group: "text",
  select: "select",
  checkbox: "checks",
  radio: "radio",
};

/** Map the §16.2 wire meta ({ title, description? }) back to the designer FormMeta
 *  ({ title, desc }). `kicker`/`meta[]` were dropped at publish time (the wire meta
 *  never carried them), so they can't round-trip — title + desc are what's stored. */
function toUiMeta(wireMeta: { title?: string; description?: string } | null | undefined): FormMeta {
  const meta: FormMeta = { title: wireMeta?.title ?? "" };
  if (wireMeta?.description) meta.desc = wireMeta.description;
  return meta;
}

/** Map stored §16.2 wire fields back to the designer's UiField[] for editing. Field
 *  `id` is PRESERVED verbatim (never re-minted) so a later {@link updateFormDefinition}
 *  carries the SAME ids the backend stored — that id match is how the backend tells a
 *  changed label apart as a rename (飞书列改名, §16.8) rather than a delete-old +
 *  add-new (which would orphan the column and isolate its data). `options:{label,value}[]`
 *  collapses back to `options:string[]` (the label, which MVP also used as the value). */
function toUiFields(wireFields: WireField[] | null | undefined): UiField[] {
  return (wireFields ?? []).map((wf) => {
    const f: UiField = {
      id: wf.id,
      type: WIRE_TO_UI_FIELD_TYPE[wf.type] ?? "text",
      label: wf.label,
    };
    if (wf.required) f.required = true;
    if (wf.options) f.options = wf.options.map((o) => o.label);
    return f;
  });
}

/** A single wire field (SPEC §16.2, aligned to §3.2 Field). Choice options are objects. */
interface WireField {
  id: string;
  type: WireFieldType;
  label: string;
  required?: boolean;
  options?: { label: string; value: string }[];
}

/** The §16.2 PublishFormInput wire body POSTed to /api/forms. */
interface PublishFormInput {
  meta: { title: string; description?: string };
  fields: WireField[];
}

/**
 * Map the designer's live model (FormMeta + UiField[]) to the §16.2 PublishFormInput
 * wire shape: `meta.desc` → `meta.description`, UI field type → §3.2 FieldType, and
 * `options: string[]` → `{ label, value }[]` (MVP uses the label as the value too).
 * Field `id` / `label` / `required` are preserved.
 */
function toPublishInput(meta: FormMeta | null, fields: UiField[]): PublishFormInput {
  const wireMeta: PublishFormInput["meta"] = { title: meta?.title ?? "" };
  if (meta?.desc) wireMeta.description = meta.desc;

  const wireFields: WireField[] = (fields ?? []).map((f) => {
    const wf: WireField = {
      id: f.id,
      type: FIELD_TYPE_MAP[f.type] ?? "text",
      label: f.label,
    };
    if (f.required) wf.required = true;
    if (f.options) wf.options = f.options.map((o) => ({ label: o, value: o }));
    return wf;
  });

  return { meta: wireMeta, fields: wireFields };
}

/** Lifecycle status of a form as the owner sees it (SPEC §16.7 / §21). MVP writes
 *  `published` on publish and toggles to `closed`; `draft` is a reserved pre-publish
 *  state with no write entry in MVP. The management UI only ever flips published↔closed. */
export type FormStatus = "published" | "draft" | "closed";

/** The two statuses the management UI can PATCH a form to (SPEC §21.3 — never `draft`). */
export type ManagedStatus = "published" | "closed";

/**
 * Result of POST /api/forms (SPEC §16.2). The backend returns the freshly minted
 * high-entropy `slug` (201) and MAY include a ready-to-open `url`. The frontend never
 * mints the slug itself; it derives the public link via {@link publicFormUrl}, which
 * prefers `url` when present and otherwise builds `/f/:slug`.
 */
export interface PublishResult {
  /** High-entropy public slug, both the public identifier and the forms-table key (§16.3). */
  slug: string;
  /** Optional ready-to-open public fill URL the backend may attach (§16.2). */
  url?: string;
}

/**
 * One row in the owner's "我的表单" list (SPEC §21.2 FormListItem). Summary-only:
 * carries the form's public `slug`, display `meta`, owner-private `status` +
 * `createdAt`, and an OPTIONAL `submissionCount` (the backend may omit it — counting
 * needs a 飞书 round-trip, §21.2). Deliberately has NO `fields` — the list is an
 * overview; never assume field data here. Carries no owner credentials (§21.2/§16.4).
 */
export interface FormSummary {
  slug: string;
  /** Display meta as stored at publish time; `title` is always present (§16.2 requires it). */
  meta: FormMeta;
  status: FormStatus;
  /** ISO-8601 creation timestamp (owner-private dimension, §21.2). */
  createdAt: string;
  /** Collected-submission count when the backend chose to compute it; omitted otherwise. */
  submissionCount?: number;
}

/** Partial update for PATCH /api/forms/:slug (SPEC §21.3, all keys optional). The
 *  management UI sends `{ status }` to open/close; `meta`/`fields` edits are a
 *  contract-permitted enhancement (not used by the publish/管理 flow itself). An
 *  empty patch is a no-op 200. `status` may only be published↔closed (never draft). */
export interface UpdateFormInput {
  status?: ManagedStatus;
  meta?: FormMeta;
  fields?: UiField[];
}

/** Owner view echoed by a successful PATCH (SPEC §21.3). The backend MAY return the
 *  full updated view or at minimum `{ slug, status }`; the management UI only relies on
 *  `slug` + `status` to confirm the change took effect, so the rest is optional. */
export interface UpdateFormResult {
  slug: string;
  status: FormStatus;
  meta?: FormMeta;
  fields?: UiField[];
  createdAt?: string;
}

/** Result of DELETE /api/forms/:slug (SPEC §21.4). Strict (non-idempotent) delete:
 *  a missing slug is a 404 ApiError, not a silent success. */
export interface DeleteFormResult {
  ok: true;
  slug: string;
}

/**
 * Build the public fill-page link for a slug (SPEC §16 URL 约定). Pure/no I/O. With a
 * `base` (e.g. an origin like "https://form-design.agentaily.com") returns an absolute
 * URL; without one returns the same-origin path `/f/:slug`. Prefer a backend-provided
 * `url` (see {@link publishForm}) over this when available.
 */
export function publicFormUrl(slug: string, base?: string): string {
  const path = PUBLIC_FORM_PATH + slug;
  if (!base) return path;
  // Strip any trailing slash on the base so we never double the leading slash of path.
  return base.replace(/\/+$/, "") + path;
}

/**
 * Publish the designer's current form (SPEC §16.2, owner-only §17). Takes the live
 * designer model (meta + UiField[]) and maps it to the PublishFormInput wire shape
 * internally; on success resolves the {@link PublishResult} (slug + optional url). A
 * 400 (missing title / bad fields) surfaces as an ApiError carrying the backend's
 * `{ error }` message; nothing is stored. A 401 surfaces as a 401 ApiError for the
 * caller to route into login.
 */
export function publishForm(meta: FormMeta | null, fields: UiField[]): Promise<PublishResult> {
  return apiFetch<PublishResult>(FORMS_PATH, {
    method: "POST",
    auth: true,
    body: toPublishInput(meta, fields),
  });
}

/**
 * List the owner's forms (SPEC §21.2, owner-only §17). Resolves to an array of
 * summaries (newest-first or unordered, per backend); an owner with no forms resolves
 * to `[]` (a normal empty state, not an error). A 401 surfaces as a 401 ApiError for
 * the caller to route into login. Summaries carry no `fields` and no credentials.
 */
export async function listForms(): Promise<FormSummary[]> {
  // GET → no body (apiFetch defaults to GET when no body is given), Bearer via auth.
  const out = await apiFetch<{ forms?: FormSummary[]; count?: number }>(FORMS_PATH, { auth: true });
  return out?.forms ?? [];
}

/**
 * Update a form by slug (SPEC §21.3, owner-only §17). The management flow uses this to
 * toggle `status` published↔closed. Resolves to the {@link UpdateFormResult} echo so
 * the UI can confirm the new status without a refetch. A 404 (unknown slug) or 400
 * (illegal status / bad body) surfaces as an ApiError; a 401 routes into login.
 */
export function updateForm(slug: string, patch: UpdateFormInput): Promise<UpdateFormResult> {
  return apiFetch<UpdateFormResult>(`${FORMS_PATH}/${slug}`, {
    method: "PATCH",
    auth: true,
    body: patch,
  });
}

/**
 * A stored form loaded back into the designer for editing (PR-7 编辑入口). The designer
 * shape: FormMeta (UI keys) + UiField[] (UI types, `options: string[]`, ids preserved) +
 * the owner-private `status` so the edit banner / 顶栏徽章 can branch published vs closed.
 */
export interface EditableForm {
  slug: string;
  meta: FormMeta;
  fields: UiField[];
  status: FormStatus;
}

/**
 * Load a form's full definition (meta + fields) back into the designer for editing
 * (SPEC §21.3, owner-only §17). The owner's "我的表单" list (listForms) omits `fields`,
 * and there is NO owner-side `GET /api/forms/:slug` (that path is the PUBLIC, no-status
 * projection). So we read the form back through the EMPTY-BODY no-op PATCH, which the
 * backend documents as a 200 that returns the FULL owner view — `{ slug, meta, fields,
 * status, createdAt }` — without changing any row (empty `input` → no UPDATE, just a
 * read-back; §21.3). This keeps the whole edit lifecycle on the owner-authed path
 * (load → edit → 更新 all via PATCH with Bearer) AND owner-scoped (a cross-owner slug is
 * a 404, never another owner's form), unlike the public projection. The wire view is
 * mapped back to the designer shape via {@link toUiMeta} / {@link toUiFields} (lossy by
 * the existing wire contract — see {@link WIRE_TO_UI_FIELD_TYPE}); ids are preserved so a
 * later {@link updateFormDefinition} round-trips them for rename detection. A 404 (unknown
 * slug / cross-owner) or 401 (session expired) surfaces as an ApiError for the caller.
 */
export async function getFormForEdit(slug: string): Promise<EditableForm> {
  const view = await apiFetch<UpdateFormResult>(`${FORMS_PATH}/${slug}`, {
    method: "PATCH",
    auth: true,
    body: {}, // empty patch → no-op read-back of the full owner view (§21.3)
  });
  return {
    slug: view.slug ?? slug,
    meta: toUiMeta(view.meta as { title?: string; description?: string } | undefined),
    fields: toUiFields(view.fields as unknown as WireField[] | undefined),
    status: view.status ?? "published",
  };
}

/**
 * Write an edited form's definition back (SPEC §21.3, owner-only §17). Takes the live
 * designer model (FormMeta + UiField[]) and maps it to the §16.2 wire shape internally —
 * the SAME mapping publishForm uses (meta.desc → description, UI field type → §3.2
 * FieldType, `options:string[]` → `{label,value}[]`), with each field's `id` PRESERVED so
 * the backend can match changed labels as renames (飞书列改名, §16.8) instead of
 * delete-old + add-new. PATCHes `{ meta, fields }` (整块替换, §21.3) and resolves the
 * {@link UpdateFormResult} echo. A 400 (missing title / bad fields), 404 (unknown slug),
 * or 401 (session expired) surfaces as an ApiError for the caller to route.
 */
export function updateFormDefinition(
  slug: string,
  meta: FormMeta | null,
  fields: UiField[],
): Promise<UpdateFormResult> {
  const wire = toPublishInput(meta, fields);
  return apiFetch<UpdateFormResult>(`${FORMS_PATH}/${slug}`, {
    method: "PATCH",
    auth: true,
    body: { meta: wire.meta, fields: wire.fields },
  });
}

/**
 * Delete a form by slug (SPEC §21.4, owner-only §17). Hard delete — the slug's public
 * fetch / submit become 404 afterwards; already-collected 飞书 records are untouched.
 * Resolves to {@link DeleteFormResult} on success. A 404 (unknown slug) surfaces as an
 * ApiError (strict, non-idempotent); a 401 routes into login. Callers should confirm
 * (the destructive-action confirmation lives in the UI, not here).
 */
export function deleteForm(slug: string): Promise<DeleteFormResult> {
  return apiFetch<DeleteFormResult>(`${FORMS_PATH}/${slug}`, {
    method: "DELETE",
    auth: true,
  });
}
