// settings.jsx — owner integration-settings dialog (SPEC §12 + §14, frontend).
// One DS Dialog (Dialog/Input/Button/Alert/Badge from @agentaily/design-system) that
// lets a logged-in owner connect DeepSeek + 飞书:
//
//   open → getConfig() → echo masked config into the form fields. A 401 (no/expired
//          owner session, §17) does NOT render as a settings error: it surfaces via
//          onNeedLogin so App pops the login dialog (mirrors auth.jsx / App §17 flow).
//          Never-configured → all-null skeleton → empty form, no error.
//
//   form → DeepSeek: apiKey (password) + optional model.
//          飞书: appId / appSecret(password) / appToken / tableId — all-or-nothing.
//          Secret fields (apiKey, appSecret) show the MASKED echo as a hint, NOT as the
//          editable value. The "don't re-submit the mask" contract (§12.4): if the
//          owner leaves a secret field empty, OMIT it from the ConfigInput (undefined,
//          not the mask) so saveConfig keeps the stored secret. Typing a new value
//          sends the new plaintext, which overwrites.
//
//   save → saveConfig(input). 200 → "已保存" Alert(ok) + re-echo the returned masked
//          view (secret inputs reset to empty so their mask hint shows again). 400 →
//          show the backend's ApiError.message in an Alert(error); the form stays open,
//          nothing cleared. 401 → onNeedLogin (login flow), not an inline error.
//
//   test → testConnections(). Always resolves (HTTP 200) → render two rows, DeepSeek
//          and 飞书, each a Badge reflecting ok (连通 / 不可连通) + the probe's message.
//          "测不通" / "未配置" are normal results, NOT request failures — only a 401 /
//          network reject shows a failure state (and 401 → onNeedLogin).
//
// getConfig / saveConfig / testConnections default to the real configClient functions
// but are injectable so tests inject a fake client and stay deterministic (same pattern
// as auth.jsx's login/logout).

import React, { useState, useEffect, useCallback } from "react";
import { Dialog, Input, Button, Alert, Badge } from "@agentaily/design-system";
import {
  getConfig as defaultGetConfig,
  saveConfig as defaultSaveConfig,
  testConnections as defaultTestConnections,
} from "./core/configClient";
import { ApiError } from "./core/apiClient";

// Plaintext (non-secret) form fields seeded from the masked echo. Secret fields
// (apiKey, appSecret) live separately as always-empty-on-open editables.
const EMPTY_FIELDS = { model: "", appId: "", appToken: "", tableId: "" };

/**
 * @param {object}   props
 * @param {boolean}  props.open                 whether the dialog is shown
 * @param {() => void} props.onClose            close the dialog
 * @param {() => void} [props.onNeedLogin]      called on a 401 so App can pop login (§17)
 * @param {() => Promise} [props.getConfig]     injectable; defaults to configClient.getConfig
 * @param {(input) => Promise} [props.saveConfig]   injectable; defaults to configClient.saveConfig
 * @param {() => Promise} [props.testConnections]   injectable; defaults to configClient.testConnections
 */
