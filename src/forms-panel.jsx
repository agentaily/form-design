// forms-panel.jsx — owner "我的表单" management panel (SPEC §21, frontend) + the
// publish-feedback surface (SPEC §16). Composed entirely from
// @agentaily/design-system (Dialog/Button/Badge/Alert/AlertDialog/Spinner/Empty) —
// never hand-rolled chrome.
//
// Two cooperating pieces, both driven by an injectable formsClient (same seam pattern
// as settings.jsx's getConfig/saveConfig: defaults to the real ./core/formsClient
// functions, injectable so tests pass a fake client and stay deterministic):
//
//   <FormsPanel> — the "我的表单" Dialog. On open → listForms() → render one row per
//     form: title (meta.title), a status Badge (已发布 / 已关闭), createdAt, and the
//     public fill link (publicFormUrl(slug)) with a copy affordance. Per-row actions:
//       • toggle status → updateForm(slug, { status }) published↔closed → reflect the
//         returned status on the row's Badge.
//       • delete → a confirmation step (AlertDialog) → on confirm deleteForm(slug)
//         → drop the row; on cancel → no request, row stays.
//     Empty list → an empty state ("还没有发布过表单"), no error. A 401 from any call →
//     onNeedLogin() (App closes this + pops login, mirroring settings.jsx §17 flow),
//     NOT an inline error.
//
//   <PublishFeedback> — the post-publish surface. On open with at least one field it
//     calls publishForm(meta, fields); on success it renders the new public fill link
//     (publicFormUrl, or the backend url) + a copy action and fires onPublished so App
//     marks the header status 已发布. On a 400 it shows the backend's ApiError.message;
//     on 401 it routes through onNeedLogin. The 发布 button is disabled while there are
//     no fields (an empty form can't publish) or while a publish is in flight.

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Dialog,
  Button,
  Badge,
  Alert,
  AlertDialog,
  Spinner,
  Empty,
} from "@agentaily/design-system";
import { Icon } from "./chat.jsx";
import {
  publishForm as defaultPublishForm,
  listForms as defaultListForms,
  updateForm as defaultUpdateForm,
  deleteForm as defaultDeleteForm,
  publicFormUrl as defaultPublicFormUrl,
} from "./core/formsClient";
import { ApiError } from "./core/apiClient";

// A 401 from any owner-only call means the session is missing/expired (§17): hand off
// to the login flow instead of rendering it as an inline panel/feedback error.
function is401(e) {
  return e instanceof ApiError && e.status === 401;
}

// Human label + Badge variant for a form's lifecycle status (SPEC §21 / §16.7).
function statusLabel(status) {
  if (status === "published") return "已发布";
  if (status === "closed") return "已关闭";
  return "草稿";
}
function statusVariant(status) {
  if (status === "published") return "ok";
  if (status === "closed") return "neutral";
  return "outline";
}

