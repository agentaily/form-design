---
"agentaily-forms": minor
---

feat(feishu): 飞书卡 link-less + per-form「飞书表格↗」入口 + 去 owner_config app_token/table_id echo（PR-4）

依赖 PR-1（#55，DS 0.10.0 + 设置区自组合）+ PR-3（#59，飞书 per-form 发布即自动建表 + saveConfig 放宽）。

- **飞书卡 link-less**：集成设置的飞书卡去掉「多维表格分享链接」输入（连同内联的 `parseFeishuLink` / `linkFromStored` 与解析回显行），改成与 DeepSeek 对称的「App ID + App Secret + 测试连接」（消费 DS `ConnectionCard` + `SecretField` + `HelpSteps`）；保存只发 `app_id` + `app_secret`。`HelpSteps` 末步改为「连接后由 Agentaily 自动建表，无需手动创建多维表格」。
- **per-form「飞书表格↗」入口**：「我的表单」→「提交数据」工具栏（挨着「导出 CSV」）新增一个「飞书表格↗」外链——当该表单已「发布即自动建表」（`forms` 行的 `feishu_app_token` / `feishu_table_id` 都非空）时显示，在新标签打开**这张表单对应的**飞书多维表格。`GET /api/forms` 投影 `forms` 行的 per-form 表定位（`FormSummary.feishuTable`），前端用纯函数 `feishuTableUrl(appToken, tableId)` 拼 URL（与 `publicFormUrl` 同风格）。它是真链接（`<a target="_blank">`），不来自提交响应（§18.6 绝不带 app_token/table_id）。
- **echo 清理（接 #59 推迟）**：`MaskedConfig.feishu` 与 `FeishuInput` 去掉 `appToken` / `tableId`；`getMaskedConfig` 不再回显 `owner_config` 的 `app_token` / `table_id`，`saveConfig` 把这两列恒绑 `NULL`（列保留仅向后兼容）。前端 `configClient` 的 `MaskedFeishu` / `FeishuInput` 同步去这两字段。提交同步链不受影响（同步读 `getFormFeishuTable(slug)` 定位 per-form 表 + `owner.feishu` 的 `app_id` / `app_secret` 换 token）。

契约：`integration-settings.feature` 去掉 app_token/table_id 回显与「半填→400」场景（飞书凭据 = app_id + app_secret 两项）；`data-dashboard.feature` 新增 2 条 per-form 入口场景；`SPEC.md` §12/§21 + `DESIGN.md` 同步。done-gate 全绿（typecheck + 前端 662 + build + workers 445 + e2e 7）。
