# SPEC：对话式动态表单设计器

> **产品定位：** 通用的表单/问卷收集工具（类似 Tally、金数据、腾讯问卷），核心链路是「设计 → 发布 → 收集 → 看结果」。差异点：用对话式 Agent + 动态渲染做出比传统表单工具更自由的视觉表现。
>
> 左侧 Agent 对话，右侧实时渲染的 React 表单画布。Agent 通过工具调用编辑一组虚拟文件（HTML 入口 + JSX），客户端在浏览器内用 Babel 即时编译并渲染到 iframe。Agent loop 跑在客户端，后端只做 LLM 代理。
>
> **数据与表现分层（贯穿全文的核心约定）：** Schema 是数据真相（字段 / 类型 / 校验 / field id），生成的 JSX 与主题只是表现层；每个 input 绑定已知 field id，无论渲染得多自由，提交时都自动归位成结构化数据。

---

## 0. 设计原则（先定调）

1. **纯客户端，无自建后端。** AI 调用用 BYOK 从浏览器直连 LLM；唯一需要服务器侧的是答题者提交的持久化，用托管 BaaS（零服务端代码）。
2. **工具调用由我们的程序执行，不让模型自己解析。** 用 LLM 原生的 tool use（function calling）能力，模型只返回结构化的 `tool_use`，由客户端的 Tool Executor 执行。
3. **代码是真相，画布是渲染。** 右侧看到的表单是由一组文件（VFS）实时编译渲染出来的，不是独立的可视化状态。改文件 → 重渲染。
4. **闭环可自愈。** iframe 里的编译/运行错误能回传给 Agent，让它自己修。这是「看起来很聪明」的关键。
5. **停止条件唯一：** LLM 不再返回 `tool_use`（返回纯文本）即结束本轮。

---

## 1. 架构分层（无后端 / 纯客户端）

| 层 | 跑在哪 | 职责 |
|---|---|---|
| 客户端 (Browser) | 用户浏览器 | 全部：Chat UI、Agent Orchestrator（ReAct 循环）、VFS、Tool Executor、Preview Renderer (iframe)、**直接调用 LLM** |
| LLM | 第三方 | 返回文本 + `tool_use` 块。浏览器直连（BYOK） |
| 数据层（仅收集时需要） | 托管 BaaS | 持久化答题者提交。详见第 8 节 |

> **没有自建后端。** AI 调用走 BYOK 浏览器直连；唯一需要"共享持久化"的是答题者提交，用托管 BaaS 解决（零服务端代码）。

数据流：

```
用户输入
  → Orchestrator 组装 messages + tools
  → 浏览器直接调 LLM（BYOK，带 anthropic-dangerous-direct-browser-access）
  → LLM 返回 tool_use 块
  → Tool Executor 客户端执行，改写 VFS
  → VFS 变化 → Renderer 重新组装 HTML → 注入 iframe
  → 工具结果回填 messages
  → 回到「浏览器直接调 LLM」
  → 直到 LLM 返回纯文本（无 tool_use）→ 结束，显示给用户
```

### 1.1 三个面（别只盯着设计器）

收集工具其实是三个面，后两者只消费设计器产出的 schema：

| 面 | 给谁看 | 说明 |
|---|---|---|
| 设计器 | 表单作者 | 左 chat + 右预览。本 SPEC 的主体，Agent loop / VFS / 工具都在这一面 |
| 发布的填写页 | 答题者（公开） | 消费 schema 渲染出可填写的表单页 |
| 数据后台 | 表单作者 | 回收、聚合、导出、分析提交数据 |

### 1.2 设计态 vs 发布态（两条渲染路径，不能复用）

这是最容易踩的坑：作者预览和答题页虽然长得一样，但渲染路径必须分开。

- **设计态（作者预览）：** iframe + Babel standalone 实时转译 JSX。只有作者一个人看，迭代速度第一，零构建即可。就是 Claude Design 那套。
- **发布态（答题者填写页）：** 可能被成千上万人访问。**绝不能**给每个访客塞 React dev UMD + Babel standalone 并在浏览器里现场转译——慢、无压缩、且不应在客户端转译代码。发布时二选一：
  - **(a) 固定 schema 渲染器**（推荐默认）：服务静态页 + 你的渲染器 + schema JSON。快、可缓存、安全。
  - **(b) 发布时编译快照**：若允许自定义表现层 JSX，在发布动作里把 JSX 编译成压缩 bundle（无后端时用浏览器内的 esbuild-wasm 跑这次编译），产物存进 BaaS / 静态托管，答题端直接加载、不再转译。

> 一句话：iframe-Babel 只服务设计态；发布态走 schema 渲染或编译快照。

---

## 2. 虚拟文件系统 (VFS)

内存里的一个 map，是 Agent 编辑的对象，也是渲染的数据源。

```ts
type VFile = {
  path: string;        // "/form.jsx"
  content: string;
  type: 'html' | 'jsx' | 'json';
  updatedAt: number;
};
type VFS = Record<string, VFile>;
```

初始文件结构（参考 Claude Design 的组织方式）：

```
/index.html        ← 入口，CDN <head> + <script type="text/babel"> 列表
/theme.jsx         ← 设计 token（颜色、间距、圆角）
/components.jsx    ← 通用组件（Field、Section、SubmitBar…）
/schema.jsx        ← 表单数据模型（Schema 路线时使用）
/form.jsx          ← 主表单组件（渲染 schema 或自由 JSX）
/mount.jsx         ← ReactDOM 挂载到 #root
```

### 模块组织：两种选择

- **A. 全局挂载（推荐 MVP）** — 和 Claude Design 一致。文件之间不用 `import`，靠 `window.X` 共享，每个文件末尾 `Object.assign(window, { Form })`。配合 Babel standalone 最稳，零构建。代价：要给每个文件的 `useState` 起别名（`const { useState: useStateForm } = React`）避免重复声明。
- **B. ES Module + import maps** — 更干净、有模块边界，但 Babel standalone 处理 module 需要额外配置，MVP 阶段不值得。

> 建议先走 A，跑通后再视情况升级。

---

## 3. 工具定义（Agent 的能力边界）

用 LLM 原生 tool use schema 定义。**文件操作类工具是基础，表单操作类工具是进阶。**

### 3.1 文件操作工具（必备）

| 工具 | 入参 | 作用 |
|---|---|---|
| `list_files` | — | 返回文件树 |
| `read_file` | `path` | 返回文件内容 |
| `write_file` | `path, content` | 创建或全量覆盖 |
| `str_replace` | `path, old_str, new_str` | 精准局部替换（`old_str` 必须唯一） |
| `delete_file` | `path` | 删除 |

