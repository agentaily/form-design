// App-level frontend realization of features/url-state-persistence.feature (PR #76 + A' 项目↔对话,
// §26.10): the active PROJECT (/p/:projectId path) carries the shared workspace, the active
// conversation (?s=<id>) carries the chat, and the settings tab nests under the project
// (/p/:id/settings/:tab). A refresh / deep-link / Back-Forward restores BOTH the workspace (via
// loadProject) AND the conversation (via loadChatSession) — without crossing transcripts. Switching
// conversations swaps only the left pane (workspace unchanged, only ?s= flips); the /p/:id project
// path stays. Driven through the real <App/> with the chatSession + project seams injected.
//
// Pairs with chat-session-persistence.spec.jsx (§26 restore) + chat-multi-session.spec.jsx (§26.9
// list/switch) + app-settings-login.spec.jsx (overlay open/close) + project-conversation-regression
// .spec.jsx (the two A' bug guards). This file pins the URL↔state wiring those leave to App. URL
// writes go to the real jsdom window.history, so each case resets the location in beforeEach.
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react/pure";
import App from "../../src/App.jsx";
import { setToken, clearToken } from "../../src/core/apiClient";
import { DESIGN_SESSION_ID_KEY } from "../../src/core/chatSessionClient";
import { DESIGN_PROJECT_ID_KEY } from "../../src/core/projectClient";
import { readProjectId } from "../../src/core/router";
import { CHAT_MODEL_STORAGE_KEY as MODEL_KEY } from "../../src/core/chatModels";

function asLoggedIn() {
  setToken("test.session.jwt-not-decoded");
}
const verifiedMe = async () => ({ email: "owner@example.com", emailVerified: true });
function makeStreamingChat(text) {
  return vi.fn(async ({ onText }) => {
    for (const ch of text) onText?.(ch);
    return { text, toolCalls: [] };
  });
}
const sessionParam = () => new URLSearchParams(window.location.search).get("s");
const projectInUrl = () => readProjectId(window.location.pathname);

// A' (§26.10): the conversation and the workspace are now TWO decoupled rows. A persisted session's
// turns are PURE chat (no embedded workspace snapshot turn — that #76 snapshot mechanism is gone);
// the workspace lives on the PROJECT row, restored separately via loadProject. These helpers build
// the two halves so a restore harness can wire loadChatSession (conversation) + loadProject (workspace).
function conversationOnly({ sessionId = "ds-deep", convoText }) {
  return {
    sessionId,
    turns: [
      { id: "u1", role: "user", text: convoText },
      { id: "a1", role: "assistant", kind: "text", text: "好的，搭好了" },
    ],
    history: [{ role: "system", content: "sys" }],
    formSlug: null,
  };
}
function projectWorkspace({ projectId, fieldLabel }) {
  return {
    projectId,
    meta: { title: "活动报名" },
    fields: [{ id: "fld_5", type: "text", label: fieldLabel, required: true }],
    formSlug: null,
    createdAt: "2026-06-13T08:00:00.000Z",
    updatedAt: "2026-06-13T10:00:00.000Z",
  };
}

function baseProps(overrides = {}) {
  return {
    chat: makeStreamingChat("ok"),
    getCurrentUser: verifiedMe,
    loadChatSession: vi.fn(async () => ({ session: null })),
    saveChatTurns: vi.fn(async () => ({ sessionId: "x", updatedAt: "t" })),
    listChatSessions: vi.fn(async () => ({ sessions: [] })),
    deleteChatSession: vi.fn(async () => ({ deleted: true })),
    renameChatSession: vi.fn(async () => ({ renamed: true })),
    // A' project seams — empty-state fakes by default (per-test overrides win, spread last).
    loadProject: vi.fn(async () => ({ project: null })),
    saveProjectWorkspace: vi.fn(async () => ({ projectId: "pj", updatedAt: "t" })),
    listProjects: vi.fn(async () => ({ projects: [] })),
    getConfig: vi.fn(async () => ({ deepseek: {}, feishu: {} })),
    saveConfig: vi.fn(async () => ({})),
    testConnection: vi.fn(async () => ({ ok: false })),
    navigate: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  // start each case on a clean designer URL so a prior case's path/?s= doesn't leak in.
  window.history.replaceState({}, "", "/");
});
afterEach(() => {
  cleanup();
  clearToken();
  try {
    localStorage.removeItem(DESIGN_SESSION_ID_KEY);
    localStorage.removeItem(DESIGN_PROJECT_ID_KEY);
    localStorage.removeItem(MODEL_KEY);
  } catch {
    /* ignore */
  }
  window.history.replaceState({}, "", "/");
});

