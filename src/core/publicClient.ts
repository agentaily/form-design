// publicClient.ts — the answerer-side seam for the PUBLIC fill page (第 6 步).
// Backend contracts: GET /api/forms/:slug (公开拉取, SPEC §16.2/§16.4) and
// POST /api/submit (公开提交, SPEC §15/§16.5/§20).
//
// CRITICAL — NO BEARER. These two endpoints are PUBLIC: the request comes from a
// stranger (the answerer), not the owner. This module MUST NOT attach an
// `Authorization` header and MUST NOT touch the owner session token. It therefore
// does NOT go through apiClient.apiFetch (which injects Bearer on `auth:true`); it
// reuses ONLY the auth-free bits of apiClient — apiBase() (base-URL resolution) and
// ApiError (typed error surface). The owner's token is never read here.
//   (Contrast: formsClient/submissionsClient/configClient are owner-only and DO use
//    apiFetch with `auth:true`.)
//
// Why a tiny private fetch helper instead of apiFetch with `auth:false`: keeping the
// public path on a separate, token-unaware code path makes "answerer requests carry
// no owner credential" a structural guarantee, not a per-call flag the implementer
// could forget. See features/public-fill.feature「提交不带 Bearer」.

import { ApiError, apiBase } from "./apiClient";

// ── token-unaware fetch ────────────────────────────────────────────────────────
// The public path is deliberately on its OWN code path, never through apiFetch: it
// resolves the base URL via apiBase() but NEVER reads the owner token, so an answerer
// request structurally cannot carry an Authorization header (the no-Bearer guarantee
// is a property of this module, not a per-call flag). It mirrors apiClient's
// errorFromResponse shape so the page can branch on `e.status` exactly as it would on
// an owner-side ApiError.

function publicUrl(path: string): string {
  return apiBase() + (path.startsWith("/") ? path : "/" + path);
}

async function errorFromResponse(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => "");
  let data: unknown;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  const msg =
    (data && typeof data === "object" && "error" in data && typeof data.error === "string"
      ? data.error
      : null) ||
    res.statusText ||
    `HTTP ${res.status}`;
  return new ApiError(res.status, msg, data);
}

interface PublicRequestOpts {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

// JSON request → parsed body, with NO Authorization header ever attached. Throws an
// ApiError on any non-2xx (surfacing the backend's `{ error }` message + status).
async function publicFetch<T>(path: string, opts: PublicRequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(publicUrl(path), {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body,
    signal: opts.signal,
  });
  if (!res.ok) throw await errorFromResponse(res);
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/** A field as the public projection returns it (SPEC §16.2/§16.4, aligned to §3.2
 *  Field). NOTE this is the BACKEND wire vocabulary, NOT the designer UiField set:
 *  the public page maps these to design-system inputs at render time (see
 *  src/public-form.jsx PUBLIC_FIELD_RENDER mapping). Choice options are objects. */
export type PublicFieldType =
  | "text"
  | "number"
  | "select"
  | "date"
  | "checkbox"
  | "radio"
  | "file"
  | "group";

/** One field of a public form (SPEC §16.2). `options` present for choice types. */
export interface PublicField {
  id: string;
  type: PublicFieldType;
  label: string;
  required?: boolean;
  options?: { label: string; value: string }[];
  /** group nesting (SPEC §3.2/§16.2). Present only for `type:"group"`. */
  children?: PublicField[];
}

/** The form a stranger sees (SPEC §16.2/§16.4): ONLY slug + meta + fields. By type
 *  it cannot carry any owner credential / status / owner_id — the "不泄漏" guarantee
 *  is a type boundary, not a runtime filter (§16.4). */
export interface PublicForm {
  slug: string;
  meta: { title: string; description?: string };
  fields: PublicField[];
}

/** One answer in a submission (SPEC §15.2). `value` is a single string, or a string
 *  array for multi-choice (checkbox) / multi-value fields. `label` matches the
 *  field's label (MVP uses label as the 飞书 column key, §15.3/§20.3). */
export interface Answer {
  label: string;
  value: string | string[];
}

/** Body POSTed to /api/submit (SPEC §15.2 + §16.5): the form's slug + the answers. */
export interface SubmitInput {
  formSlug: string;
  answers: Answer[];
}

/** Success body of POST /api/submit (SPEC §15.4): the new 飞书 record id. */
export interface SubmitResult {
  ok: true;
  recordId: string;
}

/**
 * Fetch a published form by slug for the public fill page (SPEC §16.2/§16.4).
 * PUBLIC — sends NO Authorization header. Resolves the {@link PublicForm} (slug +
 * meta + fields) on 200. A 404 (unknown / deleted / unpublished-removed slug)
 * surfaces as an {@link ApiError} with `status === 404` for the page to render its
 * friendly "表单不存在" 404 state. Stub.
 *
 * Implementer note: build the request WITHOUT Bearer (do not call apiFetch with
 * auth:true; use a token-unaware fetch over apiBase()). On non-2xx, reject with an
 * ApiError carrying the status + the backend `{ error }` message (mirror
 * apiClient.errorFromResponse's shape so the page can branch on `e.status`).
 */
export function getPublicForm(slug: string): Promise<PublicForm> {
  return publicFetch<PublicForm>(`/api/forms/${encodeURIComponent(slug)}`);
}

/**
 * Submit an answer set to a published form (SPEC §15/§16.5/§20). PUBLIC — sends NO
 * Authorization header (the answers come from the answerer, not the owner). Resolves
 * {@link SubmitResult} on 200. The page branches on the rejected {@link ApiError}'s
 * `status`:
 *   - 400 → 缺必填 / 请求体形状非法 (the page may also pre-validate required client-side)
 *   - 404 → the form no longer exists
 *   - 409 → 表单未开放提交 (draft/closed, §20.2) OR owner 未配飞书 (§15.6) — distinguished
 *           by the backend's `{ error }` message, surfaced via ApiError.message
 *   - 502 → 上游(飞书)出错
 * Stub. Same no-Bearer build note as {@link getPublicForm}.
 */
export function submitForm(slug: string, answers: Answer[]): Promise<SubmitResult> {
  const body: SubmitInput = { formSlug: slug, answers };
  return publicFetch<SubmitResult>("/api/submit", { method: "POST", body });
}
