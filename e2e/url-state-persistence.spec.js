import { test, expect } from "@playwright/test";
import { mockChat, mockPublish, META } from "./chatMock.js";

// End-to-end realization of URL 状态持久化 (PR #76 + A' §26.10, features/url-state-persistence.feature)
// in a real browser. Two promises a unit/integration test can't fully cover:
//   1. 项目 + 会话进 URL + 刷新【完整】恢复对话 + 工作区: an owner chats → a form is built → the URL
//      carries /p/:projectId?s=<sessionId> → a full reload re-fetches BOTH the project workspace
//      (loadProject) AND the conversation (loadChatSession) and rebuilds the chat thread + the
//      right-pane form PREVIEW.
//   2. 设置 tab 进 URL: opening settings reflects /p/:id/settings/:tab; switching tabs updates the
//      path; a reload lands on the right tab — all while the project stays in the path.
//
// A' (§26.10): the workspace lives on its OWN project row (no longer a snapshot turn inside the
// session's turns_json). So the in-memory backend below backs THREE seams that round-trip across the
// reload: the conversation (/api/chat/session/:id), the project workspace (/api/projects/:id), and
// the project-scoped session list (/api/chat/sessions).
const TOKEN = "fake.jwt.token";

async function seedSession(page) {
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", emailVerified: true }),
    });
  });
  // settings 集成 tab fetches the masked config; keep it empty + deterministic.
  await page.route("**/api/config", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deepseek: {}, feishu: {}, updatedAt: null }),
    });
  });
  await page.addInitScript((token) => {
    try {
      localStorage.setItem("agentaily_forms_token", token);
    } catch {
      /* private mode — token mirror still set in-app */
    }
  }, TOKEN);
}

function deriveTitle(turns) {
  const u = (turns || []).find((t) => t && t.role === "user");
  return (u && u.text) || "新会话";
}

// The A' in-memory backend: conversation (per-session) + workspace (per-project) + list, sharing one
// store so writes and reads round-trip across the reload exactly as the real backend would.
async function mockBackend(page) {
  const store = { session: null, project: null };

  // GET /api/chat/sessions?projectId= — the project's conversation list (most-recent-first).
  await page.route("**/api/chat/sessions**", async (route) => {
    const sessions = store.session
      ? [
          {
            sessionId: store.session.sessionId,
            title: deriveTitle(store.session.turns),
            turnCount: (store.session.turns || []).filter((t) => t && t.role === "user").length,
            formSlug: store.session.formSlug ?? null,
            updatedAt: store.session.updatedAt,
          },
        ]
      : [];
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessions }),
    });
  });

  // GET (restore) / PUT (save) one conversation — /api/chat/session/:id?projectId=.
  await page.route("**/api/chat/session/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const sessionId = decodeURIComponent((url.pathname.split("/").pop() || "").split("?")[0]);
    if (req.method() === "PUT") {
      const body = JSON.parse(req.postData() || "{}");
      store.session = {
        sessionId,
        turns: body.turns || [],
        history: body.history || [],
        formSlug: body.formSlug ?? null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      };
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, updatedAt: store.session.updatedAt }),
      });
      return;
    }
    // GET restore: the stored conversation iff its id matches; else empty (初始空态).
    const hit = store.session && store.session.sessionId === sessionId ? store.session : null;
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: hit }),
    });
  });

  // GET (restore) / PUT (save) the project WORKSPACE — /api/projects/:id.
  await page.route("**/api/projects/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const projectId = decodeURIComponent((url.pathname.split("/").pop() || "").split("?")[0]);
    if (req.method() === "PUT") {
      const body = JSON.parse(req.postData() || "{}");
      store.project = {
        projectId,
        meta: body.meta ?? null,
        fields: body.fields || [],
        formSlug: body.formSlug ?? null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      };
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, updatedAt: store.project.updatedAt }),
      });
      return;
    }
    const hit = store.project && store.project.projectId === projectId ? store.project : null;
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: hit }),
    });
  });

  // GET /api/projects — the project list (used by 继续编辑's reverse-lookup; here just reflect store).
  await page.route("**/api/projects", async (route) => {
    const projects = store.project
      ? [
          {
            projectId: store.project.projectId,
            title: (store.project.meta && store.project.meta.title) || "未命名表单",
            fieldCount: (store.project.fields || []).length,
            formSlug: store.project.formSlug ?? null,
            updatedAt: store.project.updatedAt,
          },
        ]
      : [];
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projects }),
    });
  });

  return store;
}