> **为什么必须有 `str_replace`：** 全量重写大文件费 token 且容易出错。局部替换是 Claude Code / Claude Design 省 token 的核心手段，让 Agent 改一行就只发一行。

工具 schema 示例（Anthropic 格式）：

```json
{
  "name": "str_replace",
  "description": "替换文件中唯一匹配的字符串。old_str 必须在文件中恰好出现一次。",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": { "type": "string" },
      "old_str": { "type": "string" },
      "new_str": { "type": "string" }
    },
    "required": ["path", "old_str", "new_str"]
  }
}
```

### 3.2 表单操作工具（进阶，收集工具的主干）

收集工具建议走 **Schema 路线**：不让 Agent 直接写 JSX，而是操作一个结构化 schema：

| 工具 | 入参 | 作用 |
|---|---|---|
| `get_form_schema` | — | 返回当前 schema |
| `add_field` | `field` | 增加字段 |
| `update_field` | `id, patch` | 改字段属性 |
| `remove_field` | `id` | 删字段 |
| `reorder_fields` | `ids[]` | 排序 |
| `set_validation` | `id, rules` | 设校验规则 |

字段模型示例：

```ts
type Field = {
  id: string;
  type: 'text' | 'number' | 'select' | 'date' | 'checkbox' | 'radio' | 'file' | 'group';
  label: string;
  required?: boolean;
  options?: { label: string; value: string }[];
  validation?: { pattern?: string; min?: number; max?: number; message?: string };
  children?: Field[];  // group 嵌套
};
```

### 两条路线 —— 不是二选一，是分工

对收集工具来说，纯自由 JSX 会丢掉可统计的结构化数据，所以正确做法是让两者各司其职：

| | 自由 JSX | Schema |
|---|---|---|
| 负责 | **表现层**：布局、风格、动效 | **数据层**：字段、类型、校验、field id |
| 视觉自由度 | 高（像 Claude Design） | — |
| 数据可统计 / 可导出 | 不可（散装 DOM） | **可** |
| 是否本产品的真相 | 否 | **是** |

> **建议：Schema 为数据真相，生成的 JSX/主题为表现层，靠 field id 绑定缝合。** 即使表单被渲染得很自由，每个 input 都挂一个已知 field id，提交时自动归位成结构化数据。这样视觉自由度和干净数据两者都不丢。

---

## 4. Agent Loop（单回合 ReAct）

下面的 `runAgentTurn` 是「一个回合」：吃一条（或合并后的）用户输入，跑 ReAct 直到无 `tool_use`。它由 §4.1 的队列层驱动。

```js
const MAX_ITERS = 25; // 防死循环

async function runAgentTurn(userText) {
  messages.push({ role: 'user', content: userText });

  for (let i = 0; i < MAX_ITERS; i++) {
    // 1) 浏览器直接调 LLM（BYOK），开 streaming
    const res = await callLLM({ system, messages, tools });
    messages.push({ role: 'assistant', content: res.content });

    // 2) 取出所有 tool_use 块
    const toolUses = res.content.filter(b => b.type === 'tool_use');

    // 3) 停止条件：没有工具调用 → 输出文本，结束
    if (toolUses.length === 0) {
      renderAssistantText(res.content);
      return;
    }

    // 4) 客户端逐个执行工具，改写 VFS
    const results = [];
    for (const tu of toolUses) {
      try {
        const out = await executeTool(tu.name, tu.input); // 改写 VFS
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: out });
      } catch (e) {
        // 工具失败 → 把错误回填，让 Agent 自己修
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(e), is_error: true });
      }
    }

    // 5) 工具结果回填，重渲染右侧画布
    messages.push({ role: 'user', content: results });
    rerenderPreview(); // VFS 变了

    // 6) 继续循环
  }
}
```

要点：

- **流式（streaming）很重要** — 让用户看到 Agent 的思考和工具调用过程，体验上接近 Claude Design 的「实时搭建」。
- **多工具并发** — 一轮里可能有多个 `tool_use`，全部执行完再回填、再渲染（避免半成品闪烁）。
- **渲染 debounce** — 一批工具执行完刷新一次，而不是每个文件写完就刷。
- **`max_iterations` 安全阀** — 防止模型陷入工具调用死循环。

### 4.1 连续发送：消息队列 + 批量合并

> 让用户在一个回合跑着时随时再发消息（Claude Code 桌面/网页版那种体验）。本质：用户输入与 Agent 执行解耦成 **一个 FIFO 队列 + 一个单消费者循环**。`runAgentTurn` 是「一个回合」，下面的 `pump` 是驱动它的队列层。

三个已定决策：

- **单消费者** — 同一时刻只允许一个回合在跑（都在改同一份 VFS，并发会打架）。连发 N 条不会开 N 个循环，只进队列。
- **flush 时机 = 回合真正结束**（无 `tool_use` 时取下一批）。比 Claude Code 现状（在下一个 LLM 停顿点 flush、含工具调用之间）更稳，避免多步编辑被中途打断。
  - *可选切换*：若要更跟手，改成「停顿点 flush」——需在 `runAgentTurn` 的工具循环里加一个检查点、回合中途消费队列。代价是可能打断进行中的编辑。
- **批量合并** — flush 点把积压的多条**原子取走**合并成一次输入，而不是一条一回合。

**必做：给 mid-work 消息打标签。** 排队消息若不加说明，模型会把它误读成对上一条输出的回复。合并时要标清「这些是你工作期间陆续输入的」。

```js
const queue = [];      // 待消费的用户消息（pending，可见、可取消）
let running = false;   // 消费循环是否在跑

function enqueue(text) {
  // 记录是否"在忙时打的" → 决定要不要打标签
  queue.push({ id: uid(), text, ts: Date.now(), status: 'pending', typedWhileBusy: running });
  renderQueue();
  pump();
}

async function pump() {
  if (running) return;                            // 单消费者：已有回合在跑就返回
  running = true;
  try {
    while (queue.length > 0) {
      const batch = queue.splice(0, queue.length); // 原子取走当前所有排队消息
      batch.forEach(m => (m.status = 'running'));
      renderQueue();
      await runAgentTurn(mergeBatch(batch));        // 跑完整回合，直到无 tool_use
      // 回合结束 → 回到顶部；期间新进来的进入下一批
    }
  } finally {
    running = false;                              // 队列空 → 空闲，等下次 enqueue
  }
}

function mergeBatch(batch) {
  const typedWhileBusy = batch.some(m => m.typedWhileBusy);
  const body = batch.length === 1
    ? batch[0].text
    : batch.map((m, i) => `${i + 1}. ${m.text}`).join('\n');
  if (!typedWhileBusy) return body;
  return `<context note="以下消息是你处理上一轮时陆续输入的，请按顺序一并处理，而不是当作对上一条输出的回应">
