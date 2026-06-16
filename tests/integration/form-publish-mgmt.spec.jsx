// Outer-loop acceptance for features/form-publish-mgmt.feature — the owner
// "发布 + 表单管理" surface (SPEC §16 发布/公开链接 + §21 owner-only 管理 CRUD, §17 auth).
//
// 发布交互改造 (N-_ayo8x): 发布是顶栏「发布」的【直接动作】—— 点一下直接 POST /api/forms 上线,
// 成功后弹一个【仅链接、无二维码】的分享浮层 (ShareDialog, src/share-dialog.jsx) 并接上既有的
// 编辑/更新 机制;旧的「打开发布反馈浮层 → 浮层里再点一次发布」(PublishFeedback) 已删。所以发布相关
// 场景现在驱动【真实 <App>】(DesignerApp) + 注入 chat / publishForm / publicFormUrl / navigate
// 等 seam(与 build-form / form-editing 一致),不再 render 一个独立的发布组件。表单管理 (列表 /
// 改状态 / 删除) 仍是 <FormsPanel> 组件级的可观察行为,injected fake formsClient。
//
// 下层 wire 契约 (path/method/auth, 设计器→§16.2 mapping, { forms,count } 解包) 钉在
// tests/unit/formsClient.test.js;这里只断言可观察的 UI 行为。
import React from "react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
// /pure → no auto afterEach(cleanup); @amiceli runs each Gherkin step as its own
// test, so cleanup is per-scenario (AfterEachScenario), never per-step.
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react/pure";
import App from "../../src/App.jsx";
import { FormsPanel } from "../../src/forms-panel.jsx";
import { setToken, clearToken, ApiError } from "../../src/core/apiClient";
import { authedCheck } from "../helpers/authGate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const feature = await loadFeature(path.join(here, "../../features/form-publish-mgmt.feature"));

// A deterministic public-link builder injected in place of the real publicFormUrl:
// same /f/:slug shape (§16.4.1) so the link the UI renders is predictable.
const fakePublicUrl = (slug) => `/f/${slug}`;

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

// ── FormsPanel (表单管理) 组件级 seam ────────────────────────────────────────────
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

// The card for a given form, located by its title; card-scoped queries hang off this.
function rowFor(title) {
  const titleEl = screen.getByText(title);
  const row =
    titleEl.closest("li, tr, [role='listitem'], [data-slug]") ||
    titleEl.closest(".d-formcard, .d-formrow, [class*='card'], [class*='row']") ||
    titleEl.parentElement;
  return within(row || titleEl.parentElement);
}

// Click a foot action button on a form's card by its accessible name. Card actions are a
// FLAT row of direct buttons now (design N-_ayo8x) — there's NO `⋯` overflow menu — so each
// lifecycle action (关闭收集 / 重新发布 / 删除) is a plain button scoped to that card.
function clickCardAction(title, name) {
  fireEvent.click(rowFor(title).getByRole("button", { name }));
}

// ── 发布 / 分享 (App 级) seam ──────────────────────────────────────────────────
const verifiedMe = async () => ({ email: "owner@example.com", emailVerified: true });

// A deterministic build turn: set the cover (with a title) + add one field via tool calls,
// then close with prose (no tools → the §4 loop stops). After this the form has a title and
// a field, so the 发布 button enables.
function makeBuildChat() {
  let n = 0;
  return vi.fn(async ({ onText }) => {
    n += 1;
    if (n === 1) {
      return {
        text: "",
        toolCalls: [
          {
            id: "meta",
            name: "set_form_meta",
            argsRaw: JSON.stringify({ title: "活动报名表", desc: "请填写你的报名信息" }),
          },
          {
            id: "f0",
            name: "add_field",
            argsRaw: JSON.stringify({ type: "text", label: "姓名", required: true }),
          },
        ],
      };
    }
    const text = "搭好了，可以发布了。";
    onText?.(text);
    return { text, toolCalls: [] };
  });
}

