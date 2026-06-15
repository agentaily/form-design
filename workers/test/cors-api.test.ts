import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { applySchema, resetConfig, resetForms, testEnv } from "./helpers";

// Outer-loop acceptance specs for CORS (§19), driven through the real Hono app in
// workerd via SELF.fetch. Realizes every scenario of workers/features/cors.feature:
//   1. 白名单来源对公开端点的 OPTIONS 预检 → 2xx + 回显 Origin + Allow-Methods/Headers
//   2. 本地 dev 来源也在白名单内
//   3. owner-only 端点的 OPTIONS 预检无 token 仍 2xx（不被 401 拦）
//   4. 白名单来源对实际请求的响应也带 CORS 头（公开拉取已发布表单）
//   5. 非白名单来源不被回显为允许来源、且不退化成 '*'
//   6. 不开启凭据模式（无 Access-Control-Allow-Credentials: true）
//
// CORS 中间件已挂在所有 /api/* 之上、在 owner-only guard 之前（src/index.ts）。预检
// 不带 token，故这些场景都 NOT 依赖 login()——这正是「预检不鉴权」的可观察证据。
//
// Contract: SPEC.md §19.

const BASE = "https://api.local";

// 白名单（§19.2，单一真相，与 src/index.ts 的 ALLOWED_ORIGINS 对齐）。
const PROD_ORIGIN = "https://form-design.agentaily.com";
// app（设计工作台）新域 —— 域名 swap 第①步把 app 从主域搬来这里（过渡期与 PROD_ORIGIN 并存）。
const STUDIO_ORIGIN = "https://form-design.studio.agentaily.com";
const DEV_ORIGIN = "http://localhost:5173";
// 一个明确不在白名单里的来源。
const EVIL_ORIGIN = "https://evil.example.com";

/**
 * 模拟浏览器 CORS 预检：OPTIONS + Origin + Access-Control-Request-Method
 * (+ -Request-Headers)。预检不带 Authorization——这正是它必须越过 guard 的原因。
 */
function preflight(
  path: string,
  origin: string,
  opts: { method?: string; requestHeaders?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Origin: origin,
    "Access-Control-Request-Method": opts.method ?? "POST",
  };
  if (opts.requestHeaders) {
    headers["Access-Control-Request-Headers"] = opts.requestHeaders;
  }
  return SELF.fetch(`${BASE}${path}`, { method: "OPTIONS", headers });
}

/** 直接往 D1 插一行 published 表单（绕开 owner-only 的 POST /api/forms），供公开拉取场景。 */
async function seedPublishedForm(slug: string): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO forms (slug, owner_id, meta_json, schema_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      slug,
      "default",
      JSON.stringify({ title: "CORS 公开拉取表单" }),
      JSON.stringify([{ id: "f_name", type: "text", label: "姓名" }]),
      "published",
      new Date().toISOString(),
    )
    .run();
}

