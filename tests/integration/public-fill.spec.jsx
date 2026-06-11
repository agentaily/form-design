// Outer-loop acceptance for features/public-fill.feature — the 公开填写页 (答题者侧,
// 第 6 步, SPEC §16.4.1 路由 + §16.2/§16.4 拉取 + §15.2/§16.5/§20 提交).
//
// We drive the REAL route split + page through <App>: passing an explicit `pathname`
// (the router seam App takes as an injectable prop) and injecting fake getPublicForm/
// submitForm straight through to <PublicFormPage>. That keeps these tests about the
// observable behavior — route to the bare answerer view, render fields by type, fill +
// submit, the success / 404 / 409 / 400 / 502 states, and the no-Bearer guarantee —
// without a backend or token store.
//
// The no-Bearer guarantee is enforced two ways: (1) the WIRE contract (no Authorization
// header) is pinned in tests/unit/publicClient.test.js; (2) here, App passes injected
// I/O seams to PublicFormPage, so the page never reaches the real token-bearing client
// — we assert the injected submitForm fired (a spy), proving the page submits through
// the public seam, not the owner one.
import React from "react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
// /pure → no auto afterEach(cleanup); @amiceli runs each Gherkin step as its own test,
// so cleanup is per-scenario (AfterEachScenario), never per-step.
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react/pure";
import App from "../../src/App.jsx";
import { ApiError } from "../../src/core/apiClient";

const here = path.dirname(fileURLToPath(import.meta.url));
const feature = await loadFeature(path.join(here, "../../features/public-fill.feature"));

const SLUG = "f8Kq2pXa";

// A §16.2 public form: title + description + one field of each rendered type.
const FORM = {
  slug: SLUG,
  meta: { title: "活动报名表", description: "请填写你的报名信息" },
  fields: [
    { id: "f_name", type: "text", label: "姓名", required: true },
    {
      id: "f_ticket",
      type: "radio",
      label: "票种",
      options: [
        { label: "普通票", value: "std" },
        { label: "学生票", value: "stu" },
      ],
    },
    {
      id: "f_hobby",
      type: "checkbox",
      label: "兴趣",
      options: [
        { label: "阅读", value: "read" },
        { label: "运动", value: "sport" },
      ],
    },
    {
      id: "f_dir",
      type: "select",
      label: "技术方向",
      options: [
        { label: "前端", value: "fe" },
        { label: "后端", value: "be" },
      ],
    },
  ],
};

// A minimal form with just one required 姓名 (for the success / required-validation flows).
const NAME_ONLY = {
  slug: SLUG,
  meta: { title: "签到", description: "" },
  fields: [{ id: "f_name", type: "text", label: "姓名", required: true }],
};

function fakeGet(form) {
  return vi.fn(async () => form);
}
function fakeGetReject(status, message) {
  return vi.fn(async () => {
    throw new ApiError(status, message);
  });
}
function fakeSubmitOk() {
  return vi.fn(async () => ({ ok: true, recordId: "recABC" }));
}
function fakeSubmitReject(status, message) {
  return vi.fn(async () => {
    throw new ApiError(status, message);
  });
}

// Render the public route via the App route split (pathname = /f/:slug), injecting the
// public I/O seams App passes through to PublicFormPage.
function renderPublic({ get, submit } = {}) {
  return render(
    <App
      pathname={`/f/${SLUG}`}
      getPublicForm={get ?? fakeGet(FORM)}
      submitForm={submit ?? fakeSubmitOk()}
    />,
  );
}

// The form's title input — located by its accessible label「姓名」.
function nameInput() {
  return (
    screen.queryByLabelText(/姓名/) ||
    // fall back to the first text input inside the page if labels aren't wired by role
    screen.getAllByRole("textbox")[0]
  );
}

