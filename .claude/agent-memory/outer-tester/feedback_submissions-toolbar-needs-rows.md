---
name: submissions-toolbar-needs-rows
description: SubmissionsContent 工具栏(导出 CSV + 飞书表格外链)只在 submissions.length>0 时渲染;空态无工具栏
metadata:
  type: feedback
---

`src/submissions-view.jsx` 的 `SubmissionsContent` 把工具栏(`.sb-toolbar`，含「导出 CSV」`<Button>` 与条件渲染的「飞书表格」`<a>`)放在 `submissions.length > 0` 的分支里;0 条提交走 `<Empty>` 空态,**完全不渲染工具栏**。

**Why:** 工具栏是「有数据才有意义」的操作面(导出、外链跳表)。任何断言工具栏内元素(导出 CSV / per-form 飞书表格外链)的 integration 场景,如果注入 `listSubmissions` 返回空列表,会落到空态分支、找不到工具栏元素而假红——不是 bug,是场景设计漏了前置。

**How to apply:** 写/改 `tests/integration/data-dashboard.spec.jsx` 里任何针对工具栏的场景时,`listSubmissions` 注入 **≥1 条**提交(复用 `RESULT` fixture),并在 When 步骤 `await screen.findByText(/张三/)` 等表格就位后再断言工具栏——确认走到了有工具栏的分支。「飞书表格」外链是真 `<a>`(link role,`target="_blank"`),用 `getByRole("link", { name: /飞书表格/ })` 取、`queryByRole(...)===null` 验缺;href 直接对比 `feishuTableUrl(appToken, tableId)`(从 `src/core/formsClient` import)避免硬编码漂移。入口由 `FormSummary.feishuTable` 驱动:摘要带 `{appToken,tableId}` → 显示,无 → 不显示(与提交数为 0/非 0 是两条正交的轴)。
