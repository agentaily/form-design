// settings.jsx — owner 设置浮层 (SPEC §12 owner 集成配置 + §14 连接测试 + §17 个人资料, frontend).
// Since DS 0.8.0 restructured settings into a FLOATING, ROUTE-REFLECTED OVERLAY with a two-tab
// left nav (账户 / 集成), this module exports <SettingsOverlay>: a SettingsSheet (a floating
// "rises up" page shell built on PanelSheet) that FLOATS OVER the designer — it does NOT unmount
// it. App opens it from the account control and reflects a /settings URL via history (so 关闭后
// 回到进入前的页面状态); see App.jsx. The sheet's left nav switches between two tabs:
//
//   • 账户 (AccountSection): 头像 + 邮箱 + 可编辑「显示名称」 + 退出登录. The display name persists
//     to the REAL profile backend (PUT /api/auth/profile via core/auth.updateProfile), NOT a
//     localStorage stub. Driven by Form.useForm + an explicit SettingsSaveBar footer (§17 个人资料).
//   • 集成: a SELF-COMPOSED 集成 section — DS 0.10.0 removed the all-in-one IntegrationSettings
//     organism AND the vendor-specific FeishuCard (+ its parseFeishuLink helper), so this module
//     now builds the section itself: a <PageSection> (集成 · INTEGRATIONS) + a readiness rail
//     (gating ONLY DeepSeek — 飞书 is optional) + two symmetric connection cards. DeepSeek uses
//     the still-shipped <DeepSeekCard> (now WITHOUT a model <Select>); 飞书 is composed from the
//     generic <ConnectionCard> + <Input>/<SecretField>/<HelpSteps> (see FeishuConnectionCard).
//     This tab still owns its config state / persistence / per-block probe / backend-400 surfacing
//     (§12 + §14), unchanged in behavior.
//
// Each tab owns its own SettingsSaveBar (GitHub model: one bar per tab, explicit 保存).
//
//   集成 mount-of-tab → getConfig() → echo the masked config into card props. A 401 (no/expired
//           owner session, §17) does NOT render as a settings error: it calls onNeedLogin so App
//           routes the owner to /signin. Never-configured → all-null skeleton → empty cards.
//
//   集成 cards → DeepSeek: apiKey (SecretField). The 对话模型 selection was dropped from the card
//           in DS 0.10.0; `model` still round-trips through config (echoed in, sent back) so a
//           re-save never wipes the stored model, but it has no UI here (the conversation-level
//           model chip, if any, is a separate concern). 飞书 (link-less, symmetric to DeepSeek):
//           只配 App ID + App Secret 两个账户级凭证 —— 分享链接 / App Token / 数据表 已从卡片退场
//           (§16.9). 发布表单时由后端「自动建表」per-form 产出多维表格并写进 forms 行，owner 不再
//           手动粘贴链接。Secret fields show a MASKED affordance via `masked`; a secret left blank is
//           OMITTED from the ConfigInput so saveConfig keeps the stored secret (§12.4 "don't
//           re-submit the mask").
//
//   集成 save → saveConfig(input). 200 → "已保存" + re-echo masked view. 400 → surface the backend's
//           ApiError.message verbatim (top-level + matching card field). 401 → onNeedLogin.
//
//   集成 test → PER-CARD (§14, PR #72): each card's 测试连接 probes ONLY its own service with that
//           card's CURRENT input value (dirty → the typed value verify-before-save; an unchanged
//           secret is OMITTED so the backend tests the STORED one — the mask is never sent), via
//           testConnection(service, creds), and updates ONLY that card. "测不通"/"未配置" are normal
//           results (status:"error" + note), NOT request failures — only a 401 / network reject is a
//           failure (401 → onNeedLogin).
//
//   账户 save → updateProfile(displayName). 200 → re-baseline the form (clean) + onProfileSaved so
//           App refreshes the account control. 401 → onNeedLogin. A >64-char name is caught client
//           side by the field's maxLength rule before submit; a backend 400 surfaces on the field.
//
// getConfig / saveConfig / testConnection / updateProfile default to the real seams but are
// injectable so tests inject fakes and stay deterministic (same pattern as auth.jsx).

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  SettingsSheet,
  SettingsSaveBar,
  DeepSeekCard,
  ConnectionCard,
  SecretField,
  HelpSteps,
  PageSection,
  Avatar,
  Field,
  Input,
  Select,
  Button,
  Form,
} from "@agentaily/design-system";
import { Icon } from "./chat.jsx";
import { L, getLocale, setLocale } from "./core/i18n";
import {
  getConfig as defaultGetConfig,
  saveConfig as defaultSaveConfig,
  testConnection as defaultTestConnection,
} from "./core/configClient";
import { updateProfile as defaultUpdateProfile } from "./core/auth";
import { ApiError } from "./core/apiClient";