${body}
</context>`;
}
```

要点：

- `if (running) return` 让连发 N 条只启动一个循环，其余进队列等同一循环消费（`pump` 幂等）。
- `splice` 在 flush 点原子取走，避免半消费；取走前的 pending 消息可被用户取消。
- 队列要可见：显示 pending 列表、允许取消未消费的、（可选）调顺序——这是"连续发"体验的关键。
- 边角：排队消息里若含斜杠命令 / 特殊语法，决定在入队时预处理还是当纯文本发。

---

## 5. 渲染管线（VFS → iframe）

iframe 没有真实文件系统，所以要把 VFS 拼成一个自包含的 HTML 字符串，用 `srcdoc` 注入。

```js
function buildSrcDoc(vfs) {
  const head = vfs['/index.html'].content; // 含 CDN <script> 们
  const jsxBlocks = Object.values(vfs)
    .filter(f => f.type === 'jsx')
    .map(f => `<script type="text/babel">${f.content}</script>`)
    .join('\n');
  return assembleHtml(head, jsxBlocks); // React/ReactDOM/Babel + #root + jsxBlocks
}

function rerenderPreview() {
  iframeEl.srcdoc = buildSrcDoc(vfs);
}
```

- **沙箱：** `sandbox="allow-scripts"`（不给 `allow-same-origin` 以隔离生成代码，但 `postMessage` 仍可用）。
- **CDN：** React 18 UMD + ReactDOM + `@babel/standalone`，加 SRI（`integrity`），和 Claude Design 一样。
- **热更新策略：** MVP 直接整页重建 `srcdoc`（最简单）。进阶再做「保留 state 的热替换」。

---

## 6. iframe ↔ 父窗口通信（postMessage 协议）

双向消息，约定 `type` 字段：

**iframe → 父：**

```js
// 编译/运行错误（错误自愈的关键）
{ type: 'error', phase: 'compile' | 'runtime', message, stack }
// 元素被点击（用于 inline comment / 选中改）
{ type: 'select', elementId, label }
// 表单被提交（拿到收集的数据）
{ type: 'submit', data }
```

**父 → iframe：**

```js
{ type: 'inject', srcdoc }      // 注入新代码（一般直接换 srcdoc）
{ type: 'highlight', elementId } // 高亮某元素
```

### 错误自愈闭环（重点）

iframe 内包一层 error boundary + `window.onerror` + 捕获 Babel 编译异常，出错就 `postMessage` 给父窗口；父窗口把错误塞进下一轮 `messages`（作为 `tool_result` 的 `is_error` 或一条 system 提示），Agent 收到后自动修复。

```
iframe 报错 → postMessage → 父窗口捕获 → 回填到 messages → Agent 自动改 bug
```

### 6.1 指向修改 / 元素定位（markup，Phase 3「元素选中改」的轻量版）

「选中改」不一定要做成评论系统。最小可用的形态是一个**纯元素定位工具，面向个人、不存任何评论**：以前在对话框只能用文字描述「右侧那个提交按钮」，现在直接指向元素、带着它的身份发消息。

- **入口：** 预览工具栏（`d-seg`，device 切换按钮左侧 + 一个 `d-seg__sep` 分隔）一个「指向修改」`IconButton`（markup 图标）。**仅当 `tab==="preview"` 且 `fieldCount>0` 时可用**；点亮 = 进入 markup 模式（按钮 solid）。
- **可定位元素：** 预览侧给元素打 `data-mk-label` / `data-mk-kind` 标签 —— ①表单标题与介绍 hero（kind=标题）②每个字段（label=字段名去掉末尾必填星，kind 按类型映射）③提交按钮 footer（kind=按钮）。字段类型 → kind 中文标签的映射见 `src/core/markup.ts`（`FIELD_KIND_LABEL`）。
- **交互：** hover 高亮光标下最近的带 `data-mk-label` 的祖先，显示高亮框 + 左上角身份标签 `label · kind`；click 选中（冻结 hover），其下方弹出 composer（textarea +「取消」/「发送到对话」）。
- **发送：** 按 `〔label · kind〕note`（无 kind 时 `〔label〕note`）格式，经现有 `onSend` 进入**左侧对话**；发送后退出 markup 模式。空白 note 不可发送。
- **退出：** `Esc`（选中态→先取消选中；非选中→退出 markup）、✕「退出」按钮。
- **顶部提示 pill：** 未选中「移到要改的地方，点击它再描述修改」；已选中「输入修改要求，发送到左侧对话」。
- **分层：** 可单测的纯函数（`formatMarkupMessage` / `fieldKindLabel` / `mkLabel`）落 `src/core/markup.ts`；DOM 交互（hover / `elementFromPoint` / 高亮框 / composer 定位）留给 `MarkupLayer` React 组件。视觉单色 accent、硬边、mono 标签，组件从 `@agentaily/design-system` 消费，不 re-vendor 设计原型的 `_ds/`。

> 与 §6 的 `postMessage select` 是同一诉求的两种实现：当预览还在父窗口同源渲染（设计态）时走本节的 DOM 定位即可；一旦预览进了隔离 iframe，再升级为 `{ type: 'select' }` 跨窗口回传。markup 的产物始终是一条带身份前缀的普通对话消息，不引入新的持久化。

---

## 7. 前端状态

```ts
interface AppState {
  chat: ChatMessage[];   // UI 展示用（可与 LLM messages 不完全一致）
  llmMessages: Message[];// 发给模型的完整上下文
  queue: QueueItem[];    // 待消费的用户消息（pending / running）
  running: boolean;      // 消费循环是否在跑（单消费者闸门）
  vfs: VFS;              // 文件
  srcdoc: string;        // 当前渲染的 HTML
  lastError: string | null;
}
```

建议用 React + 一个轻量 store（zustand 或 `useReducer`）。`chat` 和 `llmMessages` 分开：前者是给人看的，后者是给模型看的（含 tool_use / tool_result 块）。

---

## 8. 无后端：BYOK 直连 + 数据层

### 8.1 LLM 调用（BYOK，浏览器直连）

```js
// key 存在 IndexedDB（不放 localStorage，降低被脚本读取的面）
fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': userApiKey,                       // 用户自带
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true', // 允许浏览器直连
  },
  body: JSON.stringify({ model, system, messages, tools, stream: true }),
});
```

