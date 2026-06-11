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
> **不在本节：** 多轮 Agent loop / 工具执行编排仍在客户端（§4），本代理只负责「一次 LLM 调用的转发」。鉴权 / 多租户仍按 §12 的 MVP 单 owner 假设（固定 `owner_id`）。
>
> **前端接入（已完成）：** 前端已接入本代理替换写死脚本——`src/core/designerChat` 用 `POST /api/chat` 流式拉 DeepSeek（OpenAI 协议透传），`src/core/designerLoop` 在客户端跑单回合 ReAct（§4）并就地执行 `src/core/designerTools` 里的 UI 字段模型工具，结果实时渲染到预览。对话引擎对测试可注入（`<App chat={…} />`）。

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
- **飞书：** 用 owner 的 `app_id` + `app_secret` 走自建应用换 `tenant_access_token` 的标准端点；飞书的约定是 HTTP `200` 也可能带业务错误码，所以判定 `ok:true` 须**同时**满足两条 gate：**(a) 上游 HTTP `res.ok`（2xx）** 且 **(b) 响应体 `code === 0`**。任一不满足（HTTP 非 2xx、或 `200` 但 `code !== 0`，如 `99991663` app secret 错）→ `ok:false`。**不能只看 `code` 而忽略 HTTP 状态**：非 2xx 的响应体未必能解析出可信的 `code`，必须先过 `res.ok` 这道闸（与 §15.5 写记录、§18.3 读记录的双 gate 判定一致）。`testFeishu` 复用 §15 的 `getFeishuTenantToken`（已含 `res.ok && code === 0` 双 gate），把其抛出的（已脱敏的）错误映射成 `ok:false` 的 `message`，自身永不抛。
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

---

## 16. 后端 · 表单发布 + 公开填写拉取（打通设计 → 发布 → 公开填写闭环）

> **与第 12/15 节的关系：** §12 持有 owner 凭据、§15 把一份作答写进 owner 的飞书多维表格。但 §15 之前缺一环：答题者填的那份表单**从哪来**。本节补上：owner 把设计好的表单定义（`meta` + `fields`）**发布**，后端生成一个公开 `slug` 存进 D1；答题者用 `slug` **无鉴权**拉取该表单的 `meta` + `fields` 渲染填写页；提交时带上 `formSlug` 关联回这份表单。至此 **设计 → 发布 → 公开填写 → 写飞书** 闭环在后端打通。
>
> **本节范围（仅 Worker 端）：** `POST /api/forms`（发布）、`GET /api/forms/:slug`（公开拉取）、以及 §15 `POST /api/submit` 增加 `formSlug` 的关联约定。
>
> **不在本节：** owner 鉴权 / 多租户、owner 的表单列表 / 编辑 / 删除、数据后台 / 统计、防刷 / 限流、`answers` 与 `fields` 的字段级一致性校验（本节从简，见 §16.5）、发布态前端渲染器。鉴权 / 多租户仍按 §12 的 MVP 单 owner 假设（固定 `owner_id`）。

### 16.1 端点职责

| 端点 | 谁调 | 鉴权 | 职责 |
|---|---|---|---|
| `POST /api/forms` | owner（设计器） | MVP 无（单 owner） | 提交表单定义 → 生成公开 `slug` → 存 D1 `forms` 表 → 返回 `{ slug }` |
| `GET /api/forms/:slug` | 答题者（公开填写页） | **无鉴权（公开）** | 按 `slug` 返回该表单的 `meta` + `fields` 用于渲染；**绝不返回任何 owner 凭据 / 配置** |
| `POST /api/submit` | 答题者 | 无 | （§15 基础上）body 增加 `formSlug`：先校验 form 存在再写飞书（见 §16.5） |

> **公开拉取是闭环里唯一对陌生人开放、无凭据的读端点**，因此它的「不泄漏」保证是本节的安全核心（§16.4）。

### 16.2 API 契约

#### `POST /api/forms` — 发布表单

请求体（`PublishFormInput`，JSON）：

```jsonc
{
  "meta": {
    "title": "活动报名表",          // 必填，非空
    "description": "请填写你的报名信息" // 可选
  },
  "fields": [                       // 必填数组（可为空，见 §16.5）；对齐 §3.2 Field[]
    { "id": "f_name", "type": "text", "label": "姓名", "required": true },
    { "id": "f_hobby", "type": "checkbox", "label": "兴趣",
      "options": [ { "label": "阅读", "value": "read" }, { "label": "运动", "value": "sport" } ] }
  ]
}
```

- 成功：`201`，`{ "slug": "f8Kq2pXa" }`（实现可附 `url` 字段给出可直接访问的公开填写页地址）。
- 缺 `meta.title`（空 / 缺失）、或 `fields` 非数组、或某 field 缺 `id`/`type`/`label` / `type` 非法 → `400 { error }`，**不落库**（§16.5）。
- owner_id **不在请求体里**：MVP 由后端恒填 `'default'`（§16.3）。
- **字段嵌套深度上限（防深 payload，安全 nit）：** `fields` 支持 `group` 字段的 `children` 递归嵌套。`parsePublishInput` / `parseField` 必须给递归**设一个深度上限**（实现在合约内定一个合理常量，建议 ≤ 8 层），超过上限即视为形状非法 → `400 { error }`，**不落库**。这是为了挡住「深度爆栈 / 资源耗尽」的恶意或畸形 payload——一份正常表单的 group 嵌套远到不了这个量级。上限值由 implementer 在合约内固定，但**必须**存在且对超限输入返回 `400`（而非栈溢出 / 5xx）。

#### `GET /api/forms/:slug` — 公开拉取（无鉴权）

响应体（`PublicForm`，JSON）：

```jsonc
{
  "slug": "f8Kq2pXa",
  "meta": { "title": "活动报名表", "description": "请填写你的报名信息" },
  "fields": [
    { "id": "f_name", "type": "text", "label": "姓名", "required": true },
    { "id": "f_hobby", "type": "checkbox", "label": "兴趣",
      "options": [ { "label": "阅读", "value": "read" }, { "label": "运动", "value": "sport" } ] }
  ]
}
```

- 命中：`200`，**只**含 `slug` + `meta` + `fields`（发布时存的原样回，§16.4）。
- `slug` 不存在：`404 { error }`（「没这张表」是正常态，不是 5xx）。
- **响应里绝不含**：`owner_id`、`status`、`created_at`，以及**任何** owner 凭据（DeepSeek key / 飞书 app_secret / app_token / table_id）——后者根本不在 `forms` 表里，且 `PublicForm` 类型里没有承载它们的字段（§16.4）。