// Mount the real App in a logged-in owner session with the publish seams injected. §26
// persistence + auth/me are stubbed deterministic so a turn never reaches the network.
async function renderApp(seams = {}) {
  setToken("owner-jwt");
  render(
    <App
      checkSession={seams.checkSession ?? authedCheck}
      chat={seams.chat ?? makeBuildChat()}
      getCurrentUser={verifiedMe}
      loadChatSession={async () => ({ session: null })}
      saveChatTurns={async () => ({})}
      listChatSessions={async () => ({ sessions: [] })}
      publishForm={seams.publishForm ?? vi.fn(async () => ({ slug: "f8Kq2pXa" }))}
      publicFormUrl={seams.publicFormUrl ?? vi.fn(fakePublicUrl)}
      updateFormDefinition={seams.updateFormDefinition}
      navigate={seams.navigate}
    />,
  );
  // Designer mounts behind the async <AuthGate>; wait for the empty-state composer anchor
  // so the gate has settled (authed → designer) before any sync designer assertion.
  await screen.findByText("描述你想要的表单");
}

// Drive the build to completion: clicking the starter hint runs the build turn; it settles
// when the 发布 button enables (disabled while building / on an empty form).
async function buildForm() {
  fireEvent.click(screen.getByText("做一个线下活动报名表"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "发布", exact: true })).toBeEnabled(),
  );
}

