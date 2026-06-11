// apiClient.ts — the single seam between the frontend and the Workers backend
// (SPEC §12–§21). Owns: base-URL resolution (VITE_API_BASE), the owner session
// token (Bearer injection for owner-only endpoints, §17), JSON request/response
// with a typed error, and a streaming variant that hands back the raw Response
// for SSE consumption (§13.3). All network I/O for the app funnels through here.

const TOKEN_KEY = "agentaily_forms_token";

// In-memory mirror so the token survives within a session even when localStorage
// is unavailable (private mode, SSR, or a sandboxed test runner).
let memToken: string | null = null;

/** Read the stored owner session token (null if not logged in). */
export function getToken(): string | null {
  try {
    const v = localStorage.getItem(TOKEN_KEY);
    if (v !== null) return v;
  } catch {
    /* fall back to the in-memory mirror */
  }
  return memToken;
}

/** Persist (or clear, when passed null/empty) the owner session token. */
export function setToken(token: string | null): void {
  memToken = token || null;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable — the in-memory mirror still holds it for this session */
  }
}

/** Clear the stored token (logout). */
export function clearToken(): void {
  setToken(null);
}

/** Resolved backend base URL (no trailing slash); "" means same-origin. */
export function apiBase(): string {
  const base = import.meta.env?.VITE_API_BASE ?? "";
  return base.replace(/\/+$/, "");
}

function apiUrl(path: string): string {
  return apiBase() + (path.startsWith("/") ? path : "/" + path);
}

/** An HTTP error from the backend, carrying the status and parsed `{ error }` body. */
export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export interface RequestOpts {
  method?: string;
  /** JSON-serialized into the body; presence flips the default method to POST. */
  body?: unknown;
  /** Attach `Authorization: Bearer <token>` for owner-only endpoints. */
  auth?: boolean;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

function buildInit(opts: RequestOpts): RequestInit {
  const headers: Record<string, string> = { ...opts.headers };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  if (opts.auth) {
    const token = getToken();
    if (token) headers["authorization"] = `Bearer ${token}`;
  }
  return {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body,
    signal: opts.signal,
  };
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

/**
 * JSON request → parsed response body. Throws {@link ApiError} on any non-2xx,
 * surfacing the backend's `{ error }` message. Empty 2xx bodies resolve to undefined.
 */
export async function apiFetch<T = unknown>(path: string, opts: RequestOpts = {}): Promise<T> {
  const res = await fetch(apiUrl(path), buildInit(opts));
  if (!res.ok) throw await errorFromResponse(res);
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/**
 * Streaming request → the raw {@link Response} (defaults to POST) for the caller
 * to consume `res.body` via {@link streamSSE}. Throws {@link ApiError} on non-2xx
 * (reading the JSON error body), so the caller only ever streams a 2xx. Used by
 * the chat proxy (§13): a 2xx is `text/event-stream`, an error is JSON `{ error }`.
 */
export async function apiStream(path: string, opts: RequestOpts = {}): Promise<Response> {
  const res = await fetch(apiUrl(path), buildInit({ ...opts, method: opts.method ?? "POST" }));
  if (!res.ok) throw await errorFromResponse(res);
  return res;
}