- 每个用户烧自己的额度 → 你没有共担 token 成本、不用做限流。
- key 暴露在客户端是这条路的固有代价：必须防 XSS，生成代码的 iframe 沙箱隔离在这里尤其关键。
- 模型可换（不同 provider 各有浏览器直连方式），但 tool use 的协议要对齐。

### 8.2 数据层（仅"收集"需要，不是你自建的后端）

收集陌生人的提交必须有共享持久化（浏览器之间互相隔离，存本地没用）。按运维负担从轻到重：

| 方案 | 你要写的代码 | 说明 |
|---|---|---|
| 托管 BaaS（推荐） | 零服务端代码 | Supabase / Firebase / PocketBase。填写页用 SDK 直接写一条提交；用行级权限控制"公开可写、仅作者可读" |
| 第三方表单端点 | 无 | Formspree / Basin，给个 POST URL 帮你收。收集托管给别人 |
| 真·零基础设施 | 无 | 只能存进填写者本地浏览器 → 无法跨人收集。仅适合导出静态 HTML 自接接口 |

> 设计器（含 AI）全程不碰数据层；数据层只在"发布 + 收集"时出现。

---

## 9. 安全

- iframe `sandbox` 隔离 Agent 生成的代码，不给 `allow-same-origin`。
- CDN 资源加 SRI（integrity hash）。
- API key 用户自带（BYOK），存浏览器 IndexedDB；它会暴露在客户端，因此防 XSS 是第一要务，iframe 不给 `allow-same-origin`。
- 不在父窗口 `eval` 任何生成代码（编译只在 iframe 内）。
- 表单提交数据常含个人隐私（姓名、电话、邮箱等），传输与存储要加密、脱敏、合规留痕；公开填写页要防刷、防注入。

---

## 10. 分阶段落地

**Phase 1 — MVP（跑通闭环）**
- 单文件 VFS、`write_file` / `str_replace` / `read_file`
- 整页 `srcdoc` 重渲染
- 非流式 loop、基础错误显示

**Phase 2 — 体验与稳健**
- streaming、错误自愈闭环、多文件、`delete_file`
- 渲染 debounce、`max_iterations` 安全阀
- 连续发送：消息队列 + 批量合并 + mid-work 标签（§4.1），队列可见可取消

**Phase 3 — 表单专用与协作**
- Schema 化表单工具（`add_field` 等）+ 校验
- inline comment / 元素选中改（postMessage select）
- 版本历史 / 回滚、导出（HTML / JSON schema）
- 保留 state 的热更新

**Phase 4 — 发布与回收（产品闭环）**
- 发布态渲染：固定 schema 渲染器（默认）或发布时编译快照
- 公开填写页：防刷、防注入、提交落库
- 数据后台：回收列表、聚合统计、CSV/Excel 导出

---

## 11. 技术选型小结

| 维度 | 选择 | 理由 |
|---|---|---|
| 渲染 | React 18 UMD + Babel standalone (CDN) | 零构建，和 Claude Design 一致，导出即可独立运行 |
| 模块组织 | 全局挂载（MVP） | 配 Babel standalone 最稳 |
| 表单 | Schema 为数据真相 + JSX 表现层 | 收集工具必须产出可统计、可导出的结构化数据 |
| Agent | LLM 原生 tool use | 不自己解析模型文本，结构化更可靠 |
| 通信 | postMessage | iframe 隔离下的标准做法 |
| 后端 | 无（BYOK 直连）+ 收集用托管 BaaS | 不自建/运维服务器；BaaS 承担答题数据持久化 |

---

## 12. 后端 · owner 集成配置存取（发布型 BYOK）

> **与第 0/8 节的关系：** 第 8 节描述的是「纯设计器」形态——设计态浏览器直连 LLM、答题数据写托管 BaaS。本节面向**发布型表单**形态（见项目记忆 `form-design-byok-feishu-architecture`）：owner（表单作者）把自己的 DeepSeek key 与飞书多维表格凭据**一次性配置好**，由 Cloudflare Workers + D1 代为持有，后续的 LLM 代理、答题落库都用 owner 自己的额度与租户。本节只定义**第一刀：配置的保存与读取**——`POST /api/config` 与 `GET /api/config`。
>
> **不在本节：** DeepSeek/飞书的「测试连接」（真实外呼）、LLM 代理转发、提交写飞书多维表格——都是后续 feature。
>
> **MVP 单 owner：** 不做登录鉴权、不做多租户。D1 里固定单行配置（单 owner id），后续接入鉴权时再扩成多行。

### 12.1 owner 配置的两块凭据

owner 在「集成设置」里连接两样东西，后端负责**持久化 + 安全**：

| 块 | 字段 | 性质 | 落库方式 |
|---|---|---|---|
| DeepSeek | `apiKey`（必填） | **密钥** | AES-GCM 密文 + iv |
| DeepSeek | `model`（可选，默认留空） | 非密 | 明文 |
| 飞书多维表格 | `appId` | 非密 | 明文 |
| 飞书多维表格 | `appSecret` | **密钥** | AES-GCM 密文 + iv |
| 飞书多维表格 | `appToken`（多维表格 app token） | 非密 | 明文 |
| 飞书多维表格 | `tableId` | 非密 | 明文 |

> **为什么 DeepSeek key 必填、飞书整块可选：** 没有 DeepSeek key 连设计器都跑不起来；飞书是「答题落库」目的地，配置阶段可以先留空，发布前再补。本刀只校验 DeepSeek `apiKey` 必填；飞书字段要么整块给齐、要么整块留空（半填留给后续 feature 决定）。

### 12.2 加密方案（AES-GCM + `CONFIG_KEY` + 每字段独立 iv）

- **主密钥：** 从 Worker 环境变量 `CONFIG_KEY`（`wrangler secret put CONFIG_KEY`）读取，**绝不入库、绝不进 git**。约定为 base64 编码的 256-bit 原始密钥，经 Web Crypto `importKey` 导入成 `AES-GCM` `CryptoKey`。
- **算法：** Web Crypto `crypto.subtle` 的 `AES-GCM`，96-bit（12 字节）随机 iv。
- **每字段独立 iv：** 每个密钥字段（DeepSeek `apiKey`、飞书 `appSecret`）各自加密、各自生成一个**新的随机 iv**，密文与 iv 成对落库。**绝不复用 iv**——GCM 下 iv 复用会泄露明文。
- **存储编码：** 密文与 iv 均以 **base64 字符串**落库（D1 列为 `TEXT`）。
- **读取时解密再掩码：** `GET /api/config`（及 `POST` 的回显）在 Worker 内用 `CONFIG_KEY` 解密后，经 `maskSecret` 只返回**掩码串**（保留首尾、隐藏中间），**绝不返回完整明文**（见 §12.4）。这样 owner 认得出配的是哪把 key、且掩码对同一 key 稳定一致。完整明文仅服务后续 feature（LLM 代理、写飞书）在 Worker 内部使用，永不出网。