describe("CORS /api/* (workers/features/cors.feature)", () => {
  beforeAll(async () => {
    await applySchema();
  });

  beforeEach(async () => {
    await resetConfig();
    await resetForms();
  });

  it("Scenario: 白名单来源对公开端点的预检得到 CORS 头", async () => {
    // Given 一个 Origin 为生产前端域名的请求
    // When 浏览器对 /api/submit 发起 OPTIONS 预检
    const res = await preflight("/api/submit", PROD_ORIGIN, {
      method: "POST",
      requestHeaders: "authorization,content-type",
    });

    // Then 响应状态码为 2xx
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    // And 响应头 Access-Control-Allow-Origin 回显该白名单来源
    expect(res.headers.get("access-control-allow-origin")).toBe(PROD_ORIGIN);

    // And 响应头 Access-Control-Allow-Methods 含 GET、POST、PUT、PATCH、DELETE
    // PUT 是 §21/§26.10 的整段替换写端点(PUT /api/projects|chat/session|auth/profile)所用方法；
    // 漏掉它会让浏览器预检挡掉那些跨源写 → 工作区/对话刷新即丢（本回归根因）。
    const allowMethods = (res.headers.get("access-control-allow-methods") ?? "").toUpperCase();
    for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      expect(allowMethods).toContain(m);
    }

    // And 响应头 Access-Control-Allow-Headers 含 Authorization 与 Content-Type
    const allowHeaders = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    expect(allowHeaders).toContain("authorization");
    expect(allowHeaders).toContain("content-type");
  });

  it("Scenario: 本地 dev 来源也在白名单内", async () => {
    // Given 一个 Origin 为本地 dev 地址的请求
    // When 浏览器对 /api/forms 发起 OPTIONS 预检
    const res = await preflight("/api/forms", DEV_ORIGIN, { method: "GET" });

    // Then 响应状态码为 2xx
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    // And 响应头 Access-Control-Allow-Origin 回显该本地 dev 来源
    expect(res.headers.get("access-control-allow-origin")).toBe(DEV_ORIGIN);
  });

  it("Scenario: app 设计工作台新域 studio 也在白名单内", async () => {
    // 域名 swap 第①步：app 从主域搬到 form-design.studio.agentaily.com。浏览器从新域调后端
    // 必须越过预检（含 PUT 等所有写方法），否则全被 CORS 挡（参 #86 的 PUT 回归教训）。
    const res = await preflight("/api/submit", STUDIO_ORIGIN, {
      method: "POST",
      requestHeaders: "authorization,content-type",
    });

    // Then 响应状态码为 2xx
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    // And 响应头 Access-Control-Allow-Origin 回显 studio 新域（不退化成 '*'、不是别的域）
    expect(res.headers.get("access-control-allow-origin")).toBe(STUDIO_ORIGIN);

    // And 响应头 Access-Control-Allow-Methods 含 GET、POST、PUT、PATCH、DELETE（PUT 见 #86 回归）
    const allowMethods = (res.headers.get("access-control-allow-methods") ?? "").toUpperCase();
    for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      expect(allowMethods, `studio origin must allow ${m}`).toContain(m);
    }

    // And 响应头 Access-Control-Allow-Headers 含 Authorization 与 Content-Type
    const allowHeaders = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    expect(allowHeaders).toContain("authorization");
    expect(allowHeaders).toContain("content-type");
  });

  it("Scenario: owner-only 端点的预检无需 token 即返回 CORS 头", async () => {
    // Given 一个 Origin 为生产前端域名的请求
    // When 浏览器对 owner-only 端点（GET /api/config）发起不带 Authorization 的 OPTIONS 预检
    const res = await preflight("/api/config", PROD_ORIGIN, { method: "GET" });

    // Then 响应状态码为 2xx（And 该预检没有被鉴权拦成 401）
    expect(res.status).not.toBe(401);
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    // And 响应头带有 Access-Control-Allow-Origin
    expect(res.headers.get("access-control-allow-origin")).toBe(PROD_ORIGIN);
  });

  it("Scenario: PUT 写端点（项目工作区 / 对话 / 显示名）的预检放行 PUT", async () => {
    // §21/§26.10 的整段替换写端点用 PUT。预检若不在 Allow-Methods 回 PUT,浏览器就会挡掉实际的
    // 跨源 PUT(工作区 saveProjectWorkspace / 对话 saveChatTurns / 显示名 updateProfile)→ 这些写
    // 全部「Failed to fetch」被前端 best-effort 吞掉 → 刷新即丢。这正是「继续编辑已发布表单 → 刷新 →
    // 工作台空」的真实根因(用真实浏览器 PUT 才暴露;curl 种数据 + 浏览器 GET 的旧验收测不出)。
    for (const path of [
      "/api/projects/some-project-id",
      "/api/chat/session/some-session-id",
      "/api/auth/profile",
    ] as const) {
      const res = await preflight(path, PROD_ORIGIN, {
        method: "PUT",
        requestHeaders: "authorization,content-type",
      });
      // 预检越过 owner-only guard(不带 token 也 2xx,§19.1)。
      expect(res.status, `PUT ${path} preflight must not 401`).not.toBe(401);
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      expect(res.headers.get("access-control-allow-origin")).toBe(PROD_ORIGIN);
      // 关键:Allow-Methods 必须含 PUT,否则浏览器挡掉实际写请求。
      const allowMethods = (res.headers.get("access-control-allow-methods") ?? "").toUpperCase();
      expect(allowMethods, `PUT ${path} must be allowed cross-origin`).toContain("PUT");
    }
  });

  it("Scenario: owner-only 写端点（PATCH/DELETE）的预检无需 token 也返回 CORS 头", async () => {
    // §21 新增的 CRUD 端点也是 owner-only；其预检同样必须越过 guard（§19.1）。
    for (const [method, path] of [
      ["PATCH", "/api/forms/some-slug"],
      ["DELETE", "/api/forms/some-slug"],
    ] as const) {
      const res = await preflight(path, PROD_ORIGIN, { method });
      expect(res.status, `${method} ${path} preflight must not 401`).not.toBe(401);
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      expect(res.headers.get("access-control-allow-origin")).toBe(PROD_ORIGIN);
    }
  });

  it("Scenario: 白名单来源对实际请求的响应带 CORS 头", async () => {
    // Given 一个 Origin 为生产前端域名的请求 And 一份已发布的表单
    const slug = "cors-actual-fetch-slug";
    await seedPublishedForm(slug);

    // When 答题者从该来源无鉴权地拉取该 slug 对应的表单
    const res = await SELF.fetch(`${BASE}/api/forms/${slug}`, {
      headers: { Origin: PROD_ORIGIN },
    });

    // Then 响应状态码为 200
    expect(res.status).toBe(200);
    // And 响应头 Access-Control-Allow-Origin 回显该白名单来源
    expect(res.headers.get("access-control-allow-origin")).toBe(PROD_ORIGIN);
  });

  it("Scenario: 非白名单来源不被回显为允许来源", async () => {
    // Given 一个 Origin 为非白名单域名的请求
    // When 浏览器从该来源对 /api/submit 发起 OPTIONS 预检
    const res = await preflight("/api/submit", EVIL_ORIGIN, { method: "POST" });

    const allowOrigin = res.headers.get("access-control-allow-origin");
    // Then 响应头 Access-Control-Allow-Origin 不等于该非白名单来源
    expect(allowOrigin).not.toBe(EVIL_ORIGIN);
    // And 响应头 Access-Control-Allow-Origin 不是通配符 星号
    expect(allowOrigin).not.toBe("*");
  });

  it("Scenario: 不开启凭据模式", async () => {
    // Given 一个 Origin 为生产前端域名的请求
    // When 浏览器对 /api/config 发起 OPTIONS 预检
    const res = await preflight("/api/config", PROD_ORIGIN, {
      method: "GET",
      requestHeaders: "authorization",
    });

    // Then 响应里不包含 Access-Control-Allow-Credentials 为真
    const credentials = res.headers.get("access-control-allow-credentials");
    expect(credentials).not.toBe("true");
  });

  it("不带 Origin 的请求行为不变（CORS 仅在带 Origin 时附头，§19）", async () => {
    // 现有公开拉取用例不带 Origin —— 不应被强加任何 Access-Control-Allow-Origin。
    const slug = "cors-no-origin-slug";
    await seedPublishedForm(slug);
    const res = await SELF.fetch(`${BASE}/api/forms/${slug}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
