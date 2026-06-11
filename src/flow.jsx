// flow.jsx — scripted agent build sequence + field model for the form designer.
// Exports: INITIAL_META, BUILD_FIELDS, buildScript, intentReply, uid

export const uid = (() => {
  let n = 0;
  return (p = "id") => `${p}_${(++n).toString(36)}_${Date.now().toString(36).slice(-3)}`;
})();

// ---- the form being authored: 互动报名 (event sign-up) ----
export const INITIAL_META = {
  kicker: "ACTIVITY · REGISTRATION",
  title: "Agentaily 开发者沙龙 · 上海站",
  desc: "6 月 28 日 · 西岸 AI 汇 · 一个下午的现场动手与交流。名额 120，报满即止。",
  meta: ["2026.06.28 SAT", "13:30–18:00", "上海 · 西岸艺术中心"],
};

// field factory helper
const f = (type, label, extra = {}) => ({ id: uid("fld"), type, label, required: false, ...extra });

// The fields the agent will add, in order. `_say` is the tool's result line.
export const BUILD_FIELDS = [
  f("text", "姓名", { placeholder: "你的真实姓名", required: true, _say: "text · required" }),
  f("tel", "手机号", {
    placeholder: "11 位手机号，用于现场签到",
    required: true,
    _say: "tel · required · pattern=^1\\d{10}$",
  }),
  f("email", "邮箱", { placeholder: "you@company.com", required: true, _say: "email · required" }),
  f("text", "公司 / 团队", { placeholder: "选填", _say: "text · optional" }),
  f("radio", "票种", {
    required: true,
    options: ["普通票 · 免费", "Workshop 票 · ¥99", "学生票 · 凭学生证"],
    _say: "radio · 3 options · required",
  }),
  f("checks", "想参加的环节", {
    options: ["主题演讲", "动手工作坊", "项目展示", "晚间社交"],
    _say: "checkbox-group · 4 options",
  }),
  f("select", "技术方向", {
    placeholder: "选择最贴近你的方向",
    options: ["前端 / 全栈", "后端 / 基础设施", "AI / 算法", "产品 / 设计", "学生 / 其他"],
    _say: "select · 5 options",
  }),
  f("textarea", "想和讲者聊点什么？", {
    placeholder: "选填，我们会挑一些问题放进圆桌环节",
    _say: "textarea · optional",
  }),
  f("consent", "我已阅读并同意活动须知与隐私条款", { required: true, _say: "consent · required" }),
];

// ---- the scripted run that plays when the user sends the first brief ----
// Each step is consumed by the runner in App.jsx with timed delays.
export function buildScript() {
  return [
    {
      t: "reasoning",
      duration: "思考 6s",
      steps: [
        <span key="1">
          把诉求拆成结构：这是一次<strong>线下活动报名</strong>，核心是
          <strong>身份采集 + 票种 + 环节选择</strong>，最后是同意条款。
        </span>,
        <span key="2">
          字段尽量短。手机号设为必填并加<strong>格式校验</strong>，邮箱用于发确认信。
        </span>,
        <span key="3">
          票种用<strong>单选</strong>，环节用<strong>多选</strong>；技术方向用下拉收敛长列表。
        </span>,
        <span key="4">先写表单元信息，再逐个挂字段，实时渲染到右侧预览。</span>,
      ],
    },
    {
      t: "text",
      text: "好的。我按「线下活动报名」给你搭一版——身份信息、票种、想参加的环节，最后加一个同意条款。边搭边渲染到右边预览：",
    },
    { t: "meta" }, // applies INITIAL_META to the form
    ...BUILD_FIELDS.map((fld) => ({ t: "field", field: fld })),
    {
      t: "text",
      text: "搭好了 ✦ 共 9 个字段。手机号已设必填 + 格式校验，票种单选、环节多选。你可以直接在右侧试填提交，或继续告诉我怎么改——比如「把公司设为必填」「加一个餐食偏好」「换个封面文案」。",
      suggestions: ["把「公司」设为必填", "加一个餐食偏好字段", "发布并生成链接"],
    },
  ];
}

// ---- lightweight intent handling for follow-up turns ----
export function intentReply(text) {
  const s = text.trim();
  const has = (...ks) => ks.some((k) => s.includes(k));

  if (has("发布", "上线", "生成链接", "publish")) {
    return {
      kind: "publish",
      tool: {
        name: "publish_form",
        args: { slug: "agentaily-salon-sh", visibility: "public" },
        result: "https://forms.agentaily.dev/agentaily-salon-sh",
      },
      text: "已发布 ✦ 链接已生成，任何人都能填写。你可以在右上角「分享」里拿到二维码。",
    };
  }
  if (has("必填") && has("公司", "团队")) {
    return {
      kind: "require",
      match: "公司",
      tool: {
        name: "update_field",
        args: { target: "公司 / 团队", set: { required: true } },
        result: "ok · required=true",
      },
      text: "好了，「公司 / 团队」已设为必填，标签右上角出现了必填星标。",
    };
  }
  if (has("必填")) {
    return {
      kind: "require",
      match: null,
      tool: { name: "update_field", args: { set: { required: true } }, result: "ok" },
      text: "已把该字段设为必填。",
    };
  }
  if (has("餐食", "用餐", "饮食", "餐")) {
    return {
      kind: "add",
      field: f("radio", "餐食偏好", {
        options: ["不限", "素食", "清真", "无麸质"],
        _say: "radio · 4 options",
      }),
      tool: {
        name: "add_field",
        args: { type: "radio", label: "餐食偏好", options: 4 },
        result: "appended · #10",
      },
      text: "加好了「餐食偏好」单选，放在同意条款之前。",
    };
  }
  if (has("备注", "留言", "问题")) {
    return {
      kind: "add",
      field: f("textarea", "其他备注", { placeholder: "选填", _say: "textarea · optional" }),
      tool: {
        name: "add_field",
        args: { type: "textarea", label: "其他备注" },
        result: "appended",
      },
      text: "已追加一个「其他备注」多行输入。",
    };
  }
  if (has("删除", "去掉", "移除", "少一个")) {
    return {
      kind: "remove",
      tool: { name: "remove_field", args: { which: "last" }, result: "removed · 1 field" },
      text: "已移除最后一个字段。",
    };
  }
  if (has("封面", "标题", "文案", "改名")) {
    return {
      kind: "meta",
      set: { desc: s.replace(/^.*(封面|标题|文案|改名)[:：]?\s*/, "") || INITIAL_META.desc },
      tool: { name: "update_form", args: { field: "description" }, result: "ok" },
      text: "封面文案已更新，右侧实时生效。",
    };
  }
  // generic: treat the message as a new short-text field label
  const label = s.length > 0 && s.length <= 14 ? s : "新字段";
  return {
    kind: "add",
    field: f("text", label, { placeholder: "请输入", _say: "text · optional" }),
    tool: { name: "add_field", args: { type: "text", label }, result: "appended" },
    text: `已追加一个「${label}」输入框。需要我把它设为必填或换成其他类型吗？`,
  };
}
