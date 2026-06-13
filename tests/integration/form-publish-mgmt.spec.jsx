// Outer-loop acceptance for features/form-publish-mgmt.feature — the owner
// "发布 + 表单管理" surface (SPEC §16 发布/公开链接 + §21 owner-only 管理 CRUD, §17 auth).
//
// We render the real <PublishFeedback> and <FormsPanel> (src/forms-panel.jsx) and
// INJECT fake publishForm/listForms/updateForm/deleteForm/publicFormUrl via their
// props — the same deterministic seam settings.jsx uses for getConfig/saveConfig.
// That keeps these tests about the components' observable behavior (public link
// shown + copied, list rows with title/status/createdAt/link, empty state, status
// toggle, delete-with-confirm, 401 → onNeedLogin without an inline error) without a
// backend or token store. The lower wire contract (path/method/auth, the designer→
// §16.2 mapping, the { forms,count } unwrap) is pinned in tests/unit/formsClient.test.js.
//
// publicFormUrl is injected as the identity-ish /f/:slug builder so the public link
// text is deterministic and we assert on what the component chose to render.
import React from "react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
// /pure → no auto afterEach(cleanup); @amiceli runs each Gherkin step as its own
// test, so cleanup is per-scenario (AfterEachScenario), never per-step.
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react/pure";
import { FormsPanel, PublishFeedback } from "../../src/forms-panel.jsx";
import { ApiError } from "../../src/core/apiClient";

const here = path.dirname(fileURLToPath(import.meta.url));
const feature = await loadFeature(path.join(here, "../../features/form-publish-mgmt.feature"));

// A deterministic public-link builder injected in place of the real publicFormUrl:
// same /f/:slug shape (§16.4.1) so the link the component renders is predictable.
const fakePublicUrl = (slug) => `/f/${slug}`;

// A designer-shape form (FormMeta + UiField[]) ready to publish.
const META = { title: "活动报名表", desc: "请填写你的报名信息" };
const FIELDS = [{ id: "f_name", type: "text", label: "姓名", required: true }];

// Owner summaries as listForms() would resolve them (§21.2 — NO fields).
const PUBLISHED_FORM = {
  slug: "f8Kq2pXa",
  meta: { title: "活动报名表", description: "请填写你的报名信息" },
  status: "published",
  createdAt: "2026-06-11T08:00:00.000Z",
};
const CLOSED_FORM = {
  slug: "c1L0sed00",
  meta: { title: "已结束的问卷" },
  status: "closed",
  createdAt: "2026-05-01T08:00:00.000Z",
};

function fakeFormsClient(overrides = {}) {
  return {
    listForms: overrides.listForms ?? vi.fn(async () => []),
    updateForm:
      overrides.updateForm ?? vi.fn(async (slug, patch) => ({ slug, status: patch.status })),
    deleteForm: overrides.deleteForm ?? vi.fn(async (slug) => ({ ok: true, slug })),
    publishForm: overrides.publishForm ?? vi.fn(async () => ({ slug: "f8Kq2pXa" })),
    publicFormUrl: overrides.publicFormUrl ?? vi.fn(fakePublicUrl),
  };
}

function renderPanel(client, extra = {}) {
  render(
    <FormsPanel
      open
      onClose={extra.onClose ?? vi.fn()}
      onNeedLogin={extra.onNeedLogin}
      listForms={client.listForms}
      updateForm={client.updateForm}
      deleteForm={client.deleteForm}
      publicFormUrl={client.publicFormUrl}
    />,
  );
}

function renderPublish(client, extra = {}) {
  render(
    <PublishFeedback
      open
      onClose={extra.onClose ?? vi.fn()}
      onNeedLogin={extra.onNeedLogin}
      onPublished={extra.onPublished}
      meta={extra.meta ?? META}
      fields={extra.fields ?? FIELDS}
      publishForm={client.publishForm}
      publicFormUrl={client.publicFormUrl}
    />,
  );
}