test.describe("Agentaily Forms · URL 状态持久化 (PR #76 + A')", () => {
  test.beforeEach(async ({ page }) => {
    await mockChat(page);
    await mockPublish(page);
  });

  test("聊一回合 → 地址栏 /p/:id?s= → 刷新【完整】恢复对话 + 工作区预览", async ({ page }) => {
    await seedSession(page);
    const store = await mockBackend(page);
    await page.goto("/");

    // 项目 + 会话进 URL:进入设计器即把项目规整进 /p/:id、会话进 ?s=(可分享/可书签)。
    await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/p\//);
    await expect.poll(() => new URL(page.url()).searchParams.get("s")).toBeTruthy();
    const projectPath = new URL(page.url()).pathname; // /p/<pid>
    const sid = new URL(page.url()).searchParams.get("s");

    // 一回合:Agent 建表 + 收尾 prose;回合结束后右侧预览出现表单封面标题(工作区已生成)。
    await page.getByText("做一个线下活动报名表").click();
    await expect(page.getByRole("button", { name: "发布", exact: true })).toBeEnabled({
      timeout: 20_000,
    });
    await expect(page.locator(".pv-hero__title")).toHaveText(META.title);
    // 回合结束批量写入后端:对话落 session 行、工作区落 project 行(A' 两次写)。
    await expect.poll(() => store.session, { timeout: 10_000 }).not.toBeNull();
    await expect.poll(() => store.project, { timeout: 10_000 }).not.toBeNull();

    // —— 刷新页面(同一 /p/:id?s= URL)——
    await page.reload();

    // 对话恢复:收尾 prose 还在、空态不在。
    await expect(page.getByText("搭好了", { exact: false })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("描述你想要的表单")).toHaveCount(0);
    // 工作区恢复:右侧预览的表单封面标题重新出现(从 loadProject 重建,不是对话卡片)。
    await expect(page.locator(".pv-hero__title")).toHaveText(META.title);
    await expect(page.locator(".pv-fieldwrap").first()).toBeVisible();
    // 地址栏仍是同一项目 + 同一段会话。
    expect(new URL(page.url()).pathname).toBe(projectPath);
    expect(new URL(page.url()).searchParams.get("s")).toBe(sid);
  });

  test("设置 tab 进 URL:打开/切换反映进 /p/:id/settings/:tab,刷新落回对应 tab", async ({
    page,
  }) => {
    await seedSession(page);
    await mockBackend(page);
    await page.goto("/");
    await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/p\//);
    const projectPath = new URL(page.url()).pathname; // /p/<pid>

    // 打开「集成设置」→ /p/:id/settings/integrations。
    await page.locator(".am-acct").click();
    await page.getByRole("menuitem", { name: /集成设置/ }).click();
    await expect(page.getByRole("button", { name: "保存" })).toBeVisible();
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe(`${projectPath}/settings/integrations`);

    // 切到「账户」tab → /p/:id/settings/account(nav 项是 exact「账户」)。
    await page.getByRole("button", { name: "账户", exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(`${projectPath}/settings/account`);

    // 刷新 → 直接落在账户 tab(可编辑「显示名称」是账户 tab 专属),项目仍在路径里。
    await page.reload();
    await expect(page.getByText("显示名称")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => new URL(page.url()).pathname).toBe(`${projectPath}/settings/account`);
  });
});
