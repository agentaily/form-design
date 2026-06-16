// App-level frontend realization of the 设计对话持久化 + 刷新恢复 (§26) scenarios from
// features/chat-session-persistence.feature. The DATA-LAYER guarantees (owner-only 鉴权门、
// (owner_id, session_id) 隔离、upsert last-write-wins、空态非 404、bad-request) are realized
// at the worker altitude (workers/test/chat-session-api.test.ts); this file pins the
// FRONTEND-observable scenarios the feature calls out, driven through the real DesignerApp
// with the chatSessionClient seams injected:
//   - 刷新页面后对话历史按原顺序恢复        → loadChatSession 回的 turns 按原序渲染、可续聊
//   - 恢复的对话能让 Agent 记得之前的上下文 → 续聊时 chat 收到的 messages 含已恢复的 LLM history
//   - 同账号换设备打开同一会话能看到对话    → 新挂载 + loadChatSession 回同一会话 → 同样的历史
//   - 一个回合结束后把对话写入后端          → 回合结束 saveChatTurns 恰好一次,带 turns + history
//   - 流式输出过程中不逐字写库              → onText 流式期间 saveChatTurns 0 次,settle 后才 1 次
//   - 发布表单后会话仍按同一 session id 续上 → 发布前后两次写用同一 sessionId,发布后带 formSlug
//   - 未登录时对话不写入后端 + 401 引导登录  → 未登录 send 不写库;chat 401 → navigate /signin
//   - 未登录刷新后不恢复任何历史            → 未登录挂载不调 loadChatSession,对话区空态
//   - 会话失效时恢复请求引导重新登录        → 挂载 loadChatSession 抛 401 → navigate /signin
//   - 全新会话首次进入时无历史可恢复        → loadChatSession 回 { session: null } → 空态不报错
//
// 这是与 email-verification-banner.spec.jsx 同形的 App 级接线 spec(plain describe/it,不绑
// gherkin):本 feature 跨海拔(多数场景是后端数据层保证),沿用本仓对这类 feature 的约定——
// 后端 plain spec 命名场景 realize、前端 plain spec 命名场景 realize,而非强行单点 describeFeature
// 绑全部场景。每个 it 显式命名它 realize 的 feature 场景。渲染的是真实 @agentaily/design-system
// 组件(ConversationThread / Message / ToolCall)。
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
// /pure → no auto cleanup; we unmount + clear the token store explicitly between cases.
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react/pure";
import App from "../../src/App.jsx";
import { setToken, clearToken, ApiError } from "../../src/core/apiClient";
import { authedCheck } from "../helpers/authGate.js";
import { DESIGN_SESSION_ID_KEY } from "../../src/core/chatSessionClient";
import { DESIGN_PROJECT_ID_KEY } from "../../src/core/projectClient";

// A' 项目↔对话 (§26.10): the App now also consumes project-level seams (loadProject /
// saveProjectWorkspace / listProjects) + renameChatSession. A harness that omits them hits the REAL
// clients → real fetch (undefined in jsdom) → flaky/hung restore. Inject empty-state fakes so the
// project leg of restore resolves deterministically; the §26 conversation half is what these
// scenarios actually assert. Per-test overrides win (spread last).
function withProjectClients(props = {}) {
  return {
    // Entry guard seam: authed by default so the designer mounts. This is the page-level session
    // gate (separate from the designer's own token-store authIsLoggedIn check that the 未登录
    // scenarios exercise — the gate's user does NOT seed the designer). Per-test overrides win.
    checkSession: authedCheck,
    loadProject: vi.fn(async () => ({ project: null })),
    saveProjectWorkspace: vi.fn(async () => ({ projectId: "pj", updatedAt: "t" })),
    listProjects: vi.fn(async () => ({ projects: [] })),
    renameChatSession: vi.fn(async () => ({ renamed: true })),
    listChatSessions: vi.fn(async () => ({ sessions: [] })),
    ...props,
  };
}

