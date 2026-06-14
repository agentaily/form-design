// Component-level spec for <ShareDialog> (src/share-dialog.jsx) — the 发布 / 分享 浮层
// (N-_ayo8x, 仅链接版, 无二维码). The App-level wiring (发布是直接动作 → publish 模式弹出;
// 分享 = 只读) is realized in form-publish-mgmt.spec.jsx against the real <App>; here we pin
// the presentational component's own contract:
//   • closed → renders nothing.
//   • mode="publish" → celebratory「表单已发布」title + 上线/我的表单 note; "share" → 只读
//     「分享这份表单」title + 只读 note. Both show the public link verbatim.
//   • 复制链接 → writes the link to the clipboard, flips the button to「已复制 ✓」, keeps the
//     dialog OPEN (link still visible), and reverts to「复制链接」after 2s.
//   • clipboard 不可用 → falls back to document.execCommand("copy").
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
// /pure → no auto cleanup (tests/setup.js installs none); unmount explicitly per test.
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react/pure";
import { ShareDialog } from "../../src/share-dialog.jsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ShareDialog (发布 / 分享 浮层, 仅链接版)", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <ShareDialog open={false} mode="publish" url="/f/abc" onClose={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("publish mode: 庆祝式「表单已发布」标题 + 公开链接", () => {
    render(<ShareDialog open mode="publish" url="/f/abc" onClose={vi.fn()} />);
    expect(screen.getByText("表单已发布")).toBeInTheDocument();
    // 上线 + 存入「我的表单」的说明文案。
    expect(screen.getByText(/已上线收集.*我的表单/)).toBeInTheDocument();
    // 公开链接原样展示。
    expect(screen.getByText("/f/abc")).toBeInTheDocument();
  });

  it("share mode: 只读「分享这份表单」标题 + 公开链接", () => {
    render(<ShareDialog open mode="share" url="/f/abc" onClose={vi.fn()} />);
    expect(screen.getByText("分享这份表单")).toBeInTheDocument();
    expect(screen.getByText(/任何拿到链接的人都可以填写/)).toBeInTheDocument();
    expect(screen.getByText("/f/abc")).toBeInTheDocument();
  });

  it("复制链接 → 写入剪贴板 + 「已复制」反馈 + 浮层不关闭 + 2s 复位", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const onClose = vi.fn();
    vi.useFakeTimers();
    render(<ShareDialog open mode="publish" url="/f/abc" onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "复制链接" }));
    // flush copy()'s awaited clipboard write + setCopied(true)
    await act(async () => {});

    // 相对链接被补成可分享的绝对地址再复制(仍含 /f/abc 路径)。
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("/f/abc"));
    // 按钮翻成「已复制」。
    expect(screen.getByRole("button", { name: /已复制/ })).toBeInTheDocument();
    // 复制不关闭浮层:链接仍在、onClose 未被调用。
    expect(screen.getByText("/f/abc")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    // 2s 后复位回「复制链接」。
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole("button", { name: "复制链接" })).toBeInTheDocument();
  });

  it("clipboard 不可用时回退 execCommand", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.assign(navigator, { clipboard: { writeText } });
    const exec = vi.fn().mockReturnValue(true);
    document.execCommand = exec;
    render(<ShareDialog open mode="share" url="/f/xyz" onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "复制链接" }));
    await waitFor(() => expect(exec).toHaveBeenCalledWith("copy"));
    // 回退路径也给出「已复制」反馈。
    expect(screen.getByRole("button", { name: /已复制/ })).toBeInTheDocument();
  });
});
