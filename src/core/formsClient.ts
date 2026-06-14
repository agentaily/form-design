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
  /**
   * per-form 飞书 bitable locator produced by "发布即自动建表" (§16.9): present only
   * when the forms row's `feishu_app_token` + `feishu_table_id` are BOTH non-null, in
   * which case GET /api/forms projects them here; not yet built → OMITTED. The 提交数据
   * toolbar uses this to show the "飞书表格↗" external link — it builds the open URL
   * via the pure {@link feishuTableUrl}(appToken, tableId) (same style as
   * {@link publicFormUrl}). Never sourced from a submission response (§18.6 never carries
   * app_token/table_id).
   */
  feishuTable?: { appToken: string; tableId: string };
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
 * Build the open URL for a form's per-form 飞书 bitable (SPEC §16.9). Pure/no I/O.
 * Given the {@link FormSummary.feishuTable} locator (appToken + tableId), returns the
 * bitable URL `https://feishu.cn/base/<appToken>?table=<tableId>` — opened in a new tab
 * by the 提交数据 toolbar's "飞书表格↗" link. Same style as {@link publicFormUrl}.
 *
 * Contract-only stub — implementer owns the body (+ its unit test), inner loop.
 */
export function feishuTableUrl(appToken: string, tableId: string): string {
  return `https://feishu.cn/base/${appToken}?table=${tableId}`;
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
