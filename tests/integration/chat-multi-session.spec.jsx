// App-level frontend realization of features/chat-multi-session.feature (§26.9 列表/新建/
// 切换/删除 + §13.6 对话级模型芯片), driven through the real DesignerApp with the
// chatSessionClient seams injected (listChatSessions / deleteChatSession / loadChatSession /
// saveChatTurns) and the real @agentaily/design-system surfaces rendered:
//   - SessionMenu 列出会话                 → listChatSessions 回的会话出现在头部菜单
//   - 新会话清空工作区 + 开新 session        → onNewChat 清空对话区、后续写入新的 design session id
//   - 切换载回该会话的转写                   → onSelect → loadChatSession(id) → 历史按原序出现
//   - 悬停删除一段会话                       → onDelete → deleteChatSession(id) → 列表刷新
//   - 对话级选模型后请求带上 per-request model → 选型号 → 发送 → chat 收到 model 参数
//
// 同形于 chat-session-persistence.spec.jsx(plain describe/it,每个 it 命名它 realize 的场景)。
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react/pure";
import App from "../../src/App.jsx";
import { setToken, clearToken } from "../../src/core/apiClient";
import { DESIGN_SESSION_ID_KEY } from "../../src/core/chatSessionClient";
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

const SESSIONS = [
  {
    sessionId: "ds-active",
    title: "活动报名表单",
    turnCount: 18,
    formSlug: null,
    updatedAt: "2026-06-13T10:00:00.000Z",
  },
  {
    sessionId: "ds-other",
    title: "客户满意度问卷",
    turnCount: 12,
    formSlug: null,
    updatedAt: "2026-06-13T08:00:00.000Z",
  },
];

afterEach(() => {
  cleanup();
  clearToken();
  try {
    localStorage.removeItem(DESIGN_SESSION_ID_KEY);
    localStorage.removeItem(MODEL_KEY);
  } catch {
    /* ignore */
  }
});

function openSessionMenu() {
  fireEvent.click(screen.getByRole("button", { name: "会话" }));
}

