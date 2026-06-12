// settings.jsx — owner 集成设置页 (SPEC §12 + §14, frontend). Since DS 0.6.0 dropped the
// all-in-one IntegrationSettings modal in favor of two PURE-DISPLAY connection cards
// (DeepSeekCard + FeishuCard — zero state, no save bar, no gating, no backend), this is a
// standalone `/settings` ROUTE page (chrome-less, like /signin) that owns everything the
// cards delegate to the caller: config state + persistence, the Save bar, the 401 → login
// handoff, the per-block connection probe, and — newly ours, since the cards don't render
// backend errors — surfacing the backend's 400 field errors.
//
//   mount → getConfig() → echo the masked config into card props. A 401 (no/expired owner
//           session, §17) does NOT render as a settings error: it navigates to /signin so
//           the owner re-authenticates. Never-configured → all-null skeleton → empty cards.
//
//   cards → DeepSeek: apiKey (SecretField) + model (Select). 飞书: appId / secret /
//           link (a Bitable share URL the card parses to App Token + table). The backend
//           stores appToken + tableId separately, so this page BRIDGES: it reconstructs a
//           share link from the stored appToken/tableId on load, and parses the edited
//           link back into appToken/tableId on save.
//           Secret fields (apiKey, secret) show a MASKED affordance via `masked` (placeholder
//           "已保存… 留空则保持不变") rather than the editable value. The "don't re-submit the
//           mask" contract (§12.4): a secret left blank is OMITTED from the ConfigInput
//           (undefined) so saveConfig keeps the stored secret; typing a new value overwrites.
//
//   save → saveConfig(input). 200 → "已保存" state + re-echo the returned masked view
//          (secret inputs reset to their masked affordance). 400 → surface the backend's
//          ApiError.message: a top-level Alert plus, when we can tell which block it's about,
//          the matching card field error (keyError / appIdError / secretError). The page
//          stays put, nothing cleared. 401 → navigate to /signin (login flow), no inline error.
//
//   test → testConnections() probes the STORED config and always resolves (HTTP 200) → push
//          status "testing" → "ok" | "error" + a result line into BOTH cards. "测不通" /
//          "未配置" are normal results (status:"error" with the backend note), NOT request
//          failures — only a 401 / network reject is a failure (and 401 → /signin).
//
// getConfig / saveConfig / testConnections / navigate default to the real seams but are
// injectable so tests inject fakes and stay deterministic (same pattern as auth.jsx).

import React, { useState, useEffect, useCallback } from "react";
import {
  SettingsPage,
  DeepSeekCard,
  FeishuCard,
  Button,
  Alert,
  parseFeishuLink,
} from "@agentaily/design-system";
import {
  getConfig as defaultGetConfig,
  saveConfig as defaultSaveConfig,
  testConnections as defaultTestConnections,
} from "./core/configClient";
import { ApiError } from "./core/apiClient";
import { SIGNIN_PATH, SETTINGS_PATH } from "./core/router";

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
 * @param {object} props
 * @param {() => Promise} [props.getConfig]          injectable; defaults to configClient.getConfig
 * @param {(input) => Promise} [props.saveConfig]    injectable; defaults to configClient.saveConfig
 * @param {() => Promise} [props.testConnections]    injectable; defaults to configClient.testConnections
 * @param {(url: string) => void} [props.navigate]   full nav by default; injectable for tests
 */
