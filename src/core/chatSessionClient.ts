// chatSessionClient.ts — frontend seam for chat-session persistence (SPEC §26, PR #48).
//
// WHAT THIS SOLVES: the designer chat (left pane) keeps two in-memory shapes that
// vanish on refresh — the UI thread (`messages`, App.jsx) and the LLM history
// (`historyRef`, OpenAI ChatMessage[], src/core/designerLoop). This module persists a
// design conversation to the backend (D1) keyed by (owner_id, session_id) so a logged-in
// owner who reloads — or opens another device — resumes the same thread and keeps chatting.
//
// KEYING (SPEC §26.2 — the load-bearing decision): a draft has NO stable id before
// publish (slug only exists post-publish; the form model lives client-side in
// modelRef.current). So the conversation is keyed by a CLIENT-MINTED stable
// `designSessionId` (generated on first entry into the designer, persisted in
// localStorage), NOT by the form. Persistence binds `(owner_id, designSessionId)`. A
// publish later associates the resulting `slug` onto that same session row (optional,
// for cross-referencing) — the session id never changes across publish. See
// {@link getOrCreateDesignSessionId}.
//
// OWNER-ONLY (SPEC §26.5): the designer chat is already owner-only (POST /api/chat,
// §13/§17). Persistence inherits that gate — every call carries `auth: true`; a missing/
// expired session surfaces as a 401 ApiError for the caller to route into /signin (§17).
// SIGNED-OUT BEHAVIOR is therefore "do not persist": with no token, App never calls
// these; the chat stays in-memory only and a send 401s into login (current behavior,
// unchanged). No localStorage fallback for the transcript itself — only the session id.
//
// WRITE CADENCE (SPEC §26.4): turns are flushed in BATCHES at turn-end (when the §4
// ReAct loop settles — no more tool calls), NOT per streamed token. The caller debounces/
// coalesces and hands a batch of completed turns to {@link saveChatTurns}; the backend
// appends them to the persisted session. This mirrors the §4 "rerender debounce" / §4.1
// "flush at turn end" discipline so D1 sees one write per turn, not one per delta.

import { apiFetch } from "./apiClient";
import type { ChatMessage } from "./designerLoop";

/** localStorage key holding the client-minted stable design-session id (SPEC §26.2). */
export const DESIGN_SESSION_ID_KEY = "agentaily_forms_design_session";

/** Owner-only chat-session endpoint base (`/api/chat/session/:sessionId`, SPEC §26.3). */
export const CHAT_SESSION_PATH = "/api/chat/session";

/**
 * Owner-only chat-session LIST endpoint (`GET /api/chat/sessions`, SPEC §26.9, PR #65).
 * NOTE the `s` and the missing `:id` segment — distinct from {@link CHAT_SESSION_PATH}
 * (`/api/chat/session/:sessionId`, the per-session GET/PUT/DELETE).
 */
export const CHAT_SESSIONS_PATH = "/api/chat/sessions";

// In-memory mirror of the design-session id, so it coheres within the page even when
// localStorage is unavailable (private mode / sandboxed runner) — mirrors apiClient's
// `memToken` (§26.2).
let memSessionId: string | null = null;

/** Build the per-session endpoint path (`/api/chat/session/:sessionId`, §26.3). */
function sessionPath(sessionId: string): string {
  return `${CHAT_SESSION_PATH}/${encodeURIComponent(sessionId)}`;
}