// The card for a given form, located by its title; card-scoped queries hang off this.
// Since PR-5 the panel is a PanelSheet of form CARDS (was a Dialog of <li> rows); the
// per-card lifecycle actions (关闭收集 / 重新发布 / 删除) moved into a `⋯` DropdownMenu.
function rowFor(title) {
  const titleEl = screen.getByText(title);
  // Walk up to the nearest card/row container (data-slug is kept on the card).
  const row =
    titleEl.closest("li, tr, [role='listitem'], [data-slug]") ||
    titleEl.closest(".d-formcard, .d-formrow, [class*='card'], [class*='row']") ||
    titleEl.parentElement;
  return within(row || titleEl.parentElement);
}

// Open the card's `⋯` overflow menu so its menu items (关闭收集 / 重新发布 / 删除) mount,
// then return a `screen`-scoped query for them (only one menu is ever open at a time).
function openCardMenu(title) {
  fireEvent.click(rowFor(title).getByRole("button", { name: /更多操作/ }));
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  AfterEachScenario(() => cleanup());

  // ── 发布 ────────────────────────────────────────────────────────────────────
  Scenario("发布当前表单拿到公开填写链接", ({ Given, And, When, Then }) => {
    const onPublished = vi.fn();
    const client = fakeFormsClient({
      publishForm: vi.fn(async () => ({ slug: "f8Kq2pXa" })),
      publicFormUrl: vi.fn(fakePublicUrl),
    });
    Given("owner 已登录", () => {});
    And("设计器里已有一份带标题和至少一个字段的表单", () => {
      // META has a title; FIELDS has one field — the publishable precondition.
      expect(META.title).toBeTruthy();
      expect(FIELDS.length).toBeGreaterThan(0);
    });
    When("owner 点击发布", () => {
      renderPublish(client, { onPublished });
    });
    And("后端返回新建表单的 slug", async () => {
      await waitFor(() => expect(client.publishForm).toHaveBeenCalled());
      // publishForm was handed exactly the designer model App already holds.
      expect(client.publishForm).toHaveBeenCalledWith(META, FIELDS);
    });
    Then("反馈里展示该 slug 对应的公开填写链接", async () => {
      // The component renders the public fill link for the returned slug (/f/:slug).
      await screen.findByText("/f/f8Kq2pXa", { exact: false });
    });
    And("顶栏状态标记为已发布", async () => {
      // PublishFeedback signals success up to App via onPublished so App flips the
      // header status badge to LIVE/已发布 (that header flip is App's job; here we
      // assert the success signal that drives it actually fired with the result).
      await waitFor(() => expect(onPublished).toHaveBeenCalled());
      expect(onPublished.mock.calls[0][0]).toMatchObject({ slug: "f8Kq2pXa" });
    });
  });

  Scenario("复制公开填写链接", ({ Given, When, Then }) => {
    const writeText = vi.fn(async () => {});
    // Stub the clipboard before render so the copy affordance can reach it.
    Object.assign(navigator, { clipboard: { writeText } });
    const client = fakeFormsClient({
      publishForm: vi.fn(async () => ({ slug: "f8Kq2pXa" })),
      publicFormUrl: vi.fn(fakePublicUrl),
    });
    Given("owner 刚发布了一份表单并看到公开填写链接", async () => {
      renderPublish(client);
      await screen.findByText("/f/f8Kq2pXa", { exact: false });
    });
    When("owner 点击复制链接", async () => {
      // The copy affordance — a button named for copying the link.
      fireEvent.click(screen.getByRole("button", { name: /复制/ }));
      await waitFor(() => expect(writeText).toHaveBeenCalled());
    });
    Then("该公开填写链接被复制到剪贴板", () => {
      // The exact public link (/f/:slug) is what got written to the clipboard.
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining("/f/f8Kq2pXa"));
    });
  });

  Scenario("空表单无法发布", ({ Given, And, Then }) => {
    const client = fakeFormsClient();
    Given("owner 已登录", () => {});
    And("设计器里还没有任何字段", () => {
      renderPublish(client, { fields: [] });
    });
    Then("发布按钮不可点击", async () => {
      // The 发布 action exists but is disabled while there are no fields, so a click
      // never reaches publishForm.
      const publishBtn = await screen.findByRole("button", { name: /发布/ });
      expect(publishBtn).toBeDisabled();
      fireEvent.click(publishBtn);
      expect(client.publishForm).not.toHaveBeenCalled();
    });
  });

  Scenario("后端拒绝缺标题的发布并提示", ({ Given, And, When, Then }) => {
    const onPublished = vi.fn();
    const client = fakeFormsClient({
      publishForm: vi.fn(async () => {
        throw new ApiError(400, "meta.title 必填");
      }),
    });
    Given("owner 已登录", () => {});
    And("设计器里有字段但表单缺少标题", () => {
      renderPublish(client, { meta: { title: "" }, fields: FIELDS, onPublished });
    });
    When("owner 点击发布", () => {
      fireEvent.click(screen.getByRole("button", { name: /发布/ }));
    });
    And("后端返回 400 与错误说明", async () => {
      await waitFor(() => expect(client.publishForm).toHaveBeenCalled());
    });
    Then("反馈里显示后端给出的错误说明", async () => {
      // The backend's ApiError.message is surfaced verbatim, not a generic string.
      await screen.findByText("meta.title 必填");
    });
    And("顶栏状态仍为草稿", () => {
      // No success → the header-status signal never fired, so App keeps DRAFT.
      expect(onPublished).not.toHaveBeenCalled();
      // No public link rendered on a failed publish.
      expect(screen.queryByText(/\/f\//)).not.toBeInTheDocument();
    });
  });

  // ── 列表 ────────────────────────────────────────────────────────────────────
  Scenario("打开「我的表单」列出已发布的表单", ({ Given, And, When, Then }) => {
    const client = fakeFormsClient({
      listForms: vi.fn(async () => [PUBLISHED_FORM]),
      publicFormUrl: vi.fn(fakePublicUrl),
    });
    Given("owner 已登录", () => {});
    And("后端已存有该 owner 的若干表单", () => {
      expect(client.listForms).not.toHaveBeenCalled();
    });
    When("owner 打开「我的表单」", async () => {
      renderPanel(client);
      await waitFor(() => expect(client.listForms).toHaveBeenCalled());
    });
    Then("列出每份表单的标题、状态徽标、创建时间与公开填写链接", async () => {
      // Title.
      await screen.findByText("活动报名表");
      const row = rowFor("活动报名表");
      // Status badge — 已发布 (contract-fixed label for published).
      expect(row.getByText(/已发布/)).toBeInTheDocument();
      // Created time — the date is surfaced in some human form; assert the year-month
      // -day is present (the exact format is the UI's choice, the data is the contract).
      expect(row.getByText(/2026/)).toBeInTheDocument();
      // Public fill link (/f/:slug).
      expect(row.getByText("/f/f8Kq2pXa", { exact: false })).toBeInTheDocument();
    });
  });

  Scenario("一份表单都没有时显示空态", ({ Given, And, When, Then }) => {
    const client = fakeFormsClient({ listForms: vi.fn(async () => []) });
    Given("owner 已登录", () => {});
    And("后端没有该 owner 的任何表单", () => {});
    When("owner 打开「我的表单」", async () => {
      renderPanel(client);
      await waitFor(() => expect(client.listForms).toHaveBeenCalled());
    });
    Then("显示「还没有发布过表单」的空态且无报错", async () => {
      await screen.findByText(/还没有发布过表单/);
      // An empty list is a normal state, NOT an error.
      expect(screen.queryByText(/出错|失败|无法/)).not.toBeInTheDocument();
    });
  });

  // ── 改状态 ──────────────────────────────────────────────────────────────────
  Scenario("关闭一份已发布表单的提交", ({ Given, When, And, Then }) => {
    const client = fakeFormsClient({
      listForms: vi.fn(async () => [PUBLISHED_FORM]),
      updateForm: vi.fn(async (slug) => ({ slug, status: "closed" })),
      publicFormUrl: vi.fn(fakePublicUrl),
    });
    Given("owner 打开「我的表单」且其中一份表单状态为已发布", async () => {
      renderPanel(client);
      const row = rowFor(await screen.findByText("活动报名表").then(() => "活动报名表"));
      expect(row.getByText(/已发布/)).toBeInTheDocument();
    });
    When("owner 点击关闭该表单", () => {
      // The toggle-to-closed action lives in the card's `⋯` menu (关闭收集).
      openCardMenu("活动报名表");
      fireEvent.click(screen.getByRole("menuitem", { name: /关闭收集/ }));
    });
    And("后端返回该表单状态已变为关闭", async () => {
      await waitFor(() => expect(client.updateForm).toHaveBeenCalled());
      // The PATCH carried the right slug + the closed status (§21.3).
      expect(client.updateForm).toHaveBeenCalledWith("f8Kq2pXa", { status: "closed" });
    });
    Then("该表单的状态徽标变为已关闭", async () => {
      const row = rowFor("活动报名表");
      await waitFor(() => expect(row.getByText(/已关闭/)).toBeInTheDocument());
      expect(row.queryByText(/已发布/)).not.toBeInTheDocument();
    });
  });

  Scenario("重新开放一份已关闭表单的提交", ({ Given, When, And, Then }) => {
    const client = fakeFormsClient({
      listForms: vi.fn(async () => [CLOSED_FORM]),
      updateForm: vi.fn(async (slug) => ({ slug, status: "published" })),
      publicFormUrl: vi.fn(fakePublicUrl),
    });
    Given("owner 打开「我的表单」且其中一份表单状态为已关闭", async () => {
      renderPanel(client);
      await screen.findByText("已结束的问卷");
      expect(rowFor("已结束的问卷").getByText(/已关闭/)).toBeInTheDocument();
    });
    When("owner 点击重新开放该表单", () => {
      // The reopen action lives in the card's `⋯` menu (重新发布).
      openCardMenu("已结束的问卷");
      fireEvent.click(screen.getByRole("menuitem", { name: /重新发布|重新开放|开放/ }));
    });
    And("后端返回该表单状态已变为已发布", async () => {
      await waitFor(() => expect(client.updateForm).toHaveBeenCalled());
      expect(client.updateForm).toHaveBeenCalledWith("c1L0sed00", { status: "published" });
    });
    Then("该表单的状态徽标变为已发布", async () => {
      const row = rowFor("已结束的问卷");
      await waitFor(() => expect(row.getByText(/已发布/)).toBeInTheDocument());
      expect(row.queryByText(/已关闭/)).not.toBeInTheDocument();
    });
  });

  // ── 删除 ────────────────────────────────────────────────────────────────────
  Scenario("删除一份表单需要确认", ({ Given, When, Then }) => {
    const client = fakeFormsClient({
      listForms: vi.fn(async () => [PUBLISHED_FORM]),
    });
    Given("owner 打开「我的表单」", async () => {
      renderPanel(client);
      await screen.findByText("活动报名表");
    });
    When("owner 点击删除某份表单", () => {
      openCardMenu("活动报名表");
      fireEvent.click(screen.getByRole("menuitem", { name: /删除/ }));
    });
    Then("弹出删除确认提示", async () => {
      // A confirmation step appears (DS Dialog/Alert) before anything is deleted, and
      // deleteForm has NOT been called yet (confirm is still pending).
      await screen.findByText(/确认删除|确定删除|删除.*\?|无法撤销|不可恢复/);
      expect(client.deleteForm).not.toHaveBeenCalled();
    });
  });

  Scenario("确认后删除并从列表移除", ({ Given, When, And, Then }) => {
    const client = fakeFormsClient({
      listForms: vi.fn(async () => [PUBLISHED_FORM, CLOSED_FORM]),
      deleteForm: vi.fn(async (slug) => ({ ok: true, slug })),
      publicFormUrl: vi.fn(fakePublicUrl),
    });
    Given("owner 已对某份表单点击删除并看到确认提示", async () => {
      renderPanel(client);
      await screen.findByText("活动报名表");
      openCardMenu("活动报名表");
      fireEvent.click(screen.getByRole("menuitem", { name: /删除/ }));
      await screen.findByText(/确认删除|确定删除|删除.*\?|无法撤销|不可恢复/);
    });
    When("owner 确认删除", () => {
      // The confirm action in the confirmation surface (a distinct 确认/确定 button).
      const confirm = screen
        .getAllByRole("button", { name: /确认|确定/ })
        .find((b) => !/取消/.test(b.textContent));
      fireEvent.click(confirm);
    });
    And("后端返回删除成功", async () => {
      await waitFor(() => expect(client.deleteForm).toHaveBeenCalledWith("f8Kq2pXa"));
    });
    Then("该表单从列表中消失", async () => {
      await waitFor(() => expect(screen.queryByText("活动报名表")).not.toBeInTheDocument());
      // The other form is untouched.
      expect(screen.getByText("已结束的问卷")).toBeInTheDocument();
    });
  });

  Scenario("取消删除则表单保留", ({ Given, When, Then }) => {
    const client = fakeFormsClient({
      listForms: vi.fn(async () => [PUBLISHED_FORM]),
    });
    Given("owner 已对某份表单点击删除并看到确认提示", async () => {
      renderPanel(client);
      await screen.findByText("活动报名表");
      openCardMenu("活动报名表");
      fireEvent.click(screen.getByRole("menuitem", { name: /删除/ }));
      await screen.findByText(/确认删除|确定删除|删除.*\?|无法撤销|不可恢复/);
    });
    When("owner 取消删除", () => {
      fireEvent.click(screen.getByRole("button", { name: /取消/ }));
    });
    Then("该表单仍在列表中且未发出删除请求", async () => {
      // Confirmation dismissed, the row stays, and NO delete request went out.
      await waitFor(() =>
        expect(screen.queryByText(/确认删除|确定删除|无法撤销|不可恢复/)).not.toBeInTheDocument(),
      );
      expect(screen.getByText("活动报名表")).toBeInTheDocument();
      expect(client.deleteForm).not.toHaveBeenCalled();
    });
  });

  // ── 401 → onNeedLogin ────────────────────────────────────────────────────────
  Scenario("未登录打开「我的表单」引导先登录", ({ Given, When, And, Then }) => {
    const onNeedLogin = vi.fn();
    const client = fakeFormsClient({
      listForms: vi.fn(async () => {
        throw new ApiError(401, "未授权");
      }),
    });
    Given("owner 未登录", () => {});
    When("owner 打开「我的表单」", () => {
      renderPanel(client, { onNeedLogin });
    });
    And("拉取表单列表返回 401", async () => {
      await waitFor(() => expect(client.listForms).toHaveBeenCalled());
    });
    Then("提示需要先登录", async () => {
      // A 401 routes into the login flow rather than an inline panel error.
      await waitFor(() => expect(onNeedLogin).toHaveBeenCalled());
    });
    And("自动弹出 owner 登录框", () => {
      // Panel-level we assert it asks for login via onNeedLogin and does NOT render the
      // 401 as its own inline error (App wires the callback → close panel + pop login).
      expect(onNeedLogin).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/未授权/)).not.toBeInTheDocument();
    });
  });

  Scenario("发布时会话失效引导先登录", ({ Given, When, And, Then }) => {
    const onNeedLogin = vi.fn();
    const client = fakeFormsClient({
      publishForm: vi.fn(async () => {
        throw new ApiError(401, "未授权");
      }),
    });
    Given("设计器里已有一份可发布的表单", () => {
      renderPublish(client, { onNeedLogin });
    });
    When("owner 点击发布", () => {
      fireEvent.click(screen.getByRole("button", { name: /发布/ }));
    });
    And("发布请求返回 401", async () => {
      await waitFor(() => expect(client.publishForm).toHaveBeenCalled());
    });
    Then("提示需要先登录", async () => {
      await waitFor(() => expect(onNeedLogin).toHaveBeenCalled());
    });
    And("自动弹出 owner 登录框", () => {
      expect(onNeedLogin).toHaveBeenCalledTimes(1);
      // The raw 401 is NOT shown as an inline publish error.
      expect(screen.queryByText(/未授权/)).not.toBeInTheDocument();
    });
  });
});
