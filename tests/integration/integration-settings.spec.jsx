// Outer-loop acceptance for features/integration-settings.feature — the owner
// integration-settings modal (SPEC §12 owner config + §14 connection test, §17 auth).
//
// We render the real <SettingsDialog> (src/settings.jsx) and INJECT fake
// getConfig/saveConfig/testConnections via its props — the same deterministic seam
// auth.jsx uses for login/logout. That keeps these tests about the dialog's
// observable behavior (echo, save, errors, per-block test rows, 401 → onNeedLogin)
// without a backend or token store. The lower wire contract (path/method/payload,
// the don't-resubmit-the-mask rule) is pinned separately in
// tests/unit/configClient.test.js.
import React from "react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
// /pure → no auto afterEach(cleanup); @amiceli runs each Gherkin step as its own
// test, so cleanup is per-scenario (AfterEachScenario), never per-step.
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react/pure";
import { SettingsDialog } from "../../src/settings.jsx";
import { ApiError } from "../../src/core/apiClient";

const here = path.dirname(fileURLToPath(import.meta.url));
const feature = await loadFeature(path.join(here, "../../features/integration-settings.feature"));

// A fully-configured masked view as GET /api/config would return it: secret fields
// (deepseek.apiKey, feishu.appSecret) come back MASKED; the rest plaintext (§12.3).
const MASKED_CONFIGURED = {
  deepseek: { apiKey: "sk-…wxyz", model: "deepseek-chat" },
  feishu: {
    appId: "cli_a1b2c3",
    appSecret: "yy…yy",
    appToken: "bascnTOKEN",
    tableId: "tblTABLE",
  },
  updatedAt: "2026-06-11T08:00:00.000Z",
};