// 显示名长度上限，与后端 MAX_DISPLAY_NAME_LENGTH 对齐（§17 个人资料）。超出由账户表单的
// maxLength 规则在提交前拦下（后端 400 仅作纵深防御兜底）。
const MAX_DISPLAY_NAME_LENGTH = 64;

// Empty per-card connection status (caller-controlled; the cards render off these).
const IDLE = { status: "idle", result: undefined };

/**
 * AccountSection — the 账户 tab body (SPEC §17 个人资料). 头像 + 身份 + 退出登录, then an editable
 * 显示名称 + a read-only 登录邮箱. Pure presentation, driven by the `form` bag (a Form.useForm
 * return owned by SettingsOverlay) + the explicit SettingsSaveBar footer. Mirrors the design
 * handoff's account.jsx.
 *
 * @param {object} props
 * @param {{ email?: string, displayName?: string|null }} [props.user]  current owner snapshot
 * @param {object} props.form         a Form.useForm() bag (owns the displayName field)
 * @param {() => void} props.onLogout  退出登录
 * @param {boolean} [props.verified]   邮箱验证状态 (§23.6); false → 渲染未验证内联卡 .acct-verify
 * @param {() => void} [props.onResend] 重新发送验证邮件 (接 App 的 resendVerification)
 * @param {number} [props.cooldown]    重新发送冷却剩余秒数 (>0 时按钮禁用并显示「重新发送 · {n}s」)
 * @param {boolean} [props.resending]  正在发送中 (按钮禁用并显示「发送中…」)
 */
