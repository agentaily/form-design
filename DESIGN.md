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

- **`@agentaily/design-system` ^0.9.0**:**UI 一律消费,不手搓**;升级随上游流过来(DS 0.2 → 0.9 全面上移见 ROADMAP;0.9.0 补 `monitor` 图标,桌面切换按钮换回 `<Icon name="monitor">`)。
- 关键组件:`DesignerShell`(双栏外壳 + 移动端切换;`brand` 槽放 `BrandMark`)· `ConversationThread`(对话线程,纯渲染 + `controller`)· `AccountControl`(账户下拉,`onProfile` 开账户 tab)· `SignInPage`(登录)· `SettingsSheet`(0.8.0 起设置 = 浮起浮层,`nav` 双 tab 账户 + 集成)› 账户 tab:`PageSection` + `Avatar` + `Field`/`Input` + `SettingsSaveBar`(`form` 模式);集成 tab(DS 0.10.0 起**调用方自组合**,IntegrationSettings/FeishuCard 已移除):`PageSection`(就绪栏只 gate DeepSeek + 连接卡容器)+ `DeepSeekCard`(已无对话模型选择)+ **自组合飞书卡**(`ConnectionCard` + App ID/App Secret + `HelpSteps`,**link-less** —— 无分享链接,凭据只 app_id + app_secret)+ `SettingsSaveBar`(显式保存)· `MarkupLayer`(指向修改)· `Form.useForm`(表单校验)· `Icon` / `BrandMark`。**per-form「飞书表格↗」入口**落在「提交数据」工具栏(挨着导出 CSV),仅在该表单已自动建表时显示(§16.9)。
- 缺组件 / 缺 seam → 往上游反馈(下游定契约、上游照做;**叫人**)。

## 页面 / 界面清单(+ 设计状态)

| 页面 / 界面             | 设计状态                                                                                                                                                                                                                                                                                                                                       | 对应代码                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 设计器(左对话 / 右预览) | 已设计(DS 0.6 上移;0.8 chrome 对齐:顶栏 `BrandMark` + 面包屑左对齐、桌面切换=显示器图标,0.9.0 起走 DS `<Icon name="monitor">`)                                                                                                                                                                                                                 | `App.jsx`(DesignerShell)+ `chat.jsx` + `preview.jsx`                          |
| 未登录守卫(入口占位)    | 已设计(PR #90 `_QB7NM8v`:设计器=受保护页,挂 `<AuthGate>` 之后。真 `GET /api/auth/me` 裁决——校验中=中性品牌占位(`BrandMark` 闪烁光标 + 发丝扫描条 + mono「正在验证登录状态」,>200ms 才显现,`.ag-*` 引 DS token)/ 401=原地整屏登录视图(复用 SignInPage)/ 200 未验证=进设计器+软提醒条(不硬墙)/ 5xx·网络=「重试 / 去登录」占位。零受保护内容闪)   | `auth-gate.jsx`(`AuthGate`)+ `App.jsx` 路由分流 + `core/auth.validateSession` |
| 登录 `/signin`          | 已设计(独立路由页)                                                                                                                                                                                                                                                                                                                             | `signin.jsx`(SignInPage)                                                      |
| 设置浮层(账户 + 集成)   | 已设计(DS 0.8 浮层 `SettingsSheet` 双 tab;**route-reflected overlay**:开浮层反映 `/settings` URL 但不卸载设计器,✕/Esc/后退复原。账户 tab=头像/邮箱+可编辑显示名+退出;集成 tab=连接卡+SettingsSaveBar+后端 400 回显)                                                                                                                            | `settings.jsx`(`SettingsOverlay` → `AccountSection` / 集成 tab)               |
| 我的表单                | 已设计                                                                                                                                                                                                                                                                                                                                         | `forms-panel.jsx`                                                             |
| 公开表单(答题者填写)    | 已设计                                                                                                                                                                                                                                                                                                                                         | `public-form.jsx`                                                             |
| 提交结果查看            | 已设计(PR-6 / chat13:**「我的表单」面板内** list↔提交数据↔记录详情 内容切换——点卡片「查看全部提交」在**同一 PanelSheet 内** swap、不开新 Dialog;面包屑 我的表单→提交数据→#记录号 各级可回退 + `←` 返回;首开有动画、内部切换只内容 fade(`.mf-swap`)、详情是**面板内子页**非弹窗;接 #56 的 **D1 数据**:列=作答标签并集、统计/CSV 全基于真实提交) | `submissions-view.jsx`(`SubmissionsContent`,由 `forms-panel.jsx` 内联托管)    |
| 邮箱验证 / 找回密码     | 已设计                                                                                                                                                                                                                                                                                                                                         | `verify-email.jsx` / `reset-password.jsx`                                     |
| 发布 / 分享(QR 对话框)  | 已设计                                                                                                                                                                                                                                                                                                                                         | (分享 dialog)                                                                 |

## 设计 ↔ 代码映射

- **`.design-baseline/`**:上次同步的设计快照(`design-sync` 三路 diff 的基线;改设计后刷新)。当前含 `BASELINE.md` + `form-design/`。
- 落地链:`designer`(去 Claude Design 设计、拿 handoff)→ `design-syncer`(`design-sync` 进代码,保留 `src/core` / tests / features)。
- **改设计 → 同一次更新本文件**(页面清单 / 设计状态别漂移;文档与代码同步纪律)。