### 16.3 `slug` 生成与唯一性约定

- **公开标识 + 主键：** `slug` 既是公开访问标识，也是 `forms` 表主键。
- **不可枚举 / 不可猜：** 用足够熵的随机串（如 crypto 随机字节编码成 URL 安全的 base32/base36），**不**用自增序号——否则答题者能枚举出别人的表单。
- **唯一性：** 靠随机串的高熵 + `slug` 作主键的插入约束保证；插入冲突时的重试策略由 implementer 在合约内决定（重新生成再插）。
- **单 owner：** MVP `forms.owner_id` 恒为 `'default'`；slug 全局唯一即可，无需 owner 维度去重。后续接鉴权时把 `owner_id` 换成真实租户键，slug 仍全局唯一。

### 16.4 公开拉取不泄漏凭据的保证

这是本节的安全核心——公开拉取对陌生人开放、无鉴权，必须从结构上杜绝凭据外泄：

- **表分离：** 凭据全在 `owner_config`（§12，加密落库），表单定义在 `forms`（只有 `meta_json` / `schema_json` 等展示数据）。公开拉取的查询**只读 `forms`**，根本不碰 `owner_config`。
- **类型级边界：** 公开拉取返回 `PublicForm`，其类型**只有** `slug` + `meta` + `fields` 三个字段，没有承载任何凭据（也没有 `owner_id` / `status` / `created_at`）的位置。即便将来 `forms` 行挂上更多 owner 私有信息，公开拉取也只能投影出这三样——「不泄漏」不是运行期过滤的产物，而是类型 + 查询路径的双重保证。
- **不可反推：** `slug` 不暴露 owner 身份（随机串），`meta` / `fields` 是 owner 主动要公开给答题者看的内容，本就该公开。

### 16.4.1 公开填写页 URL 约定（前端）

- **路径约定：** 一份发布出来的表单按其 `slug` 暴露在前端路由 `/f/:slug`（同源），完整链接形如 `https://<站点域名>/f/<slug>`，例：`https://form-design.agentaily.com/f/f8Kq2pXa`。这是「公开填写链接」的对外形态——owner 发布后展示/复制的就是它，分享给答题者。
- **slug 是唯一标识：** 前端只持有高熵 `slug`（§16.3），由 `formsClient.publicFormUrl(slug)` 拼出展示用链接；`POST /api/forms` 若返回 `url` 字段则以其为准，否则按本约定拼。
- **第 6 步公开页据此实现：** 公开填写页（`GET /api/forms/:slug` 渲染 + `POST /api/submit` 提交）从 `/f/:slug` 解析出 `slug` 再拉 schema 渲染——发布（第 5 步）与公开填写（第 6 步）由这条 URL 约定衔接。前端契约见 `src/core/formsClient.ts`（`PUBLIC_FORM_PATH` / `publicFormUrl`）。
- **第 6 步前端契约（已落桩）：** 路由分流不引重路由库——`src/core/router.ts` 的纯函数 `matchPublicForm(pathname)` 识别 `/f/:slug` 取出 `slug`，`App.jsx` 据此在公开路由只渲染 `PublicFormPage`（纯答题视图，不挂设计器/登录/设置那套），其它路由仍渲染设计器。公开页的拉取/提交走 `src/core/publicClient.ts`（`getPublicForm` / `submitForm` + `PublicForm` / `Answer` / `SubmitInput` / `SubmitResult`）——**不带 Bearer**（公开端点，`answers` 来自答题者、非 owner），与 owner-only 的 `formsClient`/`configClient` 走 `apiFetch(auth:true)` 形成对照。答题者填好的值收集成 `answers:[{ label, value:string|string[] }]`（多选 → 数组），与 §15.2 对齐。页面与各错误态（404 不存在 / 409 已停止收集 / 400 缺必填）见 `src/public-form.jsx`。

### 16.5 submit 关联约定与从简校验

§15 的 `POST /api/submit` 在本节**增加 `formSlug`** 字段，把作答关联回一份已发布表单：

请求体（`SubmitRequest`，在 §15.2 基础上）：

```jsonc
{
  "formSlug": "f8Kq2pXa",          // 必填，非空；关联的已发布表单
  "answers": [
    { "label": "姓名", "value": "张三" },
    { "label": "兴趣", "value": ["阅读", "运动"] }
  ]
}
```

Worker 内部流程（在 §15.1 的步骤前插入校验）：

```
0) parseSubmitRequest(body)        ← 形状校验：formSlug 非空 + answers 非空数组（否则 400，不打上游）
0.5) formExists(db, formSlug)      ← 查 forms 表：不存在 → 404 { error }，不打任何飞书上游
1)..8) 同 §15.1（换 token → 映射 fields → 写记录 → 200 { ok, recordId }）
```

- **`formSlug` 缺失 / 空：** `400 { "error": "formSlug is required" }`，不打上游（与 §15.2 的形状级校验同级）。
- **`formSlug` 对应 form 不存在：** `404 { error }`，**不换 token、不写记录**（提前拒绝，避免把陌生 slug 的作答写进 owner 的表）。
- **字段级一致性从简：** 本期**不**校验 `answers` 的 `label` 是否对得上该 form 的 `fields`、是否漏填必填项、value 是否满足 `validation`——只校验「form 存在」。`answers` 仍按 §15.3 原样映射成飞书 `fields`。字段级一致性校验留后续 feature。
- **多 owner 预留：** MVP 飞书凭据仍取自单 owner 的 `getOwnerConfig`；`formSlug` 此期主要用于「校验 form 存在」，并为将来「按 form 的 `owner_id` 定位该写哪个 owner 的飞书表」预留接口（届时用 `forms.owner_id` 去查对应 owner 的配置）。

### 16.6 错误响应（状态码 + `{ error }`）

| 端点 | 情况 | 状态码 | 响应体 |
|---|---|---|---|
| `POST /api/forms` | 请求体非合法 JSON | `400` | `{ "error": "invalid JSON body" }` |
| `POST /api/forms` | 缺 `meta.title` / `fields` 非数组 / field 形状非法 | `400` | `{ "error": "..." }`（不落库） |
| `GET /api/forms/:slug` | slug 不存在 | `404` | `{ "error": "..." }` |
| `POST /api/submit` | 缺 `formSlug` / 为空 | `400` | `{ "error": "formSlug is required" }`（不打上游） |
| `POST /api/submit` | `formSlug` 对应 form 不存在 | `404` | `{ "error": "..." }`（不打飞书上游） |

- 错误体一律 `application/json` 的 `{ error }`，与成功体（`201 { slug }` / `200 PublicForm` / §15 的 `200 { ok, recordId }`）区分。

