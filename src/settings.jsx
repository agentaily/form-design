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
//   • 集成 (IntegrationSettings): the DeepSeek + 飞书 pure-display connection cards + this module's
//     OWN config state / persistence / per-block probe / backend-400 surfacing (§12 + §14),
//     unchanged in behavior from the previous standalone /settings page — only the host moved
//     from a route page into this tab.
//
// Each tab owns its own SettingsSaveBar (GitHub model: one bar per tab, explicit 保存).
//
//   集成 mount-of-tab → getConfig() → echo the masked config into card props. A 401 (no/expired
//           owner session, §17) does NOT render as a settings error: it calls onNeedLogin so App
//           routes the owner to /signin. Never-configured → all-null skeleton → empty cards.
//
//   集成 cards → DeepSeek: apiKey (SecretField) + model (Select). 飞书: appId / secret / link (a
//           Bitable share URL the card parses to App Token + table). The backend stores appToken +
//           tableId separately, so this module BRIDGES: it reconstructs a share link from the
//           stored appToken/tableId on load, and parses the edited link back on save. Secret
//           fields show a MASKED affordance via `masked`; a secret left blank is OMITTED from the
//           ConfigInput so saveConfig keeps the stored secret (§12.4 "don't re-submit the mask").
//
//   集成 save → saveConfig(input). 200 → "已保存" + re-echo masked view. 400 → surface the backend's
//           ApiError.message verbatim (top-level + matching card field). 401 → onNeedLogin.
//
//   集成 test → testConnections() probes the STORED config and always resolves; "测不通"/"未配置"
//           are normal results (status:"error" + note), NOT request failures — only a 401 / network
//           reject is a failure (401 → onNeedLogin).
//
//   账户 save → updateProfile(displayName). 200 → re-baseline the form (clean) + onProfileSaved so
//           App refreshes the account control. 401 → onNeedLogin. A >64-char name is caught client
//           side by the field's maxLength rule before submit; a backend 400 surfaces on the field.
//
// getConfig / saveConfig / testConnections / updateProfile default to the real seams but are
// injectable so tests inject fakes and stay deterministic (same pattern as auth.jsx).

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  SettingsSheet,
  IntegrationSettings,
  SettingsSaveBar,
  DeepSeekCard,
  FeishuCard,
  parseFeishuLink,
  PageSection,
  Avatar,
  Field,
  Input,
  Button,
  Form,
} from "@agentaily/design-system";
import { Icon } from "./chat.jsx";
import {
  getConfig as defaultGetConfig,
  saveConfig as defaultSaveConfig,
  testConnections as defaultTestConnections,
} from "./core/configClient";
import { updateProfile as defaultUpdateProfile } from "./core/auth";
import { ApiError } from "./core/apiClient";

// 显示名长度上限，与后端 MAX_DISPLAY_NAME_LENGTH 对齐（§17 个人资料）。超出由账户表单的
// maxLength 规则在提交前拦下（后端 400 仅作纵深防御兜底）。
const MAX_DISPLAY_NAME_LENGTH = 64;

// The DeepSeek model options surfaced in the card's <Select>. Mirrors the DS default
// list but pinned here so the saved `model` always maps to a known option.
const MODEL_OPTIONS = [
  { value: "deepseek-chat", label: "deepseek-chat · 通用 · 快" },
  { value: "deepseek-reasoner", label: "deepseek-reasoner · 深度推理" },
];

// Reconstruct a Bitable share link the FeishuCard can parse back into {token, table},
// from the stored appToken + tableId (the backend keeps them as separate plaintext
// fields, but the card's single editable is the share URL). Empty when no appToken.
function linkFromStored(feishu) {
  const token = feishu?.appToken;
  if (!token) return "";
  const table = feishu?.tableId;
  return `https://feishu.cn/base/${token}` + (table ? `?table=${table}` : "");
}

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
 */