function AccountSection({
  user,
  form,
  onLogout,
  verified = true,
  onResend,
  cooldown = 0,
  resending = false,
}) {
  const u = user || {};
  const ident = u.displayName || u.email || L("未登录", "Not signed in");
  // Register the field WITH a maxLength rule so a too-long name is caught before submit
  // (the SettingsSaveBar gates 保存 on validity); the backend 400 is only a fallback.
  const dn = form.field("displayName", {
    maxLength: {
      value: MAX_DISPLAY_NAME_LENGTH,
      message: L(
        `显示名称最多 ${MAX_DISPLAY_NAME_LENGTH} 个字符`,
        `Display name can be at most ${MAX_DISPLAY_NAME_LENGTH} characters`,
      ),
    },
  });
  return (
    <PageSection
      eyebrow={L("账户 · ACCOUNT", "Account · ACCOUNT")}
      title={L("你的账户", "Your account")}
      description={L(
        "管理你的登录身份与个人偏好。这些设置只对你自己可见。",
        "Manage your sign-in identity and personal preferences. These settings are visible only to you.",
      )}
    >
      <div className="acct-id">
        <Avatar name={ident} size="lg" />
        <div className="acct-id__txt">
          <div className="acct-id__name">{ident}</div>
          <div className="acct-id__email">{u.email || "—"}</div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          icon={<Icon name="logout" size={14} />}
          onClick={onLogout}
        >
          {L("退出登录", "Sign out")}
        </Button>
      </div>

      <div className="acct-fields">
        <Field
          label={L("显示名称", "Display name")}
          hint={L(
            "出现在你创建的表单与提交记录里。留空则用邮箱。",
            "Shown on the forms you create and in submission records. Leave blank to use your email.",
          )}
          error={dn.error}
        >
          <Input
            name={dn.name}
            value={dn.value || ""}
            onChange={dn.onChange}
            onBlur={dn.onBlur}
            placeholder={L("如：陈伟", "e.g. Alex Chen")}
          />
        </Field>
        <Field
          label={L("登录邮箱", "Sign-in email")}
          hint={L(
            "邮箱用于登录，暂不可修改。",
            "Email is used to sign in and can't be changed for now.",
          )}
        >
          <Input value={u.email || ""} disabled />
        </Field>
        <Field
          label={L("语言 / Language", "Language / 语言")}
          hint={L("切换后页面会重新加载。", "The page reloads after switching.")}
        >
          <Select
            value={getLocale()}
            onChange={(e) => setLocale(e.target.value)}
            options={[
              { value: "zh", label: "中文" },
              { value: "en", label: "English" },
            ]}
          />
        </Field>
      </div>

      {/* 邮箱未验证内联卡 (§23.6 新设计 .acct-verify) — 仅未验证时显示;与顶部 .vb 条共用 App 的
          重发逻辑(冷却同步)。消费 DS Button + Icon。 */}
      {!verified ? (
        <div className="acct-verify">
          <Icon name="mail" size={16} />
          <div className="acct-verify__txt">
            <div className="acct-verify__h">{L("邮箱还未验证", "Email not verified yet")}</div>
            <p className="acct-verify__p">
              {L(
                "验证后才能接收表单提醒与重要账户通知。验证邮件已发送至上方邮箱，请点击其中的链接完成验证。",
                "Verify to receive form notifications and important account alerts. A verification email has been sent to the address above — click the link inside to finish.",
              )}
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={cooldown > 0 || resending}
            onClick={onResend}
          >
            {resending
              ? L("发送中…", "Sending…")
              : cooldown > 0
                ? L("重新发送 · ", "Resend · ") + cooldown + "s"
                : L("重新发送", "Resend")}
          </Button>
        </div>
      ) : null}
    </PageSection>
  );
}

/**
 * FeishuConnectionCard — 应用层自组合的「飞书多维表格」连接卡 (SPEC §12 + §14 + §16.9). DS 0.10.0
 * 删除了厂商专用的 FeishuCard,这里改用通用 <ConnectionCard> + <Input>/<SecretField>/<HelpSteps>
 * 组合出一张与 DeepSeek 卡对称的卡:只配 App ID + App Secret 两个账户级凭证(link-less —— 分享链接 /
 * App Token / 数据表 已退场,发布表单时由后端自动建表 per-form,§16.9)。纯展示 —— 配置状态 / 连接
 * 探测 / 持久化由 SettingsOverlay 拥有,props 进、事件出。
 *
 * @param {object} props
 * @param {string} [props.appId] / [props.secret]                  受控字段值
 * @param {(v:string)=>void} props.onAppIdChange/onSecretChange    编辑回调(值)
 * @param {boolean} [props.masked]    已存 app_secret → 显示掩码占位 + 「留空保持不变」
 * @param {string} [props.appIdError] / [secretError]              字段级后端错误
 * @param {"idle"|"testing"|"ok"|"error"} [props.status]   调用方控制的连接状态(驱动 StatusPill/TestRow)
 * @param {string} [props.result]     TestRow 结果行
 * @param {() => void} [props.onTest]  点「测试连接」
 * @param {boolean} [props.canTest]   覆盖派生的可测态(默认:有 App ID 且有 secret 或已掩码)
 */