### 16.7 D1 表结构（`workers/schema.sql`）

单 owner 设计：与 `owner_config` 同约定，`owner_id` 恒为 `'default'`。

```sql
CREATE TABLE IF NOT EXISTS forms (
  slug          TEXT PRIMARY KEY,   -- 公开 slug：对外标识 + 主键。不可枚举 / 不可猜（§16.3）
  owner_id      TEXT NOT NULL,      -- MVP 恒为 'default'（单 owner）
  meta_json     TEXT NOT NULL,      -- 序列化的 FormMeta（title / description），展示用
  schema_json   TEXT NOT NULL,      -- 序列化的 Field[]（数据真相），公开拉取原样回
  status        TEXT NOT NULL,      -- 'published' | 'draft' | 'closed'；MVP 发布即 'published'
  created_at    TEXT NOT NULL       -- ISO-8601，发布时刻
);
```

- 表只存表单的展示 `meta` 与字段定义，**绝不**存任何凭据（凭据全在 `owner_config`，§16.4）。
- 公开拉取只投影 `meta_json` + `schema_json` + `slug`；`owner_id` / `status` / `created_at` 不回给答题者。
- 单 owner 约束靠 `owner_id` 恒 `'default'`；后续接鉴权时换成真实租户键即可平滑扩成多行，公开拉取的投影不变。

---

## 17. 后端 · owner 鉴权（方案 A：owner 密码 → session JWT）

> **与第 12–16 节的关系：** §12–§16 落地了发布型 BYOK 的完整后端闭环，但所有端点**当前全无鉴权**（MVP 单 owner 假设）。本节补上最后一块：把 **owner-only**（设计态 / 管理态）端点用一道轻量鉴权门保护起来，公开端点（答题者用）保持开放。这样 owner 的配置存取、表单发布、连接测试、数据后台只对持有 owner 密码的人开放，而答题者拉表单 / 提交作答仍无需任何凭据。
>
> **方案 A（owner 密码 → session JWT）：** owner 用一个预置的 owner 密码（Worker secret `OWNER_PASSWORD`）登录，后端校验后签发一个短期 session JWT（用 Worker secret `AUTH_SECRET` 签名）；后续 owner-only 端点凭 `Authorization: Bearer <jwt>` 通行。**单 owner**：登录后 JWT 的 `sub` 恒为 `'default'`（与 `owner_config.owner_id` / `forms.owner_id` 同约定）。
>
> **本节范围（仅 Worker 端）：** `POST /api/auth/login`（密码 → token）、auth 中间件（验签 + 未过期）、owner-only 端点保护清单、env secret 约定、安全。
>
> **不在本节：** 多 owner（登录后恒 `sub='default'`，不区分租户）、注册 / 改密 / 找回密码、刷新 token / 登出黑名单、限流 / 防爆破、RBAC / 细粒度权限、前端登录页 UI。这些留后续 feature。

### 17.1 端点职责与鉴权矩阵

| 端点 | 谁调 | 鉴权 | 说明 |
|---|---|---|---|
| `POST /api/auth/login` | owner | **公开**（鉴权入口自身不保护） | body `{ password }` → 校验 `OWNER_PASSWORD` → 200 `{ token }`；密码错 / 缺 → 401 |
| `GET /api/config` | owner | **owner-only** | 读掩码配置（§12） |
| `POST /api/config` | owner | **owner-only** | 保存配置（§12） |
| `POST /api/config/test` | owner | **owner-only** | 连接测试（§14） |
| `POST /api/chat` | owner（设计态） | **owner-only** | LLM 代理（§13）——只供 owner 在设计器里用，归 owner-only |
| `POST /api/forms` | owner（设计器） | **owner-only** | 发布表单（§16） |
| `GET /api/forms/:slug/submissions` | owner（数据后台） | **owner-only** | 提交列表（§18） |
| `GET /api/forms/:slug` | 答题者 | **公开** | 公开拉取表单（§16）——不变 |
| `POST /api/submit` | 答题者 | **公开** | 答题落库（§15）——不变 |
| `GET /health` | 任意 | **公开** | 健康检查——不变 |

> **划分原则：** owner 的设计态 / 管理态（持有或操作 owner 凭据、私有数据）一律 owner-only；答题者面向的公开读 / 写（拉表单、交作答）保持无鉴权。`POST /api/chat` 虽不直接落库，但它消费 owner 的 DeepSeek 额度、且只在设计器里用，故归 owner-only，防止陌生人盗刷 owner 的 key。

### 17.2 `POST /api/auth/login` 契约

请求体（JSON）：

```jsonc
{ "password": "owner 的登录密码" }
```

- 成功（密码与 `OWNER_PASSWORD` 一致）：`200`，`{ "token": "<jwt>" }`。
- 密码错 / 缺 `password` / body 非合法 JSON：`401`，`{ "error": "..." }`（**统一 401**，不区分「密码错」与「缺字段」，避免给爆破者额外信号；body 非 JSON 也按鉴权失败处理）。
- 服务端未配置 `OWNER_PASSWORD` / `AUTH_SECRET`（部署疏漏）：`500`，`{ "error": "..." }`（这是部署错误，不是鉴权失败，不能误判成 401 把所有人放进来或全部锁死的歧义态）。
- 校验只比对 owner 密码本身，**不**触碰 D1 / 飞书 / DeepSeek——登录是纯 secret 比对 + 签名。
- **密码比对走常量时间（安全 nit）：** 提交的密码与 `OWNER_PASSWORD` 的比对**不**用朴素的 `===` / `!==`（朴素短路比较会因「第几位开始不匹配」泄漏时序信号，给计时攻击逐位猜密码的可乘之机）。用一个**常量时间等长比较**（见 §17.7）：先把两侧编码成等长字节再逐字节累积异或，比较耗时只与长度有关、与「哪一位不同」无关。长度不同时仍判失败，但同样不短路。无论匹配与否，可观察行为不变（匹配 → `200 { token }`，不匹配 → 统一 `401`）。

### 17.3 session JWT 约定

- **签名：** HMAC（`HS256`），密钥取自 Worker secret `AUTH_SECRET`。复用 Hono 内置的 `hono/jwt`（`sign` / `verify`）。
- **payload：** 至少含
  - `sub`: 恒 `'default'`（MVP 单 owner，对齐 `owner_config.owner_id` / `forms.owner_id`）。
  - `exp`: 过期时间（Unix 秒）。签发时设一个合理的短期窗口（建议 ≤ 24h；具体时长由 implementer 在合约内定，但**必须**带 `exp`）。
  - 可选 `iat`。
