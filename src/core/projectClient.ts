// projectClient.ts — frontend seam for PROJECT-level workspace persistence (A' 项目↔对话, §26.10).
//
// WHAT THIS SOLVES (A'): a「表单 = 项目」是容器, its workspace (FormMeta + UiField[]) belongs to the
// PROJECT, not to any single conversation. PR #76 rode the workspace as a synthetic snapshot turn
// inside a session's turns_json — so 切对话 = 切到另一份工作区, which contradicts「多条对话共编同一表单」.
// A' lifts the workspace up to a `projects` row keyed by a client-minted `projectId`, so switching
// conversations only swaps the left-pane chat while the right-pane workspace stays put. This module
// is the frontend consumer of the §26.10 project endpoints (mirrors chatSessionClient's structure).
//
// KEYING (§A'.1 — the load-bearing decision): like a draft session, a draft project has NO stable
// form id before publish (slug only exists post-publish). So the project is keyed by a CLIENT-MINTED
// stable `projectId` (minted on first designer entry, persisted in localStorage), NOT by the form.
// A publish later软-associates the resulting `slug` onto the project row (never replacing its id).
//
// OWNER-ONLY (§17 / §26.10): every call carries `auth: true`; a missing/expired session surfaces as
// a 401 ApiError for the caller to route into /signin. The transcript/workspace are never persisted
// client-side — only the project id (mirrors chatSessionClient's session-id discipline).

import { apiFetch } from "./apiClient";
import type { FormMeta, UiField } from "./designerTools";

/** localStorage key holding the client-minted stable design-project id (§A'.1). */
export const DESIGN_PROJECT_ID_KEY = "agentaily_forms_design_project";

/** Owner-only projects LIST endpoint (`GET /api/projects`, §26.10). */
export const PROJECTS_PATH = "/api/projects";

// In-memory mirror of the design-project id, so it coheres within the page even when localStorage
// is unavailable (private mode / sandboxed runner) — mirrors chatSessionClient's `memSessionId`.
let memProjectId: string | null = null;

/** Build the per-project endpoint path (`/api/projects/:projectId`, §26.10). */
function projectPath(projectId: string): string {
  return `${PROJECTS_PATH}/${encodeURIComponent(projectId)}`;
}