/** Mint a fresh high-entropy design-session id (crypto.randomUUID with a fallback, §26.2). */
function mintSessionId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through to the manual fallback */
  }
  // Fallback for environments without crypto.randomUUID — still high-entropy enough
  // for a per-owner session key (the real isolation is the (owner_id, sessionId) PK).
  return `ds-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// ---------------------------------------------------------------------------
// Persisted transcript shapes (serializable; the contract the backend stores)
// ---------------------------------------------------------------------------

/**
 * Role of a persisted UI turn (SPEC §26.6). Mirrors the chat.jsx message model
 * (`renderChatTurn`): `user` is the author's prompt; everything the agent emits is
 * `assistant`, differentiated by {@link PersistedTurnKind}.
 */
export type PersistedTurnRole = "user" | "assistant";

/**
 * Kind of a persisted assistant turn (SPEC §26.6), aligned to chat.jsx `renderChatTurn`:
 *   - `text`      → assistant prose (a <Message>), optionally carrying suggestion chips
 *   - `tool`      → a tool-call card (<ToolCall>: name/args/result/status)
 *   - `reasoning` → a thinking block (<Reasoning>)
 *   - `error`     → a failed-turn alert (<Alert variant="danger">)
 * `user` turns are always `text`-like and carry only `text`.
 */
export type PersistedTurnKind = "text" | "tool" | "reasoning" | "error";

/**
 * One persisted UI turn (SPEC §26.6) — the SERIALIZABLE form of a chat.jsx message
 * (`{ id, role, kind, text, ... }`). This is what the thread renders on restore; it is
 * the UI-facing transcript, distinct from {@link ChatMessage} (the LLM wire history).
 * Both are persisted in a {@link PersistedChatSession} so restore rebuilds the visible
 * thread AND seeds the loop's history. Carries no credentials, no streaming flags
 * (transient), and no live React handlers.
 */
export interface PersistedTurn {
  /** Stable per-turn id (the chat.jsx message id, e.g. "msg-…"); used as React key on restore. */
  id: string;
  role: PersistedTurnRole;
  /** Assistant turns set a kind; user turns omit it (treated as text). */
  kind?: PersistedTurnKind;
  /** Visible text (prose / user prompt / error message). Empty for a pure tool turn. */
  text?: string;
  /** Tool-call card fields (kind === "tool"): tool name, parsed input, result string, status. */
  name?: string;
  args?: Record<string, unknown>;
  result?: string;
  status?: "running" | "done" | "error";
  /** Reasoning block fields (kind === "reasoning"). */
  steps?: string[];
  duration?: number;
  /** Suggestion chips attached to a settled assistant text turn (the §FOLLOWUPS chips). */
  suggestions?: string[];
}

/**
 * A persisted design conversation (SPEC §26.6) — the full restorable unit. Holds BOTH
 * transcripts so a reload rebuilds the visible thread (`turns`) and re-seeds the loop's
 * LLM history (`history`, including the leading system prompt). Owner-scoped + keyed by
 * the client-minted {@link sessionId}; `formSlug` is filled once the session's form is
 * published (SPEC §26.2). Timestamps are ISO-8601. Carries no owner credentials.
 */
export interface PersistedChatSession {
  /** Client-minted stable design-session id (the (owner_id, sessionId) key, §26.2). */
  sessionId: string;
  /** UI-facing transcript, in original order (what the thread renders on restore). */
  turns: PersistedTurn[];
  /** LLM wire history (OpenAI shape, incl. the leading system message) to re-seed the loop. */
  history: ChatMessage[];
  /** Public slug once this session's form is published; null/absent before publish (§26.2). */
  formSlug?: string | null;
  /** ISO-8601 first-write time. */
  createdAt?: string;
  /** ISO-8601 last-write time. */
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Request / response DTOs (the wire contract — SPEC §26.3)
// ---------------------------------------------------------------------------

/**
 * Body of `PUT /api/chat/session/:sessionId` (SPEC §26.3) — the batch write at turn end
 * (§26.4). Sends the turns + LLM history accumulated for this session; the backend
 * REPLACES the stored transcript for (owner, sessionId) with this snapshot (last-write-
 * wins, simplest correct semantics for a single-owner editor — see §26.4). `formSlug`,
 * when present, associates the published form onto the session row. Never per-token.
 */
export interface SaveChatSessionInput {
  turns: PersistedTurn[];
  history: ChatMessage[];
  /** Optional: associate the published form's slug onto this session (§26.2). */
  formSlug?: string | null;
}

/**
 * Response of `GET /api/chat/session/:sessionId` (SPEC §26.3). On a never-seen session id
 * the backend returns `{ session: null }` (a normal empty state — first visit / cleared
 * storage — NOT a 404). On hit, the stored {@link PersistedChatSession}.
 */
export interface LoadChatSessionResult {
  session: PersistedChatSession | null;
}

/** Response of `PUT /api/chat/session/:sessionId` (SPEC §26.3): the saved snapshot's stamps. */
export interface SaveChatSessionResult {
  sessionId: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Stable session-id helper (SPEC §26.2) — implementation留给 implementer
// ---------------------------------------------------------------------------

/**
 * Return the owner's stable design-session id, minting + persisting one on first call
 * (SPEC §26.2). Reads {@link DESIGN_SESSION_ID_KEY} from localStorage; if absent,
 * generates a fresh high-entropy id (e.g. crypto.randomUUID()), stores it, and returns
 * it. The id is STABLE across reloads (so the same conversation resumes) and survives
 * publish (the slug is associated onto the session, never replacing its id).
 *
 * This is the ONLY thing kept in localStorage for an unauthenticated user — the
 * transcript itself is never persisted client-side (§26.5). When localStorage is
 * unavailable, fall back to an in-memory id for the current page (mirrors apiClient's
 * memToken pattern) so a single session still coheres.
 *
 * @returns the stable design-session id.
 */
export function getOrCreateDesignSessionId(): string {
  // Prefer a previously-persisted id (stable across reloads, §26.2). localStorage is
  // the source of truth; the in-memory mirror is only a fallback when it's unavailable
  // (private mode / sandboxed runner) — mirrors apiClient's `memToken` ordering.
  try {
    const existing = localStorage.getItem(DESIGN_SESSION_ID_KEY);
    if (existing) {
      memSessionId = existing;
      return existing;
    }
    // localStorage works but is empty → mint, persist, and return.
    const fresh = mintSessionId();
    memSessionId = fresh;
    localStorage.setItem(DESIGN_SESSION_ID_KEY, fresh);
    return fresh;
  } catch {
    /* storage unavailable — fall through to the in-memory mirror */
  }

  // localStorage threw: reuse the mirror if we already minted one this page, else mint.
  if (memSessionId) return memSessionId;
  memSessionId = mintSessionId();
  return memSessionId;
}

/**
 * Make `id` the active design-session id (SPEC §26.2/§26.9, PR #65) — used when the owner
 * SWITCHES to or creates another conversation. Writes it to localStorage
 * ({@link DESIGN_SESSION_ID_KEY}) so a reload resumes THIS conversation, and updates the
 * in-memory mirror so {@link getOrCreateDesignSessionId} immediately returns it (kept
 * coherent within the page even when storage is unavailable — mirrors apiClient's
 * `memToken`). Storage failures are swallowed: the in-memory mirror still coheres the page.
 *
 * @param id the design-session id to make active.
 */
export function setActiveDesignSessionId(id: string): void {
  // Update the in-memory mirror first so the id coheres even if persistence throws.
  memSessionId = id;
  try {
    localStorage.setItem(DESIGN_SESSION_ID_KEY, id);
  } catch {
    /* storage unavailable — the in-memory mirror still coheres the page (§26.2) */
  }
}

/**
 * Mint a fresh design-session id, make it active, and return it (SPEC §26.2/§26.9, PR #65)
 * — used when the owner starts a NEW conversation. The new id is high-entropy (so it never
 * collides with an existing (owner_id, sessionId) row), persisted + mirrored via
 * {@link setActiveDesignSessionId}, and becomes the key every subsequent turn-end save
 * writes under (so the new conversation never overwrites the prior one).
 *
 * @returns the freshly-minted active design-session id.
 */
export function newDesignSessionId(): string {
  const fresh = mintSessionId();
  setActiveDesignSessionId(fresh);
  return fresh;
}

/**
 * The live in-memory chat message shape the designer thread keeps (a superset of
 * {@link PersistedTurn}, carrying the transient `streaming` flag + live handles).
 * Sourced from `src/App.jsx` `messages` state / `renderChatTurn` (`src/chat.jsx`).
 */
export interface LiveChatMessage {
  id: string;
  role: PersistedTurnRole;
  kind?: PersistedTurnKind;
  text?: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: string;
  status?: "running" | "done" | "error";
  steps?: string[];
  duration?: number;
  suggestions?: string[];
  /** Transient render flag (live thread only) — NEVER persisted (§26.6). */
  streaming?: boolean;
}

/**
 * Project the live UI thread (`messages`) into its SERIALIZABLE {@link PersistedTurn}
 * form for a batch write (SPEC §26.6): keep only the substantive turn fields and DROP
 * the transient `streaming` flag (and, by omission, any live React handles). Pure +
 * order-preserving, so the restore renders the same thread the owner saw. Undefined
 * fields are omitted so the persisted snapshot stays compact and JSON-round-trippable.
 *
 * @param messages the live thread messages (App.jsx `messages` state).
 * @returns the persisted turns, in original order.
 */
export function toPersistedTurns(messages: readonly LiveChatMessage[]): PersistedTurn[] {
  return messages.map((m) => {
    const turn: PersistedTurn = { id: m.id, role: m.role };
    if (m.kind !== undefined) turn.kind = m.kind;
    if (m.text !== undefined) turn.text = m.text;
    if (m.name !== undefined) turn.name = m.name;
    if (m.args !== undefined) turn.args = m.args;
    if (m.result !== undefined) turn.result = m.result;
    if (m.status !== undefined) turn.status = m.status;
    if (m.steps !== undefined) turn.steps = m.steps;
    if (m.duration !== undefined) turn.duration = m.duration;
    if (m.suggestions !== undefined) turn.suggestions = m.suggestions;
    // `streaming` and any live handles are intentionally excluded (§26.6).
    return turn;
  });
}

/**
 * Load a persisted design conversation by session id (SPEC §26.3, owner-only §17).
 * Resolves to {@link LoadChatSessionResult}: `{ session }` on hit, `{ session: null }`
 * when this owner has never persisted that id (normal first-visit empty state). A
 * 401 surfaces as a 401 ApiError for the caller to route into /signin. Carries `auth:true`.
 *
 * @param sessionId the stable design-session id (from {@link getOrCreateDesignSessionId}).
 */
export function loadChatSession(sessionId: string): Promise<LoadChatSessionResult> {
  return apiFetch<LoadChatSessionResult>(sessionPath(sessionId), { auth: true });
}

/**
 * Persist (replace) the design conversation for a session id (SPEC §26.3/§26.4,
 * owner-only §17). Called in BATCHES at turn end — never per streamed token (§26.4) —
 * with the turns + LLM history accumulated so far; the backend stores them under
 * (owner, sessionId), upserting the row (last-write-wins). Resolves to
 * {@link SaveChatSessionResult}. A 401 surfaces as a 401 ApiError for the caller to
 * route into /signin. Carries `auth:true`.
 *
 * @param sessionId the stable design-session id.
 * @param input the batch snapshot to persist ({@link SaveChatSessionInput}).
 */
export function saveChatTurns(
  sessionId: string,
  input: SaveChatSessionInput,
): Promise<SaveChatSessionResult> {
  return apiFetch<SaveChatSessionResult>(sessionPath(sessionId), {
    method: "PUT",
    auth: true,
    body: input,
  });
}

// ---------------------------------------------------------------------------
// Multi-session list + delete (SPEC §26.9, PR #65) — owner-only, mirrors backend
// ---------------------------------------------------------------------------

/**
 * A chat session's summary for the session-list / switcher (SPEC §26.9). Mirrors the
 * backend `ChatSessionSummary` (workers/src/chatSessions.ts): just enough to render a
 * list row and switch/delete — NOT the full transcript (that comes from
 * {@link loadChatSession} by sessionId). `title` / `turnCount` are derived server-side
 * from the stored turns (no extra columns). Carries no owner credentials.
 */
export interface ChatSessionSummary {
  /** Client-minted stable design-session id (the (owner_id, sessionId) key, §26.2). */
  sessionId: string;
  /** Derived list title: first user turn's text, trimmed + truncated; "新会话" if none (§26.9). */
  title: string;
  /** Conversation rounds = count of `role === "user"` turns in the stored transcript (§26.9). */
  turnCount: number;
  /** Public slug once this session's form is published; null before publish (§26.2). */
  formSlug: string | null;
  /** ISO-8601 last-write time (the list is ordered most-recent-first, §26.9). */
  updatedAt: string;
}

/**
 * Response of `GET /api/chat/sessions` (SPEC §26.9): the current owner's sessions,
 * most-recent-first. An owner with no sessions gets `{ sessions: [] }` (normal empty
 * state, not an error). Cross-owner isolation is enforced server-side (only this owner's
 * rows, §26.8).
 */
export interface ListChatSessionsResult {
  sessions: ChatSessionSummary[];
}

/** Response of `DELETE /api/chat/session/:sessionId` (SPEC §26.9) on a hit. */
export interface DeleteChatSessionResult {
  deleted: boolean;
}

/**
 * List the current owner's chat sessions (SPEC §26.9, owner-only §17). Resolves to
 * {@link ListChatSessionsResult} — `{ sessions }` most-recent-first, `{ sessions: [] }`
 * when the owner has none. A 401 surfaces as a 401 ApiError for the caller to route into
 * /signin. Carries `auth:true`. GETs {@link CHAT_SESSIONS_PATH} (note: `/sessions`, no id —
 * distinct from the per-session {@link CHAT_SESSION_PATH}).
 */
export function listChatSessions(): Promise<ListChatSessionsResult> {
  return apiFetch<ListChatSessionsResult>(CHAT_SESSIONS_PATH, { auth: true });
}

/**
 * Delete one of the current owner's chat sessions by id (SPEC §26.9, owner-only §17).
 * Resolves to `{ deleted: true }` on a hit. A session that never existed under this owner —
 * or belongs to another owner — surfaces as a **404 ApiError** (`{ error: "会话不存在" }`,
 * owner isolation §26.8) for the CALLER to handle; this function does not swallow it.
 * A 401 likewise surfaces for routing into /signin. Carries `auth:true`. DELETEs
 * {@link CHAT_SESSION_PATH}/:sessionId (the per-session path, with id).
 *
 * @param sessionId the design-session id to delete.
 */
export function deleteChatSession(sessionId: string): Promise<DeleteChatSessionResult> {
  return apiFetch<DeleteChatSessionResult>(sessionPath(sessionId), {
    method: "DELETE",
    auth: true,
  });
}