- **token 里绝不放敏感物：** `OWNER_PASSWORD` / `AUTH_SECRET` / 任何 owner 凭据都不进 payload；payload 是可被客户端解码的（JWT 仅签名、非加密）。
- **无状态：** 不维护服务端 session 表 / 黑名单；token 一经签发，在 `exp` 前一直有效（登出 / 吊销留后续 feature）。

### 17.4 auth 中间件

owner-only 端点统一挂一道 auth 中间件，校验 `Authorization: Bearer <jwt>`：

- **取 token：** 从 `Authorization` 头解析 `Bearer <jwt>`；缺头 / 格式不对（非 `Bearer ` 前缀）→ `401 { error }`，**不进入** route handler。
- **验签 + 未过期：** 用 `AUTH_SECRET` 验签且校验 `exp` 未过；验签失败 / 过期 / payload 非法 → `401 { error }`。
- **放行：** 校验通过则把解出的 session（至少 `sub`）挂到请求上下文（如 `c.set('session', ...)`），交给 route handler。
- **错误体不泄漏：** 401 的 `{ error }` 只表「未授权」语义，**绝不**包含 `AUTH_SECRET`、被拒 token 的内容、或任何可辅助伪造 / 爆破的细节。
- **实现选型：** 可直接用 `hono/jwt` 的 `jwt({ secret })` 中间件，或在 `auth.ts` 里基于 `verify` 写一个薄中间件（统一 401 文案 + 把 session 挂上下文）。两者皆可；implementer 在合约内择一并保持上面的可观察行为。

### 17.5 index.ts 如何挂载（cross-cutting）

鉴权是**横切关注点**，在 `index.ts` 路由层统一挂，不渗进各 route handler 的业务体：

- **公开端点先注册 / 或显式豁免：** `GET /health`、`POST /api/auth/login`、`GET /api/forms/:slug`、`POST /api/submit` 不挂 auth 中间件。
- **owner-only 端点挂中间件：** 推荐用 Hono 的路径前缀中间件 / 分组，对 owner-only 路径前缀套 `requireAuth`，例如：
  - `app.use('/api/config', requireAuth)` 与 `app.use('/api/config/*', requireAuth)`（覆盖 `GET/POST /api/config`、`POST /api/config/test`）。
  - `app.use('/api/chat', requireAuth)`。
  - `app.post('/api/forms', requireAuth, handler)`（注意**只**保护 `POST /api/forms`，而 `GET /api/forms/:slug` 公开——用 method 级挂载或精确路径，避免把公开拉取也罩进去）。
  - `app.get('/api/forms/:slug/submissions', requireAuth, handler)`（数据后台，§18）。
- **关键陷阱：** `/api/forms/:slug`（公开）与 `POST /api/forms`、`/api/forms/:slug/submissions`（owner-only）共享 `/api/forms` 前缀。**不能**用一句 `app.use('/api/forms/*', requireAuth)` 把公开拉取也保护了。挂载方式以「精确匹配 owner-only 的 method + 路径」为准，公开的 `GET /api/forms/:slug` 必须不受影响。implementer 在合约内决定具体挂法（method 级中间件 / 精确路径），但**必须**满足 §17.1 的矩阵：公开端点无鉴权、owner-only 端点缺 / 坏 token 一律 401。

### 17.6 env secret 约定

| secret | 用途 | 来源 |
|---|---|---|
| `OWNER_PASSWORD` | owner 登录密码（与提交密码做**常量时间**比对，§17.8） | 生产 `wrangler secret put OWNER_PASSWORD`；测试由 `vitest.config.ts` 注入固定值 |
| `AUTH_SECRET` | session JWT 的 HMAC 签名密钥 | 生产 `wrangler secret put AUTH_SECRET`；测试由 `vitest.config.ts` 注入固定值 |

- 二者均为 Worker secret，**绝不**入 git、不进任何响应 / 日志。与 §12 的 `CONFIG_KEY` 同等对待。
- `Env` 接口（`index.ts`）需扩展出这两个绑定（`OWNER_PASSWORD: string`、`AUTH_SECRET: string`）。

### 17.7 安全

- **统一 401：** 登录失败与中间件拒绝都回 `401`，文案只表「未授权」，不泄漏「密码长度 / 是否存在 / 验签为何失败」等可被利用的信号。
- **secret 不出网：** `OWNER_PASSWORD` / `AUTH_SECRET` 只在 Worker 内用于比对 / 签名验签，绝不进 token payload、响应体、HTTP 头、日志。
- **token 非加密：** JWT payload 可被任何持有者解码，故 payload 里只放 `sub='default'` + `exp` 这类非敏感物。
- **密码比对常量时间（防计时攻击）：** owner 密码与 `OWNER_PASSWORD` 的比对用一个**常量时间等长比较** helper（`auth.ts` 的 `timingSafeEqualStr`，§17.8），而非 `===`。这样比对耗时不随「第几位开始不同」变化，攻击者无法靠测响应时延逐位还原密码。这是一个就近的安全 nit，不改变任何可观察 HTTP 行为。
- **保护半径：** 加上鉴权后，owner 的配置、表单发布、连接测试、LLM 代理、数据后台都需 token；这道门也是后续多 owner（把 `sub` 换成真实租户键，按 `sub` 过滤数据）的接入点。

### 17.8 常量时间密码比较（`timingSafeEqualStr`）

Workers 运行时（workerd）没有 Node 的 `crypto.timingSafeEqual`，所以在 `auth.ts` 里提供一个纯函数 helper 做常量时间字符串比较：

- **签名：** `timingSafeEqualStr(a: string, b: string): boolean`——两个字符串「内容是否相等」，比对耗时只与输入长度有关、与首个不同位的位置无关。
- **实现思路（合约内）：** 用 `TextEncoder` 把两侧编码成字节；逐字节做异或累积（`acc |= ai ^ bi`），**全程不短路**（不在第一个不同字节就 `return false`）；最后用 `acc === 0` 且长度相等判等。长度不同时返回 `false`，但仍跑完固定步数、不提前 return。绝不使用朴素 `a === b` / 提前短路的逐字符比较。
- **用途：** 仅供 `POST /api/auth/login` 比对提交密码与 `OWNER_PASSWORD`（§17.2）。`AUTH_SECRET` 的验签由 `hono/jwt` 的 HMAC 负责（HMAC 验签本身已抗时序），不走本 helper。
- **安全：** 入参与返回都不含也不回显任何 secret；本 helper 只返回布尔，绝不把密码 / secret 写进日志或响应。

