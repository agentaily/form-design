// submissions-view.jsx — owner 数据后台 view (第 6 步). Contract stub: body left for
// `implementer`; this file fixes the props + behaviour. Behaviour spec:
// features/data-dashboard.feature.
//
// Where it lives: a per-form「看提交」affordance in <FormsPanel> (src/forms-panel.jsx).
// Each form row gets a「看提交」action; activating it opens this view for that slug
// (inline expansion under the row, or a nested Dialog — the exact surface is the UI's
// choice; the data contract is what's fixed). OWNER-ONLY — reads via
// submissionsClient.listSubmissions (Bearer, §17/§18).
//
// Lifecycle:
//   1. On open for a slug → listSubmissions(slug):
//        • 200 with rows → render the submissions list + the count.
//        • 200 empty     → a friendly empty state ("还没有收到提交")，no error.
//        • 401           → onNeedLogin() (App closes the panel + pops login, the same
//                          handler shape FormsPanel already uses, §17) — NOT an inline error.
//        • 409 (未配飞书) → a hint to go connect 飞书 in 集成设置 (§18.5).
//        • 404 / 502 / other → a retriable inline error.
//      A spinner shows while loading.
//   2. Each submission renders its `fields` (column label → value; arrays joined for
//      display) and, when present, its createdTime. The count is shown alongside the list.
//   3. Closing the view fires no request; reopening re-fetches.
//
// All chrome from @agentaily/design-system (Dialog/Spinner/Empty/Alert/Badge/Button) —
// never hand-rolled. listSubmissions is injectable (defaults to the real client) so
// FormsPanel-level / unit tests stay deterministic, mirroring formsClient injection.

import React, { useState, useEffect, useCallback } from "react";
import { Dialog, Spinner, Empty, Alert, Badge, Button } from "@agentaily/design-system";
import { Icon } from "./chat.jsx";
import { listSubmissions as defaultListSubmissions } from "./core/submissionsClient";
import { ApiError } from "./core/apiClient";

// A submission field value renders as text; a multi-value (array) joins for display.
function displayValue(v) {
  if (Array.isArray(v)) return v.join("、");
  return v == null ? "" : String(v);
}

// Best-effort human timestamp; falls back to nothing when absent/unparseable.
function formatTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${mo}-${da} ${hh}:${mm}`;
}

/**
 * Owner 数据后台 view for one form's submissions (SPEC §18).
 *
 * @param {object} props
 * @param {boolean} props.open                   whether the view is shown (inert when false)
 * @param {string}  props.slug                   the form whose submissions to load
 * @param {string}  [props.title]                the form's title, for the view header
 * @param {() => void} props.onClose             close the view
 * @param {() => void} [props.onNeedLogin]       called on a 401 so App pops login (§17)
 * @param {(slug: string) => Promise<import("./core/submissionsClient").SubmissionsResult>} [props.listSubmissions]
 *        injected for tests; defaults to the real submissionsClient.listSubmissions (Bearer)
 */
export function SubmissionsView({
  open,
  slug,
  title,
  onClose,
  onNeedLogin,
  listSubmissions = defaultListSubmissions,
} = {}) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  // Non-401 failures surface inline; 401 routes through onNeedLogin instead.
  const [error, setError] = useState(""); // "" | "feishu" | "retry"

  const handleError = useCallback(
    (e) => {
      if (e instanceof ApiError && e.status === 401) {
        onNeedLogin?.();
        return true;
      }
      return false;
    },
    [onNeedLogin],
  );

  // Fetch on open; a closed view does no work and re-opening re-fetches.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError("");
    setResult(null);
    setLoading(true);
    Promise.resolve()
      .then(() => listSubmissions(slug))
      .then((res) => {
        if (alive) setResult(res);
      })
      .catch((e) => {
        if (!alive) return;
        if (handleError(e)) return; // 401 → login flow, no inline error
        if (e instanceof ApiError && e.status === 409) setError("feishu");
        else setError("retry");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // listSubmissions is injected per-mount and stable; re-fetch on (re)open / slug change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, slug]);

  // App mounts this unconditionally; when closed it must be fully inert.
  if (!open) return null;

  const submissions = result?.submissions ?? [];
  const count = result?.count ?? submissions.length;

  let body;
  if (loading) {
    body = (
      <div className="d-subs__loading">
        <Spinner size="md" />
      </div>
    );
  } else if (error === "feishu") {
    body = (
      <Alert variant="warn" title="还差一步">
        请先到「集成设置」里连接飞书，之后才能查看这份表单收到的提交。
      </Alert>
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
      <div className="d-subs">
        <div className="d-subs__count ax-label">
          共 <Badge variant="solid">{count}</Badge> 条提交
        </div>
        <ul className="d-subs__list">
          {submissions.map((s) => (
            <li
              className="d-subrow"
              data-record={s.recordId}
              data-created={s.createdTime ? formatTime(s.createdTime) : undefined}
              key={s.recordId}
            >
              <dl className="d-subrow__fields">
                {Object.entries(s.fields || {}).map(([label, value]) => (
                  <div className="d-subrow__pair" key={label}>
                    <dt className="d-subrow__key">{label}</dt>
                    <dd className="d-subrow__val">{displayValue(value)}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <Dialog
      open={open}
      title={title ? `提交 · ${title}` : "提交"}
      onClose={onClose}
      footer={
        <Button variant="secondary" onClick={onClose}>
          关闭
        </Button>
      }
    >
      {body}
    </Dialog>
  );
}