/** Mint a fresh high-entropy design-project id (crypto.randomUUID with a fallback, §A'.1). */
function mintProjectId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through to the manual fallback */
  }
  // Fallback for environments without crypto.randomUUID — still high-entropy enough for a
  // per-owner project key (the real isolation is the (owner_id, projectId) PK).
  return `pj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// ---------------------------------------------------------------------------
// Contract types (mirror workers/src/projects.ts, §3.1 / §3.3)
// ---------------------------------------------------------------------------

/** The project-level workspace the right pane renders (A'): the shared form model (meta + fields). */
export interface ProjectWorkspace {
  meta: FormMeta | null;
  fields: UiField[];
}

/**
 * A project (= a form container) as projected by `GET /api/projects/:projectId` (§3.1). meta/fields
 * are already JSON-parsed; `formSlug` is filled once the project's form is published (null before).
 * Timestamps are ISO-8601. Carries no owner credentials.
 */
export interface ProjectRecord {
  projectId: string;
  meta: FormMeta | null;
  fields: UiField[];
  formSlug: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Body of `PUT /api/projects/:projectId` (§3.1) — the整段替换 workspace snapshot. `formSlug`, when a
 * string, associates the published form onto the project row; omit it (or null) to leave the existing
 * slug untouched (COALESCE, mirrors §26.3 form_slug discipline).
 */
export interface ProjectUpsertInput {
  meta: FormMeta | null;
  fields: UiField[];
  formSlug?: string | null;
}

/**
 * A project's summary for the project switcher (§3.1). `title` is meta.title (falling back to a
 * default server-side); `fieldCount` is the workspace field count. Mirrors backend `ProjectSummary`.
 */
export interface ProjectSummary {
  projectId: string;
  title: string;
  fieldCount: number;
  formSlug: string | null;
  updatedAt: string;
}

/**
 * Response of `GET /api/projects/:projectId` (§26.10). On a never-seen project id the backend returns
 * `{ project: null }` (a normal empty state — first visit / cleared storage — NOT a 404).
 */
export interface LoadProjectResult {
  project: ProjectRecord | null;
}

/** Response of `PUT /api/projects/:projectId` (§26.10): the saved snapshot's stamps. */
export interface SaveProjectResult {
  projectId: string;
  updatedAt: string;
}

/** Response of `GET /api/projects` (§26.10): the owner's projects, most-recent-first. */
export interface ListProjectsResult {
  projects: ProjectSummary[];
}

/** Response of `DELETE /api/projects/:projectId` (§26.10) on a hit. */
export interface DeleteProjectResult {
  deleted: boolean;
}

// ---------------------------------------------------------------------------
// Stable project-id helper (§A'.1) — mirrors chatSessionClient's session-id helpers
// ---------------------------------------------------------------------------

/**
 * Return the owner's stable design-project id, minting + persisting one on first call (§A'.1). Reads
 * {@link DESIGN_PROJECT_ID_KEY} from localStorage; if absent, generates a fresh high-entropy id,
 * stores it, and returns it. The id is STABLE across reloads (so the same project resumes) and
 * survives publish (the slug is associated onto the project, never replacing its id). When
 * localStorage is unavailable, falls back to an in-memory id for the current page.
 */
export function getOrCreateProjectId(): string {
  try {
    const existing = localStorage.getItem(DESIGN_PROJECT_ID_KEY);
    if (existing) {
      memProjectId = existing;
      return existing;
    }
    const fresh = mintProjectId();
    memProjectId = fresh;
    localStorage.setItem(DESIGN_PROJECT_ID_KEY, fresh);
    return fresh;
  } catch {
    /* storage unavailable — fall through to the in-memory mirror */
  }
  if (memProjectId) return memProjectId;
  memProjectId = mintProjectId();
  return memProjectId;
}

/**
 * Make `id` the active design-project id (§A'.1) — used when the owner enters another project
 * (e.g.「继续编辑」reverse-resolves a published form's project). Writes it to localStorage so a
 * reload resumes THIS project, and updates the in-memory mirror so {@link getOrCreateProjectId}
 * immediately returns it. Storage failures are swallowed: the mirror still coheres the page.
 */
export function setActiveProjectId(id: string): void {
  memProjectId = id;
  try {
    localStorage.setItem(DESIGN_PROJECT_ID_KEY, id);
  } catch {
    /* storage unavailable — the in-memory mirror still coheres the page */
  }
}

/**
 * Mint a fresh design-project id, make it active, and return it (§A'.1) — used when the owner starts
 * a brand-new project (a fresh draft form). The new id is high-entropy (so it never collides with an
 * existing (owner_id, projectId) row), persisted + mirrored via {@link setActiveProjectId}.
 */
export function newProjectId(): string {
  const fresh = mintProjectId();
  setActiveProjectId(fresh);
  return fresh;
}

// ---------------------------------------------------------------------------
// Project-level workspace load/save/list/delete (§26.10) — replaces #76's snapshot
// ---------------------------------------------------------------------------

/**
 * Load a project's workspace by id (§26.10, owner-only §17). Resolves to {@link LoadProjectResult}:
 * `{ project }` on hit, `{ project: null }` when this owner has never persisted that id (normal
 * first-visit empty state). A 401 surfaces as a 401 ApiError for the caller to route into /signin.
 */
export function loadProject(projectId: string): Promise<LoadProjectResult> {
  return apiFetch<LoadProjectResult>(projectPath(projectId), { auth: true });
}

/**
 * Persist (replace) a project's workspace (§26.10, owner-only §17). Called when the workspace changes
 * / at turn end — decoupled from the conversation turns (which go to saveChatTurns). The backend
 * upserts the row (last-write-wins). A 401 surfaces for routing into /signin.
 */
export function saveProjectWorkspace(
  projectId: string,
  input: ProjectUpsertInput,
): Promise<SaveProjectResult> {
  return apiFetch<SaveProjectResult>(projectPath(projectId), {
    method: "PUT",
    auth: true,
    body: input,
  });
}

/**
 * List the current owner's projects (§26.10, owner-only §17), most-recent-first. An owner with no
 * projects gets `{ projects: [] }` (normal empty state). A 401 surfaces for routing into /signin.
 */
export function listProjects(): Promise<ListProjectsResult> {
  return apiFetch<ListProjectsResult>(PROJECTS_PATH, { auth: true });
}

/**
 * Delete one of the current owner's projects by id (§26.10, owner-only §17). The backend cascade-
 * deletes the project's conversations. Resolves to `{ deleted: true }` on a hit; a foreign / never-
 * existed id surfaces as a 404 ApiError for the caller to handle. A 401 surfaces for routing.
 */
export function deleteProject(projectId: string): Promise<DeleteProjectResult> {
  return apiFetch<DeleteProjectResult>(projectPath(projectId), {
    method: "DELETE",
    auth: true,
  });
}