const clickPublish = () =>
  fireEvent.click(screen.getByRole("button", { name: "发布", exact: true }));

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  AfterEachScenario(() => {
    cleanup();
    clearToken();
  });

  // ── 发布 (直接动作 → ShareDialog) ─────────────────────────────────────────────
  Scenario("发布当前表单拿到公开填写链接", ({ Given, And, When, Then }) => {
    const publishForm = vi.fn(async () => ({ slug: "f8Kq2pXa" }));
    Given("owner 已登录", async () => {
      await renderApp({ publishForm });
    });
    And("设计器里已有一份带标题和至少一个字段的表单", async () => {
      await buildForm();
    });
    When("owner 点击发布", () => {
      clickPublish();
    });
    And("后端返回新建表单的 slug", async () => {
      // 发布是直接动作:点一下 header「发布」就直接调发布接口(没有第二步浮层里的再点)。
      await waitFor(() => expect(publishForm).toHaveBeenCalled());
      // publishForm was handed the designer model App holds: a meta with the built title +
      // a non-empty field list.
      const [meta, fields] = publishForm.mock.calls[0];
      expect(meta?.title).toBe("活动报名表");
      expect(Array.isArray(fields) && fields.length).toBeGreaterThan(0);
    });
    Then("反馈里展示该 slug 对应的公开填写链接", async () => {
      // The ShareDialog (post-publish surface) renders the public fill link for the slug.
      await screen.findByText("/f/f8Kq2pXa", { exact: false });
    });
    And("顶栏状态标记为已发布", async () => {
      // 发布成功把刚发布的表单置为「正在编辑的已发布表单」→ 顶栏徽章变 LIVE。
      await screen.findByText("LIVE");
    });
  });

  Scenario("复制公开填写链接", ({ Given, When, Then }) => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    Given("owner 刚发布了一份表单并看到公开填写链接", async () => {
      await renderApp({ publishForm: vi.fn(async () => ({ slug: "f8Kq2pXa" })) });
      await buildForm();
      clickPublish();
      await screen.findByText("/f/f8Kq2pXa", { exact: false });
    });
    When("owner 点击复制链接", async () => {
      // The copy affordance lives in the ShareDialog footer.
      fireEvent.click(screen.getByRole("button", { name: /复制链接/ }));
      await waitFor(() => expect(writeText).toHaveBeenCalled());
    });
    Then("该公开填写链接被复制到剪贴板", () => {
      // 展示用链接可能是相对的 /f/:slug;复制时补成绝对地址 —— 但仍包含该 slug 路径。
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining("/f/f8Kq2pXa"));
    });
  });

  Scenario("空表单无法发布", ({ Given, And, Then }) => {
    const publishForm = vi.fn(async () => ({ slug: "f8Kq2pXa" }));
    Given("owner 已登录", async () => {
      await renderApp({ publishForm });
    });
    And("设计器里还没有任何字段", () => {
      // No build → the designer is empty.
      expect(screen.getByText("描述你想要的表单")).toBeInTheDocument();
    });
    Then("发布按钮不可点击", async () => {
      const publishBtn = await screen.findByRole("button", { name: "发布", exact: true });
      expect(publishBtn).toBeDisabled();
      fireEvent.click(publishBtn);
      expect(publishForm).not.toHaveBeenCalled();
    });
  });

  Scenario("后端拒绝缺标题的发布并提示", ({ Given, And, When, Then }) => {
    const publishForm = vi.fn(async () => {
      throw new ApiError(400, "meta.title 必填");
    });
    Given("owner 已登录", async () => {
      await renderApp({ publishForm });
    });
    And("设计器里有字段但表单缺少标题", async () => {
      // 建出一份可点发布的表单;缺标题是后端拒绝的【原因】,前端只负责把后端的拒绝原话透出来。
      await buildForm();
    });
    When("owner 点击发布", () => {
      clickPublish();
    });
    And("后端返回 400 与错误说明", async () => {
      await waitFor(() => expect(publishForm).toHaveBeenCalled());
    });
    Then("反馈里显示后端给出的错误说明", async () => {
      // 发布是直接动作:失败时在对话外贴一条提示,显示后端的 ApiError.message 原话(不是泛化文案)。
      await screen.findByText("meta.title 必填");
    });
    And("顶栏状态仍为草稿", async () => {
      // 失败没进编辑态 → 顶栏徽章仍是 DRAFT,且没有弹出任何公开链接。
      await screen.findByText("DRAFT");
      expect(screen.queryByText(/\/f\//)).not.toBeInTheDocument();
    });
  });

  // ── 发布是直接动作 + 分享只读 (N-_ayo8x) ──────────────────────────────────────
  Scenario("发布是直接动作并弹出分享浮层", ({ Given, And, When, Then }) => {
    const publishForm = vi.fn(async () => ({ slug: "f8Kq2pXa" }));
    Given("owner 已登录", async () => {
      await renderApp({ publishForm });
    });
    And("设计器里已有一份带标题和至少一个字段的表单", async () => {
      await buildForm();
    });
    When("owner 点击发布", () => {
      clickPublish();
    });
    And("后端返回新建表单的 slug", async () => {
      await waitFor(() => expect(publishForm).toHaveBeenCalled());
    });
    Then("直接弹出展示公开填写链接的分享浮层", async () => {
      // 庆祝式「表单已发布」浮层(仅链接),直接弹出 —— 不是在对话里、也不是两步浮层。
      await screen.findByText("表单已发布");
      await screen.findByText("/f/f8Kq2pXa", { exact: false });
    });
    And("发布过程不往对话里发任何消息", () => {
      // 链接只出现在分享浮层里,没有被回灌进对话(若发布发了对话消息,链接会出现两处)。
      expect(screen.getAllByText("/f/f8Kq2pXa", { exact: false })).toHaveLength(1);
      // 旧的「发布并生成链接」对话驱动发布方式不复存在。
      expect(screen.queryByText(/发布并生成链接|生成链接/)).not.toBeInTheDocument();
    });
  });

  Scenario("分享已发布的表单只读取链接", ({ Given, When, Then, And }) => {
    const updateFormDefinition = vi.fn(async () => ({ slug: "f8Kq2pXa", status: "published" }));
    Given("owner 刚发布了一份表单", async () => {
      await renderApp({
        publishForm: vi.fn(async () => ({ slug: "f8Kq2pXa" })),
        updateFormDefinition,
      });
      await buildForm();
      clickPublish();
      await screen.findByText("表单已发布");
    });
    When("owner 点击分享", () => {
      // 发布后进入编辑态,顶栏出现「分享」按钮(只读)。jsdom 不做命中测试,即便浮层开着也能点到。
      fireEvent.click(screen.getByRole("button", { name: "分享", exact: true }));
    });
    Then("弹出展示该表单公开填写链接的分享浮层", async () => {
      // 同一个浮层翻成「分享这份表单」只读模式,仍展示该表单的公开链接。
      await screen.findByText("分享这份表单");
      expect(screen.getByText("/f/f8Kq2pXa", { exact: false })).toBeInTheDocument();
    });
    And("分享不发起改状态的请求也不往对话发消息", () => {
      // 只读:分享既不写回表单定义,也不触发任何 PATCH。
      expect(updateFormDefinition).not.toHaveBeenCalled();
    });
  });

  // ── 列表 (FormsPanel 组件级) ──────────────────────────────────────────────────
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
      await screen.findByText("活动报名表");
      const row = rowFor("活动报名表");
      expect(row.getByText(/已发布/)).toBeInTheDocument();
      expect(row.getByText(/2026/)).toBeInTheDocument();
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
      clickCardAction("活动报名表", /关闭收集/);
    });
    And("后端返回该表单状态已变为关闭", async () => {
      await waitFor(() => expect(client.updateForm).toHaveBeenCalled());
      expect(client.updateForm).toHaveBeenCalledWith("f8Kq2pXa", { status: "closed" });
    });
    Then("该表单的状态徽标变为已关闭", async () => {
      const row = rowFor("活动报名表");
      await waitFor(() => expect(row.getByText("已关闭")).toBeInTheDocument());
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
      expect(rowFor("已结束的问卷").getByText("已关闭")).toBeInTheDocument();
    });
    When("owner 点击重新开放该表单", () => {
      clickCardAction("已结束的问卷", /重新发布|重新开放|开放/);
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
      clickCardAction("活动报名表", /删除/);
    });
    Then("弹出删除确认提示", async () => {
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
      clickCardAction("活动报名表", /删除/);
      await screen.findByText(/确认删除|确定删除|删除.*\?|无法撤销|不可恢复/);
    });
    When("owner 确认删除", () => {
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
      clickCardAction("活动报名表", /删除/);
      await screen.findByText(/确认删除|确定删除|删除.*\?|无法撤销|不可恢复/);
    });
    When("owner 取消删除", () => {
      fireEvent.click(screen.getByRole("button", { name: /取消/ }));
    });
    Then("该表单仍在列表中且未发出删除请求", async () => {
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
      await waitFor(() => expect(onNeedLogin).toHaveBeenCalled());
    });
    And("自动弹出 owner 登录框", () => {
      expect(onNeedLogin).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/未授权/)).not.toBeInTheDocument();
    });
  });

  Scenario("发布时会话失效引导先登录", ({ Given, When, And, Then }) => {
    const navigate = vi.fn();
    const publishForm = vi.fn(async () => {
      throw new ApiError(401, "未授权");
    });
    Given("设计器里已有一份可发布的表单", async () => {
      await renderApp({ publishForm, navigate });
      await buildForm();
    });
    When("owner 点击发布", () => {
      clickPublish();
    });
    And("发布请求返回 401", async () => {
      await waitFor(() => expect(publishForm).toHaveBeenCalled());
    });
    Then("提示需要先登录", async () => {
      // 发布 401 → 会话失效 → 路由到独立 /signin 登录页(§17),不把原始 401 当行内错误显示。
      await waitFor(() => expect(navigate).toHaveBeenCalled());
      expect(navigate.mock.calls[0][0]).toMatch(/^\/signin\?/);
    });
    And("自动弹出 owner 登录框", () => {
      expect(screen.queryByText(/未授权/)).not.toBeInTheDocument();
    });
  });
});