function AccountSection({ user, form, onLogout }) {
  const u = user || {};
  const ident = u.displayName || u.email || "未登录";
  // Register the field WITH a maxLength rule so a too-long name is caught before submit
  // (the SettingsSaveBar gates 保存 on validity); the backend 400 is only a fallback.
  const dn = form.field("displayName", {
    maxLength: {
      value: MAX_DISPLAY_NAME_LENGTH,
      message: `显示名称最多 ${MAX_DISPLAY_NAME_LENGTH} 个字符`,
    },
  });
  return (
    <PageSection
      eyebrow="账户 · ACCOUNT"
      title="你的账户"
      description="管理你的登录身份与个人偏好。这些设置只对你自己可见。"
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
          退出登录
        </Button>
      </div>

      <div className="acct-fields">
        <Field
          label="显示名称"
          hint="出现在你创建的表单与提交记录里。留空则用邮箱。"
          error={dn.error}
        >
          <Input
            name={dn.name}
            value={dn.value || ""}
            onChange={dn.onChange}
            onBlur={dn.onBlur}
            placeholder="如：陈伟"
          />
        </Field>
        <Field label="登录邮箱" hint="邮箱用于登录，暂不可修改。">
          <Input value={u.email || ""} disabled />
        </Field>
      </div>
    </PageSection>
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
 * @param {() => Promise} [props.testConnections]    injectable; defaults to configClient.testConnections
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
  testConnections = defaultTestConnections,
  updateProfile = defaultUpdateProfile,
} = {}) {
  // ── 集成 tab state ────────────────────────────────────────────────────────────
  // The masked echo of the stored config; null until the first getConfig resolves.
  const [config, setConfig] = useState(null);
  // Controlled card fields. Secret editables (apiKey / secret) start empty so the masked
  // affordance shows; a non-empty value is the new plaintext to overwrite with.
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("deepseek-chat");
  const [appId, setAppId] = useState("");
  const [secret, setSecret] = useState("");
  const [link, setLink] = useState("");
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
  // reset to empty (so the masked affordance shows), 飞书 link reconstructed.
  const echo = useCallback((cfg) => {
    setConfig(cfg);
    setModel(cfg?.deepseek?.model || "deepseek-chat");
    setAppId(cfg?.feishu?.appId ?? "");
    setLink(linkFromStored(cfg?.feishu));
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
        if (alive) handleError(e, "登录后配置集成");
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
  // 飞书 link is parsed back into appToken/tableId; 飞书 is all-or-nothing, so the whole block is
  // omitted only when no 飞书 field is set at all.
  const buildInput = () => {
    const deepseek = {};
    if (apiKey.trim()) deepseek.apiKey = apiKey;
    if (model.trim()) deepseek.model = model;

    const feishu = {};
    if (appId.trim()) feishu.appId = appId;
    if (secret.trim()) feishu.appSecret = secret;
    const parsed = parseFeishuLink(link);
    if (parsed?.token) feishu.appToken = parsed.token;
    if (parsed?.table) feishu.tableId = parsed.table;
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
      if (handleError(e, "登录后配置集成")) return; // 401 → onNeedLogin, no inline error
      applyBackendError(e instanceof ApiError ? e.message : "保存失败，请检查网络或后端地址。");
    } finally {
      setSaving(false);
    }
  };

  // Run the stored-config probe and push status/result into BOTH cards.
  const runTest = async () => {
    setDsConn((c) => ({ ...c, status: "testing" }));
    setFsConn((c) => ({ ...c, status: "testing" }));
    try {
      const r = await testConnections();
      setDsConn(probeToConn(r.deepseek));
      setFsConn(probeToConn(r.feishu));
    } catch (e) {
      if (handleError(e, "登录后配置集成")) return; // 401 → onNeedLogin
      const failed = { status: "error", result: "无法连接到后端，请检查网络。" };
      setDsConn(failed);
      setFsConn(failed);
    }
  };

  // Readiness rail (compositional IntegrationSettings): an integration counts as ready when it
  // has stored creds OR its last probe came back ok. Cosmetic — drives the hero rail copy.
  const readyCount =
    (hasStoredApiKey || dsConn.status === "ok" ? 1 : 0) +
    (hasStoredSecret || fsConn.status === "ok" ? 1 : 0);

  // 放弃更改 (集成 SettingsSaveBar onReset): revert edits back to the last-loaded/saved view.
  const resetForm = () => {
    echo(config);
    setDirty(false);
    setSaved(false);
    setSaveError("");
    setFieldErrors({});
  };

  const intro = loading
    ? "加载中…"
    : "连接你自己的 DeepSeek key 与飞书多维表格 —— 对话设计走你的额度，答题落库进你的租户。";

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
        onNeedLogin("登录后管理你的账户");
        return;
      }
      // A backend 400 (e.g. 显示名称过长 — normally caught client-side) surfaces on the field.
      accountForm.setError(
        "displayName",
        e instanceof ApiError ? e.message : "保存失败，请检查网络后重试。",
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
      crumb="设置"
      label="设置"
      onClose={onClose}
      nav={[
        { id: "account", label: "账户", icon: "user" },
        { id: "integrations", label: "集成", icon: "plug" },
      ]}
      active={section}
      onNavigate={onNavigate}
      footer={footer}
    >
      {section === "account" ? (
        <AccountSection user={user} form={accountForm} onLogout={onLogout} />
      ) : (
        <IntegrationSettings ready={readyCount} total={2} intro={intro}>
          <DeepSeekCard
            apiKey={apiKey}
            onApiKeyChange={(v) => {
              touch();
              clearFieldError("keyError");
              setApiKey(v);
              setDsConn(IDLE);
            }}
            model={model}
            onModelChange={(v) => {
              touch();
              setModel(v);
            }}
            models={MODEL_OPTIONS}
            masked={hasStoredApiKey}
            keyError={fieldErrors.keyError}
            status={dsConn.status}
            result={dsConn.result}
            onTest={runTest}
            // Test probes the STORED backend config (§14), not the local fields, so it is
            // always available once loaded — "未配置" is a normal result, not a reason to disable.
            canTest={!loading}
          />

          <FeishuCard
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
            link={link}
            onLinkChange={(v) => {
              touch();
              clearFieldError("linkError");
              setLink(v);
              setFsConn(IDLE);
            }}
            masked={hasStoredSecret}
            appIdError={fieldErrors.appIdError}
            secretError={fieldErrors.secretError}
            linkError={fieldErrors.linkError}
            status={fsConn.status}
            result={fsConn.result}
            onTest={runTest}
            canTest={!loading}
          />
        </IntegrationSettings>
      )}
    </SettingsSheet>
  );
}

// Turn a backend per-block probe ({ ok, message }) into the card's caller-controlled connection
// state. ok → green "已连接" pill + the (optional) note; not-ok is a NORMAL result ("未配置" /
// "凭据无效"), expressed as the card's "error" state carrying that note — NOT a request failure.
function probeToConn(probe) {
  if (!probe) return { status: "error", result: "未配置" };
  if (probe.ok) return { status: "ok", result: probe.message || "已连接" };
  return { status: "error", result: probe.message || "不可连通" };
}