function FeishuConnectionCard({
  appId = "",
  onAppIdChange,
  secret = "",
  onSecretChange,
  masked = false,
  appIdError,
  secretError,
  status = "idle",
  result,
  onTest,
  canTest,
}) {
  // 已存 secret 且未编辑 → 掩码占位(与 DeepSeekCard 的掩码文案一致,§12.4 留空保持不变)。
  const secretMaskedNow = masked && !(secret || "").trim();
  // Test 探测的是后端已存配置 (§14),配置加载后即可用;canTest 显式控制,否则按本地字段派生。
  const testDisabled =
    canTest !== undefined ? !canTest : !(appId || "").trim() || (!(secret || "").trim() && !masked);
  return (
    <ConnectionCard
      icon="table"
      title={L("飞书多维表格", "Feishu Bitable")}
      desc={L(
        "连接你的飞书自建应用。连上后，发布表单时会自动为它创建一张多维表格，每次提交写入一行——不用你先去飞书建表。",
        "Connect your Feishu custom app. Once linked, publishing a form auto-creates a Bitable for it and writes one row per submission — no need to build the table yourself.",
      )}
      status={status}
      result={result}
      onTest={onTest}
      testDisabled={testDisabled}
      idleHint={L("填写应用凭证后测试连接", "Enter app credentials, then test the connection")}
    >
      <Input
        label="App ID"
        hint={L("应用标识，可公开。", "App identifier — safe to expose.")}
        error={appIdError}
        mono
        value={appId}
        placeholder="cli_xxxxxxxxxxxx"
        spellCheck={false}
        onChange={(e) => onAppIdChange && onAppIdChange(e.target.value)}
      />
      <SecretField
        label="App Secret"
        value={secret}
        onChange={onSecretChange}
        placeholder={
          secretMaskedNow
            ? L("已保存 ········  ·  留空则保持不变", "Saved ········  ·  leave blank to keep")
            : L("应用密钥（与 App ID 配对）", "App secret (paired with App ID)")
        }
        hint={
          secretMaskedNow
            ? L(
                "已存密钥 · 留空表示不修改，输入新值即覆盖",
                "Stored · leave blank to keep, type a new value to overwrite",
              )
            : L("应用密钥，加密存储。", "App secret — stored encrypted.")
        }
        error={secretError}
      />
      <HelpSteps
        title={L("如何获取飞书应用凭证？", "How to get Feishu app credentials")}
        steps={[
          <React.Fragment>
            {L("打开飞书开放平台 ", "Open the Feishu Open Platform ")}
            <code>open.feishu.cn</code>
            {L("，创建一个「企业自建应用」。", " and create a “custom app”.")}
          </React.Fragment>,
          <React.Fragment>
            {L("在「凭证与基础信息」中复制 ", "In “Credentials & Basic Info”, copy the ")}
            <code>App ID</code>
            {L(" 与 ", " and ")}
            <code>App Secret</code>
            {L("。", ".")}
          </React.Fragment>,
          <React.Fragment>
            {L(
              "到「权限管理」开通多维表格读写权限 ",
              "Under “Permissions”, enable Bitable read/write ",
            )}
            <code>bitable:app</code>
            {L("，并发布版本。", ", then publish a version.")}
          </React.Fragment>,
          <React.Fragment>
            {L("连接后由 Agentaily ", "After connecting, Agentaily ")}
            <strong>{L("自动建表", "creates the table automatically")}</strong>
            {L("，无需你手动创建多维表格。", " — no manual Bitable setup needed.")}
          </React.Fragment>,
        ]}
        link={{
          href: "https://open.feishu.cn",
          label: L("打开飞书开放平台", "Open Feishu Open Platform"),
        }}
      />
    </ConnectionCard>
  );
}