### 12.3 API 契约

#### `POST /api/config` — 保存配置

请求体（`OwnerConfigInput`，JSON）：

```jsonc
{
  "deepseek": {
    "apiKey": "sk-xxxxxxxxxxxxxxxx",   // 必填，非空
    "model": "deepseek-chat"            // 可选；缺省/空串表示未指定
  },
  "feishu": {                           // 可选整块；留空表示「暂不配置飞书」
    "appId": "cli_xxx",
    "appSecret": "yyyy",                // 密钥
    "appToken": "bascnXXXX",
    "tableId": "tblXXXX"
  }
}
```

- 成功：`200`，响应体直接返回保存后的掩码视图（与 `GET /api/config` 同形状的 `MaskedConfig`），让前端无需二次拉取即可回显。
- 缺必填（DeepSeek `apiKey` 为空/缺失）：`400`，`{ "error": "deepseek.apiKey is required" }`，**不落库**。
- 保存是**整行覆盖（upsert 单行）**：每次 `POST` 写完整配置，已存在则更新、不存在则插入；`updated_at` 刷新为当前时间。

#### `GET /api/config` — 读取配置（密钥一律掩码）

响应体（`MaskedConfig`，JSON）：

```jsonc
{
  "deepseek": {
    "apiKey": "sk-…wxyz",   // 掩码串；从未配置时为 null
    "model": "deepseek-chat" // 明文回显；未指定为 null
  },
  "feishu": {
    "appId": "cli_xxx",      // 明文回显；未配置为 null
    "appSecret": "yy…yy",    // 掩码串；未配置为 null
    "appToken": "bascnXXXX", // 明文回显
    "tableId": "tblXXXX"     // 明文回显
  },
  "updatedAt": "2026-06-11T08:00:00.000Z" // 从未配置时为 null
}
```

- **密钥字段一律掩码，绝不返回完整明文。** `apiKey` / `appSecret` 在 Worker 内解密后经 `maskSecret` 脱敏（保留首尾、隐藏中间）再返回（见 §12.4），调用方拿不到完整原值。
- **未配置时返回空骨架：** D1 里没有那一行时，返回上面的结构但所有值为 `null`，HTTP 仍为 `200`（「没配过」是正常态，不是错误）。
- 非密字段（`model` / `appId` / `appToken` / `tableId`）明文回显，方便前端展示当前连的是哪张表。

### 12.4 掩码规则（`maskSecret`）

把密钥转成「看得出配过、但还原不出原值」的展示串：

- 保留首尾少量字符、中间用省略号 `…`（U+2026）连接，例如 `sk-…wxyz`。
- 输入太短（不足以安全保留首尾）时，整体打码、不暴露任何原文字符（如全 `•` 或固定占位），**绝不**因为短就回退成明文。
- 空串 / 未配置的密钥字段映射为 `null`，而非掩码串——`null` 表示「没配过」，掩码串表示「配过、这是脱敏预览」。
- 掩码作用于**解密后的明文**（首尾可见、中间隐藏），所以 owner 认得出配的是哪把 key，且同一 key 多次保存的掩码稳定一致；它只服务 UI 回显，从掩码无法还原完整原值。

### 12.5 D1 表结构（`workers/schema.sql`）

单行单 owner 设计：固定主键 `owner_id`（MVP 恒为 `'default'`），整行 upsert。

```sql
CREATE TABLE IF NOT EXISTS owner_config (
  owner_id              TEXT PRIMARY KEY,   -- MVP 恒为 'default'（单 owner）
  -- DeepSeek
  deepseek_key_cipher   TEXT,               -- AES-GCM 密文 (base64)
  deepseek_key_iv       TEXT,               -- 该密文的 iv (base64)，与 cipher 成对
  deepseek_model        TEXT,               -- 明文，可空
  -- 飞书多维表格
  feishu_app_id         TEXT,               -- 明文，可空
  feishu_secret_cipher  TEXT,               -- AES-GCM 密文 (base64)
  feishu_secret_iv      TEXT,               -- 该密文的 iv (base64)，与 cipher 成对
  feishu_app_token      TEXT,               -- 明文，可空
  feishu_table_id       TEXT,               -- 明文，可空
  updated_at            TEXT NOT NULL       -- ISO-8601，每次写入刷新
);
```

- 密文/iv 成对：`*_cipher` 与对应 `*_iv` 要么同时有值、要么同时为 `NULL`。
- 单行约束靠固定主键实现；后续接鉴权时把 `owner_id` 换成真实租户键即可平滑扩成多行。

---

## 13. 后端 · LLM 代理 `POST /api/chat`（用 owner key 直连 DeepSeek，流式透传）

> **与第 8/12 节的关系：** 第 8 节描述「纯设计器」形态——设计态浏览器**直连** LLM（BYOK，key 在浏览器）。本节面向**发布型表单**形态：owner 的 DeepSeek key 已由 §12 加密存进 D1，浏览器**不再持有 key**；对话式设计走一个 Worker 代理 `POST /api/chat`，由 Worker 用 owner 的明文 key 直连上游 DeepSeek，把上游的流式响应**原样透传**回前端。这样 key 永不出现在浏览器侧。
>
> **直连上游：** Worker 直接打 `https://api.deepseek.com/chat/completions`（DeepSeek 的 OpenAI 兼容端点），**不**经 OpenRouter 或其它中转。
>
> **本节范围（第一刀，仅 Worker 端）：** `POST /api/chat` 的请求形状、SSE 流式响应、用 owner key 直连、model 默认、未配置/上游错误的状态码与体、安全约束。
>
> **不在本节：** 前端 `flow.jsx` 接入真代理（替换浏览器直连）是单独一期；多轮 Agent loop / 工具执行编排仍在客户端（§4），本代理只负责「一次 LLM 调用的转发」。鉴权 / 多租户仍按 §12 的 MVP 单 owner 假设（固定 `owner_id`）。

### 13.1 端点职责

`POST /api/chat` 是一个**薄转发层**：吃 OpenAI 风格的 chat 请求，用 owner 自己的 DeepSeek key 向上游发起**流式** `chat/completions`，把上游 SSE 字节流原样回写给前端。Worker 不解析、不重组、不缓冲上游的流，只透传。

