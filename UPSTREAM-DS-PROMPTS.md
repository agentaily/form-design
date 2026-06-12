# 给「设计系统」上游的反馈 prompt（✅ 已落地 · 历史记录）

> **状态（2026-06-12）：两轮 seam 反馈都已发 DS 并落地，form-design 已采用，本文件留作历史。**
>
> - **第一轮（→ DS 0.5.0）：** `SignInPage` 加 `error`/`submitting`（form-design `signin.jsx` 已用、删了 `.d-signin-error` 兜底）；`IntegrationSettings` 加受控 seam `value/onChange/onSave/onTest/readiness/masked`。
> - **第二轮（→ DS 0.6.0，超越第一轮的 IntegrationSettings 方案）：** 把集成设置**拆成纯展示连接卡** `DeepSeekCard`+`FeishuCard`（组件零 localStorage/状态/保存/门禁，全归调用方）、**删除旧 `IntegrationSettings`**、`BrandMark` 默认 `cursor=false` 去掉 logo 光标。form-design 已改为 `/settings` 路由页 + 两张卡 + 自己的保存栏/后端 400 错误/门禁（`SettingsScreen`）。
> - 下面是当时发出的原始 prompt（第一轮），保留备查。第二轮的对话直接在 DS 的 Claude Design 项目里进行。

> **发给谁：** 这两段都是发给 **DS / `@agentaily/design-system` 的 Claude Design 项目**（组件库本身），
> **不是** form-design 自己的 Claude Design 项目（`aec2feef-c4e6-4456-a4c2-6093023f9161`，那个是用来设计 form-design 页面的）。
> 别发错对象。
>
> **背景：** 2026-06-12 这次同步把 form-design 的本地手搓 UI 全面换成了 DS 0.4.0 的上游组件
> （`DesignerShell` / `ConversationThread` / `AccountControl` / `SignInPage` / `MarkupLayer` / `Icon`）。
> 落地时发现两处上游组件**缺 seam**，下游只能本地兜底；按「通用能力放上游、缺了补上游、下游定契约上游照做」的原则，
> 把验证过的 API 当规格发回 DS 补齐，补齐后 form-design 删掉本地兜底。

---

## 1. `IntegrationSettings` 缺「后端持久化 seam」

```
原则:通用 UI 放上游,但 IntegrationSettings 现在把配置写死进 localStorage,接不到真实后端,
下游(form-design)用的是 BYOK 服务端配置(DeepSeek + 飞书 key 加密存服务器、供 /api/chat 代理用),
所以无法采用 IntegrationSettings——一采用就把真实后端退化成 localStorage mock。

【现状】IntegrationSettings 只有 onClose / showUsageCap / storageKey,内部 self-persist 到 localStorage,
Save 前自门禁 0/2 就绪态。没有任何让调用方接管「读 / 存 / 测连接」的入口。

【要补的能力】把 IntegrationSettings 改成「展示 + 受控」,保持向后兼容:
  - 新增可选 prop:
      value?            —— 受控配置 { deepseek?: {...}, feishu?: {...} };传了就用它,不再读 localStorage
      onChange?(next)   —— 字段变更回调
      onSave?(value)    —— 保存(下游写自己的后端;返回 Promise,pending 时禁用 Save+转圈)
      onTest?(which)    —— 测连接(which: "deepseek"|"feishu";返回 Promise<{ ok, message }> 驱动 TestRow/StatusPill)
      readiness?        —— 外部就绪态覆盖(下游按后端真实状态算 0/2,而不是只看本地字段非空)
      masked?           —— 掩码回显模式:已存的密钥显示掩码、不强迫重输、不把掩码当新值回传(对应下游的「不重交密文」§12.4)
  - 不传这些 prop 时维持现有 localStorage 自持久化(默认行为不变,向后兼容)。
  - 内部仍复用 SecretField / StatusPill / TestRow / HelpSteps;只把状态源从「内部 localStorage」放开为「可由调用方持有」。

【验收】
  - 不传新 prop:行为与现在完全一致(localStorage 自持久化),向后兼容。
  - 传 value/onSave/onTest/masked:调用方能用自己的后端读写、测连接驱动 TestRow/StatusPill、掩码回显不重交密文。
  - 深/浅主题正常,无 console 报错;更新 .d.ts 与 .prompt.md,给「受控 + 后端接线」的范例。
补完重新构建 bundle。
```

## 2. `SignInPage` 缺「后端错误展示 seam」（以及 submit busy 态）

```
原则:通用 UI 放上游。SignInPage 现在只有客户端校验(邮箱格式/密码长度/确认一致),
没有展示「服务端返回的错误」的入口。下游真实登录会返回 409 邮箱已注册 / 401 账号或密码错 /
400 弱密码,现在只能在 SignInPage 外面另起一个 Alert 浮层兜底,体验割裂。

【要补的能力】给 SignInPage 增加(保持向后兼容):
  - error?: ReactNode —— 在表单内(提交按钮上方)显示一条服务端错误;传了就显示,不传不显示。
  - submitting?: boolean —— 提交中:禁用提交按钮 + 显示 busy 文案/转圈(下游 onSubmit 是 async,要防重复提交)。
  - onSubmit 仍在「客户端校验通过」后触发,error 由调用方在 onSubmit 的 catch 里 set 进来。
  - 切换 mode(signin↔signup)或改动输入时,组件可清掉自己持有的客户端错误;外部 error 由调用方自己清。

【验收】
  - 不传 error/submitting:行为与现在一致,向后兼容。
  - 传 error:在提交按钮上方显示该错误;传 submitting:提交按钮禁用 + busy。
  - 深/浅主题正常,无 console 报错;更新 .d.ts 与 .prompt.md,补「async onSubmit + 后端错误回填」范例。
补完重新构建 bundle。
```

---

补完上游、把 form-design 的 `@agentaily/design-system` 绑定升到含这两处 seam 的新版后：

- `src/signin.jsx` 删掉 `.d-signin-error` 浮层兜底,改用 `SignInPage error={…} submitting={…}`;
- 集成设置整块换成上游 `IntegrationSettings`(受控 + 接 `core/configClient`),删掉本地 `src/settings.jsx`。
