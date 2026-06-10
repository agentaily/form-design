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