export function SettingsDialog({
  open,
  onClose,
  onNeedLogin,
  getConfig = defaultGetConfig,
  saveConfig = defaultSaveConfig,
  testConnections = defaultTestConnections,
} = {}) {
  // The masked echo of the stored config (its secret masks are shown as hints, never
  // as editable values). null until the first getConfig resolves.
  const [config, setConfig] = useState(null);
  // Plaintext non-secret fields (echoed from `config`, then owner-editable).
  const [fields, setFields] = useState(EMPTY_FIELDS);
  // Secret editables — always start empty so the mask hint shows; a non-empty value
  // means "the owner typed a new secret" and is the only thing sent on save.
  const [apiKey, setApiKey] = useState("");
  const [appSecret, setAppSecret] = useState("");

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  // A backend-rejected save (e.g. 400) surfaces its message here, verbatim.
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);
  // Per-block connectivity probe results (null until 测试连接 runs).
  const [testResult, setTestResult] = useState(null);

  // A 401 from any owner-only call means the session is missing/expired (§17):
  // hand off to the login flow instead of rendering it as a settings error.
  const handleError = useCallback(
    (e) => {
      if (e instanceof ApiError && e.status === 401) {
        onNeedLogin?.();
        return true;
      }
      return false;
    },
    [onNeedLogin],
  );

  // Echo a masked view into the editable form: non-secret fields fill plaintext,
  // secret editables reset to empty (the mask shows as a hint, never as the value).
  const echo = useCallback((cfg) => {
    setConfig(cfg);
    setFields({
      model: cfg?.deepseek?.model ?? "",
      appId: cfg?.feishu?.appId ?? "",
      appToken: cfg?.feishu?.appToken ?? "",
      tableId: cfg?.feishu?.tableId ?? "",
    });
    setApiKey("");
    setAppSecret("");
  }, []);

  // On open, fetch + echo the current config. On close, drop transient state so a
  // reopen starts clean. `open === false` must do NO fetch / effect work (App mounts
  // this unconditionally) — the guard below keeps a closed dialog inert.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setSaveError("");
    setSaved(false);
    setTestResult(null);
    setLoading(true);
    Promise.resolve()
      .then(() => getConfig())
      .then((cfg) => {
        if (alive) echo(cfg);
      })
      .catch((e) => {
        if (!alive) return;
        // A 401 routes into login; a never-configured backend never errors here.
        handleError(e);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // getConfig is injected per-mount and stable in tests; re-run only on (re)open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // App mounts <SettingsDialog> unconditionally; when closed it must be fully inert —
  // render nothing and fire no fetch/effect. (The effect above also short-circuits.)
  if (!open) return null;

  // Any edit invalidates the "已保存" confirmation — the form no longer matches
  // what was last written, so drop the success Alert until the next save.
  const setField = (key) => (e) => {
    setSaved(false);
    const { value } = e.target;
    setFields((f) => ({ ...f, [key]: value }));
  };

  // Whether the stored config already has each secret (mask present) — used to keep
  // an untouched secret stored (omit it) rather than wiping it.
  const hasStoredApiKey = !!config?.deepseek?.apiKey;
  const hasStoredAppSecret = !!config?.feishu?.appSecret;

  // Build the ConfigInput, honoring the "don't re-submit the mask" rule (§12.4):
  // a secret left empty is OMITTED (undefined) so the backend keeps the stored value;
  // a typed secret is sent verbatim as new plaintext.
  const buildInput = () => {
    const deepseek = {};
    if (apiKey.trim()) deepseek.apiKey = apiKey;
    if (fields.model.trim()) deepseek.model = fields.model;

    // 飞书 is all-or-nothing: include the block when the owner provided/echoed any
    // 飞书 value (so a re-save keeps the stored app_secret via omission). When no
    // 飞书 field is set at all, omit the whole block (暂不配置飞书).
    const feishu = {};
    if (fields.appId.trim()) feishu.appId = fields.appId;
    if (appSecret.trim()) feishu.appSecret = appSecret;
    if (fields.appToken.trim()) feishu.appToken = fields.appToken;
    if (fields.tableId.trim()) feishu.tableId = fields.tableId;
    const hasFeishu = Object.keys(feishu).length > 0;

    return hasFeishu ? { deepseek, feishu } : { deepseek };
  };

  const onSave = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError("");
    setSaved(false);
    try {
      const out = await saveConfig(buildInput());
      echo(out); // re-echo the returned masked view; secret inputs reset to mask hints
      setSaved(true);
    } catch (e) {
      if (handleError(e)) return; // 401 → login flow, no inline error
      // 400 (missing key / half-filled 飞书) → surface the backend message verbatim;
      // the form stays open and nothing is cleared so the owner can fix and retry.
      setSaveError(e instanceof ApiError ? e.message : "保存失败，请检查网络或后端地址。");
    } finally {
      setSaving(false);
    }
  };

  const onTest = async () => {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testConnections();
      setTestResult(result); // ok:false / 未配置 are normal results, rendered per-block
    } catch (e) {
      if (handleError(e)) return; // 401 → login flow
      setTestResult({ error: "无法连接到后端，请检查网络。" });
    } finally {
      setTesting(false);
    }
  };

  // A configured secret shows its mask as a hint; touched (non-empty) → "将更新此密钥".
  const apiKeyHint = apiKey.trim()
    ? "将更新 DeepSeek key"
    : hasStoredApiKey
      ? `当前：${config.deepseek.apiKey}（留空则保持不变）`
      : undefined;
  const appSecretHint = appSecret.trim()
    ? "将更新飞书 app_secret"
    : hasStoredAppSecret
      ? `当前：${config.feishu.appSecret}（留空则保持不变）`
      : undefined;

  // A per-block probe row. The ok mark avoids the substring "连通" so the failing
  // mark ("不可连通") is the unambiguous "not connected" signal; the backend's note is
  // shown only on failure (a healthy block needs no explanation, and a successful
  // probe's note must not duplicate the connectivity wording).
  const probeRow = (name, probe) =>
    probe ? (
      <div className="d-settings__probe" key={name}>
        <Badge variant={probe.ok ? "ok" : "danger"} dot>
          {`${name} · ${probe.ok ? "已连接" : "不可连通"}`}
        </Badge>
        {!probe.ok && probe.message ? (
          <span className="d-settings__probe-msg">{probe.message}</span>
        ) : null}
      </div>
    ) : null;

  return (
    <Dialog
      open={open}
      title="集成设置"
      onClose={onClose}
      footer={
        <React.Fragment>
          <Button variant="secondary" disabled={testing || loading} onClick={onTest}>
            {testing ? "测试中…" : "测试连接"}
          </Button>
          <Button variant="primary" disabled={saving || loading} onClick={onSave}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </React.Fragment>
      }
    >
      <div className="d-settings">
        {saved ? (
          <Alert variant="ok" title="已保存">
            配置已写入。密钥以掩码回显，留空表示保持不变。
          </Alert>
        ) : null}
        {saveError ? (
          <Alert variant="danger" title="保存失败">
            {saveError}
          </Alert>
        ) : null}

        <section className="d-settings__block">
          <div className="ax-label">DEEPSEEK</div>
          <Input
            label="API KEY"
            type="password"
            mono
            placeholder={hasStoredApiKey ? "已配置（留空则保持不变）" : "sk-…"}
            hint={apiKeyHint}
            value={apiKey}
            onChange={(e) => {
              setSaved(false);
              setApiKey(e.target.value);
            }}
          />
          <Input
            label="MODEL"
            mono
            placeholder="deepseek-chat"
            value={fields.model}
            onChange={setField("model")}
          />
        </section>

        <section className="d-settings__block">
          <div className="ax-label">飞书多维表格</div>
          <Input
            label="APP ID"
            mono
            placeholder="cli_…"
            value={fields.appId}
            onChange={setField("appId")}
          />
          <Input
            label="APP SECRET"
            type="password"
            mono
            placeholder={hasStoredAppSecret ? "已配置（留空则保持不变）" : "…"}
            hint={appSecretHint}
            value={appSecret}
            onChange={(e) => {
              setSaved(false);
              setAppSecret(e.target.value);
            }}
          />
          <Input
            label="APP TOKEN"
            mono
            placeholder="bascn…"
            value={fields.appToken}
            onChange={setField("appToken")}
          />
          <Input
            label="TABLE ID"
            mono
            placeholder="tbl…"
            value={fields.tableId}
            onChange={setField("tableId")}
          />
        </section>

        {testResult ? (
          <section className="d-settings__block d-settings__test">
            <div className="ax-label">连接测试</div>
            {testResult.error ? (
              <Alert variant="danger" title="测试失败">
                {testResult.error}
              </Alert>
            ) : (
              <React.Fragment>
                {probeRow("DEEPSEEK", testResult.deepseek)}
                {probeRow("飞书", testResult.feishu)}
              </React.Fragment>
            )}
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}
