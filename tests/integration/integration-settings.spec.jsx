// Outer-loop acceptance for features/integration-settings.feature — the owner
// 集成设置 (SPEC §12 owner config + §14 connection test, §17 auth).
//
// Since DS 0.8.0 集成设置 is the 集成 tab of a floating settings overlay (src/settings.jsx →
// SettingsOverlay). DS 0.10.0 removed IntegrationSettings + FeishuCard, so the 集成 section is now
// SELF-COMPOSED: a readiness rail (gating only DeepSeek) + the still-shipped <DeepSeekCard> (no
// model select) + a self-built 飞书 card (ConnectionCard + Input/SecretField/HelpSteps). Plus this
// tab's OWN save bar, backend error display, and a 401 → onNeedLogin handoff (App then routes
// to /signin). We render the real <SettingsOverlay section="integrations"> and INJECT fake
// getConfig/saveConfig/testConnections/onNeedLogin via its props — the same deterministic seam
// auth.jsx uses. That keeps these tests about the tab's observable behavior (echo, save, backend
// errors, per-block test rows, 401 → onNeedLogin) without a backend or token store. The lower
// wire contract (path/method/payload, the don't-resubmit-the-mask rule) is pinned separately in
// tests/unit/configClient.test.js.
import React from "react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
// /pure → no auto afterEach(cleanup); @amiceli runs each Gherkin step as its own
// test, so cleanup is per-scenario (AfterEachScenario), never per-step.
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react/pure";
import { SettingsOverlay } from "../../src/settings.jsx";
import { ApiError } from "../../src/core/apiClient";

const here = path.dirname(fileURLToPath(import.meta.url));
const feature = await loadFeature(path.join(here, "../../features/integration-settings.feature"));

// A fully-configured masked view as GET /api/config would return it: secret fields
// (deepseek.apiKey, feishu.appSecret) come back MASKED; the rest plaintext (§12.3).
// ★ PR-4 link-less: the 飞书 card is now ONLY App ID + App Secret (account-level "连一次"
// credentials). app_token/table_id are no longer filled by the owner nor echoed — they're
// produced per-form by "发布即自动建表" (§16.9), not surfaced here. So a configured 飞书 view
// carries just { appId, appSecret }; no Bitable share link, no app_token/table_id read-out.
const MASKED_CONFIGURED = {
  deepseek: { apiKey: "sk-…wxyz", model: "deepseek-chat" },
  feishu: {
    appId: "cli_a1b2c3",
    appSecret: "yy…yy",
  },
  updatedAt: "2026-06-11T08:00:00.000Z",
};

// Never-configured backend → all-null skeleton (the normal "未配置" state, not error).
const MASKED_EMPTY = {
  deepseek: { apiKey: null, model: null },
  feishu: { appId: null, appSecret: null },
  updatedAt: null,
};

// Build an injectable fake client; each scenario overrides the relevant fn.
function fakeClient(overrides = {}) {
  return {
    getConfig: overrides.getConfig ?? vi.fn(async () => MASKED_EMPTY),
    saveConfig: overrides.saveConfig ?? vi.fn(async () => MASKED_CONFIGURED),
    testConnections:
      overrides.testConnections ??
      vi.fn(async () => ({ deepseek: { ok: true }, feishu: { ok: true } })),
  };
}

// Render the 集成 tab of the settings overlay with injected fakes; getConfig fires when the
// 集成 tab shows (here, on mount with section="integrations"), so wait for the form to settle
// (the Save action is present once the fetch resolves).
function openSettings(client, extra = {}) {
  render(
    <SettingsOverlay
      open
      section="integrations"
      onNeedLogin={extra.onNeedLogin ?? vi.fn()}
      getConfig={client.getConfig}
      saveConfig={client.saveConfig}
      testConnections={client.testConnections}
    />,
  );
}

