---
name: app-harness-needs-project-clients
description: A' 后 <App> integration 测试必须注入 project 客户端否则走真 fetch 假红;活跃会话标题在两处渲染
metadata:
  type: feedback
---

A' 项目↔对话重构后,`<App>`(DesignerApp)的 integration 测试 harness 必须注入**全套 project 客户端**,否则登录态 restore 会打真实 `apiClient.apiFetch` → jsdom 里 `fetch` undefined → restore 挂起/假红。

**要注入的 fake(空态)**:`loadProject: async()=>({project:null})`、`saveProjectWorkspace: async()=>({projectId:"pj",updatedAt:"t"})`、`listProjects: async()=>({projects:[]})`、`renameChatSession: async()=>({renamed:true})`。外加已有的 `loadChatSession/saveChatTurns/listChatSessions/deleteChatSession`。`tests/integration/project-conversation-regression.spec.jsx` 的 `baseProps` 是 canonical 模板(含一个 in-memory backend `makeMemoryBackend()` 做真 round-trip)。

**Why:** App 的 `props` 默认是真 client(`loadProjectClient` 等);harness 不覆盖就 fall through 到真 fetch。登录态(种了 token)挂载即触发 `enterProject` → `loadProject` 先于 `loadChatSession`。

**How to apply / 改签名的连带断言:**

- `loadChatSession/saveChatTurns/deleteChatSession/listChatSessions` 现在首参是 **projectId**:`loadChatSession(projectId, sessionId)`、`saveChatTurns(projectId, sessionId, input)`。断言要么 `toHaveBeenCalledWith(expect.any(String), sessionId)`,要么解构时 input 在**第 3** 位(`const [,,input]=calls[0]`,曾在第 2 位)。deferred mock 捕获会话 id 要取**第 2 个**参数。
- URL 方案变了:设计器在 **`/p/:projectId?s=:sessionId`**(原 `/?s=`);设置浮层在 **`/p/:id/settings/:tab`**(原 `/settings/:tab`);关闭设置回 `/p/:id`(原 `/`)。project id 是 minted UUID,断言用 `toMatch(/^\/p\/[^/]+\/settings\/integrations$/)` + `readProjectId(pathname)` 取 id,别硬编码。
- **坑:活跃会话标题在两处渲染**。A'(§5)把当前会话标题当成 ConversationThread 的可编辑 header 标题(`.ax-cthread__title`),所以 `getByText("活动报名表单")` 在「该会话恰好是活跃会话」时会同时命中 header + SessionMenu 行 → ambiguous。断言会话**列表**时 scope 进菜单面板 `within(document.querySelector(".cs-menu__panel"))`,别裸 `screen.getByText`。
- 工作区不再骑 turns_json:`buildWorkspaceSnapshotTurn`/`splitWorkspaceSnapshot`/`WORKSPACE_SNAPSHOT_ID` **已删**,import 它们的测试要拆——对话从 `loadChatSession`(纯 chat turns),工作区从 `loadProject`(注入 `{project:{projectId,meta,fields,formSlug,createdAt,updatedAt}}`)。
- **form-editing 的反转**:旧场景「编辑期间的对话不污染设计会话持久化」(断言 saveChatTurns NOT called)**整条作废**;A' 下编辑就是进项目、对话照常持久化,改成断言 saveChatTurns **被调用**(且 saveProjectWorkspace 落工作区)。同步改 `features/form-editing.feature` 的 Gherkin。
