// Outer-loop acceptance for features/data-dashboard.feature — the owner 数据后台
// (owner 侧「看提交」, 第 6 步, SPEC §18 list submissions; §17 auth).
//
// We render the REAL <SubmissionsView> (src/submissions-view.jsx) and INJECT a fake
// listSubmissions via its prop — the same deterministic seam FormsPanel uses for its
// formsClient calls. That keeps these tests about the view's observable behavior
// (list each submission's field values + the count, empty state, 401 → onNeedLogin,
// 409 → 去集成设置 hint, 502 → retriable error) without a backend or token store.
// The lower wire contract (path/method/auth:true/Bearer + the { submissions,count }
// shape) is pinned in tests/unit/submissionsClient.test.js.
//
// The「看提交」entry lives per-form in FormsPanel (the stub fixes SubmissionsView's
// props: open/slug/title/onClose/onNeedLogin/listSubmissions); opening the view for a
// slug is modeled here by rendering it `open` with that slug.
import React from "react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
// /pure → no auto afterEach(cleanup); @amiceli runs each Gherkin step as its own test,
// so cleanup is per-scenario (AfterEachScenario), never per-step.
import { render, screen, waitFor, cleanup } from "@testing-library/react/pure";
import { SubmissionsView } from "../../src/submissions-view.jsx";
import { ApiError } from "../../src/core/apiClient";

const here = path.dirname(fileURLToPath(import.meta.url));
const feature = await loadFeature(path.join(here, "../../features/data-dashboard.feature"));

const SLUG = "f8Kq2pXa";

// A §18.2 submissions payload: rows whose fields carry string + string[] values.
const RESULT = {
  submissions: [
    {
      recordId: "recAAA",
      fields: { 姓名: "张三", 兴趣: ["阅读", "运动"] },
      createdTime: 1700000000000,
    },
    { recordId: "recBBB", fields: { 姓名: "李四" } },
  ],
  count: 2,
};

function renderView({ list, onNeedLogin } = {}) {
  return render(
    <SubmissionsView
      open
      slug={SLUG}
      title="活动报名表"
      onClose={vi.fn()}
      onNeedLogin={onNeedLogin ?? vi.fn()}
      listSubmissions={list}
    />,
  );
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  AfterEachScenario(() => cleanup());

  // ── 列出提交 + count ──────────────────────────────────────────────────────────
  Scenario("查看一份表单的提交列表与数量", ({ Given, And, When, Then }) => {
    const list = vi.fn(async () => RESULT);
    Given("owner 已登录并打开「我的表单」", () => {});
    And("其中一份表单已收到若干提交", () => {
      expect(RESULT.count).toBeGreaterThan(0);
    });
    When("owner 点击该表单的「看提交」", () => {
      renderView({ list });
    });
    And("后端返回该表单的提交列表与数量", async () => {
      // Opening the view fetches submissions for that slug.
      await waitFor(() => expect(list).toHaveBeenCalledWith(SLUG));
    });
    Then("列出每条提交的字段值", async () => {
      // Each submission's field VALUES are rendered (the answers the owner回收).
      await screen.findByText(/张三/);
      expect(screen.getByText(/李四/)).toBeInTheDocument();
      // a multi-value field renders both of its values (array joined for display)
      expect(screen.getByText(/阅读/)).toBeInTheDocument();
      expect(screen.getByText(/运动/)).toBeInTheDocument();
    });
    And("显示提交总数", () => {
      // The count (2) is shown alongside the list.
      expect(screen.getByText(/2/)).toBeInTheDocument();
    });
  });

  // ── 空态 ──────────────────────────────────────────────────────────────────────
  Scenario("一份表单还没有提交时显示空态", ({ Given, And, When, Then }) => {
    const list = vi.fn(async () => ({ submissions: [], count: 0 }));
    Given("owner 已登录并打开「我的表单」", () => {});
    And("其中一份表单还没有任何提交", () => {});
    When("owner 点击该表单的「看提交」", () => {
      renderView({ list });
    });
    And("后端返回空的提交列表", async () => {
      await waitFor(() => expect(list).toHaveBeenCalledWith(SLUG));
    });
    Then("显示「还没有收到提交」的空态且无报错", async () => {
      await screen.findByText(/还没有收到提交|暂无提交|还没有提交/);
      // An empty list is a normal state, NOT an error.
      expect(screen.queryByText(/出错|失败|无法/)).not.toBeInTheDocument();
    });
  });

  // ── 401 → onNeedLogin ────────────────────────────────────────────────────────
  Scenario("会话失效查看提交时引导先登录", ({ Given, When, Then, And }) => {
    const onNeedLogin = vi.fn();
    const list = vi.fn(async () => {
      throw new ApiError(401, "未授权");
    });
    Given("owner 打开「我的表单」并点击某份表单的「看提交」", async () => {
      renderView({ list, onNeedLogin });
      await waitFor(() => expect(list).toHaveBeenCalledWith(SLUG));
    });
    When("拉取提交列表返回 401", () => {
      // the injected list already rejected with 401 above
    });
    Then("提示需要先登录", async () => {
      // A 401 routes into the login flow rather than an inline view error.
      await waitFor(() => expect(onNeedLogin).toHaveBeenCalled());
    });
    And("自动弹出 owner 登录框", () => {
      // View-level we assert it hands off via onNeedLogin and does NOT render the raw
      // 401 inline (App wires the callback → pop login).
      expect(onNeedLogin).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/未授权/)).not.toBeInTheDocument();
    });
  });

  // ── 未配飞书：409 → 集成设置 ──────────────────────────────────────────────────
  Scenario("未连接飞书时提示去集成设置", ({ Given, When, Then }) => {
    const list = vi.fn(async () => {
      throw new ApiError(409, "owner 未配置飞书");
    });
    Given("owner 已登录并点击某份表单的「看提交」", async () => {
      renderView({ list });
      await waitFor(() => expect(list).toHaveBeenCalledWith(SLUG));
    });
    When("后端返回 409 表示尚未配置飞书", () => {
      // the injected list already rejected with 409 above
    });
    Then("页面提示需要先在集成设置里连接飞书", async () => {
      await screen.findByText(/集成设置|连接飞书|配置飞书/);
    });
  });

  // ── 上游错误：502 ─────────────────────────────────────────────────────────────
  Scenario("读取提交遇上游错误时提示稍后重试", ({ Given, When, Then }) => {
    const list = vi.fn(async () => {
      throw new ApiError(502, "upstream");
    });
    Given("owner 已登录并点击某份表单的「看提交」", async () => {
      renderView({ list });
      await waitFor(() => expect(list).toHaveBeenCalledWith(SLUG));
    });
    When("后端返回 502 上游错误", () => {
      // the injected list already rejected with 502 above
    });
    Then("页面提示加载提交失败请稍后重试", async () => {
      await screen.findByText(/加载.*失败|稍后重试|失败/);
    });
  });
});
