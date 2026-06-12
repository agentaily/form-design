// verify-email.jsx — the 邮箱验证 result landing page (SPEC §23.6). A STANDALONE,
// chrome-less page: App mounts ONLY this when matchVerifyEmail(pathname, search) hits
// /verify-email?status= (see src/core/router.ts + the 路由分流挂载点 note in App.jsx).
//
// This page does NOT call the backend. The backend's confirm endpoint
// (GET /api/auth/verify-email/confirm?token=) is what the user opens from the email;
// it consumes the token, marks the email verified, then 302-redirects HERE with the
// outcome in `?status=` (§23.4). So this page only reads `status` (normalised by the
// router to "ok" | "invalid", fail-closed) and shows the matching two-state result:
//   • status="ok"      → 「邮箱已验证」 + 回设计器 entry
//   • status="invalid" → 「链接已失效」 + 回设计器 entry (re-send lives in the in-app banner)
//
// All chrome from @agentaily/design-system (Empty/Button). No hand-rolled controls.
// `onBackToApp` routes the「回到设计器」action; in production it navigates to "/".

import React from "react";
import { Empty, Button } from "@agentaily/design-system";
import { Icon } from "./chat.jsx";

/**
 * The email-verification result landing page (SPEC §23.6). Mounted by App at
 * /verify-email?status=ok|invalid.
 *
 * @param {object} props
 * @param {"ok" | "invalid"} props.status        the backend-supplied result (router-normalised)
 * @param {() => void} [props.onBackToApp]        route the「回到设计器」action (defaults to navigating to "/")
 */
export function VerifyEmailPage({
  status,
  onBackToApp = () => {
    if (typeof window !== "undefined") window.location.assign("/");
  },
} = {}) {
  const ok = status === "ok";
  return (
    <div className="pf-page">
      <div className="pf-card auth-land">
        <div className="auth-land__state">
          {ok ? (
            <Empty
              icon={<Icon name="check" size={18} />}
              title="邮箱已验证"
              description="你的邮箱已成功验证，这个邮箱现在归你所有。可以回到设计器继续使用。"
            />
          ) : (
            <Empty
              icon={<Icon name="lock" size={18} />}
              title="链接已失效"
              description="这个验证链接无效或已过期。回到设计器后，可在顶部提示条点「重新发送」获取一封新的验证邮件。"
            />
          )}
          <Button
            variant={ok ? "primary" : "secondary"}
            full
            icon={<Icon name="layout" size={14} />}
            onClick={onBackToApp}
          >
            回到设计器
          </Button>
        </div>
        <p className="pf-foot ax-label">Powered by agentaily forms</p>
      </div>
    </div>
  );
}