---

## 18. 后端 · 数据后台 · 提交列表 `GET /api/forms/:slug/submissions`

> **与第 15/16/17 节的关系：** §15 把答题者的作答写进 owner 的飞书多维表格，§16 让 owner 发布表单 / 答题者公开填写，§17 给 owner-only 端点加了鉴权。本节补上 owner 视角的「**读回**」：owner 登录后，在数据后台按 `slug` 拉取这份表单已收集到的提交列表——从 owner 自己的飞书多维表格里读记录，而非另存一份。
>
> **本节范围（仅 Worker 端）：** `GET /api/forms/:slug/submissions`（owner-only）的契约、读飞书记录的上游流程、响应形状（提交列表 + count）、错误码、安全（不返回 owner 凭据）。
>
> **不在本节：** 分页 / 游标（MVP 一次性拉，或拉上游一页即可，见 §18.4）、筛选 / 排序 / 搜索、字段级聚合 / 图表统计、导出 CSV、删除 / 编辑提交、跨 owner 数据隔离（MVP 单 owner，`sub='default'`）。这些留后续 feature。
>
> **第 6 步前端接入（已落桩）：** owner 侧「数据后台」是「我的表单」(`src/forms-panel.jsx`) 每份表单行下的「看提交」入口——打开后按该 `slug` 调本端点。前端契约见 `src/core/submissionsClient.ts`（`listSubmissions(slug)` + `Submission` / `SubmissionsResult`，**owner-only**，复用 `apiClient` 的 Bearer 注入 `auth:true`），视图见 `src/submissions-view.jsx`（`SubmissionsView`）。空态友好、`401` → `onNeedLogin` 引导先登录（复用 §17 模式）、`409` 未配飞书 → 引导去集成设置。

### 18.1 端点职责

`GET /api/forms/:slug/submissions`（**owner-only**，挂 §17 的 auth 中间件）：

```
0) requireAuth                       ← 缺 / 坏 token → 401（§17.4），不进入下面
1) formExists(db, slug)              ← 查 forms 表：不存在 → 404 { error }，不打飞书上游
2) importConfigKey(env.CONFIG_KEY)   ← AES-GCM 主密钥（§12.2）
3) getOwnerConfig(env.DB, key)        ← 读单行 + 解密 → OwnerConfig 内部视图
4) 若 owner.feishu === null（未配飞书）→ 409 { error }，不打上游
5) getFeishuTenantToken(appId, appSecret)        ← 换 tenant_access_token（§15.5 共享 helper）
6) listSubmissions(token, appToken, tableId)     ← GET 多维表格记录列表（§18.3）
7) 上游 code === 0 → 200 { submissions: [...], count }
   换 token 失败 / 读记录 code≠0 / 非 2xx → 502 { error }，不泄漏 token/secret
```

> 复用 §15 的凭据解密 + 换 token 路径；区别只在第 6 步从「写一条记录」换成「读记录列表」。

### 18.2 响应契约

成功（`200`，`application/json`）：

```jsonc
{
  "submissions": [
    {
      "recordId": "recXXXXXXXX",        // 上游 record_id
      "fields": { "姓名": "张三", "兴趣": ["阅读", "运动"] },  // 上游记录的 fields，原样投影
      "createdTime": 1700000000000       // 可选：上游 created_time（毫秒时间戳），无则省略
    }
  ],
  "count": 1                            // submissions 的条数（本期等于本次返回的记录数）
}
```

- `submissions`：把上游 `data.items` 里每条记录映射成简洁形状 `{ recordId, fields, createdTime? }`。空表 → `[]`（正常态，不是错误）。
- `count`：`submissions.length`（本期不分页，等于这一批的条数；将来分页时可换成上游 `total`）。
- **响应里绝不含**任何 owner 凭据（DeepSeek key / 飞书 app_secret / app_token / table_id）、`tenant_access_token`、或 `owner_id`——只回提交数据本身（§18.5）。

### 18.3 读记录的上游端点与判定

| 步骤 | 上游端点 | 凭据用法 | 判定 |
|---|---|---|---|
| 换 token | `POST .../auth/v3/tenant_access_token/internal` | body `{ app_id, app_secret }` | 同 §15.5：`200` 且 `code === 0` → 拿到 token |
| 读记录 | `GET https://open.feishu.cn/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records` | `Authorization: Bearer <tenant_access_token>` | `2xx` 且 body `code === 0` → 取 `data.items`（每项 `{ record_id, fields, created_time? }`）；否则视为读记录失败 |

- 读记录复用与 §15 写记录**同一个** URL 模板（`FEISHU_BITABLE_RECORDS_URL`，`submit.ts` 已导出），区别只是 method 为 `GET`、无 body。
- 同 §15.5：飞书 HTTP `200` 也可能带非 0 业务码，判定**必须**看 body 的 `code`，复用 `FEISHU_OK_CODE`。

### 18.4 分页（MVP 从简）

- MVP **不分页**：要么一次性拉（上游默认页大小通常够小数据量用），要么只拉上游第一页即可。是否携带 `page_size` / 跟 `page_token` 翻页由 implementer 在合约内定，但本期对外契约**不暴露**分页参数 / 游标——`count` 反映本次返回的条数即可。
- 后续接分页时，可在响应里加 `hasMore` / `pageToken`，`count` 换成上游 `total`；本期形状向前兼容。

### 18.5 错误响应（状态码 + `{ error }`）

| 情况 | 状态码 | 响应体 | 说明 |
|---|---|---|---|
| 缺 / 坏 / 过期 token | `401` | `{ "error": "..." }` | auth 中间件拦截（§17.4），不进入 handler |
| `slug` 对应 form 不存在 | `404` | `{ "error": "..." }` | 不打飞书上游 |
| owner 未配飞书（`owner.feishu === null`） | `409` | `{ "error": "owner 未配置飞书" }` | 不打上游；引导去集成设置（§12） |
| 换 token 失败 / 读记录失败（非 2xx / `code≠0` / 不可达） | `502` | `{ "error": "..." }` | 错误体**绝不**含 `app_secret` / `tenant_access_token`；可带飞书 `code` / HTTP 状态这类非敏感摘要 |

- 错误体一律 `application/json` 的 `{ error }`。
- 上游错误状态码归一策略同 §15.6：可辨识为「上游 / 配置出错」、且错误体绝不含凭据。

### 18.6 安全（不返回 owner 凭据）

