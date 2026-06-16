// auth-gate.jsx — 页面级「未登录守卫」(AuthGate),设计源 _QB7NM8v(单页 SPA + 守卫)。
//
// 契约:进入受保护页(设计器)前,先跑一次真实会话校验(GET /api/auth/me,经 core/auth
// 的 {@link validateSession});只有「已登录有效」才【实例化】受保护内容(render-prop 只在
// authed 时调用),所以未授权用户永远拿不到设计器的任何可见帧或可点控件 —— 零闪烁。
//
// 四态路由(与设计稿 + SPEC §17/§23.6 对齐):
//   • checking → 中性品牌占位(只在校验超过 200ms 阈值才显现;极快校验直接落地,不闪 loading)
//   • authed   → children(user):挂载设计器,user.emailVerified 驱动设计器内的软提醒条(不硬墙)
//   • unauthed → renderSignIn(onSignedIn):原地整屏登录视图(不跳转白屏);登录成功回调即原地重校验
//   • error    → 中性「重试 / 去登录」占位(5xx / 网络异常 → 不是登录视图:离线的 owner 不是「未登录」)
//
// 纯前端单层守卫:占位 → 路由,绝不引 design-kit / 不 mock —— 生产跑真 Cloudflare Worker。
// 全部 chrome 取自 @agentaily/design-system(BrandMark / Button),不手搓;.ag-* 布局样式在 app.css。
import React, { useState, useEffect, useRef, useCallback } from "react";
import { BrandMark, Button } from "@agentaily/design-system";
import { validateSession as defaultValidateSession } from "./core/auth";
import { L } from "./core/i18n";

// 占位态延迟阈值:校验超过它(毫秒)才显现品牌占位;更快的校验直接落到目的视图,不闪 loading。
const LOADER_DELAY = 200;

// ── 校验中:中性品牌占位态(绝不渲染受保护内容)──────────────────────────────
// agentaily 标记(闪烁块光标)+ 发丝扫描条 + mono「正在验证登录状态」。
function GuardLoader() {
  return (
    <div
      className="ag-gate"
      role="status"
      aria-live="polite"
      aria-label={L("正在验证登录状态", "Verifying session")}
    >
      <div className="ag-loader">
        <div className="ag-mark">
          <BrandMark size={26} wordmark cursor blink />
        </div>
        <div className="ag-bar">
          <span className="ag-bar__run" />
        </div>
        <div className="ag-status">
          <span className="ag-status__dot" />
          {L("正在验证登录状态", "Verifying session")}
        </div>
      </div>
    </div>
  );
}

// ── 校验出错:中性「重试 / 去登录」占位(仍不渲染受保护内容)─────────────────
function GuardError({ onRetry, onSignIn }) {
  return (
    <div className="ag-gate" role="alert">
      <div className="ag-loader is-error">
        <div className="ag-mark">
          <BrandMark size={26} wordmark cursor={false} />
        </div>
        <div className="ag-errhead">{L("无法验证登录状态", "Can't verify session")}</div>
        <p className="ag-errsub">
          {L(
            "连接登录校验服务超时。请重试,或前往登录页。",
            "Timed out reaching the session service. Retry, or go to sign in.",
          )}
        </p>
        <div className="ag-erractions">
          <Button variant="primary" size="sm" onClick={onRetry}>
            {L("重试", "Retry")}
          </Button>
          <Button variant="secondary" size="sm" onClick={onSignIn}>
            {L("去登录", "Sign in")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * 页面级入口守卫。在挂载受保护内容前先校验会话,据结果路由(见文件头契约)。
 *
 * @param {object} props
 * @param {() => Promise<import("./core/auth").SessionState>} [props.check]
 *   会话校验 seam,默认 core/auth 的 {@link validateSession}(真 GET /api/auth/me)。可注入,
 *   令外环/单测确定性驱动「已登录 / 未登录 / 校验异常」三条路径,无需 mock 网络层。
 * @param {(onSignedIn: () => void) => React.ReactNode} props.renderSignIn
 *   渲染原地登录视图;入参 `onSignedIn` 在登录成功后调用 → 守卫原地重校验(无跳转白屏)。
 * @param {(user: import("./core/auth").CurrentUser) => React.ReactNode} props.children
 *   受保护内容的 render-prop,【仅在 authed 时调用】(零闪烁)。入参是校验拿到的 owner 快照。
 */
export function AuthGate({ check = defaultValidateSession, renderSignIn, children }) {
  const [phase, setPhase] = useState("checking"); // checking | authed | denied | error
  const [user, setUser] = useState(null);
  const [showLoader, setShowLoader] = useState(false); // 延迟阈值前不显现占位态
  const [tick, setTick] = useState(0); // 重试 / 登录后重校验计数

  // Always-current mirror of `check` so a caller passing an inline fn each render doesn't
  // re-fire the effect on every render (we only re-run on an explicit revalidate tick).
  const checkRef = useRef(check);
  checkRef.current = check;

  useEffect(() => {
    let alive = true;
    setPhase("checking");
    setShowLoader(false);
    const delay = setTimeout(() => {
      if (alive) setShowLoader(true);
    }, LOADER_DELAY);
    Promise.resolve()
      .then(() => checkRef.current())
      .then((r) => {
        if (!alive) return;
        clearTimeout(delay);
        if (r && r.status === "authed") {
          setUser(r.user);
          setPhase("authed"); // 落地后端 user → 实例化受保护内容
        } else if (r && r.status === "error") {
          setPhase("error");
        } else {
          setPhase("denied"); // unauthed(401 / 无 token)→ 登录视图
        }
      })
      .catch(() => {
        if (!alive) return;
        clearTimeout(delay);
        setPhase("error"); // 校验本身抛错(不该发生,validateSession 已 fail-soft)→ 重试占位
      });
    return () => {
      alive = false;
      clearTimeout(delay);
    };
  }, [tick]);

  // 原地重校验(重试 / 登录成功 / 场景变化)——重跑 check,不刷新整页。
  const revalidate = useCallback(() => setTick((t) => t + 1), []);

  if (phase === "authed") return children(user);
  if (phase === "denied") return renderSignIn ? renderSignIn(revalidate) : null;
  if (phase === "error") {
    return <GuardError onRetry={revalidate} onSignIn={() => setPhase("denied")} />;
  }
  // 校验中:延迟阈值前给中性底色(绝不闪受保护内容),超过阈值才显现品牌占位。
  return showLoader ? <GuardLoader /> : <div className="ag-gate" aria-hidden="true" />;
}
