// REGRESSION GUARDS for the two「老板线上一步复现」bugs the A' 项目↔对话 cutover must fix (PR-C 验收
// 钉死). The prior attempt「在 main 没复现到」because its tests used mock/假数据 that didn't exercise the
// REAL data paths — so these specs drive REAL-shaped data through the REAL <App>:
//
//   BUG #1 (崩 / 黑屏): 点「继续编辑」一份其某个选择字段(radio/checks/select)缺 options 的已发布表单 →
//     FieldView 旧代码 `options.map(...)` 抛 TypeError reading 'map' → 黑屏。Fix: FieldView 防御性默认 []。
//
//   BUG #2 (刷新对话丢): 「继续编辑」后继续对话 → 刷新(/p/:id?s=)对话变空线程。Root cause: 编辑态
//     `editingFormRef` 让 persistTurn 直接 return,编辑期间每个回合都没落库。A' 下编辑就是进项目、对话
//     照常持久化到项目会话 → 刷新能恢复。
//
// To AVOID the mock blind spot, BUG #2 + the A'-core「切对话工作区不变」case run against a small IN-MEMORY
// BACKEND (a real persist→reload round-trip across project + session rows), not bare spies.
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react/pure";
import App from "../../src/App.jsx";
import { FormPreview } from "../../src/preview.jsx";
import { setToken, clearToken } from "../../src/core/apiClient";
import { DESIGN_SESSION_ID_KEY } from "../../src/core/chatSessionClient";
import { DESIGN_PROJECT_ID_KEY } from "../../src/core/projectClient";
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

// Default App props with the A' project clients injected (empty-state fakes; per-test overrides).
function baseProps(overrides = {}) {
  return {
    chat: makeStreamingChat("ok"),
    getCurrentUser: verifiedMe,
    loadChatSession: vi.fn(async () => ({ session: null })),
    saveChatTurns: vi.fn(async () => ({ sessionId: "x", updatedAt: "t" })),
    listChatSessions: vi.fn(async () => ({ sessions: [] })),
    deleteChatSession: vi.fn(async () => ({ deleted: true })),
    renameChatSession: vi.fn(async () => ({ renamed: true })),
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

// An in-memory backend mirroring the §26.10 project + session contract — REAL round-trip, no spies.
function deriveTitle(turns) {
  const u = (turns || []).find((t) => t && t.role === "user");
  return (u && u.text) || "新会话";
}
function makeMemoryBackend() {
  const sessions = new Map(); // `${projectId}::${sessionId}` -> { sessionId, turns, history, formSlug, updatedAt, title? }
  const projects = new Map(); // projectId -> { meta, fields, formSlug }
  const key = (p, s) => `${p}::${s}`;
  return {
    sessions,
    projects,
    loadChatSession: vi.fn(async (projectId, sessionId) => {
      const row = sessions.get(key(projectId, sessionId));
      return { session: row ? { ...row } : null };
    }),
    saveChatTurns: vi.fn(async (projectId, sessionId, input) => {
      const prev = sessions.get(key(projectId, sessionId)) || {};
      sessions.set(key(projectId, sessionId), {
        ...prev,
        sessionId,
        turns: input.turns,
        history: input.history,
        formSlug: input.formSlug ?? prev.formSlug ?? null,
        updatedAt: "2026-06-15T00:00:00.000Z",
      });
      return { sessionId, updatedAt: "2026-06-15T00:00:00.000Z" };
    }),
    listChatSessions: vi.fn(async (projectId) => ({
      sessions: [...sessions.entries()]
        .filter(([k]) => k.startsWith(projectId + "::"))
        .map(([, v]) => ({
          sessionId: v.sessionId,
          title: v.title || deriveTitle(v.turns),
          turnCount: (v.turns || []).filter((t) => t && t.role === "user").length,
          formSlug: v.formSlug ?? null,
          updatedAt: v.updatedAt || "t",
        })),
    })),
    deleteChatSession: vi.fn(async () => ({ deleted: true })),
    renameChatSession: vi.fn(async () => ({ renamed: true })),
    loadProject: vi.fn(async (projectId) => {
      const row = projects.get(projectId);
      return {
        project: row ? { projectId, ...row, createdAt: "t", updatedAt: "t" } : null,
      };
    }),
    saveProjectWorkspace: vi.fn(async (projectId, input) => {
      const prev = projects.get(projectId) || {};
      projects.set(projectId, {
        meta: input.meta,
        fields: input.fields,
        formSlug: input.formSlug ?? prev.formSlug ?? null,
      });
      return { projectId, updatedAt: "t" };
    }),
    listProjects: vi.fn(async () => ({
      projects: [...projects.entries()].map(([projectId, v]) => ({
        projectId,
        title: (v.meta && v.meta.title) || "未命名表单",
        fieldCount: (v.fields || []).length,
        formSlug: v.formSlug ?? null,
        updatedAt: "t",
      })),
    })),
  };
}

async function openMyForms() {
  await waitFor(() => expect(document.querySelector(".am-acct")).toBeInTheDocument());
  fireEvent.click(document.querySelector(".am-acct"));
  fireEvent.click(screen.getByRole("menuitem", { name: /我的表单/ }));
}

// This jsdom config provides NO `localStorage` global (the project/session id helpers wrap every
// access in try/catch and fall back to a module-level in-memory mirror — which would LEAK across
// tests). Install a fresh, working fake per test so the project-id resolution (URL → stored → resume
// → mint) is deterministic and isolated.
function installFakeLocalStorage() {
  const store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => void store.clear(),
  });
}