// The Save button is the natural anchor for "the page is rendered and ready". (The
// TestRows also render a "测试连接" button per card, so scope Save by exact name.)
function saveButton() {
  return screen.getByRole("button", { name: "保存" });
}
// Each card renders its own TestRow "测试连接" button — the first is DeepSeek's.
function testButtons() {
  return screen.getAllByRole("button", { name: /测试连接|重新测试/ });
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  AfterEachScenario(() => cleanup());

  Scenario("打开设置拉取并回显已保存配置（密钥掩码）", ({ Given, And, When, Then }) => {
    const client = fakeClient({ getConfig: vi.fn(async () => MASKED_CONFIGURED) });
    Given("owner 已登录", () => {});
    And("后端已保存过 DeepSeek key 与飞书凭据", () => {
      expect(client.getConfig).not.toHaveBeenCalled();
    });
    When("owner 打开集成设置", async () => {
      openSettings(client);
      await waitFor(() => expect(client.getConfig).toHaveBeenCalled());
      await waitFor(() => expect(saveButton()).toBeInTheDocument());
    });
    Then("设置页用掩码值回显 DeepSeek key 与飞书 app_secret", async () => {
      // A stored secret surfaces as the card's MASKED affordance (placeholder "已保存…留空
      // 则保持不变") — the editable value stays empty so the real key is never shown nor
      // re-submitted. Both secret fields (DeepSeek key + 飞书 app_secret) show it.
      await waitFor(() => {
        const masked = screen.getAllByPlaceholderText(/已保存.*留空则保持不变/);
        expect(masked.length).toBe(2);
        masked.forEach((el) => expect(el.value).toBe(""));
      });
    });
    And("非密字段（app_id）以明文回显", () => {
      // app_id echoes in its input. PR-4 link-less: the 飞书 card has no share-link read-out
      // anymore, so app_token/table_id are neither filled nor displayed here. (DS 0.10.0 also
      // dropped the model <Select>, so model has no UI — it still round-trips through config,
      // just isn't displayed.)
      const inputs = Array.from(document.querySelectorAll("input"));
      const values = inputs.map((el) => el.value);
      expect(values).toContain("cli_a1b2c3"); // app_id input
      // No model <Select> is rendered anymore.
      expect(document.querySelector("select")).toBeNull();
    });
  });

  Scenario("从未配置时打开设置显示空表单", ({ Given, And, When, Then }) => {
    const client = fakeClient({ getConfig: vi.fn(async () => MASKED_EMPTY) });
    Given("owner 已登录", () => {});
    And("后端从未保存过配置", () => {});
    When("owner 打开集成设置", async () => {
      openSettings(client);
      await waitFor(() => expect(client.getConfig).toHaveBeenCalled());
      await waitFor(() => expect(saveButton()).toBeInTheDocument());
    });
    Then("设置页显示空的配置表单且无报错", async () => {
      // Cards are present (Save action exists) and no error Alert / masked affordance shows.
      const inputs = Array.from(document.querySelectorAll("input"));
      // All-null skeleton → no pre-filled plaintext values and no masked-secret placeholder.
      expect(inputs.every((el) => el.value === "")).toBe(true);
      expect(screen.queryByPlaceholderText(/已保存.*留空则保持不变/)).not.toBeInTheDocument();
      // No error surface from a normal never-configured load — the page's own danger
      // Alert ("保存失败") is absent (the cards' static security copy isn't an error).
      expect(screen.queryByText("保存失败")).not.toBeInTheDocument();
    });
  });

  Scenario("保存有效配置成功", ({ Given, When, Then, And }) => {
    const client = fakeClient({
      getConfig: vi.fn(async () => MASKED_EMPTY),
      saveConfig: vi.fn(async () => MASKED_CONFIGURED),
    });
    Given("owner 已登录并打开集成设置", async () => {
      openSettings(client);
      await waitFor(() => expect(saveButton()).toBeInTheDocument());
    });
    When("owner 填入 DeepSeek key 与完整飞书凭据并保存", async () => {
      // Fill the DeepSeek key plus the 飞书 App ID + App Secret — the complete account-level
      // 飞书 credential (PR-4 link-less: there is no share-link input anymore; app_token/
      // table_id are produced per-form at publish, not entered here).
      fireEvent.change(screen.getByPlaceholderText(/sk-/), { target: { value: "sk-newkey" } });
      fireEvent.change(screen.getByPlaceholderText("cli_xxxxxxxxxxxx"), {
        target: { value: "cli_real" },
      });
      const secretInput = document.querySelector('input[id="secret-app-secret"]');
      fireEvent.change(secretInput, { target: { value: "feishu-secret" } });
      fireEvent.click(saveButton());
      await waitFor(() => expect(client.saveConfig).toHaveBeenCalled());
    });
    Then("设置页提示保存成功", async () => {
      await screen.findByText(/已保存|保存成功/);
    });
    And("设置页用后端返回的掩码视图回显当前配置", async () => {
      // Re-echo of the returned masked view: both secret masks reset to the masked affordance
      // (DeepSeek key + 飞书 app_secret), with the plaintext app_id back. PR-4 link-less: there
      // is no app_token/table_id read-out to re-echo anymore.
      await waitFor(() => {
        expect(screen.getAllByPlaceholderText(/已保存.*留空则保持不变/).length).toBe(2);
      });
    });
  });

  Scenario("缺 DeepSeek key 时保存被后端拒绝并提示", ({ Given, When, And, Then }) => {
    const saveErr = new ApiError(400, "DeepSeek key 必填");
    const client = fakeClient({
      getConfig: vi.fn(async () => MASKED_EMPTY),
      saveConfig: vi.fn(async () => {
        throw saveErr;
      }),
    });
    Given("owner 已登录并打开集成设置", async () => {
      openSettings(client);
      await waitFor(() => expect(saveButton()).toBeInTheDocument());
    });
    When("owner 把 DeepSeek key 留空并保存", () => {
      // Make the form dirty (so Save is enabled) without typing a key — edit a non-key field
      // (飞书 App ID). DS 0.10.0 dropped the model <Select>, so there is no model field to nudge.
      fireEvent.change(screen.getByPlaceholderText("cli_xxxxxxxxxxxx"), {
        target: { value: "cli_dirty" },
      });
      fireEvent.click(saveButton());
    });
    And("后端返回 400 与错误说明", async () => {
      await waitFor(() => expect(client.saveConfig).toHaveBeenCalled());
    });
    Then("设置页显示后端给出的错误说明", async () => {
      // The backend's ApiError.message is surfaced verbatim, not a generic string — in the
      // page's top-level danger Alert and, since it names the DeepSeek key, the card field
      // error too (so it appears at least once).
      const hits = await screen.findAllByText("DeepSeek key 必填");
      expect(hits.length).toBeGreaterThanOrEqual(1);
    });
    And("配置未被保存", () => {
      // Page stays put and no success alert appears — the owner can retry.
      expect(saveButton()).toBeInTheDocument();
      expect(screen.queryByText(/已保存|保存成功/)).not.toBeInTheDocument();
    });
  });

  Scenario("不修改的密钥字段不会被覆盖", ({ Given, And, When, Then }) => {
    const client = fakeClient({
      getConfig: vi.fn(async () => MASKED_CONFIGURED),
      saveConfig: vi.fn(async () => MASKED_CONFIGURED),
    });
    Given("owner 已登录并打开集成设置", async () => {
      openSettings(client);
      await waitFor(() => expect(client.getConfig).toHaveBeenCalled());
    });
    And("设置页回显着 DeepSeek key 与飞书 app_secret 的掩码值", async () => {
      // Both stored secrets surface their masked affordance (untouched, empty editable).
      await waitFor(() => {
        const masked = screen.getAllByPlaceholderText(/已保存.*留空则保持不变/);
        expect(masked.length).toBe(2);
        masked.forEach((el) => expect(el.value).toBe(""));
      });
    });
    When("owner 只改了非密字段（飞书 App ID）而不动两个密钥字段并保存", async () => {
      // DS 0.10.0 dropped the model <Select>, so edit a non-secret field that still has UI —
      // the 飞书 App ID — leaving both secret fields untouched (empty masked affordance).
      fireEvent.change(screen.getByPlaceholderText("cli_xxxxxxxxxxxx"), {
        target: { value: "cli_edited" },
      });
      fireEvent.click(saveButton());
      await waitFor(() => expect(client.saveConfig).toHaveBeenCalled());
    });
    Then("提交里不包含 DeepSeek key 与飞书 app_secret 的密文", () => {
      const input = client.saveConfig.mock.calls[0][0];
      // Untouched secrets are OMITTED (undefined), never the mask, never plaintext.
      expect(input.deepseek.apiKey).toBeUndefined();
      if (input.feishu) expect(input.feishu.appSecret).toBeUndefined();
      // The mask string must not have leaked into the submitted payload.
      expect(JSON.stringify(input)).not.toContain("sk-…wxyz");
      expect(JSON.stringify(input)).not.toContain("yy…yy");
      // The edited non-secret IS submitted.
      expect(input.feishu.appId).toBe("cli_edited");
    });
    And("后端保留原有的两个密钥不变", () => {
      // Contract: omitting a secret subfield = "keep stored value" (configClient §12.4).
      const input = client.saveConfig.mock.calls[0][0];
      expect("apiKey" in input.deepseek).toBe(false);
    });
  });

  Scenario("测试连接逐条显示 DeepSeek 与飞书结果", ({ Given, When, And, Then }) => {
    const client = fakeClient({
      getConfig: vi.fn(async () => MASKED_CONFIGURED),
      testConnections: vi.fn(async () => ({
        deepseek: { ok: true, message: "可连通" },
        feishu: { ok: false, message: "凭据无效" },
      })),
    });
    Given("owner 已登录并打开集成设置", async () => {
      openSettings(client);
      await waitFor(() => expect(testButtons().length).toBe(2));
    });
    When("owner 点击测试连接", () => {
      // Either card's Test triggers the stored-config probe; click the DeepSeek one.
      fireEvent.click(testButtons()[0]);
    });
    And("后端返回 DeepSeek 可连通、飞书凭据无效", async () => {
      await waitFor(() => expect(client.testConnections).toHaveBeenCalled());
    });
    Then("设置页把 DeepSeek 标记为连通", async () => {
      // DeepSeek's card flips to its connected state — the green "已连接" StatusPill + the
      // backend note ("可连通") in its TestRow result line.
      await screen.findByText("可连通");
      expect(screen.getAllByText("已连接").length).toBeGreaterThanOrEqual(1);
    });
    And("设置页把飞书标记为不可连通并显示其说明", async () => {
      // 飞书's card flips to its error state — the red "连接失败" StatusPill + the note.
      await screen.findByText("凭据无效");
      expect(screen.getAllByText("连接失败").length).toBeGreaterThanOrEqual(1);
    });
  });

  Scenario("连不通是正常结果而非报错", ({ Given, When, And, Then }) => {
    const client = fakeClient({
      getConfig: vi.fn(async () => MASKED_EMPTY),
      testConnections: vi.fn(async () => ({
        deepseek: { ok: false, message: "未配置" },
        feishu: { ok: false, message: "未配置" },
      })),
    });
    Given("owner 已登录并打开集成设置", async () => {
      openSettings(client);
      await waitFor(() => expect(testButtons().length).toBe(2));
    });
    When("owner 点击测试连接", () => {
      fireEvent.click(testButtons()[0]);
    });
    And("后端返回两块都未配置", async () => {
      await waitFor(() => expect(client.testConnections).toHaveBeenCalled());
    });
    Then("设置页逐条显示两块均不可连通及其说明", async () => {
      // Both cards flip to their (normal) error state showing the "未配置" note — ok:false
      // is a result, not a request failure.
      await waitFor(() => {
        expect(screen.getAllByText("未配置").length).toBe(2);
        expect(screen.getAllByText("连接失败").length).toBe(2);
      });
    });
    And("设置页不显示请求失败的报错", () => {
      // ok:false is a normal result, NOT a request failure — no failure Alert.
      expect(screen.queryByText(/请求失败|测试失败|无法连接到后端/)).not.toBeInTheDocument();
    });
  });

  Scenario("未登录访问集成设置引导先登录", ({ Given, When, And, Then }) => {
    const onNeedLogin = vi.fn();
    const client = fakeClient({
      getConfig: vi.fn(async () => {
        throw new ApiError(401, "未授权");
      }),
    });
    Given("owner 未登录", () => {});
    When("owner 打开集成设置", () => {
      openSettings(client, { onNeedLogin });
    });
    And("拉取配置返回 401", async () => {
      await waitFor(() => expect(client.getConfig).toHaveBeenCalled());
    });
    Then("设置页提示需要先登录", async () => {
      // A 401 hands off to App (onNeedLogin) which routes into /signin — never an inline error.
      await waitFor(() => expect(onNeedLogin).toHaveBeenCalled());
    });
    And("引导去 owner 登录页", () => {
      // The handoff carries a reason for the login page, and the raw 401 message is never
      // surfaced as an inline settings error. (App turns this into /signin?return=/settings.)
      expect(onNeedLogin).toHaveBeenCalledWith(expect.stringContaining("登录"));
      expect(screen.queryByText(/未授权/)).not.toBeInTheDocument();
    });
  });
});
