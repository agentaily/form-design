import React from "react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
// /pure → no auto afterEach(cleanup); @amiceli runs each step as its own test, so the rendered
// tree persists across the Given/When/Then of one scenario (cleanup runs per scenario).
import { render, screen, fireEvent, cleanup } from "@testing-library/react/pure";
import App from "../../src/App.jsx";
import { setToken, clearToken } from "../../src/core/apiClient";
import { authedCheck } from "../helpers/authGate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const feature = await loadFeature(path.join(here, "../../features/theme-persistence.feature"));

// theme-persistence.feature realized at the component level against the REAL <App>: the designer
// mounts behind <AuthGate> (driven by authedCheck), and theme is owned by @agentaily/design-system's
// <ThemeProvider> (wired in App). Production persists to the cross-subdomain cookie `agentaily:theme`
// (domain=.agentaily.com); on localhost that cookie is rejected so design-system's `auto` backend falls
// back to localStorage under the SAME key. We pin that localhost path by stubbing a working
// localStorage (Node 26's jsdom has none — same reason i18n-render.test.jsx stubs it) so design-system
// resolves to it and persistence round-trips deterministically.
const DESIGNER = "描述你想要的表单";
const THEME_BTN = "切换主题"; // IconButton label → aria-label
const STORAGE_KEY = "agentaily:theme";

const verifiedMe = async () => ({ email: "owner@example.com", emailVerified: true });

const themeAttr = () => document.documentElement.getAttribute("data-theme");

/** Install a Map-backed localStorage (optionally seeded) so design-system + the test share one store. */
function installStorage(seed) {
  const store = new Map(seed ? Object.entries(seed) : []);
  vi.stubGlobal("localStorage", {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => void store.clear(),
  });
}

const renderDesigner = () =>
  render(<App chat={vi.fn()} checkSession={authedCheck} getCurrentUser={verifiedMe} />);

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  AfterEachScenario(() => {
    cleanup();
    clearToken();
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute("data-theme");
  });

  Scenario("无持久化偏好时默认 dark", ({ Given, When, Then }) => {
    Given("owner 从未切换过主题(无任何持久化偏好)", () => {
      setToken("owner-jwt");
      installStorage();
    });
    When("进入设计器", async () => {
      renderDesigner();
      await screen.findByText(DESIGNER);
    });
    Then("文档主题为 dark", () => {
      expect(themeAttr()).toBe("dark");
    });
  });

  Scenario("设计器读回已持久化的主题(刷新后不回落 dark)", ({ Given, When, Then }) => {
    Given("已持久化的主题偏好是 light", () => {
      setToken("owner-jwt");
      installStorage({ [STORAGE_KEY]: "light" });
    });
    When("进入设计器", async () => {
      renderDesigner();
      await screen.findByText(DESIGNER);
    });
    Then("文档主题为 light", () => {
      expect(themeAttr()).toBe("light");
    });
  });

  Scenario("在设计器切换主题会写入持久化存储", ({ Given, When, Then, And }) => {
    Given("owner 从未切换过主题(无任何持久化偏好)", () => {
      setToken("owner-jwt");
      installStorage();
    });
    When("进入设计器并点击主题钮", async () => {
      renderDesigner();
      await screen.findByText(DESIGNER);
      fireEvent.click(screen.getByRole("button", { name: THEME_BTN }));
    });
    Then("文档主题为 light", () => {
      expect(themeAttr()).toBe("light");
    });
    And("持久化存储里的主题偏好是 light", () => {
      expect(localStorage.getItem(STORAGE_KEY)).toBe("light");
    });
  });

  Scenario("切换后重新加载仍保持所选主题", ({ Given, When, Then, And }) => {
    Given("owner 从未切换过主题(无任何持久化偏好)", () => {
      setToken("owner-jwt");
      installStorage();
    });
    When("进入设计器并点击主题钮", async () => {
      renderDesigner();
      await screen.findByText(DESIGNER);
      fireEvent.click(screen.getByRole("button", { name: THEME_BTN }));
    });
    And("重新加载设计器", async () => {
      // Simulate a full reload: tear down the tree and force the applied attribute back to the
      // default, so only re-reading the persisted preference can restore "light".
      cleanup();
      document.documentElement.setAttribute("data-theme", "dark");
      renderDesigner();
      await screen.findByText(DESIGNER);
    });
    Then("文档主题为 light", () => {
      expect(themeAttr()).toBe("light");
    });
  });
});
