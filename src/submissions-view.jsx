// submissions-view.jsx — owner 数据后台 (第 6 步) 的**内容**视图. Behaviour spec:
// features/data-dashboard.feature.
//
// ★ PR-6（chat13「内容切换设计」）：从前是一个独立的 DS Dialog（<SubmissionsView>）；现在改成
//   **content-only** 的 <SubmissionsContent>，由「我的表单」面板（src/forms-panel.jsx 的 PanelSheet）
//   在**同一块面板内**内联渲染——点某表单的「查看全部提交」不再 tear down 重开一个 Dialog，而是在
//   PanelSheet 里把内容 swap 成该表单的提交数据。`detail / setDetail` 由上层面板托管（面包屑要跟随
//   详情子页变化），所以本组件是受控的：list 视图 ↔ 单条记录详情子页都在这里渲染，但「是否在看详情」
//   这个状态住在父面板。记录详情是**面板内子页**，不是 Dialog 弹窗。
//
// ★ 接 #56 的 D1 数据：listSubmissions 现在从 D1 主存投影回 { id, answers, createdAt, feishu }
//   （见 src/core/submissionsClient.ts）。本视图据此推导列（= 各条提交 answer 标签的并集）、概览统计
//   （累计 / 今日新增 / 近 7 天 / 完成率）、搜索过滤、CSV 导出、单条详情——全部基于真实 D1 数据。
//
// Lifecycle（list 视图）:
//   1. 挂载 / 换表单 → listSubmissions(slug):
//        • 200 有数据 → 概览统计 + 搜索 + DataTable + 单条「查看」入详情子页。
//        • 200 空     → 友好空态（「还没有收到提交」），无报错。
//        • 401        → onNeedLogin()（父面板关面板 + 弹登录，§17）——不内联报错。
//        • 其它非 2xx → 可重试的内联错误。
//      加载中显示 Spinner。
//   2. 详情子页：点某行「查看」→ setDetail(该条提交) → 渲染这条提交的全部作答（label → value）。
//
// All chrome from @agentaily/design-system（PageSection / DataTable / Empty / Alert / Spinner /
// Button / Badge）—— never hand-rolled. listSubmissions is injectable（默认真实 client），让
// FormsPanel 级 / 集成测试可注入假 client 保持确定性（与 formsClient 注入同构）。

import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { PageSection, DataTable, Empty, Alert, Spinner, Button } from "@agentaily/design-system";
import { Icon } from "./chat.jsx";
import { listSubmissions as defaultListSubmissions } from "./core/submissionsClient";
import { ApiError } from "./core/apiClient";

// 一个作答值渲染成文本；多值（数组）用「、」连接展示（与提交时对称）。
function displayValue(v) {
  if (Array.isArray(v)) return v.join("、");
  return v == null ? "" : String(v);
}

// 去掉标签结尾的「 *」（必填标记）只为表头/详情更干净——值本身不动。
function stripStar(s) {
  return (s || "").replace(/\s*\*\s*$/, "");
}

