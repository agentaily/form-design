import React from "react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { loadFeature, describeFeature } from "@amiceli/vitest-cucumber";
// /pure → no auto afterEach(cleanup); cleanup happens per scenario instead.
import { render, screen, fireEvent, cleanup } from "@testing-library/react/pure";
import { FormPreview } from "../../src/preview.jsx";

const here = path.dirname(fileURLToPath(import.meta.url));
const feature = await loadFeature(path.join(here, "features/fill-and-submit.feature"));

const FIELDS = [
  { id: "name", type: "text", label: "姓名", required: true, placeholder: "你的姓名" },
  { id: "note", type: "textarea", label: "备注", placeholder: "选填" },
];

// Controlled harness: FormPreview takes values/setValue from the parent.
function FormHarness() {
  const [values, setValues] = React.useState({});
  const setValue = (id, v) => setValues((s) => ({ ...s, [id]: v }));
  return (
    <FormPreview
      meta={null}
      fields={FIELDS}
      values={values}
      setValue={setValue}
      style="card"
      building={false}
    />
  );
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  AfterEachScenario(() => cleanup());

  Scenario("必填校验拦住空提交", ({ Given, When, Then }) => {
    Given("一个含必填「姓名」的表单", () => {
      render(<FormHarness />);
    });
    When("答题者直接点击提交", () => {
      fireEvent.click(screen.getByText("提交报名"));
    });
    Then("出现必填校验提示", () => {
      expect(screen.getByText("此项必填")).toBeInTheDocument();
    });
  });

  Scenario("填好后提交成功", ({ Given, When, Then }) => {
    Given("一个含必填「姓名」的表单", () => {
      render(<FormHarness />);
    });
    When("答题者填写「姓名」并点击提交", () => {
      const input = document.querySelector(".pv-card input");
      fireEvent.change(input, { target: { value: "张三" } });
      fireEvent.click(screen.getByText("提交报名"));
    });
    Then("出现报名成功态", () => {
      expect(screen.getByText("报名成功")).toBeInTheDocument();
    });
  });
});