- 与 §15.7 同源的边界：明文 `app_secret` 只进换 token 请求体；`tenant_access_token` 只进读记录请求的 `Authorization` 头；二者绝不进响应、HTTP 头回显、日志。
- 数据后台只投影**提交数据**（`recordId` / `fields` / `createdTime`），不回 owner 的任何凭据 / 配置，也不回 `app_token` / `table_id`（它们是「数据存在哪」的私有信息）。
- 这是 owner-only 端点（§17 保护），陌生人无 token 拿不到任何提交数据。

---

## 19. 后端 · CORS（跨源访问控制，覆盖所有 `/api/*`）

> **与第 12–18 节的关系：** §12–§18 落地了发布型 BYOK 的完整后端 API + owner 鉴权。但前端（`form-design.agentaily.com`，CF Pages）与后端 API（Workers）是**不同源**：浏览器对带凭据 / 自定义头的跨源请求会先发 `OPTIONS` 预检，缺正确的 `Access-Control-*` 响应头会被浏览器拦在发出之前。本节补上这一横切层：用 Hono 内置 `cors` 中间件，对所有 `/api/*` 端点统一加 CORS 响应头并正确应答预检。
>
> **本节范围（仅 Worker 端）：** 允许的来源（origins）、允许的方法 / 头、`OPTIONS` 预检应答、挂载范围。
>
> **不在本节：** 限流 / 防刷、`Access-Control-Allow-Credentials`（本架构用 `Authorization: Bearer` 头携带 token，**不**用 cookie，故不需要也不应开启 credentials 模式）、CSRF（无 cookie 即无 CSRF 面）。

### 19.1 端点职责

用 Hono 内置中间件 `import { cors } from "hono/cors"`，作为**横切中间件**挂在所有 `/api/*` 路径上（在鉴权 guard 之前生效，使预检的 `OPTIONS` 也能在不带 token 时被正确应答）。它只负责附加 `Access-Control-*` 响应头与应答预检，不改变任何业务 route 的行为。

- **挂载范围：** 覆盖所有 `/api/*`（含公开端点 `GET /api/forms/:slug`、`POST /api/submit`、`POST /api/auth/login` 与 owner-only 端点）。`GET /health` 是否纳入由实现自定（纳入无害）。
- **挂载次序：** CORS 中间件须在 owner-only 的 `requireAuth` guard **之前**注册/生效——浏览器的 `OPTIONS` 预检不带 `Authorization` 头，若先被 guard 拦成 401，预检失败、真实请求根本发不出来。Hono 的 `cors()` 自身会短路应答 `OPTIONS`（返回带 CORS 头的 204/200），不会把预检透到业务 handler。

### 19.2 允许的来源（origins）

允许的前端来源用一个**常量数组**集中声明（实现放在 `index.ts` 或一个 `cors.ts` 常量里，单一真相）：

| 环境 | origin |
|---|---|
| 生产前端 | `https://form-design.agentaily.com` |
| 本地 dev | `http://localhost:5173`（Vite 默认端口）|

- **白名单回显式：** `cors` 的 `origin` 用上面这个**允许列表**（数组）；命中列表的请求 `Origin` 才回显进 `Access-Control-Allow-Origin`，不命中则不回该头（浏览器据此拦截）。**不**用 `*` 通配——既因为将来可能需要带凭据，也为收窄可调用面。
- 允许列表为常量（非 env）即可满足 MVP；若实现愿意从 env 读取额外 origin（如 PR 预览域名）可在合约内扩展，但**必须**默认包含上面两个、且不退化成 `*`。

### 19.3 允许的方法与头

- **`Access-Control-Allow-Methods`：** `GET`、`POST`、`PATCH`、`DELETE`、`OPTIONS`（覆盖现有 + §21 新增的 CRUD 方法）。
- **`Access-Control-Allow-Headers`：** 至少 `Authorization`（owner-only 端点的 Bearer token）、`Content-Type`（JSON body）。
- **`Access-Control-Max-Age`：** 可选，给预检结果设一个缓存时长（如 86400）以减少预检次数；具体值由实现在合约内定。
- **不开启 credentials：** 不设置 `Access-Control-Allow-Credentials: true`——本架构 token 走 `Authorization` 头而非 cookie，无需 credentials 模式。

### 19.4 预检（`OPTIONS`）行为

- 浏览器对跨源的带 `Authorization` / 非简单 `Content-Type` 的请求先发 `OPTIONS` 预检；`cors` 中间件须以一个 `2xx`（`204` 或 `200`）短路应答，并带上 §19.2 / §19.3 的 `Access-Control-*` 头。
- 预检**不**进入业务 handler、**不**被 `requireAuth` 拦（§19.1 次序保证）——即对 owner-only 端点的 `OPTIONS` 预检也应返回带 CORS 头的 `2xx`，而非 `401`。

### 19.5 安全

- CORS 是**浏览器侧**的访问控制，不是服务端鉴权——它不替代 §17 的 token 鉴权。owner-only 端点仍由 `requireAuth` 守护；CORS 只决定「哪个网页源的脚本能读到响应」。
- 收窄 origin 白名单（不退化 `*`）+ 不开 credentials，缩小可被任意网站脚本调用 / 读取的面。

---

## 20. 后端 · 提交校验：状态门 + answers 对 schema 必填校验（`POST /api/submit`）

> **与第 15/16 节的关系：** §15 把作答写进 owner 飞书表，§16 给 submit 加了 `formSlug` + `formExists`（form 不存在 → 404）。但 §16.5 明确「从简」：**不查表单状态、不校验 answers 是否符合 schema**。本节补上这两道在写飞书**之前**的校验门，挡住「往已关闭 / 草稿表单提交」与「漏填必填项」这两类脏数据。
>
> **本节范围（仅 Worker 端）：** 在 §16.5 的 `formExists` 之后、§15 飞书写入之前，新增 ①表单状态门（非 `published` → 拒收）②answers 对 schema 的**必填校验**。
>
> **不在本节：** 字段类型 / 选项 / `validation`（pattern / min / max）的完整语义校验（本期至少做必填；类型/选项校验列为**可选增强**，见 §20.3）、防刷 / 限流、答案去重 / 幂等。

### 20.1 校验在流程里的位置

在 §16.5 的 submit 流程上插入两步（都在「读 owner 配置 / 打任何飞书上游」之前）：

```
0)   parseSubmitRequest(body)          ← 形状校验：formSlug 非空 + answers 非空数组（否则 400，不打上游）
0.5) formExists(db, formSlug)          ← form 不存在 → 404，不打上游（§16.5，不变）
0.6) getFormStatus(db, formSlug)       ← 【新】读该 form 的 status；非 'published'（draft/closed）→ 409，不打上游
0.7) getFormFields(db, formSlug)       ← 【新】读该 form 的 fields（schema 真相）
0.8) validateAnswers(fields, answers)  ← 【新】按 fields 校验 answers：必填项缺失/空值 → 400，不打上游
1)..  同 §15.1（读+解密 owner 配置 → 未配飞书 409 → 换 token → 映射 fields → 写记录 → 200 { ok, recordId }）
```