function openSessionMenu() {
  fireEvent.click(screen.getByRole("button", { name: "会话" }));
}

describe("URL 状态持久化 · 设计会话进 URL (features/url-state-persistence.feature, PR #76)", () => {
  it("Scenario: 进入设计器时把当前会话规整进 URL", async () => {
    asLoggedIn();
    render(<App {...baseProps()} />);
    // On mount the App normalizes / → /p/<projectId>?s=<sessionId> (A'): the project enters the PATH
    // (so the shared workspace is shareable/bookmarkable) and the active conversation enters ?s=.
    await waitFor(() => expect(sessionParam()).toBeTruthy());
    await waitFor(() => expect(projectInUrl()).toBeTruthy());
    expect(window.location.pathname).toMatch(/^\/p\/[^/]+$/);
  });

  it("Scenario: 带会话参数的 URL 刷新后完整恢复对话与工作区", async () => {
    asLoggedIn();
    // A' (§26.10): the deep link names BOTH the project (path) and the conversation (?s=). Restore
    // loads the workspace from loadProject(projectId) and the conversation from loadChatSession.
    window.history.replaceState({}, "", "/p/pj-deep?s=ds-deep");
    const loadProject = vi.fn(async (projectId) =>
      projectId === "pj-deep"
        ? { project: projectWorkspace({ projectId, fieldLabel: "恢复-字段-唯一标记" }) }
        : { project: null },
    );
    const loadChatSession = vi.fn(async (_projectId, id) =>
      id === "ds-deep"
        ? { session: conversationOnly({ sessionId: "ds-deep", convoText: "恢复-对话-唯一标记" }) }
        : { session: null },
    );
    render(
      <App
        {...baseProps({ loadProject, loadChatSession })}
        pathname="/p/pj-deep"
        search="?s=ds-deep"
      />,
    );

    // the workspace is loaded by the URL's project id…
    await waitFor(() => expect(loadProject).toHaveBeenCalledWith("pj-deep"));
    // …the conversation is loaded by (projectId, sessionId)…
    await waitFor(() => expect(loadChatSession).toHaveBeenCalledWith("pj-deep", "ds-deep"));
    // …the conversation comes back…
    expect(await screen.findByText("恢复-对话-唯一标记")).toBeInTheDocument();
    // …AND the workspace (right-pane form preview) is rebuilt from the PROJECT row (not a snapshot turn).
    expect(await screen.findByText("恢复-字段-唯一标记")).toBeInTheDocument();
    // the URL keeps naming this project + session (no spurious normalization away from it).
    expect(sessionParam()).toBe("ds-deep");
    expect(projectInUrl()).toBe("pj-deep");
  });

  it("Scenario: 会话参数为未持久化的值时退化为空态而不串内容", async () => {
    asLoggedIn();
    window.history.replaceState({}, "", "/p/pj-x?s=ds-bogus");
    const loadChatSession = vi.fn(async () => ({ session: null }));
    render(<App {...baseProps({ loadChatSession })} pathname="/p/pj-x" search="?s=ds-bogus" />);

    await waitFor(() => expect(loadChatSession).toHaveBeenCalledWith("pj-x", "ds-bogus"));
    // empty state, no crash — the empty-thread hint is shown.
    expect(await screen.findByText("描述你想要的表单")).toBeInTheDocument();
  });

  it("Scenario: 新建会话时把新会话写进 URL", async () => {
    asLoggedIn();
    render(<App {...baseProps()} />);
    await waitFor(() => expect(sessionParam()).toBeTruthy());
    await waitFor(() => expect(projectInUrl()).toBeTruthy());
    const beforeSession = sessionParam();
    const beforeProject = projectInUrl();

    openSessionMenu();
    fireEvent.click(screen.getByText("新会话"));

    // the URL now names a DIFFERENT (freshly-minted) session…
    await waitFor(() => expect(sessionParam()).not.toBe(beforeSession));
    expect(sessionParam()).toBeTruthy();
    // …but the PROJECT path is UNCHANGED (A': 新对话留在当前项目,继续编同一份表单 — only ?s= flips).
    expect(projectInUrl()).toBe(beforeProject);
  });

  it("Scenario: 切换会话时 URL 改为目标会话", async () => {
    asLoggedIn();
    const SESSIONS = [
      {
        sessionId: "ds-active",
        title: "活动报名",
        turnCount: 3,
        formSlug: null,
        updatedAt: "2026-06-13T10:00:00.000Z",
      },
      {
        sessionId: "ds-other",
        title: "满意度问卷",
        turnCount: 2,
        formSlug: null,
        updatedAt: "2026-06-13T08:00:00.000Z",
      },
    ];
    const loadChatSession = vi.fn(async (_projectId, id) =>
      id === "ds-other"
        ? {
            session: {
              sessionId: "ds-other",
              turns: [{ id: "o1", role: "user", text: "另一段-唯一标记" }],
              history: [{ role: "system", content: "s" }],
            },
          }
        : id === "ds-active"
          ? {
              session: {
                sessionId: "ds-active",
                turns: [{ id: "c1", role: "user", text: "当前段-唯一标记" }],
                history: [{ role: "system", content: "s" }],
              },
            }
          : { session: null },
    );
    // Start in a project with a workspace field → 切对话工作区不变 can be asserted.
    window.history.replaceState({}, "", "/p/pj-sw?s=ds-active");
    const loadProject = vi.fn(async (projectId) => ({
      project: projectWorkspace({ projectId, fieldLabel: "工作区字段-切对话不变" }),
    }));
    render(
      <App
        {...baseProps({
          listChatSessions: vi.fn(async () => ({ sessions: SESSIONS })),
          loadChatSession,
          loadProject,
        })}
        pathname="/p/pj-sw"
        search="?s=ds-active"
      />,
    );
    expect(await screen.findByText("工作区字段-切对话不变")).toBeInTheDocument();

    openSessionMenu();
    fireEvent.click(screen.getByText("满意度问卷"));

    // A' (§26.10): the conversation load is keyed (projectId, sessionId)…
    await waitFor(() => expect(loadChatSession).toHaveBeenCalledWith("pj-sw", "ds-other"));
    expect(sessionParam()).toBe("ds-other");
    expect(await screen.findByText("另一段-唯一标记")).toBeInTheDocument();
    // …切对话工作区不变: the workspace field stays + the /p/:id project path stays (only ?s= flipped).
    expect(screen.getByText("工作区字段-切对话不变")).toBeInTheDocument();
    expect(projectInUrl()).toBe("pj-sw");
    // switching reloads ONLY the conversation, never the workspace (loadProject not re-fired).
    expect(loadProject).toHaveBeenCalledTimes(1);
  });

  it("Scenario: 浏览器后退切回上一段会话且不串内容", async () => {
    asLoggedIn();
    const A = {
      sessionId: "ds-a",
      turns: [{ id: "a1", role: "user", text: "A会话-唯一标记" }],
      history: [{ role: "system", content: "s" }],
    };
    const B = {
      sessionId: "ds-b",
      turns: [{ id: "b1", role: "user", text: "B会话-唯一标记" }],
      history: [{ role: "system", content: "s" }],
    };
    const loadChatSession = vi.fn(async (_projectId, id) =>
      id === "ds-a" ? { session: A } : id === "ds-b" ? { session: B } : { session: null },
    );
    const SESSIONS = [
      {
        sessionId: "ds-a",
        title: "A",
        turnCount: 1,
        formSlug: null,
        updatedAt: "2026-06-13T10:00:00.000Z",
      },
      {
        sessionId: "ds-b",
        title: "B",
        turnCount: 1,
        formSlug: null,
        updatedAt: "2026-06-13T09:00:00.000Z",
      },
    ];
    // Both conversations live UNDER the same project (A': Back/Forward between conversations keeps
    // the /p/:id path, only ?s= flips).
    window.history.replaceState({}, "", "/p/pj-ab?s=ds-a");
    render(
      <App
        {...baseProps({
          listChatSessions: vi.fn(async () => ({ sessions: SESSIONS })),
          loadChatSession,
        })}
        pathname="/p/pj-ab"
        search="?s=ds-a"
      />,
    );
    expect(await screen.findByText("A会话-唯一标记")).toBeInTheDocument();

    // switch A → B (menu).
    openSessionMenu();
    fireEvent.click(screen.getByText("B"));
    expect(await screen.findByText("B会话-唯一标记")).toBeInTheDocument();
    expect(sessionParam()).toBe("ds-b");
    expect(screen.queryByText("A会话-唯一标记")).not.toBeInTheDocument();

    // simulate the browser Back button: the URL is already back on A (same project), then popstate fires.
    window.history.replaceState({}, "", "/p/pj-ab?s=ds-a");
    window.dispatchEvent(new PopStateEvent("popstate"));

    // Back restores A's transcript; B's transcript must NOT bleed into A (no cross-session串).
    expect(await screen.findByText("A会话-唯一标记")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("B会话-唯一标记")).not.toBeInTheDocument());
    expect(sessionParam()).toBe("ds-a");
    expect(projectInUrl()).toBe("pj-ab");
  });

  it("Scenario: 乱序到达的会话加载不串内容(stale 的 B 绝不落到当前的 A)", async () => {
    // Regression for the async-reorder race: switch B (load in flight) → Back to A (load in flight)
    // → the LATEST (A) resolves first, then the STALE (B) resolves last. Without the load-sequence
    // guard the stale B would win — rendering B under A's id and then persisting it there.
    asLoggedIn();
    const A = {
      sessionId: "ds-a",
      turns: [{ id: "a1", role: "user", text: "A会话-唯一标记" }],
      history: [{ role: "system", content: "s" }],
    };
    const B = {
      sessionId: "ds-b",
      turns: [{ id: "b1", role: "user", text: "B会话-唯一标记" }],
      history: [{ role: "system", content: "s" }],
    };
    const resultFor = (id) =>
      id === "ds-a" ? { session: A } : id === "ds-b" ? { session: B } : { session: null };
    const deferreds = [];
    // A' (§4.3): loadChatSession is now keyed (projectId, sessionId) — capture the conversation id
    // (the 2nd arg) so the deferred resolves the right transcript.
    const loadChatSession = vi.fn(
      (_projectId, id) =>
        new Promise((resolve) => deferreds.push({ id, resolve: () => resolve(resultFor(id)) })),
    );
    const SESSIONS = [
      {
        sessionId: "ds-a",
        title: "A",
        turnCount: 1,
        formSlug: null,
        updatedAt: "2026-06-13T10:00:00.000Z",
      },
      {
        sessionId: "ds-b",
        title: "B",
        turnCount: 1,
        formSlug: null,
        updatedAt: "2026-06-13T09:00:00.000Z",
      },
    ];
    window.history.replaceState({}, "", "/p/pj-race?s=ds-a");
    render(
      <App
        {...baseProps({
          listChatSessions: vi.fn(async () => ({ sessions: SESSIONS })),
          loadChatSession,
        })}
        pathname="/p/pj-race"
        search="?s=ds-a"
      />,
    );

    // mount-restore A in flight → resolve it → A shown.
    await waitFor(() => expect(deferreds.length).toBe(1));
    deferreds[0].resolve();
    expect(await screen.findByText("A会话-唯一标记")).toBeInTheDocument();

    // switch A → B: B's load is in flight (not resolved yet).
    openSessionMenu();
    fireEvent.click(screen.getByText("B"));
    await waitFor(() => expect(deferreds.length).toBe(2));

    // Back to A via popstate (same project, only ?s= changes): A's load is in flight.
    window.history.replaceState({}, "", "/p/pj-race?s=ds-a");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(deferreds.length).toBe(3));

    // resolve the LATEST (A) first, then the STALE (B) last.
    deferreds[2].resolve(); // ds-a (current)
    deferreds[1].resolve(); // ds-b (stale — must be ignored by the load-sequence guard)

    await waitFor(() => expect(screen.getByText("A会话-唯一标记")).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText("B会话-唯一标记")).not.toBeInTheDocument());
    expect(sessionParam()).toBe("ds-a");
    expect(projectInUrl()).toBe("pj-race");
  });
});