beforeEach(() => {
  installFakeLocalStorage();
  window.history.replaceState({}, "", "/");
});
afterEach(() => {
  cleanup();
  clearToken();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("回归 · BUG #1 选择字段缺 options 不崩溃 (preview render)", () => {
  it("FormPreview renders radio / checks / select fields with MISSING options without throwing", () => {
    // A real stored form may carry a choice field whose `options` is undefined / non-array. The old
    // FieldView destructured `options` and called `options.map(...)` → TypeError reading 'map'.
    const fields = [
      { id: "f1", type: "text", label: "姓名" },
      { id: "f2", type: "radio", label: "票种-唯一标记" }, // no options
      { id: "f3", type: "checks", label: "兴趣-唯一标记" }, // no options
      { id: "f4", type: "select", label: "城市-唯一标记" }, // no options
    ];
    expect(() =>
      render(
        <FormPreview
          meta={{ title: "活动报名" }}
          fields={fields}
          values={{}}
          setValue={() => {}}
          style="minimal"
        />,
      ),
    ).not.toThrow();
    // the option-less fields still render (their labels show) instead of blanking the screen.
    expect(screen.getByText("票种-唯一标记")).toBeInTheDocument();
    expect(screen.getByText("城市-唯一标记")).toBeInTheDocument();
  });
});

describe("回归 · BUG #1 继续编辑选项缺失表单不黑屏 (App)", () => {
  it("继续编辑 a published form whose radio field has no options → banner up + field shown, no crash", async () => {
    asLoggedIn();
    const FORM = {
      slug: "f8Kq2pXa",
      status: "published",
      meta: { title: "活动报名表" },
      fields: [
        { id: "fld_3", type: "text", label: "姓名", required: true },
        // ← the missing-options trigger: a `select` field hits FieldView's unguarded `options.map`
        // directly (radio delegates to the DS RadioGroup, which guards — so it must be select/checks).
        { id: "fld_9", type: "select", label: "票种-唯一标记" },
      ],
    };
    render(
      <App
        {...baseProps({
          listForms: vi.fn(async () => [
            {
              slug: "f8Kq2pXa",
              meta: { title: "活动报名表" },
              status: "published",
              createdAt: "2026-06-11T08:00:00.000Z",
            },
          ]),
          getFormForEdit: vi.fn(async () => FORM),
        })}
      />,
    );
    await openMyForms();
    fireEvent.click(await screen.findByRole("button", { name: /继续编辑/ }));
    // edit mode entered AND the option-less field renders in the preview (no blank screen).
    await screen.findByTestId("edit-banner");
    expect(await screen.findByText("票种-唯一标记")).toBeInTheDocument();
  });
});

describe("回归 · BUG #2 继续编辑后刷新对话不丢 (real persist→reload round-trip)", () => {
  it("继续编辑 → 对话(落库)→ 刷新(/p/:id?s=)→ 对话恢复(非空线程)", async () => {
    asLoggedIn();
    const be = makeMemoryBackend();
    // A form published earlier already has its project (formSlug-associated) — loadFormForEdit
    // reverse-resolves it via listProjects.
    be.projects.set("pj-seed", {
      meta: { title: "活动报名表" },
      fields: [{ id: "fld_3", type: "text", label: "姓名" }],
      formSlug: "f8Kq2pXa",
    });
    const FORM = {
      slug: "f8Kq2pXa",
      status: "published",
      meta: { title: "活动报名表" },
      fields: [{ id: "fld_3", type: "text", label: "姓名", required: true }],
    };
    const { unmount } = render(
      <App
        {...baseProps({
          ...be,
          listForms: vi.fn(async () => [
            {
              slug: "f8Kq2pXa",
              meta: { title: "活动报名表" },
              status: "published",
              createdAt: "2026-06-11T08:00:00.000Z",
            },
          ]),
          getFormForEdit: vi.fn(async () => FORM),
          chat: makeStreamingChat("好的，已记下你的改动"),
        })}
      />,
    );
    // 继续编辑 → enter the project.
    await openMyForms();
    fireEvent.click(await screen.findByRole("button", { name: /继续编辑/ }));
    await screen.findByTestId("edit-banner");
    // The designer URL normalized to /p/:id?s=.
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/p\//));

    // Continue the conversation IN EDIT MODE — under A' this MUST persist (the old editingForm skip
    // dropped it → the bug).
    const ta = screen.getByPlaceholderText(/描述你想要的表单/);
    fireEvent.change(ta, { target: { value: "把手机号设为必填-唯一标记" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("好的，已记下你的改动")).toBeInTheDocument();
    // the edit-mode turn WAS persisted to the project's session row.
    await waitFor(() => expect(be.saveChatTurns).toHaveBeenCalled());
    await waitFor(() => {
      const persisted = [...be.sessions.values()].some((row) =>
        (row.turns || []).some((t) => t.text === "把手机号设为必填-唯一标记"),
      );
      expect(persisted).toBe(true);
    });

    // ── SIMULATE A REFRESH: remount the App at the SAME /p/:id?s= URL with the same backend ──
    const url = window.location.pathname + window.location.search;
    unmount();
    cleanup();
    window.history.replaceState({}, "", url);
    render(
      <App
        {...baseProps({ ...be })}
        pathname={window.location.pathname}
        search={window.location.search}
      />,
    );
    // the conversation is restored from the project's session — NOT an empty thread (the bug).
    expect(await screen.findByText("把手机号设为必填-唯一标记")).toBeInTheDocument();
  });
});

describe("回归 · A' 核心:切换对话只换聊天,右侧工作区不变", () => {
  it("切到另一段对话后聊天变了,但工作区字段与 /p/:id 不变(只 ?s= 改)", async () => {
    asLoggedIn();
    const be = makeMemoryBackend();
    be.projects.set("pj-1", {
      meta: { title: "活动报名表" },
      fields: [{ id: "fld_keep", type: "text", label: "工作区字段-不变标记" }],
      formSlug: null,
    });
    be.sessions.set("pj-1::ds-a", {
      sessionId: "ds-a",
      turns: [{ id: "a1", role: "user", text: "对话A-唯一标记" }],
      history: [{ role: "system", content: "s" }],
      updatedAt: "2026-06-13T10:00:00.000Z",
      title: "对话A",
    });
    be.sessions.set("pj-1::ds-b", {
      sessionId: "ds-b",
      turns: [{ id: "b1", role: "user", text: "对话B-唯一标记" }],
      history: [{ role: "system", content: "s" }],
      updatedAt: "2026-06-13T08:00:00.000Z",
      title: "对话B",
    });
    window.history.replaceState({}, "", "/p/pj-1?s=ds-a");
    render(<App {...baseProps({ ...be })} pathname="/p/pj-1" search="?s=ds-a" />);
    // workspace field + conversation A both restored.
    expect(await screen.findByText("工作区字段-不变标记")).toBeInTheDocument();
    expect(await screen.findByText("对话A-唯一标记")).toBeInTheDocument();

    // switch to 对话B via the SessionMenu.
    fireEvent.click(screen.getByRole("button", { name: "会话" }));
    fireEvent.click(await screen.findByText("对话B"));

    // conversation B shows now…
    expect(await screen.findByText("对话B-唯一标记")).toBeInTheDocument();
    // …the workspace field is UNCHANGED (切对话工作区不变)…
    expect(screen.getByText("工作区字段-不变标记")).toBeInTheDocument();
    // …and only ?s= flipped while the /p/:id project path stayed put.
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("s")).toBe("ds-b"));
    expect(window.location.pathname).toBe("/p/pj-1");
  });
});

describe("A' cutover · 裸开 resume 最近项目(消除「现有 owner 看不到已迁数据」gap)", () => {
  it("无 URL / 无 localStorage 项目 → listProjects() resume 最近项目,载其工作区 + URL 落 /p/<id>", async () => {
    asLoggedIn();
    const be = makeMemoryBackend();
    // an existing / just-migrated owner already has a server project (its workspace).
    be.projects.set("pj-recent", {
      meta: { title: "已迁表单" },
      fields: [{ id: "fld_r", type: "text", label: "恢复项目字段-唯一标记" }],
      formSlug: null,
    });
    window.history.replaceState({}, "", "/");
    render(<App {...baseProps({ ...be })} pathname="/" search="" />);

    // mount RESUMES the most-recent server project → its workspace renders + URL anchors to it.
    expect(await screen.findByText("恢复项目字段-唯一标记")).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/p/pj-recent"));
    expect(be.listProjects).toHaveBeenCalled();
  });

  it("无 URL / 无 localStorage 项目 + owner 无任何项目 → mint 全新项目(不 resume)", async () => {
    asLoggedIn();
    const listProjects = vi.fn(async () => ({ projects: [] }));
    window.history.replaceState({}, "", "/");
    render(<App {...baseProps({ listProjects })} pathname="/" search="" />);

    // listProjects consulted, came back empty → a fresh /p/<minted-id>, empty designer.
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/p\/[^/]+$/));
    expect(listProjects).toHaveBeenCalled();
    expect(await screen.findByText("描述你想要的表单")).toBeInTheDocument();
  });

  it("有 localStorage 活跃项目 → resume 它(不查 listProjects,localStorage 优先)", async () => {
    asLoggedIn();
    localStorage.setItem(DESIGN_PROJECT_ID_KEY, "pj-stored");
    const be = makeMemoryBackend();
    be.projects.set("pj-stored", {
      meta: { title: "上次的表单" },
      fields: [{ id: "fld_s", type: "text", label: "存储项目字段-唯一标记" }],
      formSlug: null,
    });
    window.history.replaceState({}, "", "/");
    render(<App {...baseProps({ ...be })} pathname="/" search="" />);

    expect(await screen.findByText("存储项目字段-唯一标记")).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/p/pj-stored"));
    // localStorage named the active project → no most-recent lookup needed.
    expect(be.listProjects).not.toHaveBeenCalled();
  });
});
