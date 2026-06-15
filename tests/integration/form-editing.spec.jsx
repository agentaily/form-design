// Outer-loop acceptance for features/form-editing.feature — 表单编辑入口 (PR-7):
// 把已发布/已关闭表单载回设计器继续编辑、改完写回、未保存改动退出二次确认 (SPEC §21.3 编辑
// + §16.8 改标签→飞书改名靠 id + §17 owner-only auth).
//
// We render the REAL <App> (DesignerApp) and inject the owner-only seams — listForms /
// getFormForEdit (载回) / updateFormDefinition (写回) / chat (让回合确定性) / navigate (401
// 去登录) — the same deterministic injection build-form / form-publish-mgmt specs use. No
// backend, no token store beyond a seeded session. The lower wire contract (no-op PATCH
// read-back, UI↔§16.2 mapping, id preservation) is pinned in tests/unit/formsClient.test.js;
// here we assert the observable App behavior: banner appears + fields load, 更新 vs 发布,
// dirty gating, 放弃 confirmation, closed-vs-published self-consistency, 401 → login.
import React from "react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
// /pure → no auto afterEach(cleanup); @amiceli runs each step as its own test.
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react/pure";
import App from "../../src/App.jsx";
import { setToken, clearToken } from "../../src/core/apiClient";
import { ApiError } from "../../src/core/apiClient";

const here = path.dirname(fileURLToPath(import.meta.url));
const feature = await loadFeature(path.join(here, "../../features/form-editing.feature"));

// Owner list summaries (§21.2 — NO fields), as listForms() resolves them.
const PUBLISHED_SUMMARY = {
  slug: "f8Kq2pXa",
  meta: { title: "活动报名表", description: "请填写你的报名信息" },
  status: "published",
  createdAt: "2026-06-11T08:00:00.000Z",
};
const CLOSED_SUMMARY = {
  slug: "c1L0sed00",
  meta: { title: "已结束的问卷" },
  status: "closed",
  createdAt: "2026-05-01T08:00:00.000Z",
};

// The full EditableForm getFormForEdit resolves (designer shape: UI types, ids preserved).
const PUBLISHED_FULL = {
  slug: "f8Kq2pXa",
  status: "published",
  meta: { title: "活动报名表", desc: "请填写你的报名信息" },
  fields: [
    { id: "fld_3", type: "text", label: "姓名", required: true },
    { id: "fld_7", type: "tel", label: "手机号", required: true },
  ],
};
const CLOSED_FULL = {
  slug: "c1L0sed00",
  status: "closed",
  meta: { title: "已结束的问卷" },
  fields: [{ id: "fld_1", type: "text", label: "姓名", required: true }],
};

const verifiedMe = async () => ({ email: "owner@example.com", emailVerified: true });

// A chat turn that adds EXACTLY ONE field via the add_field tool (→ model mutates → form
// dirty), then closes with prose. The §4 loop calls chat until a turn has no tool calls, so
// the tool call must only fire on the first call — otherwise it loops, re-adding the field.
function chatAddsField() {
  let n = 0;
  return vi.fn(async ({ onText }) => {
    n += 1;
    if (n === 1) {
      return {
        text: "",
        toolCalls: [
          {
            id: "t1",
            name: "add_field",
            argsRaw: JSON.stringify({ type: "textarea", label: "备注" }),
          },
        ],
      };
    }
    const text = "已加上备注字段。";
    onText?.(text);
    return { text, toolCalls: [] };
  });
}

// Mount the App in a logged-in owner session with the edit seams injected. The A' project↔对话 seams
// (loadProject / saveProjectWorkspace / listProjects + renameChatSession) are injected with empty-
// state fakes so「继续编辑」(= 进项目) doesn't hit the real clients (real fetch → undefined in jsdom).
// A saveChatTurns / saveProjectWorkspace spy can be injected to assert what an edit turn persists.
function renderApp(seams = {}) {
  setToken("owner-jwt");
  render(
    <App
      chat={seams.chat ?? vi.fn(async () => ({ text: "", toolCalls: [] }))}
      getCurrentUser={verifiedMe}
      loadChatSession={seams.loadChatSession ?? (async () => ({ session: null }))}
      saveChatTurns={seams.saveChatTurns ?? (async () => ({}))}
      listChatSessions={seams.listChatSessions ?? (async () => ({ sessions: [] }))}
      deleteChatSession={seams.deleteChatSession ?? (async () => ({ deleted: true }))}
      renameChatSession={seams.renameChatSession ?? (async () => ({ renamed: true }))}
      loadProject={seams.loadProject ?? (async () => ({ project: null }))}
      saveProjectWorkspace={
        seams.saveProjectWorkspace ?? (async () => ({ projectId: "pj", updatedAt: "t" }))
      }
      listProjects={seams.listProjects ?? (async () => ({ projects: [] }))}
      publishForm={vi.fn()}
      listForms={seams.listForms}
      getFormForEdit={seams.getFormForEdit}
      updateFormDefinition={seams.updateFormDefinition}
      navigate={seams.navigate}
    />,
  );
}

