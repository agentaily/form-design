import { describe, it, expect } from "vitest";
import { buildScript, intentReply, BUILD_FIELDS, INITIAL_META } from "../../src/flow.jsx";

describe("flow · buildScript (the scripted first turn)", () => {
  it("emits reasoning → intro text → meta → 9 fields → closing text with suggestions", () => {
    const steps = buildScript();
    expect(steps[0].t).toBe("reasoning");
    expect(steps[1].t).toBe("text");
    expect(steps[2].t).toBe("meta");

    const fieldSteps = steps.filter((s) => s.t === "field");
    expect(fieldSteps).toHaveLength(BUILD_FIELDS.length);
    expect(BUILD_FIELDS).toHaveLength(9);

    const last = steps[steps.length - 1];
    expect(last.t).toBe("text");
    expect(last.suggestions).toEqual(expect.arrayContaining(["发布并生成链接"]));
  });

  it("marks 手机号 required with a pattern hint", () => {
    const tel = BUILD_FIELDS.find((f) => f.label === "手机号");
    expect(tel.required).toBe(true);
    expect(tel._say).toMatch(/pattern/);
  });
});

describe("flow · intentReply (keyword follow-ups)", () => {
  it("recognizes publish intent", () => {
    const r = intentReply("发布并生成链接");
    expect(r.kind).toBe("publish");
    expect(r.tool.name).toBe("publish_form");
  });

  it("sets 公司 required", () => {
    const r = intentReply("把公司设为必填");
    expect(r.kind).toBe("require");
    expect(r.match).toBe("公司");
  });

  it("adds a meal-preference field", () => {
    const r = intentReply("加一个餐食偏好");
    expect(r.kind).toBe("add");
    expect(r.field.type).toBe("radio");
    expect(r.field.label).toContain("餐食");
  });

  it("removes the last field", () => {
    const r = intentReply("删除最后一个");
    expect(r.kind).toBe("remove");
  });

  it("falls back to adding a short free-text field", () => {
    const r = intentReply("微信号");
    expect(r.kind).toBe("add");
    expect(r.field.type).toBe("text");
    expect(r.field.label).toBe("微信号");
  });

  it("exposes INITIAL_META for the form hero", () => {
    expect(INITIAL_META.title).toContain("Agentaily");
    expect(Array.isArray(INITIAL_META.meta)).toBe(true);
  });
});
