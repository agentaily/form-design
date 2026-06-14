// Component-level realization of the SessionMenu (会话菜单) — the 「新会话 + 最近会话列表」
// dropdown injected into ConversationThread's `actions` slot (SPEC §26.9, PR #65). Realizes
// the UI slice of features/chat-multi-session.feature 列表/新建/切换/删除 at the component
// altitude (the App-level wiring lives in chat-multi-session.spec.jsx; chat-session-persistence
// .spec.jsx covers the single-session restore/save path from #48).
//
// SessionMenu consumes @agentaily/design-system: the trigger is a DS IconButton + Icon
// ("message"); the panel is a DS Popover (click-to-open, closes on outside-click/Escape)
// whose rich rows (标题 / N 轮 · time / 当前打勾 / 悬停删除) are composed at the app layer
// with DS Icon + DS tokens — DropdownMenu's MenuItem can't express the per-row delete side
// action, so a Popover + app-composed list is the right seam (no new DS primitive).
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react/pure";
import { SessionMenu } from "../../src/SessionMenu.jsx";

const SESSIONS = [
  {
    sessionId: "ds-1",
    title: "活动报名表单",
    turnCount: 18,
    formSlug: "f8Kq2pXa",
    updatedAt: "2026-06-13T10:00:00.000Z",
  },
  {
    sessionId: "ds-2",
    title: "客户满意度问卷",
    turnCount: 12,
    formSlug: null,
    updatedAt: "2026-06-13T08:00:00.000Z",
  },
];

afterEach(() => cleanup());

// Open the panel by clicking the trigger IconButton (aria-label "会话").
function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "会话" }));
}

describe("SessionMenu (features/chat-multi-session.feature, §26.9 component)", () => {
  it("Scenario: owner 列出自己的全部会话 — 面板列出每段会话的标题与轮数", () => {
    render(<SessionMenu sessions={SESSIONS} activeId="ds-1" />);
    openMenu();

    // every session's title shows
    expect(screen.getByText("活动报名表单")).toBeInTheDocument();
    expect(screen.getByText("客户满意度问卷")).toBeInTheDocument();
    // turnCount renders as 「N 轮」
    expect(screen.getByText(/18 轮/)).toBeInTheDocument();
    expect(screen.getByText(/12 轮/)).toBeInTheDocument();
  });

  it("Scenario: 当前会话项打勾、非当前项悬停可删除", () => {
    const onDelete = vi.fn();
    render(<SessionMenu sessions={SESSIONS} activeId="ds-1" onDelete={onDelete} />);
    openMenu();

    // the active row (ds-1) carries the check affordance and NO delete button.
    const activeRow = screen.getByText("活动报名表单").closest("[data-session-id]");
    expect(activeRow).toHaveAttribute("data-active", "true");
    expect(within(activeRow).queryByRole("button", { name: "删除会话" })).toBeNull();

    // a non-active row (ds-2) exposes a delete button; clicking it calls onDelete with its id
    // and does NOT bubble into a select.
    const otherRow = screen.getByText("客户满意度问卷").closest("[data-session-id]");
    expect(otherRow).toHaveAttribute("data-active", "false");
    fireEvent.click(within(otherRow).getByRole("button", { name: "删除会话" }));
    expect(onDelete).toHaveBeenCalledWith("ds-2");
  });

  it("Scenario: 新建会话 — 点「新会话」回调 onNewChat", () => {
    const onNewChat = vi.fn();
    render(<SessionMenu sessions={SESSIONS} activeId="ds-1" onNewChat={onNewChat} />);
    openMenu();

    fireEvent.click(screen.getByText("新会话"));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it("Scenario: 切换到另一段会话 — 点会话行回调 onSelect(id)", () => {
    const onSelect = vi.fn();
    render(<SessionMenu sessions={SESSIONS} activeId="ds-1" onSelect={onSelect} />);
    openMenu();

    fireEvent.click(screen.getByText("客户满意度问卷"));
    expect(onSelect).toHaveBeenCalledWith("ds-2");
  });

  it("renders an empty list without crashing (owner 名下暂无会话)", () => {
    render(<SessionMenu sessions={[]} activeId={null} />);
    openMenu();
    // 「新会话」 is always available even with no history.
    expect(screen.getByText("新会话")).toBeInTheDocument();
  });
});