/**
 * SettingsOverlay — the floating settings sheet (账户 + 集成 tabs). Owns BOTH tabs' state and
 * renders the SettingsSheet shell. App controls `open` / `section` and provides the seams; the
 * sheet floats over the designer (which stays mounted), so closing restores the prior state.
 *
 * @param {object} props
 * @param {boolean} [props.open=true]              passed to SettingsSheet (mounted only while true)
 * @param {"account"|"integrations"} [props.section="integrations"]  controlled active tab
 * @param {(id: string) => void} [props.onNavigate]  tab switch
 * @param {() => void} [props.onClose]               close the overlay (App restores the URL)
 * @param {{ email?: string, displayName?: string|null }} [props.user]  current owner (账户 tab)
 * @param {() => void} [props.onLogout]              退出登录 (账户 tab)
 * @param {(reason?: string) => void} [props.onNeedLogin]  401 handoff (both tabs)
 * @param {(me: object) => void} [props.onProfileSaved]   propagate a saved profile to App
 * @param {() => Promise} [props.getConfig]          injectable; defaults to configClient.getConfig
 * @param {(input) => Promise} [props.saveConfig]    injectable; defaults to configClient.saveConfig
 * @param {(service: string, creds?: object) => Promise} [props.testConnection]  injectable single-service probe; defaults to configClient.testConnection
 * @param {(name: string) => Promise} [props.updateProfile]  injectable; defaults to auth.updateProfile
 */