// loggedIn 取自 token store (authIsLoggedIn) —— 设计对话持久化是 owner-only (§26.5),持久化/恢复
// 只在登录态发生。种一个 throwaway token 进入登录态,afterEach 清掉。
function asLoggedIn() {
  setToken("test.session.jwt-not-decoded");
}

// 登录态挂载时 DesignerApp 会 refreshMe()(GET /api/auth/me)—— 注入一个已验证的 me,避免真网络
// 调用,也不让未验证 banner 干扰。
const verifiedMe = async () => ({ email: "owner@example.com", emailVerified: true });

// 通过 composer 发一条后续消息(对话区已非空、空态 hint 已消失时用):往 textarea 打字
// (→ onDraftChange → draft state),再点「Send」(send(draft) → controller.enqueue)。
function sendViaComposer(text) {
  const ta = screen.getByPlaceholderText(/描述你想要的表单/);
  fireEvent.change(ta, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

// 一个最简单的「单 LLM 调用就 settle」的回合:流式吐 text、无 tool 调用 → §4 loop 立刻停。
// onTick 在每个 onText 片段时回调(给「流式期间不写库」断言用)。
function makeStreamingChat(text, onTick) {
  return vi.fn(async ({ onText }) => {
    for (const ch of text) {
      onText?.(ch);
      onTick?.();
    }
    return { text, toolCalls: [] };
  });
}

afterEach(() => {
  cleanup();
  clearToken();
  try {
    localStorage.removeItem(DESIGN_SESSION_ID_KEY);
    localStorage.removeItem(DESIGN_PROJECT_ID_KEY);
  } catch {
    /* ignore */
  }
});

describe("设计对话持久化 + 刷新恢复 (features/chat-session-persistence.feature, §26 frontend)", () => {
  // —— 恢复:登录态重载 → 历史按原顺序恢复,可继续往下聊 ——————————————————————

  it("Scenario: 刷新页面后对话历史按原顺序恢复", async () => {
    // Given owner 已登录且有一段已持久化的设计对话 —— loadChatSession 回两条按序的 turns。
    asLoggedIn();
    const RESTORED = {
      sessionId: "ds-restored",
      turns: [
        { id: "r1", role: "user", text: "做一个客户回访表-第一条" },
        { id: "r2", role: "assistant", kind: "text", text: "好的,已经开始-第二条" },
      ],
      history: [
        { role: "system", content: "你是设计助手" },
        { role: "user", content: "做一个客户回访表-第一条" },
        { role: "assistant", content: "好的,已经开始-第二条" },
      ],
    };
    const loadChatSession = vi.fn(async () => ({ session: RESTORED }));
    const saveChatTurns = vi.fn(async () => ({ sessionId: "ds-restored", updatedAt: "t" }));

    // When owner 重新加载设计器页面(= 一次新的挂载,登录态触发 restore useEffect)。该项目最近会话
    // = ds-restored,故 listProjects 空、listChatSessions 列出它,restore 据此载该对话。
    render(
      <App
        {...withProjectClients({
          chat: makeStreamingChat("继续"),
          getCurrentUser: verifiedMe,
          loadChatSession,
          saveChatTurns,
          listChatSessions: vi.fn(async () => ({
            sessions: [
              {
                sessionId: "ds-restored",
                title: "客户回访",
                turnCount: 1,
                formSlug: null,
                updatedAt: "2026-06-13T10:00:00.000Z",
              },
            ],
          })),
        })}
      />,
    );

    // Then 之前的对话回合按原始顺序重新出现在对话区。
    await waitFor(() => expect(loadChatSession).toHaveBeenCalled());
    const first = await screen.findByText("做一个客户回访表-第一条");
    const second = await screen.findByText("好的,已经开始-第二条");
    // 「按原顺序」: r1(user)在 r2(assistant)之前 —— 用 DOM 文档序判定。
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // And owner 可以接着这段对话继续发送消息 —— 对话区已非空(空态 hint 消失),走 composer 发出,
    // 回合跑完后落库。
    sendViaComposer("接着上面继续改");
    await waitFor(() => expect(saveChatTurns).toHaveBeenCalled());
  });

  it("Scenario: 恢复的对话能让 Agent 记得之前的上下文", async () => {
    // Given owner 刷新后看到恢复的对话历史(含一段先前的 LLM history)。
    asLoggedIn();
    const PRIOR = "先前上下文-表单要收集邮箱-CONTEXT";
    const loadChatSession = vi.fn(async () => ({
      session: {
        sessionId: "ds-ctx",
        turns: [{ id: "p1", role: "user", text: PRIOR }],
        history: [
          { role: "system", content: "你是设计助手" },
          { role: "user", content: PRIOR },
        ],
      },
    }));
    const chat = makeStreamingChat("收到");
    render(
      <App
        {...withProjectClients({
          chat,
          getCurrentUser: verifiedMe,
          loadChatSession,
          saveChatTurns: vi.fn(async () => ({ sessionId: "ds-ctx", updatedAt: "t" })),
          listChatSessions: vi.fn(async () => ({
            sessions: [
              {
                sessionId: "ds-ctx",
                title: PRIOR,
                turnCount: 1,
                formSlug: null,
                updatedAt: "2026-06-13T10:00:00.000Z",
              },
            ],
          })),
        })}
      />,
    );
    // 等历史恢复完成(historyRef 已被重新 seed)。
    await screen.findByText(PRIOR);

    // When owner 发送一条依赖先前上下文的后续消息(对话区已非空,走 composer)。
    sendViaComposer("基于刚才说的再加一个字段");

    // Then Agent 在带着已恢复的历史的前提下继续这一回合 —— chat 收到的 messages 含先前 history。
    await waitFor(() => expect(chat).toHaveBeenCalled());
    const sentMessages = chat.mock.calls[0][0].messages;
    expect(sentMessages.some((m) => m.content === PRIOR)).toBe(true);
  });

  it("Scenario: 同账号换设备打开同一会话能看到对话", async () => {
    // B 设备 = 同账号在另一处全新挂载;loadChatSession 按同一 session id 回 A 设备存的对话,
    // B 设备就按原顺序显示相同历史。(跨账号真正隔离由 worker 层 isolation 测试保证。)
    asLoggedIn();
    const A_DEVICE_SESSION = {
      sessionId: "ds-shared",
      turns: [
        { id: "a1", role: "user", text: "A 设备上写的-报名表" },
        { id: "a2", role: "assistant", kind: "text", text: "A 设备上 Agent 的回复" },
      ],
      history: [{ role: "system", content: "你是设计助手" }],
    };
    const loadChatSession = vi.fn(async () => ({ session: A_DEVICE_SESSION }));
    render(
      <App
        {...withProjectClients({
          chat: makeStreamingChat("继续"),
          getCurrentUser: verifiedMe,
          loadChatSession,
          saveChatTurns: vi.fn(async () => ({ sessionId: "ds-shared", updatedAt: "t" })),
          listChatSessions: vi.fn(async () => ({
            sessions: [
              {
                sessionId: "ds-shared",
                title: "报名表",
                turnCount: 1,
                formSlug: null,
                updatedAt: "2026-06-13T10:00:00.000Z",
              },
            ],
          })),
        })}
      />,
    );
    await waitFor(() => expect(loadChatSession).toHaveBeenCalled());
    expect(await screen.findByText("A 设备上写的-报名表")).toBeInTheDocument();
    expect(screen.getByText("A 设备上 Agent 的回复")).toBeInTheDocument();
  });

  // —— 持久化:回合结束批量写入(不是每 token)———————————————————————————

  it("Scenario: 一个回合结束后把对话写入后端", async () => {
    // Given owner 已登录、有稳定的 design session id;无历史可恢复。
    asLoggedIn();
    const loadChatSession = vi.fn(async () => ({ session: null }));
    const saveChatTurns = vi.fn(async () => ({ sessionId: "x", updatedAt: "t" }));
    render(
      <App
        {...withProjectClients({
          chat: makeStreamingChat("搭好了"),
          getCurrentUser: verifiedMe,
          loadChatSession,
          saveChatTurns,
        })}
      />,
    );
    await waitFor(() => expect(loadChatSession).toHaveBeenCalled());

    // When owner 发送一条消息并且 Agent 完成这一个回合。
    fireEvent.click(screen.getByText("做一个线下活动报名表"));

    // Then 这一回合随该 session id 写入后端,且为回合结束一次性批量(恰好一次),带 turns + history。
    // A' (§26.10): the conversation write is now keyed (projectId, sessionId, input) — the batch
    // snapshot lives in the 3rd arg (the workspace goes to saveProjectWorkspace, a separate write).
    await waitFor(() => expect(saveChatTurns).toHaveBeenCalledTimes(1));
    const [, , input] = saveChatTurns.mock.calls[0];
    expect(Array.isArray(input.turns)).toBe(true);
    expect(input.turns.length).toBeGreaterThan(0);
    expect(Array.isArray(input.history)).toBe(true);
    // 持久化的 turns 是 serializable 投影 —— 不带 transient streaming 标记(§26.6)。
    expect(input.turns.every((t) => !("streaming" in t))).toBe(true);
  });

  it("Scenario: 流式输出过程中不逐字写库", async () => {
    // Given owner 已登录。
    asLoggedIn();
    const saveChatTurns = vi.fn(async () => ({ sessionId: "x", updatedAt: "t" }));
    // 记录每个流式片段那一刻 saveChatTurns 已被调用的次数 —— 流式期间应恒为 0。
    const savesSeenDuringStream = [];
    const chat = makeStreamingChat("一字一字地流式输出这段较长的助手回复", () =>
      savesSeenDuringStream.push(saveChatTurns.mock.calls.length),
    );
    render(
      <App
        {...withProjectClients({
          chat,
          getCurrentUser: verifiedMe,
          loadChatSession: vi.fn(async () => ({ session: null })),
          saveChatTurns,
        })}
      />,
    );

    // When 助手的回复正在逐字流式输出。(等设计器越过入口守卫挂载后再点 starter hint。)
    fireEvent.click(await screen.findByText("做一个线下活动报名表"));
    await waitFor(() => expect(saveChatTurns).toHaveBeenCalledTimes(1));

    // Then 流式过程中不向后端发起逐 token 的写入请求(每个片段时刻都还是 0 次),
    // 写入只在回合结束发生一次。
    expect(savesSeenDuringStream.length).toBeGreaterThan(1); // 确有多个流式片段
    expect(savesSeenDuringStream.every((n) => n === 0)).toBe(true);
    expect(saveChatTurns).toHaveBeenCalledTimes(1);
  });

  it("Scenario: 发布表单后会话仍按同一 session id 续上", async () => {
    // Given owner 已登录且有一段进行中的设计对话(先搭出一个有字段的表单,发布按钮才可点)。
    asLoggedIn();
    const saveChatTurns = vi.fn(async () => ({ sessionId: "x", updatedAt: "t" }));
    const publishForm = vi.fn(async () => ({ slug: "f8Kq2pXa" }));
    // 搭表单的回合:turn1 加字段(tool calls),turn2 收尾(prose,无 tool → 停)。
    let call = 0;
    const chat = vi.fn(async ({ onText }) => {
      call += 1;
      if (call === 1) {
        return {
          text: "",
          toolCalls: [
            {
              id: "f0",
              name: "add_field",
              argsRaw: JSON.stringify({ type: "text", label: "姓名" }),
            },
          ],
        };
      }
      onText?.("搭好了");
      return { text: "搭好了", toolCalls: [] };
    });
    const saveProjectWorkspace = vi.fn(async () => ({ projectId: "pj", updatedAt: "t" }));
    render(
      <App
        {...withProjectClients({
          chat,
          getCurrentUser: verifiedMe,
          loadChatSession: vi.fn(async () => ({ session: null })),
          saveChatTurns,
          saveProjectWorkspace,
          publishForm,
          publicFormUrl: (slug) => `/f/${slug}`,
        })}
      />,
    );

    // When owner 发布这份表单(先搭出字段使「发布」可点)。(等设计器越过入口守卫挂载后再点。)
    fireEvent.click(await screen.findByText("做一个线下活动报名表"));
    await waitFor(() => expect(saveChatTurns).toHaveBeenCalledTimes(1));
    const publishBtn = screen.getByRole("button", { name: "发布" });
    await waitFor(() => expect(publishBtn).toBeEnabled());
    fireEvent.click(publishBtn);
    await waitFor(() => expect(publishForm).toHaveBeenCalled());

    // Then 对话仍按同一个 design session id 恢复(发布前后两次写用同一 (projectId, sessionId)),
    // And 该项目被关联到刚发布表单的 slug。A' (§4.1):发布把 slug 软关联到 PROJECT 行(saveProjectWorkspace
    // 带 formSlug),会话写同样带上 formSlug 以便 cross-ref;两者的 (projectId, sessionId) 都不随发布改变。
    await waitFor(() => expect(saveChatTurns.mock.calls.length).toBeGreaterThanOrEqual(2));
    const [turnEndProjectId, turnEndSessionId] = saveChatTurns.mock.calls[0];
    const publishSave = saveChatTurns.mock.calls.find(
      ([, , input]) => input.formSlug === "f8Kq2pXa",
    );
    expect(publishSave).toBeTruthy();
    expect(publishSave[0]).toBe(turnEndProjectId); // project id 不随发布改变
    expect(publishSave[1]).toBe(turnEndSessionId); // session id 不随发布改变
    // 发布把 slug 软关联到 PROJECT 行(A' §4.1 的核心落点)。
    await waitFor(() =>
      expect(
        saveProjectWorkspace.mock.calls.some(([, input]) => input.formSlug === "f8Kq2pXa"),
      ).toBe(true),
    );
  });

  // —— 未登录态:不持久化 + 401 引导登录(明确定义,无未定义态)————————————

  it("Scenario: 未登录时对话不写入后端", async () => {
    // Given owner 未登录(不种 token)。chat seam 在未登录态会被后端 401 拒绝。
    const navigate = vi.fn();
    const loadChatSession = vi.fn(async () => ({ session: null }));
    const saveChatTurns = vi.fn(async () => ({ sessionId: "x", updatedAt: "t" }));
    const chat = vi.fn(async () => {
      throw new ApiError(401, "未授权");
    });
    render(
      <App
        {...withProjectClients({
          chat,
          loadChatSession,
          saveChatTurns,
          navigate,
        })}
      />,
    );

    // When owner 在设计器里输入并发送一条消息。(等设计器越过入口守卫挂载后再点。)
    fireEvent.click(await screen.findByText("做一个线下活动报名表"));

    // Then 发送对话设计请求返回 401 → 提示需要先登录并引导去登录页(/signin)。
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(navigate.mock.calls[0][0]).toMatch(/^\/signin\?/);
    // And 不向后端发起任何会话持久化写入(未登录不持久化,§26.5)。
    expect(saveChatTurns).not.toHaveBeenCalled();
  });

  it("Scenario: 未登录刷新后不恢复任何历史", async () => {
    // Given owner 未登录。
    const loadChatSession = vi.fn(async () => ({
      session: { sessionId: "x", turns: [], history: [] },
    }));
    const loadProject = vi.fn(async () => ({ project: null }));
    render(
      <App
        {...withProjectClients({
          chat: makeStreamingChat("x"),
          loadChatSession,
          saveChatTurns: vi.fn(),
          loadProject,
        })}
      />,
    );

    // When owner 加载设计器页面。
    // Then 不向后端发起任何会话恢复请求,对话区为初始空态。
    await screen.findByText("描述你想要的表单");
    // 给 restore useEffect 充分机会(若它会错误触发的话)。
    await waitFor(() => expect(screen.getByText("描述你想要的表单")).toBeInTheDocument());
    // 未登录不恢复:既不拉对话,也不拉项目工作区(§26.5)。
    expect(loadChatSession).not.toHaveBeenCalled();
    expect(loadProject).not.toHaveBeenCalled();
  });

  // —— 鉴权门控 / 失效 ——————————————————————————————————————————————————

  it("Scenario: 会话失效时恢复请求引导重新登录", async () => {
    // Given owner 的登录态已过期 —— 仍有 token(loggedIn 为真)但恢复请求被后端 401。
    asLoggedIn();
    const navigate = vi.fn();
    const loadChatSession = vi.fn(async () => {
      throw new ApiError(401, "未授权");
    });
    render(
      <App
        {...withProjectClients({
          chat: makeStreamingChat("x"),
          getCurrentUser: verifiedMe,
          loadChatSession,
          saveChatTurns: vi.fn(),
          navigate,
        })}
      />,
    );

    // When 设计器按 session id 拉取会话历史并返回 401。
    await waitFor(() => expect(loadChatSession).toHaveBeenCalled());

    // Then 提示需要先登录并引导去登录页 —— 且不把裸「未授权」泄露到界面。
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(navigate.mock.calls[0][0]).toMatch(/^\/signin\?/);
    expect(screen.queryByText(/未授权/)).not.toBeInTheDocument();
  });

  // —— 首次进入 / 无历史:空态不报错 ————————————————————————————————————

  it("Scenario: 全新会话首次进入时无历史可恢复", async () => {
    // Given owner 已登录且该 session id 从未持久化过对话 —— 后端回 { session: null }。
    asLoggedIn();
    const loadChatSession = vi.fn(async () => ({ session: null }));
    render(
      <App
        {...withProjectClients({
          chat: makeStreamingChat("x"),
          getCurrentUser: verifiedMe,
          loadChatSession,
          saveChatTurns: vi.fn(),
        })}
      />,
    );

    // When 设计器按 session id 拉取会话历史。
    await waitFor(() => expect(loadChatSession).toHaveBeenCalled());

    // Then 后端返回「没有该会话」的空结果 → 对话区显示为初始空态且不报错。
    expect(await screen.findByText("描述你想要的表单")).toBeInTheDocument();
  });

  // —— 回归守卫:restore 必须在 StrictMode 双触发下仍恰好生效一次 ————————————

  it("Scenario: 刷新恢复在 StrictMode 双触发下不被吞掉(回归守卫)", async () => {
    // 本仓 src/main.jsx 用 <React.StrictMode> 包裹 <App/>,所以 dev / e2e(dev server)下挂载
    // effect 会双触发。restore 必须 StrictMode-safe:restoredRef 仅在「异步成功且未 cancel 应用」
    // 后才置位 —— 否则第一次(被 cleanup 标 cancelled 的)run 吃掉守卫、第二次 early-return,
    // 结果 setMessages 永不执行,恢复整个失效。其余用例渲染裸 <App/> 不会双触发、抓不到这个回归;
    // 这条把 <App/> 包进 StrictMode,在 jsdom(React dev → 双触发)下钉住「恢复恰好生效一次」。
    asLoggedIn();
    const loadChatSession = vi.fn(async () => ({
      session: {
        sessionId: "ds-strict",
        turns: [{ id: "s1", role: "user", text: "StrictMode 下也要恢复-唯一标记" }],
        history: [{ role: "system", content: "你是设计助手" }],
      },
    }));
    render(
      <React.StrictMode>
        <App
          {...withProjectClients({
            chat: makeStreamingChat("x"),
            getCurrentUser: verifiedMe,
            loadChatSession,
            saveChatTurns: vi.fn(async () => ({ sessionId: "ds-strict", updatedAt: "t" })),
            listChatSessions: vi.fn(async () => ({
              sessions: [
                {
                  sessionId: "ds-strict",
                  title: "strict",
                  turnCount: 1,
                  formSlug: null,
                  updatedAt: "2026-06-13T10:00:00.000Z",
                },
              ],
            })),
          })}
        />
      </React.StrictMode>,
    );
    await waitFor(() => expect(loadChatSession).toHaveBeenCalled());
    // 恢复的回合出现(若回归则永不出现 → findAllByText 超时失败),且不因双触发而重复渲染。
    const hits = await screen.findAllByText("StrictMode 下也要恢复-唯一标记");
    expect(hits).toHaveLength(1);
  });
});
