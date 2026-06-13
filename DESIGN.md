# Design — Agentaily Forms

这个产品**长什么样、怎么设计的**的真相源(视觉 / 交互维度)。和 [`SPEC.md`](./SPEC.md)(架构真相)、[`features/`](./features)(行为真相)**三足鼎立** —— 它是**视觉契约**。

> 本产品的视觉系统(palette / type / 组件)在上游 `@agentaily/design-system` —— 本文件**不重复**那些,只记 form-design **自己的**设计指针 + 决策。`designer` agent 读本文件当真相源。

## 设计在哪做(来源)

- **Claude Design 项目**:`aec2feef-c4e6-4456-a4c2-6093023f9161`(claude.ai/design)—— form-design 的页面在这里设计 → 拿 handoff → `design-sync` 落地进代码。
- handoff 取法、`design-sync` 三路合并见 `design-via-claude-design` skill。**别和上游 `@agentaily/design-system` 的设计项目搞混**(那个是设计组件本身的;form-design 缺组件 / seam 时才往那反馈,历史见 [`UPSTREAM-DS-PROMPTS.md`](./UPSTREAM-DS-PROMPTS.md))。

## 设计原则 / 交互

- **对话式表单设计器**:左侧 Agent 对话、右侧实时表单预览(`DesignerShell` 双栏 + 可拖拽分隔)。
- **数据与表现分层**(贯穿全文的核心约定):Schema 是数据真相(字段 / 类型 / 校验 / field id),生成的 JSX + 主题只是表现层;无论渲染多自由,提交时都归位成结构化数据(见 SPEC)。
- **指向修改**:hover 高亮预览元素、点击带身份发消息到对话(`MarkupLayer`,靠 preview 上的 `data-mk-*`)。
- **响应式**:≤720px 单列 + 对话 / 预览分段切换器、头部压缩;≤380px 仅留 logo。
- **品牌**:随上游 DS(极客风、简约、大气、科技感、双主题暗色默认)。

## 消费的设计系统

- **`@agentaily/design-system` ^0.8.0**:**UI 一律消费,不手搓**;升级随上游流过来(DS 0.2 → 0.8 全面上移见 ROADMAP)。
- 关键组件:`DesignerShell`(双栏外壳 + 移动端切换)· `ConversationThread`(对话线程,纯渲染 + `controller`)· `AccountControl`(账户下拉)· `SignInPage`(登录)· `SettingsSheet` › `IntegrationSettings` › `DeepSeekCard` / `FeishuCard` + `SettingsSaveBar`(0.8.0 起集成设置 = 浮层 settings 页 › 集成分区 › 纯展示连接卡 + 显式保存栏)· `MarkupLayer`(指向修改)· `Form.useForm`(表单校验)· `Icon` / `BrandMark`。
- 缺组件 / 缺 seam → 往上游反馈(下游定契约、上游照做;**叫人**)。

## 页面 / 界面清单(+ 设计状态)

| 页面 / 界面             | 设计状态                                                                                           | 对应代码                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 设计器(左对话 / 右预览) | 已设计(DS 0.6 上移)                                                                                | `App.jsx`(DesignerShell)+ `chat.jsx` + `preview.jsx` |
| 登录 `/signin`          | 已设计(独立路由页)                                                                                 | `signin.jsx`(SignInPage)                             |
| 集成设置 `/settings`    | 已设计(DS 0.8 浮层链:SettingsSheet › IntegrationSettings › 连接卡 + SettingsSaveBar;后端 400 回显) | `settings.jsx`(SettingsScreen)                       |
| 我的表单                | 已设计                                                                                             | `forms-panel.jsx`                                    |
| 公开表单(答题者填写)    | 已设计                                                                                             | `public-form.jsx`                                    |
| 提交结果查看            | 已设计                                                                                             | `submissions-view.jsx`                               |
| 邮箱验证 / 找回密码     | 已设计                                                                                             | `verify-email.jsx` / `reset-password.jsx`            |
| 发布 / 分享(QR 对话框)  | 已设计                                                                                             | (分享 dialog)                                        |

## 设计 ↔ 代码映射

- **`.design-baseline/`**:上次同步的设计快照(`design-sync` 三路 diff 的基线;改设计后刷新)。当前含 `BASELINE.md` + `form-design/`。
- 落地链:`designer`(去 Claude Design 设计、拿 handoff)→ `design-syncer`(`design-sync` 进代码,保留 `src/core` / tests / features)。
- **改设计 → 同一次更新本文件**(页面清单 / 设计状态别漂移;文档与代码同步纪律)。
