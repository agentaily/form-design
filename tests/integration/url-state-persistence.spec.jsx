// App-level frontend realization of features/url-state-persistence.feature (PR #76): the active
// design session (?s=<id>) and the settings tab (/settings/:tab) are reflected into the URL, so a
// refresh / deep-link / Back-Forward restores the conversation AND the workspace — without crossing
// transcripts between sessions. Driven through the real <App/> with the chatSessionClient seams
// injected (loadChatSession / saveChatTurns / listChatSessions) and the real DS surfaces rendered.
//
// Pairs with chat-session-persistence.spec.jsx (§26 restore) + chat-multi-session.spec.jsx (§26.9
// list/switch) + app-settings-login.spec.jsx (overlay open/close); this file pins the URL↔state
// wiring those leave to App. URL writes go to the real jsdom window.history, so each case resets
// the location in beforeEach to avoid leaking ?s= across tests.
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react/pure";
import App from "../../src/App.jsx";
import { setToken, clearToken } from "../../src/core/apiClient";
import {
  DESIGN_SESSION_ID_KEY,
  buildWorkspaceSnapshotTurn,
} from "../../src/core/chatSessionClient";
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

// A persisted session whose turns carry BOTH the conversation and a workspace snapshot turn (PR #76),
// so restore rebuilds the right-pane preview, not just the chat.
function sessionWithWorkspace({ convoText, fieldLabel }) {
  return {
    sessionId: "ds-deep",
    turns: [
      { id: "u1", role: "user", text: convoText },
      { id: "a1", role: "assistant", kind: "text", text: "好的，搭好了" },
      buildWorkspaceSnapshotTurn({ title: "活动报名" }, [
        { id: "fld_5", type: "text", label: fieldLabel, required: true },
      ]),
    ],
    history: [{ role: "system", content: "sys" }],
    formSlug: null,
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
    getConfig: vi.fn(async () => ({ deepseek: {}, feishu: {} })),
    saveConfig: vi.fn(async () => ({})),
    testConnection: vi.fn(async () => ({ ok: false })),
    navigate: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  // start each case on a clean designer URL so a prior case's ?s= / /settings doesn't leak in.
  window.history.replaceState({}, "", "/");
});
afterEach(() => {
  cleanup();
  clearToken();
  try {
    localStorage.removeItem(DESIGN_SESSION_ID_KEY);
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
    // On mount the resolved session id is reflected into ?s= (so a fresh load is shareable).
    await waitFor(() => expect(sessionParam()).toBeTruthy());
    expect(window.location.pathname).toBe("/");
  });

  it("Scenario: 带会话参数的 URL 刷新后完整恢复对话与工作区", async () => {
    asLoggedIn();
    window.history.replaceState({}, "", "/?s=ds-deep");
    const loadChatSession = vi.fn(async (id) =>
      id === "ds-deep"
        ? {
            session: sessionWithWorkspace({
              convoText: "恢复-对话-唯一标记",
              fieldLabel: "恢复-字段-唯一标记",
            }),
          }
        : { session: null },
    );
    render(<App {...baseProps({ loadChatSession })} />);

    // load is keyed by the URL's session id…
    await waitFor(() => expect(loadChatSession).toHaveBeenCalledWith("ds-deep"));
    // …the conversation comes back…
    expect(await screen.findByText("恢复-对话-唯一标记")).toBeInTheDocument();
    // …AND the workspace (right-pane form preview) is rebuilt from the snapshot.
    expect(await screen.findByText("恢复-字段-唯一标记")).toBeInTheDocument();
    // the URL keeps naming this session (no spurious normalization away from it).
    expect(sessionParam()).toBe("ds-deep");
  });

  it("Scenario: 会话参数为未持久化的值时退化为空态而不串内容", async () => {
    asLoggedIn();
    window.history.replaceState({}, "", "/?s=ds-bogus");
    const loadChatSession = vi.fn(async () => ({ session: null }));
    render(<App {...baseProps({ loadChatSession })} />);

    await waitFor(() => expect(loadChatSession).toHaveBeenCalledWith("ds-bogus"));
    // empty state, no crash — the empty-thread hint is shown.
    expect(await screen.findByText("描述你想要的表单")).toBeInTheDocument();
  });

  it("Scenario: 新建会话时把新会话写进 URL", async () => {
    asLoggedIn();
    render(<App {...baseProps()} />);
    await waitFor(() => expect(sessionParam()).toBeTruthy());
    const before = sessionParam();

    openSessionMenu();
    fireEvent.click(screen.getByText("新会话"));

    // the URL now names a DIFFERENT (freshly-minted) session.
    await waitFor(() => expect(sessionParam()).not.toBe(before));
    expect(sessionParam()).toBeTruthy();
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
    const loadChatSession = vi.fn(async (id) =>
      id === "ds-other"
        ? {
            session: {
              sessionId: "ds-other",
              turns: [{ id: "o1", role: "user", text: "另一段-唯一标记" }],
              history: [{ role: "system", content: "s" }],
            },
          }
        : { session: null },
    );
    render(
      <App
        {...baseProps({
          listChatSessions: vi.fn(async () => ({ sessions: SESSIONS })),
          loadChatSession,
        })}
      />,
    );
    await waitFor(() => expect(sessionParam()).toBeTruthy());

    openSessionMenu();
    fireEvent.click(screen.getByText("满意度问卷"));

    await waitFor(() => expect(loadChatSession).toHaveBeenCalledWith("ds-other"));
    expect(sessionParam()).toBe("ds-other");
    expect(await screen.findByText("另一段-唯一标记")).toBeInTheDocument();
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
    const loadChatSession = vi.fn(async (id) =>
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
    window.history.replaceState({}, "", "/?s=ds-a");
    render(
      <App
        {...baseProps({
          listChatSessions: vi.fn(async () => ({ sessions: SESSIONS })),
          loadChatSession,
        })}
      />,
    );
    expect(await screen.findByText("A会话-唯一标记")).toBeInTheDocument();

    // switch A → B (menu).
    openSessionMenu();
    fireEvent.click(screen.getByText("B"));
    expect(await screen.findByText("B会话-唯一标记")).toBeInTheDocument();
    expect(sessionParam()).toBe("ds-b");
    expect(screen.queryByText("A会话-唯一标记")).not.toBeInTheDocument();

    // simulate the browser Back button: the URL is already back on A, then popstate fires.
    window.history.replaceState({}, "", "/?s=ds-a");
    window.dispatchEvent(new PopStateEvent("popstate"));

    // Back restores A's transcript; B's transcript must NOT bleed into A (no cross-session串).
    expect(await screen.findByText("A会话-唯一标记")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("B会话-唯一标记")).not.toBeInTheDocument());
    expect(sessionParam()).toBe("ds-a");
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
    const loadChatSession = vi.fn(
      (id) =>
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
    window.history.replaceState({}, "", "/?s=ds-a");
    render(
      <App
        {...baseProps({
          listChatSessions: vi.fn(async () => ({ sessions: SESSIONS })),
          loadChatSession,
        })}
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

    // Back to A via popstate: A's load is in flight.
    window.history.replaceState({}, "", "/?s=ds-a");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(deferreds.length).toBe(3));

    // resolve the LATEST (A) first, then the STALE (B) last.
    deferreds[2].resolve(); // ds-a (current)
    deferreds[1].resolve(); // ds-b (stale — must be ignored by the load-sequence guard)

    await waitFor(() => expect(screen.getByText("A会话-唯一标记")).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText("B会话-唯一标记")).not.toBeInTheDocument());
    expect(sessionParam()).toBe("ds-a");
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
    expect(window.location.pathname).toBe("/settings/integrations");

    // switch to the 账户 tab via the sheet nav → URL follows.
    fireEvent.click(screen.getByRole("button", { name: "账户" }));
    await waitFor(() => expect(window.location.pathname).toBe("/settings/account"));
  });

  it("Scenario: 深链到某设置 tab 刷新后直接落在该 tab", async () => {
    asLoggedIn();
    window.history.replaceState({}, "", "/settings/account");
    render(<App {...baseProps()} pathname="/settings/account" />);
    // opens directly on the 账户 tab (its editable 显示名称 field is account-tab-only).
    expect(await screen.findByText("显示名称")).toBeInTheDocument();
  });

  it("Scenario: 设置参数与会话参数正交共存，关闭回到设计器仍带会话", async () => {
    asLoggedIn();
    window.history.replaceState({}, "", "/settings/integrations?s=ds-x");
    const loadChatSession = vi.fn(async () => ({ session: null }));
    render(
      <App
        {...baseProps({ loadChatSession })}
        pathname="/settings/integrations"
        search="?s=ds-x"
      />,
    );

    // settings is open (集成 tab fetch fired) AND the session ?s= is active underneath.
    await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument());
    await waitFor(() => expect(loadChatSession).toHaveBeenCalledWith("ds-x"));

    // close the overlay → back to the designer root, still carrying the session ?s=.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument(),
    );
    expect(window.location.pathname).toBe("/");
    expect(sessionParam()).toBe("ds-x");
  });
});