describe("URL 状态持久化 · 设置 tab 进 URL (features/url-state-persistence.feature, PR #76)", () => {
  it("Scenario: 在设置里切换 tab 同步更新 URL", async () => {
    asLoggedIn();
    render(<App {...baseProps()} />);
    // open 集成设置 from the account menu.
    await waitFor(() => expect(document.querySelector(".am-acct")).toBeInTheDocument());
    fireEvent.click(document.querySelector(".am-acct"));
    fireEvent.click(screen.getByRole("menuitem", { name: /集成设置/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument());
    // A' (§26.10): the settings tab nests UNDER the project (/p/:id/settings/:tab).
    expect(window.location.pathname).toMatch(/^\/p\/[^/]+\/settings\/integrations$/);
    const projectId = projectInUrl();

    // switch to the 账户 tab via the sheet nav → URL follows (project stays in the path).
    fireEvent.click(screen.getByRole("button", { name: "账户" }));
    await waitFor(() => expect(window.location.pathname).toBe(`/p/${projectId}/settings/account`));
  });

  it("Scenario: 深链到某设置 tab 刷新后直接落在该 tab", async () => {
    asLoggedIn();
    // A project-nested settings deep link: /p/:id/settings/account opens straight on the 账户 tab.
    window.history.replaceState({}, "", "/p/pj-deep/settings/account");
    render(<App {...baseProps()} pathname="/p/pj-deep/settings/account" />);
    // opens directly on the 账户 tab (its editable 显示名称 field is account-tab-only).
    expect(await screen.findByText("显示名称")).toBeInTheDocument();
  });

  it("Scenario: 设置参数与会话参数正交共存，关闭回到设计器仍带会话", async () => {
    asLoggedIn();
    // A' (§26.10): all three coexist — the project path, the nested /settings/:tab overlay, and ?s=.
    window.history.replaceState({}, "", "/p/pj-x/settings/integrations?s=ds-x");
    const loadChatSession = vi.fn(async () => ({ session: null }));
    render(
      <App
        {...baseProps({ loadChatSession })}
        pathname="/p/pj-x/settings/integrations"
        search="?s=ds-x"
      />,
    );

    // settings is open (集成 tab fetch fired) AND the session ?s= is active underneath the project.
    await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument());
    await waitFor(() => expect(loadChatSession).toHaveBeenCalledWith("pj-x", "ds-x"));

    // close the overlay → back to the designer at /p/:id, still carrying the session ?s=.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument(),
    );
    expect(window.location.pathname).toBe("/p/pj-x");
    expect(sessionParam()).toBe("ds-x");
  });
});