// The page's submit affordance (a button to send the answers).
function submitButton() {
  return screen.getByRole("button", { name: /提交|提交报名|发送|报名/ });
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  AfterEachScenario(() => cleanup());

  // ── 路由分流 ──────────────────────────────────────────────────────────────────
  Scenario("访问 /f/:slug 进入公开填写页而非设计器", ({ Given, When, Then, And }) => {
    const get = fakeGet(FORM);
    Given("浏览器地址是 /f/f8Kq2pXa", () => {});
    When("应用按路径分流", async () => {
      renderPublic({ get });
      // The public page mounts → it fetches the form for the route slug.
      await waitFor(() => expect(get).toHaveBeenCalledWith(SLUG));
    });
    Then("渲染公开填写页且只渲染答题视图", async () => {
      // The answerer view shows the form's title — proof the public page rendered.
      await screen.findByText("活动报名表");
    });
    And("不出现设计器的对话、预览或登录入口", () => {
      // None of the designer chrome is mounted on the public route.
      expect(screen.queryByText("描述你想要的表单")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /登录账户|我的表单|集成设置/ }),
      ).not.toBeInTheDocument();
    });
  });

  Scenario("普通路径仍进入设计器", ({ Given, When, Then }) => {
    Given("浏览器地址是 /", () => {});
    When("应用按路径分流", () => {
      // No public slug → App renders the designer (no public I/O seams needed).
      render(<App pathname="/" chat={vi.fn()} login={vi.fn()} logout={vi.fn()} />);
    });
    Then("渲染设计器而非公开填写页", () => {
      // The designer's empty-state heading is present; no public form title.
      expect(screen.getByText("描述你想要的表单")).toBeInTheDocument();
      expect(screen.queryByText("活动报名表")).not.toBeInTheDocument();
    });
  });

  // ── 拉取并渲染 ────────────────────────────────────────────────────────────────
  Scenario("拉取并渲染已发布表单的各字段", ({ Given, When, And, Then }) => {
    const get = fakeGet(FORM);
    Given("公开链接对应的表单含标题、单行文本、多选与单选等字段", () => {
      expect(FORM.fields.map((f) => f.type)).toEqual(
        expect.arrayContaining(["text", "radio", "checkbox", "select"]),
      );
    });
    When("答题者打开该公开链接", () => {
      renderPublic({ get });
    });
    And("后端返回该表单的 meta 与 fields", async () => {
      await waitFor(() => expect(get).toHaveBeenCalledWith(SLUG));
    });
    Then("页面展示表单标题与介绍", async () => {
      await screen.findByText("活动报名表");
      expect(screen.getByText("请填写你的报名信息")).toBeInTheDocument();
    });
    And("按字段类型渲染出对应的输入控件", () => {
      // text → a text input
      expect(nameInput()).toBeInTheDocument();
      // radio → the single-choice options are rendered (普通票/学生票)
      expect(screen.getByText("普通票")).toBeInTheDocument();
      // checkbox-with-options → the multi-choice options are rendered (阅读/运动)
      expect(screen.getByText("阅读")).toBeInTheDocument();
      expect(screen.getByText("运动")).toBeInTheDocument();
      // select → its options are present (前端/后端) inside a combobox/listbox
      expect(screen.getByText("前端")).toBeInTheDocument();
    });
  });

  // ── 提交成功 ──────────────────────────────────────────────────────────────────
  Scenario("填好后提交成功看到感谢反馈", ({ Given, When, And, Then }) => {
    const get = fakeGet(NAME_ONLY);
    const submit = fakeSubmitOk();
    Given("答题者打开了一份只含必填「姓名」的公开表单", async () => {
      renderPublic({ get, submit });
      await screen.findByText("签到");
    });
    When("答题者填写「姓名」并点击提交", async () => {
      fireEvent.change(nameInput(), { target: { value: "张三" } });
      fireEvent.click(submitButton());
      await waitFor(() => expect(submit).toHaveBeenCalled());
    });
    And("后端返回提交成功", () => {
      // the injected submit resolved ok (above) — nothing more to do
      expect(submit).toHaveBeenCalledWith(SLUG, expect.any(Array));
    });
    Then("页面显示提交成功的感谢反馈", async () => {
      await screen.findByText(/提交成功|感谢|谢谢|已收到|报名成功/);
    });
  });

  Scenario("提交时按约定收集 answers", ({ Given, When, Then, And }) => {
    const get = fakeGet(FORM);
    const submit = fakeSubmitOk();
    Given("答题者打开了一份含「姓名」单行文本与「兴趣」多选的公开表单", async () => {
      renderPublic({ get, submit });
      await screen.findByText("活动报名表");
    });
    When("答题者填写「姓名」并勾选两项「兴趣」后提交", async () => {
      fireEvent.change(nameInput(), { target: { value: "张三" } });
      // Tick both 兴趣 options by clicking their visible labels.
      fireEvent.click(screen.getByText("阅读"));
      fireEvent.click(screen.getByText("运动"));
      fireEvent.click(submitButton());
      await waitFor(() => expect(submit).toHaveBeenCalled());
    });
    Then("提交请求带上对应表单的 formSlug", () => {
      // submitForm(slug, answers) — the route slug is passed as the first arg.
      expect(submit.mock.calls[0][0]).toBe(SLUG);
    });
    And("提交请求的 answers 含「姓名」的单值与「兴趣」的多值数组", () => {
      const answers = submit.mock.calls[0][1];
      const name = answers.find((a) => a.label === "姓名");
      const hobby = answers.find((a) => a.label === "兴趣");
      expect(name.value).toBe("张三");
      expect(Array.isArray(hobby.value)).toBe(true);
      expect(hobby.value).toHaveLength(2);
    });
  });

  // ── 不带 Bearer ──────────────────────────────────────────────────────────────
  Scenario("公开拉取与提交都不携带 owner 凭据", ({ Given, When, Then, And }) => {
    const get = fakeGet(NAME_ONLY);
    const submit = fakeSubmitOk();
    Given("答题者打开一个公开填写页", async () => {
      renderPublic({ get, submit });
      await screen.findByText("签到");
    });
    When("页面拉取表单并提交作答", async () => {
      fireEvent.change(nameInput(), { target: { value: "张三" } });
      fireEvent.click(submitButton());
      await waitFor(() => expect(submit).toHaveBeenCalled());
    });
    Then("拉取请求不带 Authorization 头", () => {
      // App routes the public page through the no-Bearer publicClient seam: here we
      // assert the page used the injected public getPublicForm (the token-unaware path),
      // never the owner-only client. The header-level guarantee is pinned in
      // tests/unit/publicClient.test.js.
      expect(get).toHaveBeenCalledWith(SLUG);
    });
    And("提交请求不带 Authorization 头", () => {
      // Same: submission went through the injected public submitForm seam.
      expect(submit).toHaveBeenCalledWith(SLUG, expect.any(Array));
    });
  });

  // ── 必填校验 ──────────────────────────────────────────────────────────────────
  Scenario("漏填必填项时前端拦住提交", ({ Given, When, Then, And }) => {
    const get = fakeGet(NAME_ONLY);
    const submit = fakeSubmitOk();
    Given("答题者打开了一份含必填「姓名」的公开表单", async () => {
      renderPublic({ get, submit });
      await screen.findByText("签到");
    });
    When("答题者未填「姓名」直接点击提交", () => {
      fireEvent.click(submitButton());
    });
    Then("出现必填校验提示", async () => {
      await screen.findByText(/必填|不能为空|请填写/);
    });
    And("不发出提交请求", () => {
      // The client-side pre-check blocked submit — no network call went out.
      expect(submit).not.toHaveBeenCalled();
    });
  });

  Scenario("后端因缺必填返回 400 时显示提示", ({ Given, When, Then }) => {
    const get = fakeGet(NAME_ONLY);
    const submit = fakeSubmitReject(400, "姓名 必填");
    Given("答题者打开了一份公开表单并点击提交", async () => {
      renderPublic({ get, submit });
      await screen.findByText("签到");
      // Fill so the client-side pre-check passes and the request actually reaches the
      // backend (which then rejects with 400 + a message).
      fireEvent.change(nameInput(), { target: { value: "张三" } });
      fireEvent.click(submitButton());
    });
    When("后端返回 400 与缺必填的错误说明", async () => {
      await waitFor(() => expect(submit).toHaveBeenCalled());
    });
    Then("页面显示该错误说明", async () => {
      // The backend's ApiError.message is surfaced verbatim.
      await screen.findByText("姓名 必填");
    });
  });

  // ── 错误态 ────────────────────────────────────────────────────────────────────
  Scenario("slug 不存在显示友好 404 页", ({ Given, When, And, Then }) => {
    const get = fakeGetReject(404, "no such form");
    Given("一个不存在的公开链接 /f/nope", () => {});
    When("答题者打开该链接", () => {
      render(<App pathname="/f/nope" getPublicForm={get} submitForm={fakeSubmitOk()} />);
    });
    And("后端拉取返回 404", async () => {
      await waitFor(() => expect(get).toHaveBeenCalledWith("nope"));
    });
    Then("页面显示「表单不存在」的友好提示", async () => {
      await screen.findByText(/表单不存在|没有找到|不存在/);
    });
    And("不显示答题表单", () => {
      // No inputs / submit affordance on the 404 page.
      expect(screen.queryByRole("button", { name: /提交/ })).not.toBeInTheDocument();
    });
  });

  Scenario("向已关闭的表单提交时提示已停止收集", ({ Given, When, Then }) => {
    const get = fakeGet(NAME_ONLY);
    const submit = fakeSubmitReject(409, "该表单已停止收集");
    Given("答题者打开了一份表单并填好后点击提交", async () => {
      renderPublic({ get, submit });
      await screen.findByText("签到");
      fireEvent.change(nameInput(), { target: { value: "张三" } });
      fireEvent.click(submitButton());
    });
    When("后端返回 409 表示表单未开放提交", async () => {
      await waitFor(() => expect(submit).toHaveBeenCalled());
    });
    Then("页面提示该表单已停止收集", async () => {
      await screen.findByText(/停止收集|已关闭|未开放/);
    });
  });

  Scenario("提交遇上游错误时提示稍后重试", ({ Given, When, Then }) => {
    const get = fakeGet(NAME_ONLY);
    const submit = fakeSubmitReject(502, "upstream");
    Given("答题者打开了一份公开表单并填好后点击提交", async () => {
      renderPublic({ get, submit });
      await screen.findByText("签到");
      fireEvent.change(nameInput(), { target: { value: "张三" } });
      fireEvent.click(submitButton());
    });
    When("后端返回 502 上游错误", async () => {
      await waitFor(() => expect(submit).toHaveBeenCalled());
    });
    Then("页面提示提交失败请稍后重试", async () => {
      await screen.findByText(/提交失败|稍后重试|失败/);
    });
  });
});