// Never-configured backend → all-null skeleton (the normal "未配置" state, not error).
const MASKED_EMPTY = {
  deepseek: { apiKey: null, model: null },
  feishu: { appId: null, appSecret: null, appToken: null, tableId: null },
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

// Render the dialog open with injected fakes; getConfig fires on open, so wait for
// the form to settle (the save action is present once the fetch resolves).
function openSettings(client, extra = {}) {
  render(
    <SettingsDialog
      open
      onClose={extra.onClose ?? vi.fn()}
      onNeedLogin={extra.onNeedLogin}
      getConfig={client.getConfig}
      saveConfig={client.saveConfig}
      testConnections={client.testConnections}
    />,
  );
}

// The Save button is the natural anchor for "the form is rendered and ready".
function saveButton() {
  return screen.getByRole("button", { name: /保存/ });
}
function testButton() {
  return screen.getByRole("button", { name: /测试|连接/ });
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
      await screen.findByRole("dialog");
    });
    Then("弹窗用掩码值回显 DeepSeek key 与飞书 app_secret", async () => {
      // Secret fields surface their masked echo (placeholder/hint/value) — never
      // the real key. The mask strings are contract-fixed (§12.3/§12.4).
      await waitFor(() => {
        expect(screen.getByText("sk-…wxyz", { exact: false })).toBeInTheDocument();
        expect(screen.getByText("yy…yy", { exact: false })).toBeInTheDocument();
      });
    });
    And("非密字段（model / app_id / app_token / table_id）以明文回显", () => {
      const dialog = screen.getByRole("dialog");
      const inputs = dialog.querySelectorAll("input");
      const values = Array.from(inputs).map((el) => el.value);
      expect(values).toContain("deepseek-chat");
      expect(values).toContain("cli_a1b2c3");
      expect(values).toContain("bascnTOKEN");
      expect(values).toContain("tblTABLE");
    });
  });

  Scenario("从未配置时打开设置显示空表单", ({ Given, And, When, Then }) => {
    const client = fakeClient({ getConfig: vi.fn(async () => MASKED_EMPTY) });
    Given("owner 已登录", () => {});
    And("后端从未保存过配置", () => {});
    When("owner 打开集成设置", async () => {
      openSettings(client);
      await waitFor(() => expect(client.getConfig).toHaveBeenCalled());
      await screen.findByRole("dialog");
    });
    Then("弹窗显示空的配置表单且无报错", async () => {
      // Form is present (save action exists) and no error Alert / mask echo shows.
      await waitFor(() => expect(saveButton()).toBeInTheDocument());
      const dialog = screen.getByRole("dialog");
      const values = Array.from(dialog.querySelectorAll("input")).map((el) => el.value);
      // All-null skeleton → no pre-filled plaintext values.
      expect(values.every((v) => v === "")).toBe(true);
      // No error surface from a normal never-configured load.
      expect(screen.queryByText(/出错|失败|无法/)).not.toBeInTheDocument();
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
      const dialog = screen.getByRole("dialog");
      const inputs = Array.from(dialog.querySelectorAll("input"));
      // Fill every field so the save carries a valid, complete config.
      inputs.forEach((el, i) => fireEvent.change(el, { target: { value: `val-${i}` } }));
      fireEvent.click(saveButton());
      await waitFor(() => expect(client.saveConfig).toHaveBeenCalled());
    });
    Then("弹窗提示保存成功", async () => {
      await screen.findByText(/已保存|保存成功/);
    });
    And("弹窗用后端返回的掩码视图回显当前配置", async () => {
      // Re-echo of the returned masked view: secret masks back, plaintext back.
      await waitFor(() => {
        expect(screen.getByText("sk-…wxyz", { exact: false })).toBeInTheDocument();
        expect(screen.getByText("yy…yy", { exact: false })).toBeInTheDocument();
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
      fireEvent.click(saveButton());
    });
    And("后端返回 400 与错误说明", async () => {
      await waitFor(() => expect(client.saveConfig).toHaveBeenCalled());
    });
    Then("弹窗显示后端给出的错误说明", async () => {
      // The backend's ApiError.message is surfaced verbatim, not a generic string.
      await screen.findByText("DeepSeek key 必填");
    });
    And("配置未被保存", () => {
      // Dialog stays open and no success alert appears — the owner can retry.
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.queryByText(/已保存|保存成功/)).not.toBeInTheDocument();
    });
  });

  Scenario("飞书字段半填时保存被后端拒绝并提示", ({ Given, When, And, Then }) => {
    const saveErr = new ApiError(400, "飞书凭据需要一次性完整填写");
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
    When("owner 只填了部分飞书字段并保存", () => {
      // Fill exactly ONE 飞书 field (APP ID, targeted by its placeholder) and leave
      // the other 飞书 fields empty — this is the observable "half-filled 飞书" state.
      // The first DOM input is DeepSeek's API KEY, so picking it would not exercise
      // 飞书 at all; address the APP ID input directly.
      fireEvent.change(screen.getByPlaceholderText("cli_…"), {
        target: { value: "cli_partial" },
      });
      fireEvent.click(saveButton());
    });
    And("后端返回 400 与错误说明", async () => {
      await waitFor(() => expect(client.saveConfig).toHaveBeenCalled());
      // Make the half-filled state observable on the wire: saveConfig must receive a
      // 飞书 block carrying only appId, with the other 飞书 keys absent (omitted, per
      // the "don't send empty fields" rule) — that absence is exactly what a real
      // backend would reject with this 400.
      const input = client.saveConfig.mock.calls[0][0];
      expect(input.feishu).toBeTruthy();
      expect(input.feishu.appId).toBe("cli_partial");
      expect("appSecret" in input.feishu).toBe(false);
      expect("appToken" in input.feishu).toBe(false);
      expect("tableId" in input.feishu).toBe(false);
    });
    Then("弹窗显示后端给出的错误说明", async () => {
      await screen.findByText("飞书凭据需要一次性完整填写");
    });
    And("配置未被保存", () => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
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
    And("弹窗回显着 DeepSeek key 与飞书 app_secret 的掩码值", async () => {
      await waitFor(() => {
        expect(screen.getByText("sk-…wxyz", { exact: false })).toBeInTheDocument();
        expect(screen.getByText("yy…yy", { exact: false })).toBeInTheDocument();
      });
    });
    When("owner 只改了 model 而不动两个密钥字段并保存", async () => {
      const dialog = screen.getByRole("dialog");
      // Find the input whose value is the echoed model plaintext and edit only it.
      const modelInput = Array.from(dialog.querySelectorAll("input")).find(
        (el) => el.value === "deepseek-chat",
      );
      expect(modelInput, "model field should echo its plaintext value").toBeTruthy();
      fireEvent.change(modelInput, { target: { value: "deepseek-reasoner" } });
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
      expect(input.deepseek.model).toBe("deepseek-reasoner");
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
      await waitFor(() => expect(testButton()).toBeInTheDocument());
    });
    When("owner 点击测试连接", () => {
      fireEvent.click(testButton());
    });
    And("后端返回 DeepSeek 可连通、飞书凭据无效", async () => {
      await waitFor(() => expect(client.testConnections).toHaveBeenCalled());
    });
    Then("弹窗把 DeepSeek 标记为连通", async () => {
      // The success mark is "已连接" (it deliberately avoids the "连通" substring so
      // the failing "不可连通" row is the unambiguous not-connected signal). Assert
      // the DeepSeek row itself rendered the connected state — the badge text is the
      // literal DOM string "DEEPSEEK · 已连接" (the ax-label uppercasing is CSS only).
      await screen.findByText(/DEEPSEEK.*已连接/);
    });
    And("弹窗把飞书标记为不可连通并显示其说明", async () => {
      await screen.findByText("凭据无效");
      expect(screen.getByText(/不可连通/)).toBeInTheDocument();
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
      await waitFor(() => expect(testButton()).toBeInTheDocument());
    });
    When("owner 点击测试连接", () => {
      fireEvent.click(testButton());
    });
    And("后端返回两块都未配置", async () => {
      await waitFor(() => expect(client.testConnections).toHaveBeenCalled());
    });
    Then("弹窗逐条显示两块均不可连通及其说明", async () => {
      await waitFor(() => {
        expect(screen.getAllByText(/不可连通/).length).toBe(2);
        expect(screen.getAllByText("未配置").length).toBe(2);
      });
    });
    And("弹窗不显示请求失败的报错", () => {
      // ok:false is a normal result, NOT a request failure — no failure Alert.
      expect(screen.queryByText(/请求失败|测试失败|出错|无法连接/)).not.toBeInTheDocument();
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
    Then("弹窗提示需要先登录", async () => {
      // A 401 routes into the login flow rather than an inline settings error.
      await waitFor(() => expect(onNeedLogin).toHaveBeenCalled());
    });
    And("自动弹出 owner 登录框", () => {
      // Here (dialog-level) we only assert the dialog asks for login via onNeedLogin
      // and does NOT render the 401 as its own inline error. The App-level wiring of
      // that callback (close settings + open login) is covered by the App-level test
      // "App wiring: integration-settings 401 routes into owner login" in
      // tests/integration/app-settings-login.spec.jsx.
      expect(onNeedLogin).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/未授权/)).not.toBeInTheDocument();
    });
  });
});