describe("多会话管理 + 对话级模型 (features/chat-multi-session.feature, §26.9/§13.6 frontend)", () => {
  it("Scenario: owner 列出自己的全部会话(SessionMenu 列出会话)", async () => {
    asLoggedIn();
    const listChatSessions = vi.fn(async () => ({ sessions: SESSIONS }));
    render(
      <App
        chat={makeStreamingChat("ok")}
        getCurrentUser={verifiedMe}
        loadChatSession={vi.fn(async () => ({ session: null }))}
        saveChatTurns={vi.fn(async () => ({ sessionId: "x", updatedAt: "t" }))}
        listChatSessions={listChatSessions}
        deleteChatSession={vi.fn(async () => ({ deleted: true }))}
      />,
    );
    // App loads the list on mount (logged in).
    await waitFor(() => expect(listChatSessions).toHaveBeenCalled());
    openSessionMenu();
    expect(await screen.findByText("活动报名表单")).toBeInTheDocument();
    expect(screen.getByText("客户满意度问卷")).toBeInTheDocument();
  });

  it("Scenario: 新建会话清空当前对话工作区并开新 session", async () => {
    asLoggedIn();
    const listChatSessions = vi.fn(async () => ({ sessions: SESSIONS }));
    render(
      <App
        chat={makeStreamingChat("好的")}
        getCurrentUser={verifiedMe}
        loadChatSession={vi.fn(async () => ({ session: null }))}
        saveChatTurns={vi.fn(async () => ({ sessionId: "x", updatedAt: "t" }))}
        listChatSessions={listChatSessions}
        deleteChatSession={vi.fn(async () => ({ deleted: true }))}
      />,
    );
    await waitFor(() => expect(listChatSessions).toHaveBeenCalled());

    // 先发一条让对话区非空(空态 hint 消失)。
    fireEvent.click(screen.getByText("做一个线下活动报名表"));
    await waitFor(() => expect(screen.queryByText("描述你想要的表单")).not.toBeInTheDocument());

    // When owner 新建一段会话。
    openSessionMenu();
    fireEvent.click(screen.getByText("新会话"));

    // Then 对话工作区被清空回初始空态 + 列表刷新一次。
    expect(await screen.findByText("描述你想要的表单")).toBeInTheDocument();
    await waitFor(() => expect(listChatSessions.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("Scenario: 切换到另一段会话载回该会话的转写", async () => {
    asLoggedIn();
    const listChatSessions = vi.fn(async () => ({ sessions: SESSIONS }));
    // 挂载恢复回空;切换到 ds-other 时 loadChatSession 回那段历史。
    const OTHER = {
      sessionId: "ds-other",
      turns: [
        { id: "o1", role: "user", text: "切换载回的历史-唯一标记" },
        { id: "o2", role: "assistant", kind: "text", text: "另一段会话的回复" },
      ],
      history: [{ role: "system", content: "你是设计助手" }],
    };
    const loadChatSession = vi.fn(async (id) =>
      id === "ds-other" ? { session: OTHER } : { session: null },
    );
    render(
      <App
        chat={makeStreamingChat("ok")}
        getCurrentUser={verifiedMe}
        loadChatSession={loadChatSession}
        saveChatTurns={vi.fn(async () => ({ sessionId: "x", updatedAt: "t" }))}
        listChatSessions={listChatSessions}
        deleteChatSession={vi.fn(async () => ({ deleted: true }))}
      />,
    );
    await waitFor(() => expect(listChatSessions).toHaveBeenCalled());

    // When owner 切换到那段会话。
    openSessionMenu();
    fireEvent.click(screen.getByText("客户满意度问卷"));

    // Then 该会话的对话历史按原顺序重新出现在对话区。
    await waitFor(() => expect(loadChatSession).toHaveBeenCalledWith("ds-other"));
    expect(await screen.findByText("切换载回的历史-唯一标记")).toBeInTheDocument();
    expect(screen.getByText("另一段会话的回复")).toBeInTheDocument();
  });

  it("Scenario: 悬停删除一段会话", async () => {
    asLoggedIn();
    const listChatSessions = vi.fn(async () => ({ sessions: SESSIONS }));
    const deleteChatSession = vi.fn(async () => ({ deleted: true }));
    render(
      <App
        chat={makeStreamingChat("ok")}
        getCurrentUser={verifiedMe}
        loadChatSession={vi.fn(async () => ({ session: null }))}
        saveChatTurns={vi.fn(async () => ({ sessionId: "x", updatedAt: "t" }))}
        listChatSessions={listChatSessions}
        deleteChatSession={deleteChatSession}
      />,
    );
    await waitFor(() => expect(listChatSessions).toHaveBeenCalled());
    openSessionMenu();

    // 删除一段非当前会话:非当前项才有删除按钮(当前项打勾)。取第一个有删除按钮的行,
    // 删它(避免依赖哪段恰好是当前活跃会话——模块级 mirror 跨用例会变)。
    await screen.findByText("客户满意度问卷");
    const delBtn = screen.getAllByRole("button", { name: "删除会话" })[0];
    const row = delBtn.closest("[data-session-id]");
    const id = row.getAttribute("data-session-id");
    fireEvent.click(delBtn);

    await waitFor(() => expect(deleteChatSession).toHaveBeenCalledWith(id));
    // 删除后列表刷新。
    await waitFor(() => expect(listChatSessions.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("Scenario Outline: 对话级选用模型后请求带上该 per-request 模型 (DeepSeek-V4-Pro)", async () => {
    asLoggedIn();
    const chat = makeStreamingChat("收到");
    render(
      <App
        chat={chat}
        getCurrentUser={verifiedMe}
        loadChatSession={vi.fn(async () => ({ session: null }))}
        saveChatTurns={vi.fn(async () => ({ sessionId: "x", updatedAt: "t" }))}
        listChatSessions={vi.fn(async () => ({ sessions: [] }))}
        deleteChatSession={vi.fn(async () => ({ deleted: true }))}
      />,
    );

    // When owner 为当前对话选用模型 "DeepSeek-V4-Pro":点 composer 的模型芯片 → 弹层 → 选 V4-Pro。
    const chip = document.querySelector(".ax-composer__model");
    expect(chip).toBeTruthy();
    fireEvent.click(chip);
    fireEvent.click(await screen.findByText("DeepSeek-V4-Pro"));

    // And owner 在该对话里发送一条消息。
    fireEvent.click(screen.getByText("做一个线下活动报名表"));

    // Then 发往对话代理的请求带上 model 参数 = V4-Pro 的小写 API id（显示名是 DeepSeek-V4-Pro，
    // 但发上游的 wire 值是 deepseek-v4-pro —— 选的是 label，发的是 value）。
    await waitFor(() => expect(chat).toHaveBeenCalled());
    expect(chat.mock.calls[0][0].model).toBe("deepseek-v4-pro");
  });

  it("Scenario: 未显式切换型号时对话仍带上默认型号 V4-Flash(默认显示在芯片上)", async () => {
    asLoggedIn();
    const chat = makeStreamingChat("收到");
    render(
      <App
        chat={chat}
        getCurrentUser={verifiedMe}
        loadChatSession={vi.fn(async () => ({ session: null }))}
        saveChatTurns={vi.fn(async () => ({ sessionId: "x", updatedAt: "t" }))}
        listChatSessions={vi.fn(async () => ({ sessions: [] }))}
        deleteChatSession={vi.fn(async () => ({ deleted: true }))}
      />,
    );
    // 默认芯片显示 V4-Flash 的 pill(DS 在头部 + composer 两处都渲染 model,故用 getAllByText)。
    expect(screen.getAllByText(/DeepSeek · V4-Flash/).length).toBeGreaterThan(0);
    // 具体地,composer 内部模型芯片(.ax-composer__model)文本含默认 pill。
    expect(document.querySelector(".ax-composer__model").textContent).toMatch(
      /DeepSeek · V4-Flash/,
    );

    // 直接发送(不开模型菜单)。
    fireEvent.click(screen.getByText("做一个线下活动报名表"));
    await waitFor(() => expect(chat).toHaveBeenCalled());
    // 默认仍选中 V4-Flash → 仍带 model(per-request 显式发送默认值是允许的,白名单兜底)。
    // 关键断言:发送时 model 是当前芯片选中默认值的小写 wire id,不是 undefined/未知/驼峰显示名。
    expect(chat.mock.calls[0][0].model).toBe("deepseek-v4-flash");
  });
});