// Best-effort human date (the exact format is the UI's choice; the data is the
// contract). Falls back to the raw string if it isn't parseable.
function formatCreatedAt(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Copy a public link to the clipboard (no-op when unavailable, e.g. SSR/sandbox).
async function copyLink(link) {
  try {
    await navigator.clipboard?.writeText(link);
  } catch {
    /* clipboard unavailable — silently ignore (the link is still shown for manual copy) */
  }
}

/**
 * The owner "我的表单" management Dialog (SPEC §21).
 *
 * @param {object}   props
 * @param {boolean}  props.open                 whether the panel is shown (inert when false)
 * @param {() => void} props.onClose            close the panel
 * @param {() => void} [props.onNeedLogin]      called on a 401 so App pops login (§17)
 * @param {() => Promise<import("./core/formsClient").FormSummary[]>} [props.listForms]
 * @param {(slug: string, patch: import("./core/formsClient").UpdateFormInput) => Promise<import("./core/formsClient").UpdateFormResult>} [props.updateForm]
 * @param {(slug: string) => Promise<import("./core/formsClient").DeleteFormResult>} [props.deleteForm]
 * @param {(slug: string, base?: string) => string} [props.publicFormUrl]
 */
export function FormsPanel({
  open,
  onClose,
  onNeedLogin,
  listForms = defaultListForms,
  updateForm = defaultUpdateForm,
  deleteForm = defaultDeleteForm,
  publicFormUrl = defaultPublicFormUrl,
} = {}) {
  const [forms, setForms] = useState([]);
  const [loading, setLoading] = useState(false);
  // A non-401 load failure (rare) surfaces inline; 401 routes to login instead.
  const [loadError, setLoadError] = useState("");
  // Per-row in-flight status toggle (slug → true) so its toggle button disables.
  const [busy, setBusy] = useState({});
  // The form pending a delete confirmation (its summary), or null when none.
  const [pendingDelete, setPendingDelete] = useState(null);

  const handleError = useCallback(
    (e) => {
      if (is401(e)) {
        onNeedLogin?.();
        return true;
      }
      return false;
    },
    [onNeedLogin],
  );

  // On open, fetch the owner's forms. `open === false` does NO fetch/effect work (App
  // mounts this unconditionally) — the guard below keeps a closed panel fully inert.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoadError("");
    setLoading(true);
    setPendingDelete(null);
    Promise.resolve()
      .then(() => listForms())
      .then((list) => {
        if (alive) setForms(Array.isArray(list) ? list : []);
      })
      .catch((e) => {
        if (!alive) return;
        if (handleError(e)) return; // 401 → login flow, no inline error
        setLoadError("无法加载表单列表，请稍后重试。");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // listForms is injected per-mount and stable in tests; re-run only on (re)open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // App mounts <FormsPanel> unconditionally; when closed it must be fully inert.
  if (!open) return null;

  const onToggle = async (form) => {
    if (busy[form.slug]) return;
    const next = form.status === "published" ? "closed" : "published";
    setBusy((b) => ({ ...b, [form.slug]: true }));
    try {
      const res = await updateForm(form.slug, { status: next });
      const status = res?.status ?? next;
      setForms((fs) => fs.map((f) => (f.slug === form.slug ? { ...f, status } : f)));
    } catch (e) {
      if (handleError(e)) return; // 401 → login flow
      setLoadError("更新表单状态失败，请稍后重试。");
    } finally {
      setBusy((b) => ({ ...b, [form.slug]: false }));
    }
  };

  const confirmDelete = async () => {
    const form = pendingDelete;
    if (!form) return;
    try {
      await deleteForm(form.slug);
      setForms((fs) => fs.filter((f) => f.slug !== form.slug));
    } catch (e) {
      if (handleError(e)) return; // 401 → login flow
      setLoadError("删除表单失败，请稍后重试。");
    } finally {
      setPendingDelete(null);
    }
  };

  const Row = (form) => {
    const link = publicFormUrl(form.slug);
    const published = form.status === "published";
    return (
      <li className="d-formrow" data-slug={form.slug} key={form.slug}>
        <div className="d-formrow__head">
          <span className="d-formrow__title">{form.meta?.title || "未命名表单"}</span>
          <Badge variant={statusVariant(form.status)} dot>
            {statusLabel(form.status)}
          </Badge>
        </div>
        <div className="d-formrow__meta">
          <span className="d-formrow__date">{formatCreatedAt(form.createdAt)}</span>
          <a className="d-formrow__link" href={link} target="_blank" rel="noreferrer">
            {link}
          </a>
        </div>
        <div className="d-formrow__actions">
          <Button variant="ghost" size="sm" onClick={() => copyLink(link)}>
            复制链接
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!!busy[form.slug]}
            onClick={() => onToggle(form)}
          >
            {published ? "关闭" : "重新开放"}
          </Button>
          <Button variant="danger" size="sm" onClick={() => setPendingDelete(form)}>
            删除
          </Button>
        </div>
      </li>
    );
  };

  return (
    <Dialog open={open} title="我的表单" onClose={onClose}>
      <div className="d-forms">
        {loadError ? (
          <Alert variant="danger" title="出错了">
            {loadError}
          </Alert>
        ) : null}

        {loading ? (
          <div className="d-forms__loading">
            <Spinner size="md" />
          </div>
        ) : forms.length === 0 ? (
          <Empty
            icon={<Icon name="layout" size={18} />}
            title="还没有发布过表单"
            description="在设计器里搭好一份表单后点「发布」，发布过的表单会出现在这里。"
          />
        ) : (
          <ul className="d-forms__list">{forms.map((f) => Row(f))}</ul>
        )}
      </div>

      {/* Confirmation surface (§21.4 destructive action). Exactly one element matches
          the spec's confirm-prompt regex — the title — so the test's findByText resolves
          a single node (the description deliberately avoids 删除/撤销/恢复 wording). */}
      <AlertDialog
        open={!!pendingDelete}
        tone="danger"
        title="确认删除这份表单？"
        description="该公开链接将立即失效，已收集到飞书的数据不受影响。"
        cancelLabel="取消"
        confirmLabel="确定"
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </Dialog>
  );
}

/**
 * Post-publish feedback surface (SPEC §16): publish the designer's current form on
 * open, then show the public fill link + a copy action.
 *
 * @param {object}   props
 * @param {boolean}  props.open                 whether the feedback is shown
 * @param {() => void} props.onClose            dismiss the feedback
 * @param {() => void} [props.onNeedLogin]      called on a 401 so App pops login (§17)
 * @param {import("./core/designerTools").FormMeta} [props.meta]   designer meta to publish
 * @param {import("./core/designerTools").UiField[]} [props.fields] designer fields to publish
 * @param {(meta, fields) => Promise<import("./core/formsClient").PublishResult>} [props.publishForm]
 * @param {(slug: string, base?: string) => string} [props.publicFormUrl]
 * @param {(result: import("./core/formsClient").PublishResult) => void} [props.onPublished]
 */
export function PublishFeedback({
  open,
  onClose,
  onNeedLogin,
  meta,
  fields,
  publishForm = defaultPublishForm,
  publicFormUrl = defaultPublicFormUrl,
  onPublished,
} = {}) {
  const [publishing, setPublishing] = useState(false);
  const [result, setResult] = useState(null);
  // The backend's verbatim rejection message (e.g. "meta.title 必填") on a 400.
  const [error, setError] = useState("");
  // Set once a 401 has routed to login; disables the 发布 button. The synchronous
  // guard (routedRef) is what actually de-dupes onNeedLogin (state is async).
  const [routedToLogin, setRoutedToLogin] = useState(false);
  // Refs are synchronous across renders, so they de-dupe even when an auto-publish
  // and a click race within the same tick:
  //   routedRef — a 401 hands off to login exactly once per (re)open.
  //   inFlightRef — only one publish is ever in flight at a time.
  const routedRef = useRef(false);
  const inFlightRef = useRef(false);

  const canPublish = Array.isArray(fields) && fields.length > 0;

  const handleError = useCallback(
    (e) => {
      if (is401(e)) {
        if (!routedRef.current) {
          routedRef.current = true;
          setRoutedToLogin(true);
          onNeedLogin?.();
        }
        return true;
      }
      return false;
    },
    [onNeedLogin],
  );

  const doPublish = useCallback(async () => {
    if (!canPublish || routedRef.current || inFlightRef.current) return;
    inFlightRef.current = true;
    setPublishing(true);
    setError("");
    try {
      const res = await publishForm(meta, fields);
      setResult(res);
      onPublished?.(res);
    } catch (e) {
      if (handleError(e)) return; // 401 → login flow, no inline error
      // 400 (missing title / bad fields) → surface the backend message verbatim.
      setError(e instanceof ApiError ? e.message : "发布失败，请稍后重试。");
    } finally {
      inFlightRef.current = false;
      setPublishing(false);
    }
    // meta/fields/publishForm are stable per (re)open; publish on open only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPublish, meta, fields, publishForm, onPublished, handleError]);

  // On open with a publishable form, publish automatically (App opens this exactly
  // when the owner pressed 发布). A closed feedback does no work.
  useEffect(() => {
    if (!open) return;
    setResult(null);
    setError("");
    setRoutedToLogin(false);
    routedRef.current = false;
    inFlightRef.current = false;
    if (canPublish) doPublish();
    // run once per (re)open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  // Prefer the backend-provided ready-to-open url when present (§16.2/§16.4.1).
  const displayLink = result ? result.url || publicFormUrl(result.slug) : "";

  return (
    <Dialog
      open={open}
      title={result ? "表单已发布" : "发布表单"}
      onClose={onClose}
      footer={
        result ? (
          <Button
            variant="primary"
            icon={<Icon name="check" size={14} />}
            onClick={() => copyLink(displayLink)}
          >
            复制链接
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={!canPublish || publishing || routedToLogin}
            onClick={doPublish}
          >
            {publishing ? "发布中…" : "发布"}
          </Button>
        )
      }
    >
      <div className="d-publish">
        {error ? (
          <Alert variant="danger" title="发布失败">
            {error}
          </Alert>
        ) : null}

        {result ? (
          <div className="d-publish__done">
            <div className="ax-label">公开填写链接</div>
            <a className="d-publish__url" href={displayLink} target="_blank" rel="noreferrer">
              {displayLink}
            </a>
            <p className="d-publish__note">
              任何拿到链接的人都可以填写，提交会进入你连接的飞书多维表格。
            </p>
          </div>
        ) : publishing ? (
          <div className="d-publish__loading">
            <Spinner size="md" />
          </div>
        ) : !canPublish ? (
          <p className="d-publish__hint">先在设计器里添加至少一个字段，再发布表单。</p>
        ) : null}
      </div>
    </Dialog>
  );
}