// 截断长单元格（带省略号）；title 仍挂完整值。短值原样返回。
function trunc(s, n) {
  s = String(s == null ? "" : s);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ISO-8601（D1 created_at）→ 可读时间；不可解析时退回原串（绝不抛）。
function formatCreatedAt(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso);
  const d = new Date(t);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${mo}-${da} ${hh}:${mm}`;
}

// 落库时刻是否在「今天」/「最近 days 天」内（基于运行时当前时间；不可解析 → false）。
function isToday(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  const d = new Date(t);
  const n = new Date();
  return (
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate()
  );
}
function withinDays(iso, days) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  const now = Date.now();
  return t <= now && now - t <= days * 86400000;
}

// 一条提交的 answers（[{label,value}]）→ label→value 的 Map（便于按列取值）。
function answerMap(submission) {
  return new Map((submission?.answers || []).map((a) => [a.label, a.value]));
}

// 一格是否「已填」：非 undefined、非空串、非空数组。用于完成率（平均字段填充率）。
function isFilled(v) {
  if (v === undefined || v === null || v === "") return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

/**
 * Owner 数据后台「提交数据」内容视图（content-only，由 FormsPanel 在 PanelSheet 内内联渲染，§18）。
 *
 * @param {object} props
 * @param {{ slug: string, status?: string, meta?: { title?: string } }} props.form  当前查看的表单
 * @param {import("./core/submissionsClient").Submission|null} props.detail  正在看的单条提交（含 _seq/_label），或 null
 * @param {(d: object|null) => void} props.setDetail  进入 / 退出详情子页（父面板据此更新面包屑）
 * @param {() => void} props.onBackToList  返回「我的表单」列表（父面板清 viewing+detail）
 * @param {() => void} [props.onNeedLogin]  401 → 引导登录（§17）
 * @param {string} [props.feishuUrl]  该表单 per-form 飞书多维表格的打开链接（§16.9）；已建表时显示
 *   「飞书表格↗」工具栏外链（新标签打开），未建表 → 省略。父面板据 viewing.feishuTable 拼出。
 * @param {(slug: string) => Promise<import("./core/submissionsClient").SubmissionsResult>} [props.listSubmissions]
 */
export function SubmissionsContent({
  form,
  detail,
  setDetail,
  onBackToList,
  onNeedLogin,
  feishuUrl,
  listSubmissions = defaultListSubmissions,
} = {}) {
  // loading 初始为 true：本组件只在父面板 swap 进提交数据时挂载（.mf-swap 换 key 重挂），挂载即拉取。
  // 若初始 false，首帧(effect 跑前)会落到「submissions.length === 0」分支、闪一帧「还没有收到提交」——
  // 一份其实有提交的表单会先闪空态。初始 true → 首帧就是 Spinner，消除这一帧误导。
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState(null);
  // "" | "retry"（D1 读端无 409/502；401 走 onNeedLogin 不内联）
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [exported, setExported] = useState(false);
  const expT = useRef(0);

  const slug = form?.slug;

  const handle401 = useCallback(
    (e) => {
      if (e instanceof ApiError && e.status === 401) {
        onNeedLogin?.();
        return true;
      }
      return false;
    },
    [onNeedLogin],
  );

  // 挂载 / 换表单时拉取（换表单 = 父面板换了 viewing，本组件因 .mf-swap key 重挂）。
  useEffect(() => {
    if (!slug) return;
    let alive = true;
    setError("");
    setResult(null);
    setLoading(true);
    setQuery("");
    Promise.resolve()
      .then(() => listSubmissions(slug))
      .then((res) => {
        if (alive) setResult(res);
      })
      .catch((e) => {
        if (!alive) return;
        if (handle401(e)) return; // 401 → login flow, no inline error
        setError("retry");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // listSubmissions injected per-mount & stable; re-fetch on slug change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // 卸载时清掉「已导出」toast 的 timer（导出后 1.8s 内返回列表 / 关面板就不会再 setState）。
  useEffect(() => () => clearTimeout(expT.current), []);

  const submissions = result?.submissions ?? [];
  const count = result?.count ?? submissions.length;

  // 列 = 所有提交 answer 标签的并集（保持首见顺序）。D1 投影不带表单 schema，故由数据推导。
  const labels = useMemo(() => {
    const seen = [];
    submissions.forEach((s) => {
      (s.answers || []).forEach((a) => {
        if (a && a.label != null && !seen.includes(a.label)) seen.push(a.label);
      });
    });
    return seen;
  }, [submissions]);

  // 每条提交 → 一行：# 序号（最新最大）、各列展示值、提交时间、原始提交（_raw 供详情）。
  const rows = useMemo(
    () =>
      submissions.map((s, i) => {
        const seq = submissions.length - i; // i=0 为最新（后端按 createdAt DESC）
        const m = answerMap(s);
        const row = {
          _seq: seq,
          _label: "#" + seq,
          _time: formatCreatedAt(s.createdAt),
          _raw: s,
        };
        labels.forEach((l, li) => {
          row["c" + li] = m.has(l) ? displayValue(m.get(l)) : "—";
        });
        return row;
      }),
    [submissions, labels],
  );

  // 概览统计（全部基于真实 D1 数据）。
  const today = useMemo(
    () => submissions.filter((s) => isToday(s.createdAt)).length,
    [submissions],
  );
  const week = useMemo(
    () => submissions.filter((s) => withinDays(s.createdAt, 7)).length,
    [submissions],
  );
  // 完成率 = 平均字段填充率：所有(行×列)格子里「已填」的占比（D1 无表单 schema，这是最诚实的可算指标）。
  const completion = useMemo(() => {
    const totalCells = submissions.length * labels.length;
    if (!totalCells) return 100;
    let filled = 0;
    submissions.forEach((s) => {
      const m = answerMap(s);
      labels.forEach((l) => {
        if (isFilled(m.get(l))) filled += 1;
      });
    });
    return Math.round((filled / totalCells) * 100);
  }, [submissions, labels]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? rows.filter(
        (r) =>
          labels.some((l, li) =>
            String(r["c" + li] || "")
              .toLowerCase()
              .includes(q),
          ) || r._label.toLowerCase().includes(q),
      )
    : rows;

  // DataTable 列：# · 每个字段一列 · 提交时间 · 查看（入详情子页）。
  const columns = [
    { key: "_seq", label: "#", numeric: true, render: (v) => <span className="sb-seq">{v}</span> },
    ...labels.map((l, li) => ({
      key: "c" + li,
      label: stripStar(l),
      render: (v) => (
        <span className="sb-cell" title={String(v == null ? "" : v)}>
          {trunc(v, 22)}
        </span>
      ),
    })),
    { key: "_time", label: "提交时间", render: (v) => <span className="sb-time">{v}</span> },
    {
      key: "_act",
      label: "",
      sortable: false,
      render: (_v, row) => (
        <button
          type="button"
          className="sb-view"
          onClick={() => setDetail({ ...row._raw, _seq: row._seq, _label: row._label })}
        >
          查看
        </button>
      ),
    },
  ];

  const exportCsv = () => {
    const head = ["编号", ...labels.map(stripStar), "提交时间"];
    const esc = (s) => {
      s = String(s == null ? "" : s);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [head.map(esc).join(",")];
    rows.forEach((r) =>
      lines.push([r._label, ...labels.map((l, li) => r["c" + li]), r._time].map(esc).join(",")),
    );
    const csv = "﻿" + lines.join("\n");
    try {
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = (slug || "form") + "-submissions.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch {
      try {
        navigator.clipboard?.writeText(csv);
      } catch {
        /* clipboard unavailable — best effort */
      }
    }
    setExported(true);
    clearTimeout(expT.current);
    expT.current = setTimeout(() => setExported(false), 1800);
  };

  if (!form) return null;

  // ── 详情子页（面板内、非 Dialog）：渲染这条提交的全部作答 ──────────────────────────────
  if (detail) {
    const nameAnswer = (detail.answers || []).find((a) =>
      /姓名|名字|name|称呼/i.test(a.label || ""),
    );
    const who = nameAnswer ? displayValue(nameAnswer.value) : "提交 " + (detail._label || "");
    return (
      <PageSection
        eyebrow={
          <button type="button" className="sb-back" onClick={() => setDetail(null)}>
            <Icon name="arrowLeft" size={13} /> 提交数据
          </button>
        }
        title={who}
        description={`${detail._label || ""} · 提交于 ${formatCreatedAt(detail.createdAt)}`}
      >
        <div className="sb-record" data-record={detail.id}>
          <dl className="sb-detail__list">
            {(detail.answers || []).map((a, i) => {
              const shown = displayValue(a.value);
              return (
                <div className="sb-detail__row" key={i}>
                  <dt className="ax-label">{stripStar(a.label)}</dt>
                  <dd>{shown === "" ? "—" : shown}</dd>
                </div>
              );
            })}
          </dl>
        </div>
      </PageSection>
    );
  }

  // ── list 视图：概览统计 + 搜索 + DataTable ─────────────────────────────────────────────
  let body;
  if (loading) {
    body = (
      <div className="d-subs__loading">
        <Spinner size="md" />
      </div>
    );
  } else if (error === "retry") {
    body = (
      <Alert variant="danger" title="出错了">
        加载提交失败，请稍后重试。
      </Alert>
    );
  } else if (submissions.length === 0) {
    body = (
      <Empty
        icon={<Icon name="inbox" size={18} />}
        title="还没有收到提交"
        description="这份表单还没有人填写。把公开链接分享出去，收到的提交会出现在这里。"
      />
    );
  } else {
    body = (
      <React.Fragment>
        <div className="sb-stats">
          <div className="sb-stat">
            <span className="ax-label sb-stat__k">累计提交</span>
            <span className="sb-stat__v">{count.toLocaleString()}</span>
          </div>
          <div className="sb-stat">
            <span className="ax-label sb-stat__k">今日新增</span>
            <span className="sb-stat__v">+{today}</span>
          </div>
          <div className="sb-stat">
            <span className="ax-label sb-stat__k">近 7 天</span>
            <span className="sb-stat__v">{week}</span>
          </div>
          <div className="sb-stat">
            <span className="ax-label sb-stat__k">完成率</span>
            <span className="sb-stat__v">{completion}%</span>
          </div>
        </div>

        <div className="sb-results">
          <div className="sb-toolbar">
            <span className="sb-search">
              <Icon name="search" size={14} />
              <input
                className="sb-search__input"
                type="text"
                value={query}
                placeholder="搜索姓名、邮箱、任意字段…"
                onChange={(e) => setQuery(e.target.value)}
              />
            </span>
            <span className="sb-toolbar__sp" />
            {q ? (
              <span className="sb-toolbar__count">
                匹配 {filtered.length} / {rows.length} 条
              </span>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              icon={<Icon name={exported ? "check" : "save"} size={14} />}
              onClick={exportCsv}
            >
              {exported ? "已导出" : "导出 CSV"}
            </Button>
            {/* 飞书表格外链（§16.9）：已建表时显示。它是真链接（要支持新标签 / 右键打开），DS Button
                是 <button onClick> 做不到，故按设计 chat13 退化为复用 ax-btn 样式的真 <a>（非手搓外观）。 */}
            {feishuUrl ? (
              <a
                className="ax-btn ax-btn--secondary ax-btn--sm sb-feishu"
                href={feishuUrl}
                target="_blank"
                rel="noreferrer"
              >
                <Icon name="external" size={14} /> 飞书表格
              </a>
            ) : null}
          </div>

          {form.status === "closed" ? (
            <div className="sb-closed">
              <Icon name="power" size={14} />
              <span>
                这份表单已关闭收集，下面是关闭前累计的全部提交。重新发布后可继续接收新提交。
              </span>
            </div>
          ) : null}

          {filtered.length === 0 ? (
            <Empty
              bordered
              icon={<Icon name="search" size={20} />}
              title="没有匹配的提交"
              description={`没有包含「${query}」的记录。试试别的关键词。`}
            />
          ) : (
            <DataTable columns={columns} rows={filtered} pageSize={8} />
          )}
        </div>
      </React.Fragment>
    );
  }

  return (
    <PageSection
      className="sb-psec"
      eyebrow={
        <button type="button" className="sb-back" onClick={onBackToList}>
          <Icon name="arrowLeft" size={13} /> 我的表单
        </button>
      }
      title={form.meta?.title || "提交数据"}
      description="收到的全部提交。点任意一行查看完整记录，或导出为 CSV 做进一步分析。"
    >
      {body}
    </PageSection>
  );
}