export function SettingsScreen({
  getConfig = defaultGetConfig,
  saveConfig = defaultSaveConfig,
  testConnections = defaultTestConnections,
  navigate = (url) => {
    window.location.href = url;
  },
} = {}) {
  // The masked echo of the stored config; null until the first getConfig resolves. Its
  // secret masks drive the `masked` affordance, never an editable value.
  const [config, setConfig] = useState(null);

  // Controlled card fields. Secret editables (apiKey / secret) start empty so the masked
  // affordance shows; a non-empty value is the new plaintext to overwrite with.
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("deepseek-chat");
  const [appId, setAppId] = useState("");
  const [secret, setSecret] = useState("");
  const [link, setLink] = useState("");

  const [loading, setLoading] = useState(true);
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

  // A 401 from any owner-only call means the session is missing/expired (§17): route to
  // the standalone /signin page (carrying where to return) instead of an inline error.
  const goSignIn = useCallback(
    (reason) => {
      const qs = new URLSearchParams({ return: SETTINGS_PATH });
      if (reason) qs.set("reason", reason);
      navigate(SIGNIN_PATH + "?" + qs.toString());
    },
    [navigate],
  );
  const handleError = useCallback(
    (e, reason) => {
      if (e instanceof ApiError && e.status === 401) {
        goSignIn(reason);
        return true;
      }
      return false;
    },
    [goSignIn],
  );

  // Echo a masked view into the card fields: non-secret plaintext fills in, secret
  // editables reset to empty (so the masked affordance shows), 飞书 link reconstructed.
  const echo = useCallback((cfg) => {
    setConfig(cfg);
    setModel(cfg?.deepseek?.model || "deepseek-chat");
    setAppId(cfg?.feishu?.appId ?? "");
    setLink(linkFromStored(cfg?.feishu));
    setApiKey("");
    setSecret("");
  }, []);

  // On mount, fetch + echo the current config (the page only mounts for a logged-in
  // owner — App's guard bounces a signed-out owner to /signin first).
  useEffect(() => {
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
    // getConfig is injected per-mount and stable; fetch once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Any edit dirties the form (re-enables Save) and drops the "已保存" confirmation +
  // a field's backend error (the owner is fixing it). Resetting a probe to idle when its
  // secret is edited keeps a stale green pill from lingering past an edit.
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

  // Build the ConfigInput, honoring the "don't re-submit the mask" rule (§12.4): a secret
  // left empty is OMITTED (undefined) so the backend keeps the stored value; a typed secret
  // is sent verbatim. 飞书 link is parsed back into appToken/tableId; 飞书 is all-or-nothing,
  // so the whole block is omitted only when no 飞书 field is set at all.
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
  // always show it at the top. DeepSeek key vs 飞书 app_secret/app_id are the fields a 400
  // can target; an unrecognised message lives only in the top-level Alert.
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
      if (handleError(e, "登录后配置集成")) return; // 401 → /signin, no inline error
      // 400 (missing key / half-filled 飞书) → surface the backend message verbatim; the
      // page stays put and nothing is cleared so the owner can fix and retry.
      applyBackendError(e instanceof ApiError ? e.message : "保存失败，请检查网络或后端地址。");
    } finally {
      setSaving(false);
    }
  };

  // Run the stored-config probe and push status/result into BOTH cards (testConnections
  // tests the saved config and returns both per-block results in one shot). Triggered by
  // either card's Test button; mark only the clicked block "testing" while it runs, but
  // refresh both from the single result so the page stays consistent.
  const runTest = async () => {
    setDsConn((c) => ({ ...c, status: "testing" }));
    setFsConn((c) => ({ ...c, status: "testing" }));
    try {
      const r = await testConnections();
      setDsConn(probeToConn(r.deepseek));
      setFsConn(probeToConn(r.feishu));
    } catch (e) {
      if (handleError(e, "登录后配置集成")) return; // 401 → /signin
      const failed = { status: "error", result: "无法连接到后端，请检查网络。" };
      setDsConn(failed);
      setFsConn(failed);
    }
  };

  const subtitle = loading
    ? "加载中…"
    : "连接你自己的 DeepSeek key 与飞书多维表格 —— 对话设计走你的额度，答题落库进你的租户。";

  return (
    <SettingsPage
      word="settings"
      title="集成设置"
      subtitle={subtitle}
      actions={
        <React.Fragment>
          <Button variant="secondary" disabled={saving} onClick={() => navigate("/")}>
            返回设计器
          </Button>
          <Button variant="primary" disabled={saving || loading || !dirty} onClick={onSave}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </React.Fragment>
      }
    >
      <div className="d-settings">
        {saved ? (
          <Alert variant="ok" title="已保存">
            配置已写入。密钥以掩码保存，留空表示保持不变。
          </Alert>
        ) : null}
        {saveError ? (
          <Alert variant="danger" title="保存失败">
            {saveError}
          </Alert>
        ) : null}

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
          // always available once loaded — "未配置" is a normal probe result, not a reason
          // to disable the button.
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
          // Same as DeepSeek: the probe targets the saved backend config (§14), so the
          // Test button stays available regardless of the local 飞书 field state.
          canTest={!loading}
        />
      </div>
    </SettingsPage>
  );
}

// Turn a backend per-block probe ({ ok, message }) into the card's caller-controlled
// connection state. ok → green "已连接" pill + the (optional) note; not-ok is a NORMAL
// result ("未配置" / "凭据无效"), expressed as the card's "error" state carrying that
// note — NOT a request failure.
function probeToConn(probe) {
  if (!probe) return { status: "error", result: "未配置" };
  if (probe.ok) return { status: "ok", result: probe.message || "已连接" };
  return { status: "error", result: probe.message || "不可连通" };
}