Worker 内部流程：

```
1) importConfigKey(env.CONFIG_KEY)                  ← 拿到 AES-GCM 主密钥（§12.2）
2) getOwnerConfig(env.DB, key)                       ← 读单行 + 解密 → OwnerConfig 内部视图
3) 若 owner.deepseek === null（未配 DeepSeek key）  → 409 { error }，不打上游
4) fetch https://api.deepseek.com/chat/completions   ← 用 owner 明文 key
     headers: Authorization: Bearer <ownerKey>, content-type: application/json
     body: { model, messages, tools?, stream: true }
       - model = owner.deepseek.model || "deepseek-chat"
       - messages / tools 透传自请求体
5) 上游 2xx          → 把上游响应体（SSE）原样透传，Content-Type: text/event-stream
   上游 4xx/5xx       → 包装成可辨识错误响应（见 §13.4），绝不回显 owner key
```

> **解密后的明文 key 只进 Authorization 头**：它从 `getOwnerConfig` 出来后，唯一用途是拼 `Authorization: Bearer <ownerKey>` 发往上游，绝不写进返回给前端的任何字段、日志、或错误体（§13.5）。

### 13.2 请求契约（`ChatRequest`）

请求体（JSON）：

```jsonc
{
  "messages": [                       // 必填，非空数组；OpenAI 风格的对话消息
    { "role": "user", "content": "帮我加一个邮箱字段" }
  ],
  "tools": [                          // 可选；function-calling 工具数组，原样透传给上游
    { "type": "function", "function": { "name": "add_field", "parameters": { } } }
  ]
}
```

- 本刀只接 `messages`（必填）与 `tools`（可选）；`model`、温度等参数**由后端补默认**，前端不传。`messages` / `tools` 的具体内部形状对代理是不透明的（opaque）——Worker 不校验其内部结构，只整体透传给上游。
- `messages` 缺失 / 非数组 / 空数组 → `400 { error }`，不打上游。
- `stream` 始终由 Worker 强制为 `true`（前端不能关流）；即便请求体里带了 `stream`，以 Worker 的 `true` 为准。

### 13.3 成功响应（流式 SSE 透传）

- 上游返回 2xx 时，Worker 以 `200`、`Content-Type: text/event-stream` 把**上游响应体原样**流回前端（不缓冲、不改写 SSE 事件）。
- 前端按标准 SSE / OpenAI 流式协议消费（`data:` 行、`[DONE]` 终止符由上游产生，Worker 不合成）。
- 流的内容形状（`delta`、`tool_calls` 分片等）是上游 DeepSeek 的协议，本代理不定义、不转译。

### 13.4 错误响应（状态码 + `{ error }`）

| 情况 | 状态码 | 响应体 | 说明 |
|---|---|---|---|
| owner 未配 DeepSeek key | `409` | `{ "error": "owner 未配置 DeepSeek" }` | 不打上游；前端据此引导去「集成设置」（§12）|
| `messages` 缺失 / 非数组 / 空 | `400` | `{ "error": "messages is required" }` | 不打上游 |
| 请求体非合法 JSON | `400` | `{ "error": "invalid JSON body" }` | 不打上游 |
| 上游 4xx（如 key 失效、参数错） | 透传上游状态码（或归一为 `502`，见下） | `{ "error": "..." }` | 错误体里**不含 owner key**；可携带上游的错误摘要供排障 |
| 上游 5xx / 不可达（额度耗尽、超时等） | `502` | `{ "error": "..." }` | 同上，不泄漏 key |

- **错误体一律 `application/json` 的 `{ error }`**（非流式），与成功的 SSE 流区分开——前端先看状态码与 `Content-Type` 决定走流式消费还是错误分支。
- 上游错误的状态码归一策略（透传上游码 vs 统一 `502`）由 implementer 在合约内自行决定，但**必须**满足：(a) 可辨识为「上游出错」而非代理自身 bug；(b) 错误体绝不包含 owner 的明文 key。

### 13.5 安全

- **明文 key 只进 Authorization、不出网（除上游）：** owner 的 DeepSeek 明文 key 仅在 Worker 内由 `getOwnerConfig` 解密得到，唯一去向是发往 `api.deepseek.com` 的 `Authorization: Bearer` 头。它**绝不**出现在：返回给前端的任何响应（成功流或错误体）、HTTP 头回显、日志。
- **不回显上游凭据相关信息：** 上游 4xx（如 401 invalid key）转成给前端的错误时，只保留「上游拒绝/出错」语义，不把 owner key 或可反推 key 的内容带回。
- **沿用 §12 的加密边界：** key 的解密只发生在 Worker 内（`CONFIG_KEY` + `getOwnerConfig`）；D1 里仍是密文，浏览器侧自始至终拿不到明文。

---

## 14. 后端 · 连接测试 `POST /api/config/test`（探一下已保存配置能否连通）

> **与第 12/13 节的关系：** §12 把 owner 的 DeepSeek key 与飞书凭据加密存进 D1；§13 用 DeepSeek key 代理对话。本节给「集成设置」的「测试连接」按钮提供后端：用 owner **已保存的**那份配置（由 `getOwnerConfig` 解密得到，**不**在请求体里收凭据），各自探一下 DeepSeek 与飞书能否连通，把每条连接的结果分别回报。
>
> **测的是 D1 里存的那份：** MVP 不接收请求体里的临时凭据——「测试连接」测的就是当前已保存、后续真正会用的那份配置。请求体为空（或被忽略）。
>
> **本节范围（第一刀，仅 Worker 端）：** `POST /api/config/test` 的探测目标（上游轻量端点）、判定规则、响应形状、未配置约定、安全（key/secret 不出网、不进 message）。
>
> **不在本节：** 飞书多维表格的读写（`appToken` / `tableId` 是否指向有效表）、答题提交落库（那是 #4 `/api/submit`）、前端「测试连接」按钮接入。本刀只验**凭据级**连通性：DeepSeek key 是否有效、飞书自建应用的 `app_id` + `app_secret` 能否换到 `tenant_access_token`。

### 14.1 端点职责

`POST /api/config/test` 读取已保存配置（`getOwnerConfig`，§13.1 同一内部视图），对两块凭据**各自独立**发起一次轻量上游探测，互不影响地把两条结果汇成一个对象返回。任一探测的成败都**不**改变 HTTP 状态码——「连不上」是正常的探测结果，不是 HTTP 错误。

Worker 内部流程：

