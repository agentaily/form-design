// Outer-loop acceptance for features/data-dashboard.feature — the owner 数据后台
// (owner 侧「查看全部提交」, 第 6 步, SPEC §18 list submissions; §17 auth).
//
// ★ PR-6（chat13）: 提交数据现在是「我的表单」面板内的内容切换（不再是独立 Dialog）。所以这里渲染
//   the REAL <FormsPanel>（src/forms-panel.jsx），注入 fake listForms（一张表单）+ fake
//   listSubmissions，然后**经真实入口**驱动：打开面板 → 点卡片的「查看全部提交」→ 同一面板内 swap 出
//   提交数据 → 点某行「查看」进记录详情子页。这正是用户走的路径，也证明了「面板内切换、详情非弹窗」。
//
// ★ D1 主存 shape（#56）：每条提交是 { id, answers:[{label,value}], createdAt, feishu }（不再是旧
//   飞书的 { recordId, fields, createdTime }）。下层 wire 契约（path/method/auth:true/Bearer + 这个
//   shape 的透传）在 tests/unit/submissionsClient.test.js 钉死；这里只看视图的可观察行为。
import React from "react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
// /pure → no auto afterEach(cleanup); @amiceli runs each Gherkin step as its own test,
// so cleanup is per-scenario (AfterEachScenario), never per-step.
import { render, screen, within, waitFor, fireEvent, cleanup } from "@testing-library/react/pure";
import { FormsPanel } from "../../src/forms-panel.jsx";
import { ApiError } from "../../src/core/apiClient";

const here = path.dirname(fileURLToPath(import.meta.url));
const feature = await loadFeature(path.join(here, "../../features/data-dashboard.feature"));

const SLUG = "f8Kq2pXa";
// One published form whose card carries the「查看全部提交」entry.
const FORM = {
  slug: SLUG,
  meta: { title: "活动报名表" },
  status: "published",
  createdAt: "2026-06-01T00:00:00.000Z",
};

// A §18.2 submissions payload, D1 主存投影：answers carry string + string[] values.
const RESULT = {
  submissions: [
    {
      id: "sub-AAA",
      answers: [
        { label: "姓名", value: "张三" },
        { label: "兴趣", value: ["阅读", "运动"] },
      ],
      createdAt: "2026-06-10T08:00:00.000Z",
      feishu: { recordId: "recAAA", syncedAt: "2026-06-10T08:00:05.000Z", error: null },
    },
    {
      id: "sub-BBB",
      answers: [{ label: "姓名", value: "李四" }],
      createdAt: "2026-06-09T08:00:00.000Z",
      feishu: { recordId: null, syncedAt: null, error: null },
    },
  ],
  count: 2,
};

// Render the real panel (open) with injected owner-only seams. listForms returns FORM so
// its card — and the「查看全部提交」entry — is present.
function renderPanel({ listSubmissions, onNeedLogin } = {}) {
  return render(
    <FormsPanel
      open
      onClose={vi.fn()}
      onNeedLogin={onNeedLogin ?? vi.fn()}
      listForms={vi.fn(async () => [FORM])}
      updateForm={vi.fn(async (slug, patch) => ({ slug, status: patch.status }))}
      deleteForm={vi.fn(async (slug) => ({ ok: true, slug }))}
      publicFormUrl={(slug) => `https://forms.example/f/${slug}`}
      listSubmissions={listSubmissions}
    />,
  );
}