export function SettingsOverlay({
  open = true,
  section = "integrations",
  onNavigate = () => {},
  onClose = () => {},
  user = null,
  onLogout = () => {},
  onNeedLogin = () => {},
  onProfileSaved = () => {},
  getConfig = defaultGetConfig,
  saveConfig = defaultSaveConfig,
  testConnection = defaultTestConnection,
  updateProfile = defaultUpdateProfile,
  // 邮箱验证状态 (§23.6) — 账户 tab 的 acct-verify 内联卡用。emailVerified 默认 true(无卡),
  // 与 App 的乐观默认一致;onResendVerification / resendCooldown / resending 接 App 的重发逻辑。
  emailVerified = true,
  onResendVerification = () => {},
  resendCooldown = 0,
  resending = false,
} = {}) {
  // ── 集成 tab state ────────────────────────────────────────────────────────────
  // The masked echo of the stored config; null until the first getConfig resolves.
  const [config, setConfig] = useState(null);
  // Controlled card fields. Secret editables (apiKey / secret) start empty so the masked
  // affordance shows; a non-empty value is the new plaintext to overwrite with.
  const [apiKey, setApiKey] = useState("");
  // Lowercase API id (case-sensitive — camelCase 400s); see core/chatModels + chat.ts.
  const [model, setModel] = useState("deepseek-v4-flash");
  const [appId, setAppId] = useState("");
  const [secret, setSecret] = useState("");
  // loading reflects the integration fetch; only meaningful once the 集成 tab is shown.
  const [loading, setLoading] = useState(section === "integrations");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  // A backend-rejected save surfaces its message here, verbatim (top-level Alert).
  const [saveError, setSaveError] = useState("");
  // Field-level backend errors mapped onto the matching card inputs.
  const [fieldErrors, setFieldErrors] = useState({});
  // Per-card connection probe state (caller-controlled): { status, result }.
  const [dsConn, setDsConn] = useState(IDLE);
  const [fsConn, setFsConn] = useState(IDLE);
  // Lazily fetch the integration config the first time the 集成 tab is shown (so opening on
  // the 账户 tab never triggers an owner-only config call).
  const integLoadedRef = useRef(false);

  // A 401 from any owner-only call means the session is missing/expired (§17): hand off to
  // App's onNeedLogin (it closes the overlay + routes to /signin) instead of an inline error.
  const handleError = useCallback(
    (e, reason) => {
      if (e instanceof ApiError && e.status === 401) {
        onNeedLogin(reason);
        return true;
      }
      return false;
    },
    [onNeedLogin],
  );

  // Echo a masked view into the card fields: non-secret plaintext fills in, secret editables
  // reset to empty (so the masked affordance shows).
  const echo = useCallback((cfg) => {
    setConfig(cfg);
    setModel(cfg?.deepseek?.model || "deepseek-v4-flash");
    setAppId(cfg?.feishu?.appId ?? "");
    setApiKey("");
    setSecret("");
  }, []);

  // Fetch + echo the current config the first time the 集成 tab is shown (the overlay only
  // opens for a logged-in owner — App's guard bounces a signed-out owner to /signin first).
  useEffect(() => {
    if (section !== "integrations" || integLoadedRef.current) return;
    integLoadedRef.current = true;
    let alive = true;
    setLoading(true);
    Promise.resolve()
      .then(() => getConfig())
      .then((cfg) => {
        if (alive) echo(cfg);
      })
      .catch((e) => {
        if (alive) handleError(e, L("登录后配置集成", "Sign in to configure integrations"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // getConfig is injected per-mount and stable; fetch once when 集成 first shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);

  // Any edit dirties the form (re-enables Save) and drops the "已保存" confirmation.
  const touch = () => {
    setDirty(true);
    setSaved(false);
  };
  const clearFieldError = (key) =>
    setFieldErrors((fe) => (fe[key] ? { ...fe, [key]: undefined } : fe));

  // Whether the stored config already has each secret (mask present) → drives `masked`
  // and the "omit to keep" save rule.
  const hasStoredApiKey = !!config?.deepseek?.apiKey;
  const hasStoredSecret = !!config?.feishu?.appSecret;

  // Build the ConfigInput, honoring the "don't re-submit the mask" rule (§12.4): a secret left
  // empty is OMITTED so the backend keeps the stored value; a typed secret is sent verbatim.
  // 飞书 is link-less now (§16.9): only app_id + app_secret are sent; the whole block is omitted
  // when neither is set.
  const buildInput = () => {
    const deepseek = {};
    if (apiKey.trim()) deepseek.apiKey = apiKey;
    if (model.trim()) deepseek.model = model;

    const feishu = {};
    if (appId.trim()) feishu.appId = appId;
    if (secret.trim()) feishu.appSecret = secret;
    const hasFeishu = Object.keys(feishu).length > 0;

    return hasFeishu ? { deepseek, feishu } : { deepseek };
  };

  // Map a backend 400 message onto a card field error when it clearly names a block, plus
  // always show it at the top.
  const applyBackendError = (msg) => {
    setSaveError(msg);
    const fe = {};
    if (/deepseek|key/i.test(msg)) fe.keyError = msg;
    if (/app[_ ]?secret|密钥|凭据/i.test(msg)) fe.secretError = msg;
    if (/app[_ ]?id/i.test(msg)) fe.appIdError = msg;
    setFieldErrors(fe);
  };

  const onSave = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError("");
    setFieldErrors({});
    setSaved(false);
    try {
      const out = await saveConfig(buildInput());
      echo(out); // re-echo the returned masked view; secret inputs reset to masked affordance
      setDirty(false);
      setSaved(true);
    } catch (e) {
      if (handleError(e, L("登录后配置集成", "Sign in to configure integrations"))) return; // 401 → onNeedLogin, no inline error
      applyBackendError(
        e instanceof ApiError
          ? e.message
          : L(
              "保存失败，请检查网络或后端地址。",
              "Save failed — check your network or backend address.",
            ),
      );
    } finally {
      setSaving(false);
    }
  };

  // 每卡独立「测试连接」(§14, PR #72):只测这张卡的服务、用这张卡当前输入框的值(dirty 就拿输入值
  // verify-before-save;未改的密钥则 OMIT → 后端走「测已存配置」兜底,绝不把掩码串发出去),并且
  // **只更新这张卡**的连接状态——点 DeepSeek 不再连带把飞书卡也改掉。
  const backendUnreachable = () => ({
    status: "error",
    result: L("无法连接到后端，请检查网络。", "Can't reach the backend — check your network."),
  });

  // DeepSeek 卡:dirty(输入了新 key)→ 拿输入值探测;未改 → 不带 key,后端测已存。
  const onTestDeepSeek = async () => {
    setDsConn((c) => ({ ...c, status: "testing" }));
    try {
      const creds = apiKey.trim() ? { apiKey } : undefined;
      setDsConn(probeToConn(await testConnection("deepseek", creds)));
    } catch (e) {
      if (handleError(e, L("登录后配置集成", "Sign in to configure integrations"))) return; // 401 → onNeedLogin
      setDsConn(backendUnreachable());
    }
  };

  // 飞书卡:appId 是明文(回显在输入框,随时可发);appSecret 仅在 owner 改过时才带,未改则
  // OMIT → 后端用已存 secret 兜底。两者都空(从未配置)则传 undefined → 后端报「未配置」。
  const onTestFeishu = async () => {
    setFsConn((c) => ({ ...c, status: "testing" }));
    try {
      const creds = {};
      if (appId.trim()) creds.appId = appId;
      if (secret.trim()) creds.appSecret = secret;
      const has = Object.keys(creds).length > 0;
      setFsConn(probeToConn(await testConnection("feishu", has ? creds : undefined)));
    } catch (e) {
      if (handleError(e, L("登录后配置集成", "Sign in to configure integrations"))) return; // 401 → onNeedLogin
      setFsConn(backendUnreachable());
    }
  };

  // Readiness rail (self-composed, replacing the removed IntegrationSettings rail): an integration
  // counts as ready when it has stored creds OR its last probe came back ok. Per chat13, the rail
  // GATES ONLY DeepSeek (required) — 飞书 is optional, shown as a connected/optional count.
  const dsReady = hasStoredApiKey || dsConn.status === "ok";
  const fsReady = hasStoredSecret || fsConn.status === "ok";

  // 放弃更改 (集成 SettingsSaveBar onReset): revert edits back to the last-loaded/saved view.
  const resetForm = () => {
    echo(config);
    setDirty(false);
    setSaved(false);
    setSaveError("");
    setFieldErrors({});
  };

  const intro = loading
    ? L("加载中…", "Loading…")
    : L(
        "连接你自己的 DeepSeek key 与飞书多维表格 —— 对话设计走你的额度，答题落库进你的租户。",
        "Connect your own DeepSeek key and Feishu Bitable — conversational design runs on your quota, and answers land in your tenant.",
      );

  // ── 账户 tab state ────────────────────────────────────────────────────────────
  // Form.useForm owns the editable 显示名; SettingsSaveBar (form mode) gates 保存 on dirty+valid,
  // validates-then-commits on click, and 放弃更改 calls form.reset(). Seeded from the current
  // owner's displayName (the overlay mounts fresh on open, so this reflects the latest `me`).
  const accountForm = Form.useForm({
    initialValues: { displayName: user?.displayName || "" },
  });
  const persistAccount = async (values) => {
    try {
      const me = await updateProfile(values.displayName || "");
      // Re-baseline the form to the saved value (clears dirty); propagate to App so the account
      // control + the next open reflect it.
      accountForm.reset({ displayName: me.displayName || "" });
      onProfileSaved(me);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        onNeedLogin(L("登录后管理你的账户", "Sign in to manage your account"));
        return;
      }
      // A backend 400 (e.g. 显示名称过长 — normally caught client-side) surfaces on the field.
      accountForm.setError(
        "displayName",
        e instanceof ApiError
          ? e.message
          : L("保存失败，请检查网络后重试。", "Save failed — check your network and try again."),
      );
    }
  };

  // ── render: the floating sheet with the two-tab nav + per-tab footer + body ──────
  const footer =
    section === "account" ? (
      <SettingsSaveBar form={accountForm} onSave={persistAccount} />
    ) : (
      <SettingsSaveBar
        dirty={dirty}
        saving={saving}
        status={saving ? "saving" : saveError ? "error" : saved ? "saved" : "idle"}
        error={saveError}
        onSave={onSave}
        onReset={resetForm}
      />
    );

  return (
    <SettingsSheet
      open={open}
      crumb={L("设置", "Settings")}
      label={L("设置", "Settings")}
      onClose={onClose}
      nav={[
        { id: "account", label: L("账户", "Account"), icon: "user" },
        { id: "integrations", label: L("集成", "Integrations"), icon: "plug" },
      ]}
      active={section}
      onNavigate={onNavigate}
      footer={footer}
    >
      {section === "account" ? (
        <AccountSection
          user={user}
          form={accountForm}
          onLogout={onLogout}
          verified={emailVerified}
          onResend={onResendVerification}
          cooldown={resendCooldown}
          resending={resending}
        />
      ) : (
        <PageSection
          eyebrow={L("集成 · INTEGRATIONS", "Integrations · INTEGRATIONS")}
          title={L("连接你的服务", "Connect your services")}
          description={intro}
        >
          {/* 自组合就绪栏(替代已移除的 IntegrationSettings 内置 rail):单个 dot 只 gate DeepSeek;
              飞书显示「已连接 / 可选」,不参与 gating(chat13)。 */}
          <div className="d-ready">
            <div className="d-ready__dots">
              <span className={"d-ready__dot" + (dsReady ? " is-on" : "")} />
            </div>
            <div className="d-ready__txt">
              {dsReady ? (
                <span>
                  <strong>
                    {L(
                      "DeepSeek 已连接，可以开始运行。",
                      "DeepSeek connected — you're ready to go.",
                    )}
                  </strong>
                  {L("飞书多维表格为可选。", "Feishu Bitable is optional.")}
                </span>
              ) : (
                <span>
                  {L("连接 ", "Connect ")}
                  <strong>DeepSeek</strong>
                  {L(
                    " 后即可开始运行；飞书多维表格为可选，连上后提交会自动写入。",
                    " to get started; Feishu Bitable is optional — once linked, submissions are written automatically.",
                  )}
                </span>
              )}
            </div>
            <span className="d-ready__count">
              {fsReady
                ? L("飞书 · 已连接", "Feishu · Connected")
                : L("飞书 · 可选", "Feishu · Optional")}
            </span>
          </div>

          <div className="d-integ-cards">
            <DeepSeekCard
              apiKey={apiKey}
              onApiKeyChange={(v) => {
                touch();
                clearFieldError("keyError");
                setApiKey(v);
                setDsConn(IDLE);
              }}
              // 对话模型选择已随 DS 0.10.0 从卡片移除;`model` 仍在 config 里 round-trip(echo 进、
              // buildInput 发回),re-save 不会清掉已存 model,但此处不再有选择 UI。
              masked={hasStoredApiKey}
              keyError={fieldErrors.keyError}
              status={dsConn.status}
              result={dsConn.result}
              onTest={onTestDeepSeek}
              // 测的是这张卡当前输入值(未改则后端测已存,§14),只更新这张卡;加载完即可用
              // ——"未配置" 是正常结果,不是禁用理由。
              canTest={!loading}
            />

            <FeishuConnectionCard
              appId={appId}
              onAppIdChange={(v) => {
                touch();
                clearFieldError("appIdError");
                setAppId(v);
                setFsConn(IDLE);
              }}
              secret={secret}
              onSecretChange={(v) => {
                touch();
                clearFieldError("secretError");
                setSecret(v);
                setFsConn(IDLE);
              }}
              masked={hasStoredSecret}
              appIdError={fieldErrors.appIdError}
              secretError={fieldErrors.secretError}
              status={fsConn.status}
              result={fsConn.result}
              onTest={onTestFeishu}
              canTest={!loading}
            />
          </div>
        </PageSection>
      )}
    </SettingsSheet>
  );
}

// Turn a backend per-block probe ({ ok, message }) into the card's caller-controlled connection
// state. ok → green "已连接" pill + the (optional) note; not-ok is a NORMAL result ("未配置" /
// "凭据无效"), expressed as the card's "error" state carrying that note — NOT a request failure.
function probeToConn(probe) {
  if (!probe) return { status: "error", result: L("未配置", "Not configured") };
  if (probe.ok) return { status: "ok", result: probe.message || L("已连接", "Connected") };
  return { status: "error", result: probe.message || L("不可连通", "Unreachable") };
}
