// Outer-loop acceptance for features/account-profile.feature — the owner 账户 tab of the
// settings overlay (SPEC §17 个人资料: editable 显示名, persisted to the real profile backend).
//
// Since DS 0.8.0, 账户设置 is the 账户 tab of <SettingsOverlay> (src/settings.jsx →
// AccountSection), driven by Form.useForm + an explicit SettingsSaveBar. We render the real
// <SettingsOverlay section="account"> and INJECT a fake updateProfile + user + onLogout +
// onNeedLogin + onProfileSaved via props — the same deterministic seam the integration tab uses.
// The lower wire contract (PUT /api/auth/profile path/method/body, the 401/400 mapping) is pinned
// in tests/unit/auth.test.js.
import React from "react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react/pure";
import { SettingsOverlay } from "../../src/settings.jsx";
import { ApiError } from "../../src/core/apiClient";

const here = path.dirname(fileURLToPath(import.meta.url));
const feature = await loadFeature(path.join(here, "../../features/account-profile.feature"));

const OWNER = { email: "owner@example.com", displayName: null };

// Render the 账户 tab with injected seams; each scenario overrides the relevant fn.
function openAccount(extra = {}) {
  const seams = {
    user: extra.user ?? OWNER,
    updateProfile:
      extra.updateProfile ?? vi.fn(async (name) => ({ ...OWNER, displayName: name || null })),
    onLogout: extra.onLogout ?? vi.fn(),
    onNeedLogin: extra.onNeedLogin ?? vi.fn(),
    onProfileSaved: extra.onProfileSaved ?? vi.fn(),
  };
  render(<SettingsOverlay open section="account" {...seams} />);
  return seams;
}

// The 显示名 input (placeholder mirrors the design). 登录邮箱 is a separate, disabled input.
function nameInput() {
  return screen.getByPlaceholderText("如：陈伟");
}
function saveButton() {
  return screen.getByRole("button", { name: "保存" });
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  AfterEachScenario(() => cleanup());

  Scenario("打开账户 tab 显示身份与可编辑显示名", ({ Given, When, Then, And }) => {
    let seams;
    Given("owner 已登录", () => {});
    When("owner 打开账户设置", () => {
      seams = openAccount({ user: { email: "owner@example.com", displayName: null } });
    });
    Then("账户 tab 显示 owner 的登录邮箱", () => {
      // The email shows in the identity block AND the read-only 登录邮箱 input.
      expect(screen.getAllByText("owner@example.com").length).toBeGreaterThanOrEqual(1);
    });
    And("账户 tab 显示可编辑的「显示名称」输入框", () => {
      const input = nameInput();
      expect(input).toBeInTheDocument();
      expect(input.disabled).toBe(false);
    });
  });

  Scenario("编辑并保存显示名持久化到后端", ({ Given, When, Then, And }) => {
    let seams;
    Given("owner 已登录并打开账户设置", () => {
      seams = openAccount();
    });
    When("owner 把显示名称改成「陈伟」并保存", async () => {
      fireEvent.change(nameInput(), { target: { value: "陈伟" } });
      // Editing makes the form dirty → the 保存 bar enables.
      await waitFor(() => expect(saveButton()).toBeEnabled());
      fireEvent.click(saveButton());
      await waitFor(() => expect(seams.updateProfile).toHaveBeenCalled());
    });
    Then("账户设置把显示名「陈伟」写到 profile 后端", () => {
      expect(seams.updateProfile).toHaveBeenCalledWith("陈伟");
    });
    And("保存后显示名以「陈伟」回流到账户控件", async () => {
      await waitFor(() => expect(seams.onProfileSaved).toHaveBeenCalled());
      expect(seams.onProfileSaved.mock.calls[0][0]).toMatchObject({ displayName: "陈伟" });
    });
  });

  Scenario("显示名过长保存被拦下", ({ Given, When, Then, And }) => {
    let seams;
    Given("owner 已登录并打开账户设置", () => {
      seams = openAccount();
    });
    When("owner 填入超过长度上限的显示名并尝试保存", async () => {
      fireEvent.change(nameInput(), { target: { value: "名".repeat(65) } });
      await waitFor(() => expect(saveButton()).toBeEnabled());
      fireEvent.click(saveButton());
    });
    Then("账户设置不把过长的显示名写到后端", async () => {
      // Client-side maxLength validation blocks the submit — updateProfile is never called.
      await waitFor(() => expect(screen.getByText(/显示名称最多/)).toBeInTheDocument());
      expect(seams.updateProfile).not.toHaveBeenCalled();
    });
    And("账户 tab 就地提示显示名过长", () => {
      expect(screen.getByText(/显示名称最多/)).toBeInTheDocument();
    });
  });

  Scenario("保存时会话失效引导先登录", ({ Given, When, Then, And }) => {
    let seams;
    Given("owner 已登录并打开账户设置", () => {
      seams = openAccount({
        updateProfile: vi.fn(async () => {
          throw new ApiError(401, "未授权");
        }),
      });
    });
    When("owner 保存显示名但后端返回 401", async () => {
      fireEvent.change(nameInput(), { target: { value: "陈伟" } });
      await waitFor(() => expect(saveButton()).toBeEnabled());
      fireEvent.click(saveButton());
      await waitFor(() => expect(seams.updateProfile).toHaveBeenCalled());
    });
    Then("账户设置引导 owner 先去登录页", async () => {
      await waitFor(() => expect(seams.onNeedLogin).toHaveBeenCalled());
    });
    And("不把 401 当作就地的保存错误展示", () => {
      expect(screen.queryByText(/未授权/)).not.toBeInTheDocument();
    });
  });

  Scenario("从账户 tab 退出登录", ({ Given, When, Then }) => {
    let seams;
    Given("owner 已登录并打开账户设置", () => {
      seams = openAccount();
    });
    When("owner 在账户 tab 点击退出登录", () => {
      fireEvent.click(screen.getByRole("button", { name: /退出登录/ }));
    });
    Then("账户设置触发退出登录", () => {
      expect(seams.onLogout).toHaveBeenCalled();
    });
  });
});