```
1) importConfigKey(env.CONFIG_KEY)                  ← AES-GCM 主密钥（§12.2）
2) getOwnerConfig(env.DB, key)                       ← 读单行 + 解密 → OwnerConfig 内部视图
3) DeepSeek 探测：
     owner.deepseek === null  → { ok:false, message:"未配置" }（不打上游）
     否则 testDeepSeek(owner.deepseek.apiKey)
4) 飞书探测：
     owner.feishu === null    → { ok:false, message:"未配置" }（不打上游）
     否则 testFeishu(owner.feishu.appId, owner.feishu.appSecret)
5) 200 { deepseek, feishu }                          ← 两条结果各自独立
```

> 两条探测彼此**独立**：DeepSeek 连不通不影响飞书探测照常进行，反之亦然。任一上游不可达/超时也只把**那一条**判为 `ok:false`，另一条照常返回。

### 14.2 各连接的上游探测与判定

| 块 | 上游端点 | 凭据用法 | 判定 `ok:true` 的条件 |
|---|---|---|---|
| DeepSeek | `GET https://api.deepseek.com/models` | `Authorization: Bearer <ownerKey>` | 上游 `2xx`（key 有效、能列模型）|
| 飞书 | `POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal` | body `{ app_id, app_secret }`（JSON） | 上游 `200` 且响应体 `code === 0`（拿到 `tenant_access_token`，自建应用凭据有效）|

- **DeepSeek：** 用 owner 明文 key 调一个最便宜的校验端点（`GET /models`，不消耗推理额度），上游 `2xx` 即认为 key 有效 → `ok:true`；`401`/其它非 2xx → `ok:false`（key 失效 / 被拒）。
- **飞书：** 用 owner 的 `app_id` + `app_secret` 走自建应用换 `tenant_access_token` 的标准端点；飞书的约定是 HTTP `200` 也可能带业务错误码，所以**必须看 body 的 `code`**：`code === 0` 才算连通（凭据有效），`code !== 0`（如 `99991663` app secret 错）→ `ok:false`。
- **`appToken` / `tableId` 不在本刀校验**：本节只验自建应用凭据本身能否换 token，不验它对某张多维表格的读写权限（留给 `/api/submit`）。

### 14.3 响应契约（`ConnTestResult`）

`200`，`application/json`：

```jsonc
{
  "deepseek": { "ok": true },
  "feishu":   { "ok": false, "message": "凭据无效" }
}
```

- 形状：`{ deepseek: ConnProbe, feishu: ConnProbe }`，每个 `ConnProbe` 为 `{ ok: boolean, message?: string }`。
- **HTTP 永远 `200`**（除非请求本身异常，如 `CONFIG_KEY` 缺失这类基础设施错才走 5xx）。「测不通」是正常结果，体现在 `ok:false` + `message`，**不是** HTTP 错误码。
- `message` 是**人可读的**简短说明（成功可省略；失败给一句排障线索，如「未配置」「凭据无效」「上游不可达」「上游返回 401」）。它只描述结果语义，**绝不**回显凭据或可反推凭据的内容。

### 14.4 未配置约定

- 某块在 D1 里从未配置（`owner.deepseek === null` 或 `owner.feishu === null`）→ 该块 `{ ok:false, message:"未配置" }`，**不打上游**。
- 约定用 `ok:false` 表达「未配置」（而非引入第三态 `skipped`）：对调用方「测试连接」而言，「没配过」和「配了但连不通」都属于「这条还不能用」，统一成 `ok:false` 最简单；`message` 区分二者（「未配置」vs「凭据无效」/「上游…」）。
- 两块都未配置 → 两条都 `{ ok:false, message:"未配置" }`，HTTP 仍 `200`。

### 14.5 安全（凭据不出网、不进 message）

- **明文凭据只发往对应上游：** owner 的 DeepSeek 明文 key 仅用于 DeepSeek 探测的 `Authorization: Bearer`；飞书 `app_secret`（与 `app_id`）仅用于飞书探测的请求体。它们解密自 `getOwnerConfig`，唯一去向是各自的上游探测请求。
- **凭据绝不进响应：** key / `app_secret` **绝不**出现在响应 body（含任何 `message`）、响应头、或日志中。
- **即便上游回错也不拼凭据：** 上游 `401`/`code≠0` 等错误转成 `message` 时，只保留「上游拒绝/出错」语义（可带上游状态码或飞书 `code` 这类**非敏感**摘要供排障），**绝不**把凭据或其片段拼进 `message`。
- **沿用 §12 的加密边界：** 解密只发生在 Worker 内；D1 里仍是密文，浏览器侧拿不到明文。

---

## 15. 后端 · 提交写飞书多维表格 `POST /api/submit`（答题落库）

> **与第 8/12/14 节的关系：** §8.2 描述「纯设计器」形态——答题数据写托管 BaaS。本节面向**发布型表单**形态（见项目记忆 `form-design-byok-feishu-architecture`）：答题者在公开填写页提交一份作答，Worker 用 owner **已保存的**飞书凭据（由 §12 加密、`getOwnerConfig` 解密得到）把这份作答写进 owner 自己的飞书多维表格。owner 的 `app_secret` / `tenant_access_token` 全程留在 Worker 内、永不出网。
> §14「连接测试」只验自建应用凭据能否换到 `tenant_access_token`；本节在此之上**真正写一条记录**进 `app_token` / `table_id` 指向的那张表。
>
> **本节范围（第一刀，仅 Worker 端）：** `POST /api/submit` 的请求形状、写入流程（换 token → 新增记录）、`answers` → 飞书 `fields` 的映射约定、响应/错误的状态码与体、安全（token/secret 不出网）。
>
> **不在本节：** 建多维表格本身、字段类型的精确映射（select 选项 id、日期/数字/附件等结构化转换）、防刷 / 限流 / 校验答案是否符合 schema、公开填写页前端。鉴权 / 多租户仍按 §12 的 MVP 单 owner 假设（固定 `owner_id`）。

### 15.1 端点职责

`POST /api/submit` 吃一份答题者作答，读取 owner 已保存的飞书凭据，向飞书自建应用换一个 `tenant_access_token`，再用它向「多维表格新增记录」端点写一条记录，成功后回报新记录 id。

Worker 内部流程：