> 0.6 / 0.7 可合并成一次 D1 读（一条 `SELECT status, schema_json ...`），是否合并由实现定；对外契约只看「状态非 published 拒收」与「必填缺失拒收」两个可观察行为。两步都在飞书上游之前，确保脏提交**绝不**写进 owner 的表。

### 20.2 表单状态门

- `getFormStatus(db, slug)` 读该 slug 行的 `status`（`'published' | 'draft' | 'closed'`，见 schema.sql / §16.7 / §21）。form 不存在时返回 `null`（但流程里 0.5 的 `formExists` 已先挡掉不存在的 slug，0.6 主要区分 published vs 其它状态）。
- **判定：** `status === 'published'` → 放行进入后续校验 / 写入；`status` 为 `'draft'` 或 `'closed'`（或任何非 `published` 值）→ **拒收**：`409 { "error": "..." }`（如「表单未开放提交」），**不**读 owner 配置、**不**打任何飞书上游、**不**写记录。
- **为什么 409：** 「表单存在但当前不接受提交」是一个与请求体无关的**状态冲突**（conflict），用 `409` 表达，与「form 不存在」的 `404`、「请求体非法」的 `400` 区分开。错误体仍是 `application/json` 的 `{ error }`。

### 20.3 answers 对 schema 的校验（MVP：必填校验）

`validateAnswers(fields, answers)` 按该 form 的 `fields`（§3.2 Field 真相）校验提交的 `answers`：

- **必填校验（本期必做）：** 对每个 `required === true` 的 field，要求 `answers` 里存在与之对应、且**值非空**的作答；缺失或空值 → 校验失败。本节**校验失败 → `400 { "error": "..." }`**（如「缺少必填字段：姓名」），不打任何飞书上游。
  - **「对应」的匹配键（MVP）：** 沿用 §15.3 的约定——`answer.label` 对位 `field.label`（MVP 用 label 做列名；field id ↔ label 的精确映射留后续）。即「该 field 的 `label` 在 `answers` 里有一条 `label` 相等、且 `value` 非空的作答」。
  - **「空值」判定：** `value` 为空字符串、纯空白字符串，或空数组（`[]`，多选未选）均视为「未填」。具体空值规则由实现在合约内定，但**必须**覆盖：空串 + 空数组 = 未填。
  - **嵌套（group）：** group 字段的子字段（`children`）的必填校验是否递归由实现在合约内定；MVP 至少校验顶层 `fields` 的必填即可（递归列为可选增强，与 §16.2 的深度上限一致地受限）。
- **类型 / 选项 / validation 校验（本期可选增强）：** 校验 `value` 是否匹配 `field.type`（number 是否数字串）、select/radio/checkbox 的 `value` 是否落在 `options` 内、是否满足 `validation`（pattern/min/max）——这些列为**可选**。若实现做了，失败同样走 `400 { error }`；不做则只跑必填校验。本节**不**要求实现它们，但要求 `validateAnswers` 的契约为它们留好位置（同一函数、同一 `400` 出口）。

### 20.4 错误响应（状态码 + `{ error }`）

| 情况 | 状态码 | 响应体 | 说明 |
|---|---|---|---|
| `formSlug` 缺失 / 空 | `400` | `{ "error": "formSlug is required" }` | §16.5，不变 |
| `answers` 缺失 / 非数组 / 空 / 单条形状非法 | `400` | `{ "error": "..." }` | §15.2 / §16.5，不变 |
| `formSlug` 对应 form 不存在 | `404` | `{ "error": "..." }` | §16.5，不变 |
| **form 状态非 `published`（draft/closed）** | `409` | `{ "error": "..." }` | 【新】不读 owner 配置、不打飞书上游 |
| **answers 漏填必填字段（或可选的类型/选项校验失败）** | `400` | `{ "error": "..." }` | 【新】不打飞书上游 |
| owner 未配飞书 | `409` | `{ "error": "owner 未配置飞书" }` | §15.6，不变（注意与「状态门 409」语义不同，error 文案区分）|
| 换 token / 写记录失败 | `502` | `{ "error": "..." }` | §15.6，不变 |

- 两个 `409`（状态门 vs 未配飞书）语义不同，靠 `error` 文案区分；前端据文案 / 上下文决定提示。
- 校验失败的 `{ error }` 可携带「哪个字段缺失」这类**非敏感**信息供答题者修正，但**绝不**含 owner 凭据。

### 20.5 对既有 submit 行为的影响（向后兼容）

- 既有「正常提交」用例：表单是 §16 `POST /api/forms` 发布出来的（发布即 `published`，§16.7），故天然过状态门；只要这些用例的 `answers` 满足表单的必填字段，行为不变（仍 `200 { ok, recordId }`）。
- 既有用例若用了「带必填字段但 answers 不含该字段」的构造，会因新必填校验从 `200` 变 `400`——这是**预期的连锁**，需在 outer-tester 侧对齐（见交付里的「现有测试连锁清单」）。

---

## 21. 后端 · 表单管理 CRUD（owner-only：列表 / 改状态 / 删除）

> **与第 16/17 节的关系：** §16 让 owner 发布表单（`POST /api/forms`）、答题者公开拉取（`GET /api/forms/:slug`），§17 给 owner-only 端点加了鉴权。但 owner 发布后**无法管理**自己的表单：看不到列表、改不了状态（开放 / 关闭提交）、删不掉。本节补上 owner 视角的管理 CRUD，全部 **owner-only**（挂 §17 的 `requireAuth`）。
>
> **本节范围（仅 Worker 端）：** `GET /api/forms`（列表）、`PATCH /api/forms/:slug`（改 status，至少；可选编辑 meta/fields）、`DELETE /api/forms/:slug`（删除）。
>
> **不在本节：** 多租户隔离（MVP 单 owner，`owner_id='default'`，列表即该 owner 全部）、分页 / 搜索 / 排序、批量操作、版本历史 / 回滚、表单复制（已有 `duplicate_field` 是字段级、与本节无关）。

### 21.1 端点职责与鉴权矩阵（在 §17.1 基础上新增）

