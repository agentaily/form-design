import React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react/pure";
import { AuthGate } from "../../src/auth-gate.jsx";

// Inner-loop unit specs for the page-level 未登录守卫 (AuthGate). It runs an injectable
// session `check` once on entry and routes on the discriminated result:
//   authed   → call children(user) (protected content — instantiated ONLY when authed → 零闪烁)
//   unauthed → renderSignIn(onSignedIn) (the in-place 登录视图)
//   error    → a neutral 「重试 / 去登录」 placeholder (NOT the login view)
// The 校验中 placeholder only shows once the check exceeds the 200ms delay threshold (a fast
// check lands straight on the destination, never flashing a loader).

const PROTECTED = <div data-testid="protected">设计器内容</div>;
const LOGIN = (onSignedIn) => (
  <button data-testid="login" onClick={() => onSignedIn()}>
    登录视图
  </button>
);

function renderGate(check) {
  return render(
    <AuthGate check={check} renderSignIn={LOGIN}>
      {(user) => <div data-testid="protected">设计器 · {user?.email}</div>}
    </AuthGate>,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AuthGate · 路由", () => {
  it("authed → 实例化受保护内容(带 user)", async () => {
    renderGate(async () => ({
      status: "authed",
      user: { email: "owner@example.com", emailVerified: true, displayName: null },
    }));
    expect(await screen.findByTestId("protected")).toHaveTextContent("owner@example.com");
  });

  it("unauthed → 原地登录视图,且【绝不】实例化受保护内容(零闪烁)", async () => {
    const childSpy = vi.fn(() => PROTECTED);
    render(
      <AuthGate check={async () => ({ status: "unauthed" })} renderSignIn={LOGIN}>
        {childSpy}
      </AuthGate>,
    );
    expect(await screen.findByTestId("login")).toBeInTheDocument();
    expect(screen.queryByTestId("protected")).not.toBeInTheDocument();
    // render-prop for protected content is never even called for an unauthorized user.
    expect(childSpy).not.toHaveBeenCalled();
  });

  it("error → 中性「重试 / 去登录」占位(不是登录视图)", async () => {
    renderGate(async () => ({ status: "error" }));
    expect(await screen.findByText("无法验证登录状态")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "去登录" })).toBeInTheDocument();
    expect(screen.queryByTestId("protected")).not.toBeInTheDocument();
  });

  it("check 抛异常 → error 占位(永不崩溃)", async () => {
    renderGate(async () => {
      throw new Error("boom");
    });
    expect(await screen.findByText("无法验证登录状态")).toBeInTheDocument();
  });
});

describe("AuthGate · 重试 / 重新校验", () => {
  it("error 态点「重试」→ 重跑 check → authed 后挂载设计器", async () => {
    let calls = 0;
    const check = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? { status: "error" }
        : { status: "authed", user: { email: "o@e.com", emailVerified: true, displayName: null } };
    });
    render(
      <AuthGate check={check} renderSignIn={LOGIN}>
        {() => PROTECTED}
      </AuthGate>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByTestId("protected")).toBeInTheDocument();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("登录视图回调 onSignedIn → 重跑 check → 进设计器(原地,无跳转)", async () => {
    let signedIn = false;
    const check = vi.fn(async () =>
      signedIn
        ? { status: "authed", user: { email: "o@e.com", emailVerified: true, displayName: null } }
        : { status: "unauthed" },
    );
    render(
      <AuthGate
        check={check}
        renderSignIn={(onSignedIn) => (
          <button
            data-testid="login"
            onClick={() => {
              signedIn = true;
              onSignedIn();
            }}
          >
            登录
          </button>
        )}
      >
        {() => PROTECTED}
      </AuthGate>,
    );
    fireEvent.click(await screen.findByTestId("login"));
    expect(await screen.findByTestId("protected")).toBeInTheDocument();
  });
});

describe("AuthGate · 延迟显示占位(>200ms 才显现)", () => {
  it("极快校验(立即 resolve)直接落地,不闪「校验中」占位", async () => {
    renderGate(async () => ({
      status: "authed",
      user: { email: "o@e.com", emailVerified: true, displayName: null },
    }));
    // The protected content arrives without the loader ever being shown.
    await screen.findByTestId("protected");
    expect(screen.queryByText("正在验证登录状态")).not.toBeInTheDocument();
  });

  it("校验超过 200ms 阈值才显现品牌占位「正在验证登录状态」", async () => {
    vi.useFakeTimers();
    // a check that never resolves during this test → stays in the checking phase.
    render(
      <AuthGate check={() => new Promise(() => {})} renderSignIn={LOGIN}>
        {() => PROTECTED}
      </AuthGate>,
    );
    // before the threshold: only the neutral background, no branded loader yet.
    expect(screen.queryByText("正在验证登录状态")).not.toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(220);
    });
    expect(screen.getByText("正在验证登录状态")).toBeInTheDocument();
  });
});