```
1) parseSubmitRequest(body)                          ← 校验请求体；空 answers → 400 不打上游
2) importConfigKey(env.CONFIG_KEY)                    ← AES-GCM 主密钥（§12.2）
3) getOwnerConfig(env.DB, key)                         ← 读单行 + 解密 → OwnerConfig 内部视图
4) 若 owner.feishu === null（未配飞书）              → 409 { error }，不打上游
5) getFeishuTenantToken(appId, appSecret)             ← 用 owner 凭据换 tenant_access_token（§15.5 共享 helper）
6) answersToFields(answers)                           ← answers 直转飞书 fields（§15.3 映射约定）
7) writeToBitable(token, appToken, tableId, fields)   ← POST 多维表格新增记录
8) 上游 code === 0    → 200 { ok:true, recordId }
   换 token 失败 / 写记录 code≠0 / 非 2xx → 可辨识错误（状态码 + { error }），不泄漏 token/secret
```

> **解密后的明文 secret 只进换 token 请求；换来的 `tenant_access_token` 只进写记录请求的 `Authorization` 头**：两者都绝不写进返回给前端的任何字段、HTTP 头回显、或日志（§15.6）。

### 15.2 请求契约（`SubmitRequest`）

请求体（JSON）：

```jsonc
{
  "answers": [                          // 必填，非空数组；一份作答的所有字段值
    { "label": "姓名", "value": "张三" },
    { "label": "兴趣", "value": ["阅读", "运动"] }  // 多选 → 字符串数组
  ]
}
```

- 每条 `answer` 是 `{ label: string; value: string | string[] }`：`label` 对应 §3.2 Field 的 `label`（MVP 用 label 作为飞书表列名直接对位，字段 id ↔ 列的精确映射留后续 feature）；`value` 是答题者填的值，多选 / 多文件这类一对多用 `string[]`。
- `answers` 缺失 / 非数组 / 空数组 → `400 { error }`，不打上游（没有任何字段可写，提前拒绝）。
- 单条 `answer` 的 `label` 为空、或 `value` 既非字符串也非字符串数组 → `400 { error }`（请求体形状非法，不打上游）。
- `answers` 内 `label` 的语义校验（是否对得上当前 schema、是否漏填必填项）**不在本刀**——本刀只做形状级校验，把合法形状的 answers 透传成飞书 fields。

### 15.3 `answers` → 飞书 `fields` 的映射约定（`answersToFields`）

MVP 直转：把 `answers` 摊平成飞书新增记录 body 里的 `fields` 对象——

- 每条 `answer` 产出一个键值对：键 = `answer.label`，值 = `answer.value`（`string` 原样、`string[]` 原样传数组）。
- 同一 `label` 出现多次时的归并策略（覆盖 / 报错）由 implementer 在合约内决定，但需在 feature 里有据可依；MVP 表单 schema 的 label 唯一，可不强求。
- **不做**字段类型的结构化转换（select 选项映射成飞书选项 id、日期转时间戳、数字转 number、附件上传换 file token 等）——这些留后续 feature。本刀把值原样塞进 `fields`，由飞书按列类型自行接收 / 报错。

### 15.4 成功响应

`200`，`application/json`：

```jsonc
{ "ok": true, "recordId": "recXXXXXXXX" }
```

- `recordId` 取自飞书新增记录响应体的 `data.record.record_id`。
- 成功响应里**只**含 `ok` 与 `recordId`，不回显写入的 `fields`、token、或任何 owner 凭据。

### 15.5 写入的上游端点与判定

| 步骤 | 上游端点 | 凭据用法 | 判定 |
|---|---|---|---|
| 换 token | `POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal` | body `{ app_id, app_secret }`（JSON） | 上游 `200` 且 body `code === 0` → 拿到 `tenant_access_token`；否则视为换 token 失败 |
| 新增记录 | `POST https://open.feishu.cn/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records` | `Authorization: Bearer <tenant_access_token>`，body `{ fields: { <label>: <value>, ... } }` | 上游 `2xx` 且 body `code === 0` → 取 `data.record.record_id`；否则视为写记录失败 |

- 飞书的约定是 HTTP `200` 也可能带非 0 业务错误码，所以两步都**必须看 body 的 `code`**，`code === 0` 才算成功（与 §14.2 一致，复用 `FEISHU_OK_CODE`）。
- `{app_token}` / `{table_id}` 用 `getOwnerConfig` 解出的 `feishu.appToken` / `feishu.tableId` 填充。

### 15.6 错误响应（状态码 + `{ error }`）

| 情况 | 状态码 | 响应体 | 说明 |
|---|---|---|---|
| owner 未配飞书（`owner.feishu === null`） | `409` | `{ "error": "owner 未配置飞书" }` | 不打上游；前端据此引导去「集成设置」（§12）|
| `answers` 缺失 / 非数组 / 空 | `400` | `{ "error": "answers is required" }` | 不打上游 |
| 单条 answer 形状非法（label 空 / value 类型错） | `400` | `{ "error": "..." }` | 不打上游 |
| 请求体非合法 JSON | `400` | `{ "error": "invalid JSON body" }` | 不打上游 |
| 换 `tenant_access_token` 失败（非 2xx / `code≠0` / 不可达） | `502` | `{ "error": "..." }` | 错误体**绝不**含 `app_secret`；可携带飞书 `code` / HTTP 状态这类非敏感摘要 |
| 写记录失败（非 2xx / `code≠0`） | `502` | `{ "error": "..." }` | 错误体**绝不**含 `tenant_access_token` / `app_secret` |

- 错误体一律 `application/json` 的 `{ error }`——前端先看状态码与 `ok` 决定成功 / 失败分支。
- 上游错误状态码归一策略（透传上游码 vs 统一 `502`）由 implementer 在合约内决定，但**必须**满足：(a) 可辨识为「上游 / 配置出错」而非代理自身 bug；(b) 错误体绝不包含 `tenant_access_token` 或 `app_secret`。

### 15.7 安全（token/secret 不出网）

- **明文 `app_secret` 只进换 token 请求体**：解密自 `getOwnerConfig`，唯一去向是 `POST .../tenant_access_token/internal` 的 body，绝不出现在返回给前端的任何响应、HTTP 头、日志。
- **`tenant_access_token` 只进写记录请求的 Authorization 头**：换到后唯一去向是 `POST .../records` 的 `Authorization: Bearer`，绝不写进成功响应（`recordId` 之外）、错误体、HTTP 头回显、日志。
- **即便上游回错也不拼凭据**：换 token / 写记录的 `code≠0` 或非 2xx 转成 `{ error }` 时，只保留「上游拒绝 / 出错」语义（可带飞书 `code` 或 HTTP 状态这类非敏感摘要供排障），绝不把 `app_secret` / `tenant_access_token` 或其片段拼进 `error`。
- **沿用 §12 的加密边界：** secret 的解密只发生在 Worker 内（`CONFIG_KEY` + `getOwnerConfig`）；D1 里仍是密文，浏览器侧自始至终拿不到明文。
