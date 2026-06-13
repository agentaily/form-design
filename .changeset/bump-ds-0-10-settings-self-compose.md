---
"agentaily-forms": minor
---

chore(deps): bump @agentaily/design-system ^0.10.0 + 集成设置区改为调用方自组合

上游 0.10.0 移除了 `IntegrationSettings`（及别名 `ServiceConnections`）、厂商专用的 `FeishuCard`（连同导出的 `parseFeishuLink` 助手），并去掉了 `DeepSeekCard` 的对话模型选择（`model`/`onModelChange`/`models`）。`src/settings.jsx` 据此迁移：

- 用通用 `ConnectionCard` + `SecretField` + `HelpSteps` 自组合 DeepSeek 卡与飞书卡两张对称卡，外加自实现的**就绪栏（只 gate DeepSeek，飞书可选）**，替代被删的 `IntegrationSettings`。
- 把 `parseFeishuLink` 内联到产品侧（厂商专用，不再属于 DS）；飞书仍按「粘贴分享链接 → 桥接 App Token / 数据表」工作，后端契约与可观察行为零回退。
- 砍掉集成设置里的 DeepSeek 模型选择 UI；`model` 仍在 config 里 round-trip（echo 进、save 发回），re-save 不会清掉已存 model。对话输入框的模型芯片是独立功能，不在本次范围。

纯设计层迁移，后端 / 飞书提交流 / BDD 行为契约不变（飞书卡 link-less + 发布自动建表留待后续 PR）。