// Open the panel, wait for the form card, then click its「查看全部提交」(swaps the panel
// content to that form's 提交数据 in-place).
async function openSubmissions(opts) {
  renderPanel(opts);
  await screen.findByText("活动报名表");
  fireEvent.click(screen.getByRole("button", { name: /查看全部提交/ }));
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
    When("owner 点击该表单的「查看全部提交」", async () => {
      await openSubmissions({ listSubmissions: list });
    });
    And("后端返回该表单的提交列表与数量", async () => {
      // Opening the submissions view fetches that form's submissions by slug.
      await waitFor(() => expect(list).toHaveBeenCalledWith(SLUG));
    });
    Then("在同一面板内列出每条提交的字段值", async () => {
      // Each submission's answer VALUES render in the swapped-in 提交数据 table.
      await screen.findByText(/张三/);
      expect(screen.getByText(/李四/)).toBeInTheDocument();
      // a multi-value answer renders both of its values (array joined for display).
      expect(screen.getByText(/阅读/)).toBeInTheDocument();
      expect(screen.getByText(/运动/)).toBeInTheDocument();
    });
    And("显示提交总数", () => {
      // The 累计提交 stat shows the count (2) — scoped so the seq/近7天「2」don't collide.
      const totalStat = screen.getByText("累计提交").closest(".sb-stat");
      expect(within(totalStat).getByText("2")).toBeInTheDocument();
    });
  });

  // ── 面板内记录详情子页（非 Dialog）─────────────────────────────────────────────
  Scenario("点一条提交进入面板内的记录详情子页", ({ Given, When, Then, And }) => {
    const list = vi.fn(async () => RESULT);
    Given("owner 已登录并打开某份表单的提交数据", async () => {
      await openSubmissions({ listSubmissions: list });
      await screen.findByText(/张三/); // table is up
    });
    When("owner 点击其中一条提交的「查看」", () => {
      // The first row (newest submission, #2) → its detail sub-page.
      fireEvent.click(screen.getAllByRole("button", { name: "查看" })[0]);
    });
    Then("在同一面板内展开这条提交的完整作答", async () => {
      // The detail sub-page lists this submission's answers as label → value pairs:
      // the 兴趣 label + its joined value only exist in the detail view (table is gone).
      await screen.findByText("兴趣");
      expect(screen.getByText("阅读、运动")).toBeInTheDocument();
    });
    And("面包屑加到记录详情这一级且可回退到提交列表", async () => {
      // Breadcrumb grew to 我的表单 / 提交数据 / #2; the record level (#2) is shown and a
      // clickable「提交数据」returns to the list — all within the same panel. There are two
      // such affordances (the breadcrumb crumb + the detail sub-page's eyebrow ‹ 提交数据);
      // either returns to the submissions list.
      expect(screen.getByText("#2")).toBeInTheDocument();
      const back = screen.getAllByRole("button", { name: "提交数据" })[0];
      fireEvent.click(back);
      // Back on the list: the rows' 查看 buttons are present again.
      await waitFor(() =>
        expect(screen.getAllByRole("button", { name: "查看" }).length).toBeGreaterThan(0),
      );
    });
  });

  // ── 空态 ──────────────────────────────────────────────────────────────────────
  Scenario("一份表单还没有提交时显示空态", ({ Given, And, When, Then }) => {
    const list = vi.fn(async () => ({ submissions: [], count: 0 }));
    Given("owner 已登录并打开「我的表单」", () => {});
    And("其中一份表单还没有任何提交", () => {});
    When("owner 点击该表单的「查看全部提交」", async () => {
      await openSubmissions({ listSubmissions: list });
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
    Given("owner 打开「我的表单」并点击某份表单的「查看全部提交」", async () => {
      await openSubmissions({ listSubmissions: list, onNeedLogin });
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
      expect(onNeedLogin).toHaveBeenCalled();
      expect(screen.queryByText(/未授权/)).not.toBeInTheDocument();
    });
  });

  // ── 其它非 2xx：可重试错误 ─────────────────────────────────────────────────────
  Scenario("读取提交遇服务端错误时提示稍后重试", ({ Given, When, Then }) => {
    const list = vi.fn(async () => {
      throw new ApiError(500, "boom");
    });
    Given("owner 已登录并点击某份表单的「查看全部提交」", async () => {
      await openSubmissions({ listSubmissions: list });
      await waitFor(() => expect(list).toHaveBeenCalledWith(SLUG));
    });
    When("后端返回服务端错误", () => {
      // the injected list already rejected with 500 above
    });
    Then("页面提示加载提交失败请稍后重试", async () => {
      await screen.findByText(/加载.*失败|稍后重试|失败/);
    });
  });
});