| 端点 | 谁调 | 鉴权 | 职责 |
|---|---|---|---|
| `GET /api/forms` | owner（管理台） | **owner-only** | 列出该 owner 的所有表单（slug / meta / status / created_at），不含 fields 全量 |
| `PATCH /api/forms/:slug` | owner | **owner-only** | 改 `status`（`published` ↔ `closed`）和/或编辑 `meta` / `fields`（至少支持改 status）|
| `DELETE /api/forms/:slug` | owner | **owner-only** | 删除该表单 |

> **关键路由共存陷阱（与 §17.5 同源、本节加剧）：** `/api/forms` 前缀下现在有四条路由，鉴权与公开**交错**：
> - `GET  /api/forms`            → **owner-only**（列表，本节新增）
> - `POST /api/forms`            → owner-only（发布，§16）
> - `GET  /api/forms/:slug`      → **公开**（公开拉取，§16）——**绝不能被误伤**
> - `PATCH/DELETE /api/forms/:slug` → owner-only（本节新增）
> - `GET  /api/forms/:slug/submissions` → owner-only（§18）
>
> guard 必须按**精确 method + path** 挂（沿用 §17.5 既有做法），逐条点名 owner-only 路由，**绝不**用宽匹配 `app.use('/api/forms/*', guard)`（会把公开的 `GET /api/forms/:slug` 也罩进去）。`GET /api/forms`（无 `:slug` 段）与 `GET /api/forms/:slug`（带段）是**两条不同路由**：前者 owner-only、后者公开——挂载时务必区分，别让列表的 guard 漏到、或公开拉取的开放被收。

### 21.2 `GET /api/forms` — owner 列出自己的表单

成功（`200`，`application/json`）：

```jsonc
{
  "forms": [
    {
      "slug": "f8Kq2pXa",
      "meta": { "title": "活动报名表", "description": "请填写你的报名信息" },
      "status": "published",
      "createdAt": "2026-06-11T08:00:00.000Z"
    }
  ],
  "count": 1
}
```

- 项形状（`FormListItem`）：`{ slug, meta, status, createdAt }`。**不**含 `fields` 全量（列表只给概览，详情走 `GET /api/forms/:slug` 或 PATCH 回显）；`submissionCount`（该表单已收集条数）列为**可选**字段——拉一次飞书才能算，实现可省略或异步补，MVP 不强求。
- `forms`：该 owner（`owner_id='default'`）的所有表单，按 `created_at` 倒序（最新在前）或不约定顺序，由实现定。空 → `[]`（正常态）。
- **与公开拉取的区别：** 这是 owner-only 列表，**可以**回 `status` / `createdAt`（owner 自己的私有维度）；而公开 `GET /api/forms/:slug` 仍只投影 `slug + meta + fields`（§16.4 不变）。但本列表项**仍不含**任何 owner 凭据（凭据在 `owner_config`，不在 `forms` 表）。

### 21.3 `PATCH /api/forms/:slug` — 编辑表单（至少改 status）

请求体（`UpdateFormInput`，JSON，**所有字段可选 / 部分更新**）：

```jsonc
{
  "status": "closed",                  // 可选：'published' | 'closed'（开放/关闭提交）
  "meta":   { "title": "新标题" },      // 可选：整块替换 meta（若给）
  "fields": [ /* Field[] */ ]          // 可选：整块替换 fields（若给）
}
```

- **至少支持改 `status`**（`published` ↔ `closed`，配合 §20 的状态门：closed → 不再接受提交）。`meta` / `fields` 的编辑为**可在合约内一并支持**的增强；若实现支持，`fields` 须复用 §16 `parseField` 的形状校验（含 §16.2 的深度上限）。
- **部分更新语义：** 只更新请求体里出现的键，未出现的键保持原值；空请求体 `{}` 是 no-op（仍 `200`）。`status` 只接受 `'published'` / `'closed'`（**不**允许 PATCH 成 `'draft'`——草稿是发布前态，MVP 发布即 published，无回退草稿的入口）；非法 status 值 → `400 { error }`。
- 成功（`200`，`application/json`）：回更新后的该表单视图（含 `slug` / `meta` / `status` / `fields` / `createdAt` 的 owner 视图，或至少回 `{ slug, status }` —— 由实现定，但**必须**让 owner 能确认改动已生效）。
- `slug` 不存在 → `404 { error }`。请求体非法 JSON / 非法 status → `400 { error }`。

### 21.4 `DELETE /api/forms/:slug` — 删除表单

- **删除语义（硬删）：** MVP 采用**硬删**——从 `forms` 表里删掉该行。删除后该 slug 的公开拉取 / submit 都变 `404`（form 不存在）。选硬删而非软删（置 `closed`）的理由：①「关闭提交」已由 §21.3 的 `status='closed'` 覆盖，软删会与之语义重叠；②MVP 不需要回收站 / 审计留痕。`DELETE` 与「PATCH 成 closed」是**两个不同动作**：closed = 表单还在、只是停止收集；delete = 表单整个移除。
- 成功（`200`，`application/json`）：`{ "ok": true, "slug": "f8Kq2pXa" }`（或 `204 No Content`，由实现择一；选 `200 { ok }` 便于前端确认）。
- `slug` 不存在 → `404 { error }`（删一个不存在的 form 是错误，不是幂等成功——MVP 取严格语义；若实现想做幂等 `200` 可在合约内定，但需在 feature 里有据）。
- **不联动删提交：** 删 `forms` 行**不**触碰 owner 飞书表里已收集的记录（数据在 owner 的飞书租户里，归 owner 自管）；本端点只删后端的表单定义行。

### 21.5 错误响应（状态码 + `{ error }`）

| 端点 | 情况 | 状态码 | 响应体 |
|---|---|---|---|
| 三者皆 | 缺 / 坏 / 过期 token | `401` | `{ "error": "未授权" }`（§17.4，guard 拦截，不进 handler）|
| `PATCH` / `DELETE` | `slug` 不存在 | `404` | `{ "error": "..." }` |
| `PATCH` | 请求体非法 JSON / status 非法值 | `400` | `{ "error": "..." }` |

- 错误体一律 `application/json` 的 `{ error }`。
- 三个端点都不回任何 owner 凭据（凭据在 `owner_config`，§16.4 / §18.6 同源边界）。

### 21.6 D1 影响

- 复用现有 `forms` 表（schema.sql / §16.7），**无需新增列**：列表读 `slug` / `meta_json` / `status` / `created_at`；PATCH 改 `status`（及可选 `meta_json` / `schema_json`）；DELETE 删行。
- `status` 列已存在且取值 `'published' | 'draft' | 'closed'`；本节让 `'closed'` 第一次有了写入入口（PATCH），`'draft'` 仍只是预留态（MVP 无写入入口）。