// 「我的表单」 lives in the AccountControl avatar menu (logged-in). Open the menu, click it.
async function openMyForms() {
  await waitFor(() => expect(document.querySelector(".am-acct")).toBeInTheDocument());
  fireEvent.click(document.querySelector(".am-acct"));
  fireEvent.click(screen.getByRole("menuitem", { name: /我的表单/ }));
}

// 通过 composer 发一条后续消息(对话区已非空时用):往 textarea 打字 → 点「Send」。
function sendViaComposer(text) {
  const ta = screen.getByPlaceholderText(/描述你想要的表单/);
  fireEvent.change(ta, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

// Load a published form into the designer for editing: open 我的表单 → 继续编辑 → banner up.
async function enterEditPublished(updateFormDefinition) {
  renderApp({
    listForms: vi.fn(async () => [PUBLISHED_SUMMARY]),
    getFormForEdit: vi.fn(async () => PUBLISHED_FULL),
    updateFormDefinition,
    chat: chatAddsField(),
  });
  await openMyForms();
  fireEvent.click(await screen.findByRole("button", { name: /继续编辑/ }));
  await screen.findByTestId("edit-banner");
}

// Make the loaded form dirty by adding a field via a chat turn; settles when 更新 enables.
async function makeDirty() {
  sendViaComposer("加个备注字段");
  await waitFor(() => expect(screen.getByRole("button", { name: /更新|已更新/ })).toBeEnabled());
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  AfterEachScenario(() => {
    cleanup();
    clearToken();
  });

  // ── 载回设计器 ────────────────────────────────────────────────────────────────
  Scenario("把一份已发布表单载回设计器编辑", ({ Given, When, And, Then }) => {
    const getFormForEdit = vi.fn(async () => PUBLISHED_FULL);
    Given("owner 打开「我的表单」且其中一份已发布表单", async () => {
      renderApp({ listForms: vi.fn(async () => [PUBLISHED_SUMMARY]), getFormForEdit });
      await openMyForms();
      await screen.findByText("活动报名表");
    });
    When("owner 点击该表单的「继续编辑」", () => {
      fireEvent.click(screen.getByRole("button", { name: /继续编辑/ }));
    });
    And("后端返回该表单的标题与字段定义", async () => {
      await waitFor(() => expect(getFormForEdit).toHaveBeenCalledWith("f8Kq2pXa"));
    });
    Then("设计器载入该表单的标题与全部字段", async () => {
      // The loaded title + all loaded fields render into the live preview.
      await waitFor(() =>
        expect(document.querySelector(".pv-hero__title")).toHaveTextContent("活动报名表"),
      );
      expect(document.querySelectorAll(".pv-fields > div")).toHaveLength(2);
    });
    And("顶部显示「正在编辑」的状态横幅", async () => {
      const banner = await screen.findByTestId("edit-banner");
      expect(banner).toHaveTextContent("EDITING");
      expect(banner).toHaveTextContent(/正在编辑/);
    });
  });

  Scenario("编辑已关闭的表单不按在线态展示", ({ Given, When, And, Then }) => {
    const getFormForEdit = vi.fn(async () => CLOSED_FULL);
    Given("owner 打开「我的表单」且其中一份已关闭表单", async () => {
      renderApp({ listForms: vi.fn(async () => [CLOSED_SUMMARY]), getFormForEdit });
      await openMyForms();
      await screen.findByText("已结束的问卷");
    });
    When("owner 点击该表单的「编辑」", () => {
      fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    });
    And("后端返回该表单的标题与字段定义", async () => {
      await waitFor(() => expect(getFormForEdit).toHaveBeenCalledWith("c1L0sed00"));
    });
    Then("状态横幅文案说明该表单未在收集", async () => {
      const banner = await screen.findByTestId("edit-banner");
      expect(banner).toHaveTextContent(/未在收集/);
    });
    And("顶栏状态徽章显示已关闭而非 LIVE", async () => {
      // The top-bar badge follows the form's real status: 已关闭, never the online LIVE.
      await waitFor(() => expect(screen.getByText("已关闭")).toBeInTheDocument());
      expect(screen.queryByText("LIVE")).not.toBeInTheDocument();
    });
  });

  // ── 顶栏主按钮：更新 ───────────────────────────────────────────────────────────
  Scenario("编辑态顶栏主按钮是「更新」", ({ Given, Then }) => {
    Given("owner 已把一份已发布表单载回设计器编辑", async () => {
      await enterEditPublished(vi.fn());
    });
    Then("顶栏主按钮显示「更新」而非「发布」", () => {
      expect(screen.getByRole("button", { name: /更新/ })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "发布" })).not.toBeInTheDocument();
    });
  });

  Scenario("改完点「更新」把 meta 与字段写回", ({ Given, When, And, Then }) => {
    const updateFormDefinition = vi.fn(async () => ({ slug: "f8Kq2pXa", status: "published" }));
    Given("owner 已把一份已发布表单载回设计器编辑", async () => {
      await enterEditPublished(updateFormDefinition);
    });
    When("owner 修改某个字段的标签", async () => {
      await makeDirty();
    });
    And("owner 点击「更新」", () => {
      fireEvent.click(screen.getByRole("button", { name: /更新/ }));
    });
    Then("通过 PATCH 把更新后的 meta 与字段写回该表单", async () => {
      await waitFor(() => expect(updateFormDefinition).toHaveBeenCalled());
      const [slug, meta] = updateFormDefinition.mock.calls[0];
      expect(slug).toBe("f8Kq2pXa");
      expect(meta).toMatchObject({ title: "活动报名表" });
    });
    And("写回的字段保留原有字段 id 以便后端识别改名", () => {
      const sentFields = updateFormDefinition.mock.calls[0][2];
      const ids = sentFields.map((f) => f.id);
      // The originally-loaded ids round-trip out (so a label change reads as a rename).
      expect(ids).toEqual(expect.arrayContaining(["fld_3", "fld_7"]));
    });
  });

  Scenario("没有改动时「更新」不可点", ({ Given, Then }) => {
    Given("owner 已把一份已发布表单载回设计器编辑", async () => {
      await enterEditPublished(vi.fn());
    });
    Then("在还没有任何改动前「更新」按钮不可点击", () => {
      expect(screen.getByRole("button", { name: /更新/ })).toBeDisabled();
    });
  });

  // ── 放弃保护 ──────────────────────────────────────────────────────────────────
  Scenario("有未保存改动时退出弹确认", ({ Given, And, When, Then }) => {
    const updateFormDefinition = vi.fn();
    Given("owner 已把一份已发布表单载回设计器编辑", async () => {
      await enterEditPublished(updateFormDefinition);
    });
    And("owner 修改了表单但还没点「更新」", async () => {
      await makeDirty();
    });
    When("owner 点击「退出」", () => {
      fireEvent.click(screen.getByRole("button", { name: "退出" }));
    });
    Then("弹出「放弃本次编辑」的确认提示", async () => {
      await screen.findByText(/放弃本次编辑/);
    });
    And("此时没有把改动写回后端", () => {
      expect(updateFormDefinition).not.toHaveBeenCalled();
    });
  });

  Scenario("确认放弃后退出编辑态回到干净草稿", ({ Given, When, Then, And }) => {
    const updateFormDefinition = vi.fn();
    Given("owner 在编辑态有未保存改动并看到「放弃本次编辑」确认", async () => {
      await enterEditPublished(updateFormDefinition);
      await makeDirty();
      fireEvent.click(screen.getByRole("button", { name: "退出" }));
      await screen.findByText(/放弃本次编辑/);
    });
    When("owner 确认放弃改动", () => {
      fireEvent.click(screen.getByRole("button", { name: "放弃改动" }));
    });
    Then("退出编辑态且设计器清空", async () => {
      // Banner gone (no longer editing) and the designer reset to the empty draft state.
      await waitFor(() => expect(screen.queryByTestId("edit-banner")).not.toBeInTheDocument());
      await screen.findByText("描述你想要的表单");
    });
    And("没有把改动写回后端", () => {
      expect(updateFormDefinition).not.toHaveBeenCalled();
    });
  });

  Scenario("继续编辑则留在编辑态不丢改动", ({ Given, When, Then }) => {
    Given("owner 在编辑态有未保存改动并看到「放弃本次编辑」确认", async () => {
      await enterEditPublished(vi.fn());
      await makeDirty();
      fireEvent.click(screen.getByRole("button", { name: "退出" }));
      await screen.findByText(/放弃本次编辑/);
    });
    When("owner 选择继续编辑", () => {
      fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    });
    Then("仍停留在编辑态且改动还在", async () => {
      // Dialog dismissed, banner still present (still editing), the added field still there.
      await waitFor(() => expect(screen.queryByText(/放弃本次编辑/)).not.toBeInTheDocument());
      expect(screen.getByTestId("edit-banner")).toBeInTheDocument();
      expect(document.querySelectorAll(".pv-fields > div")).toHaveLength(3);
    });
  });

  Scenario("没有改动时退出直接离开不打扰", ({ Given, When, Then }) => {
    Given("owner 已把一份已发布表单载回设计器编辑", async () => {
      await enterEditPublished(vi.fn());
    });
    When("owner 在没有任何改动时点击「退出」", () => {
      fireEvent.click(screen.getByRole("button", { name: "退出" }));
    });
    Then("直接退出编辑态且不弹确认", async () => {
      await waitFor(() => expect(screen.queryByTestId("edit-banner")).not.toBeInTheDocument());
      expect(screen.queryByText(/放弃本次编辑/)).not.toBeInTheDocument();
    });
  });

  // ── 编辑对话就是项目的对话(A' 反转:不再隔离,照常持久化)────────────────────────
  // 反转自旧场景「编辑期间的对话不污染设计会话持久化」(§4.4 整条要改):A' 下「继续编辑」= 进入该表单
  // 对应的项目,编辑态对话就是该项目下的会话,照常持久化到项目的会话行(这修了「继续编辑后刷新对话丢」
  // 的 bug —— 旧 editingFormRef 跳过持久化把每个编辑回合都丢了)。
  Scenario("编辑态的对话照常持久化到项目的会话", ({ Given, When, Then, And }) => {
    const saveChatTurns = vi.fn(async () => ({}));
    const saveProjectWorkspace = vi.fn(async () => ({ projectId: "pj", updatedAt: "t" }));
    Given("owner 已把一份已发布表单载回设计器编辑", async () => {
      renderApp({
        listForms: vi.fn(async () => [PUBLISHED_SUMMARY]),
        getFormForEdit: vi.fn(async () => PUBLISHED_FULL),
        updateFormDefinition: vi.fn(),
        chat: chatAddsField(),
        saveChatTurns,
        saveProjectWorkspace,
        // No prior conversation under the project → a fresh session id for this edit conversation.
        listChatSessions: vi.fn(async () => ({ sessions: [] })),
      });
      await openMyForms();
      fireEvent.click(await screen.findByRole("button", { name: /继续编辑/ }));
      await screen.findByTestId("edit-banner");
    });
    When("owner 在编辑态发生一轮对话改动", async () => {
      await makeDirty();
    });
    Then("这轮编辑对话写进该项目下的会话持久化", async () => {
      // A' 反转 (§4.4): an edit conversation IS the project's conversation, so turn-end §26 persistence
      // RUNS — the edit turn is saved to the project-scoped session row (keyed (projectId, sessionId)).
      await waitFor(() => expect(saveChatTurns).toHaveBeenCalled());
      const [projectId, sessionId, input] = saveChatTurns.mock.calls[0];
      expect(projectId).toBeTruthy();
      expect(sessionId).toBeTruthy();
      // the persisted batch carries the edit conversation's turns (the「加个备注字段」turn + reply).
      expect(Array.isArray(input.turns)).toBe(true);
      expect(input.turns.length).toBeGreaterThan(0);
    });
    And("编辑改动的工作区也落到该项目行", async () => {
      // The workspace (the form being edited) is persisted to the PROJECT row (decoupled write).
      await waitFor(() => expect(saveProjectWorkspace).toHaveBeenCalled());
      const [projectId, ws] = saveProjectWorkspace.mock.calls[0];
      expect(projectId).toBeTruthy();
      expect(Array.isArray(ws.fields)).toBe(true);
    });
  });

  // ── 401 → login ──────────────────────────────────────────────────────────────
  Scenario("写回时会话失效引导先登录", ({ Given, When, And, Then }) => {
    const navigate = vi.fn();
    const updateFormDefinition = vi.fn(async () => {
      throw new ApiError(401, "未授权");
    });
    Given("owner 已把一份已发布表单载回设计器编辑并做了改动", async () => {
      renderApp({
        listForms: vi.fn(async () => [PUBLISHED_SUMMARY]),
        getFormForEdit: vi.fn(async () => PUBLISHED_FULL),
        updateFormDefinition,
        navigate,
        chat: chatAddsField(),
      });
      await openMyForms();
      fireEvent.click(await screen.findByRole("button", { name: /继续编辑/ }));
      await screen.findByTestId("edit-banner");
      await makeDirty();
    });
    When("owner 点击「更新」", () => {
      fireEvent.click(screen.getByRole("button", { name: /更新/ }));
    });
    And("写回请求返回 401", async () => {
      await waitFor(() => expect(updateFormDefinition).toHaveBeenCalled());
    });
    Then("提示需要先登录", async () => {
      // A 401 routes into the standalone /signin page (App.needLogin → navigate).
      await waitFor(() => expect(navigate).toHaveBeenCalled());
      expect(navigate.mock.calls[0][0]).toContain("/signin");
    });
  });
});
