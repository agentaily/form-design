// forms-panel.jsx — owner "我的表单" management panel (SPEC §21, frontend) + the
// publish-feedback surface (SPEC §16). Composed entirely from
// @agentaily/design-system (PanelSheet/PageSection/Card/DropdownMenu/Dialog/Button/
// Badge/Alert/AlertDialog/Spinner/Empty) — never hand-rolled chrome.
//
// Two cooperating pieces, both driven by an injectable formsClient (same seam pattern
// as settings.jsx's getConfig/saveConfig: defaults to the real ./core/formsClient
// functions, injectable so tests pass a fake client and stay deterministic):
//
//   <FormsPanel> — the "我的表单" full-screen PanelSheet (PR-5: was a DS Dialog). On
//     open → listForms() → render one CARD per form: title (meta.title), a status Badge
//     (已发布 / 已关闭), createdAt, the public fill link (publicFormUrl(slug)), and a
//     "查看全部提交" affordance that swaps the panel's content to that form's 提交数据
//     (SubmissionsContent, in-panel — not a new Dialog; PR-6/chat13). Per-card actions
//     (bottom row):
//       • 复制链接 — copy the public fill link.
//       • 编辑 — PR-7 placeholder (载回设计器编辑 is a later root): disabled until then.
//       • `⋯` overflow menu (DropdownMenu):
//           – 关闭收集 / 重新发布 → updateForm(slug, { status }) published↔closed →
//             reflect the returned status on the card's Badge.
//           – 删除 → a confirmation step (AlertDialog) → on confirm deleteForm(slug)
//             → drop the card; on cancel → no request, card stays.
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
  PanelSheet,
  PageSection,
  Card,
  Dialog,
  Button,
  Badge,
  Alert,
  AlertDialog,
  Spinner,
  Empty,
  DropdownMenu,
} from "@agentaily/design-system";
import { Icon } from "./chat.jsx";
import { SubmissionsContent } from "./submissions-view.jsx";
import {
  publishForm as defaultPublishForm,
  listForms as defaultListForms,
  updateForm as defaultUpdateForm,
  deleteForm as defaultDeleteForm,
  getFormForEdit as defaultGetFormForEdit,
  publicFormUrl as defaultPublicFormUrl,
  feishuTableUrl,
} from "./core/formsClient";
import { listSubmissions as defaultListSubmissions } from "./core/submissionsClient";
import { ApiError } from "./core/apiClient";
import { L } from "./core/i18n";

// A 401 from any owner-only call means the session is missing/expired (§17): hand off
// to the login flow instead of rendering it as an inline panel/feedback error.
function is401(e) {
  return e instanceof ApiError && e.status === 401;
}

// Human label + Badge variant for a form's lifecycle status (SPEC §21 / §16.7).
function statusLabel(status) {
  if (status === "published") return L("已发布", "Live");
  if (status === "closed") return L("已关闭", "Closed");
  return L("草稿", "Draft");
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
 * @param {(slug: string) => Promise<import("./core/submissionsClient").SubmissionsResult>} [props.listSubmissions]
 */
export function FormsPanel({
  open,
  onClose,
  onNeedLogin,
  listForms = defaultListForms,
  updateForm = defaultUpdateForm,
  deleteForm = defaultDeleteForm,
  // 载回设计器编辑 (PR-7): pull the form's full meta+fields then hand it to App so the
  // designer loads it. Defaults to the real formsClient.getFormForEdit; injectable for tests.
  getFormForEdit = defaultGetFormForEdit,
  // App callback: receives the loaded {@link EditableForm} ({ slug, meta, fields, status });
  // App loads it into the designer + enters edit mode + closes this panel.
  onEditForm,
  publicFormUrl = defaultPublicFormUrl,
  listSubmissions = defaultListSubmissions,
} = {}) {
  const [forms, setForms] = useState([]);
  const [loading, setLoading] = useState(false);
  // A non-401 load failure (rare) surfaces inline; 401 routes to login instead.
  const [loadError, setLoadError] = useState("");
  // Per-row in-flight status toggle (slug → true) so its toggle button disables.
  const [busy, setBusy] = useState({});
  // The form pending a delete confirmation (its summary), or null when none.
  const [pendingDelete, setPendingDelete] = useState(null);
  // The slug currently being loaded for editing (PR-7) — disables its 编辑 button while
  // the fetch is in flight so a double-click can't fire two loads.
  const [editingSlug, setEditingSlug] = useState(null);
  // 数据后台「查看全部提交」(§18): 在同一 PanelSheet 内 swap 内容（不再开独立 Dialog）。
  //   viewing — 正在看提交数据的表单（null = 列表视图）；
  //   detail  — 正在看的单条提交记录（null = 提交列表；非 null = 记录详情子页）。
  // 两态都住在面板层，因为面包屑（PanelSheet 顶栏）要跟随 列表 → 提交数据 → 记录号 加级回退。
  const [viewing, setViewing] = useState(null);
  const [detail, setDetail] = useState(null);

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
    setViewing(null);
    setDetail(null);
    Promise.resolve()
      .then(() => listForms())
      .then((list) => {
        if (alive) setForms(Array.isArray(list) ? list : []);
      })
      .catch((e) => {
        if (!alive) return;
        if (handleError(e)) return; // 401 → login flow, no inline error
        setLoadError(
          L("无法加载表单列表，请稍后重试。", "Couldn't load your forms. Please try again."),
        );
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
      setLoadError(
        L("更新表单状态失败，请稍后重试。", "Couldn't update the form status. Please try again."),
      );
    } finally {
      setBusy((b) => ({ ...b, [form.slug]: false }));
    }
  };

  // 载回设计器编辑 (PR-7): pull the form's full meta+fields (listForms summaries omit
  // fields), then hand the loaded definition up to App, which loads it into the designer,
  // enters edit mode, and closes this panel. A 401 routes into login (same as other calls);
  // any other failure surfaces inline without tearing down the panel.
  const onEditCard = async (form) => {
    if (editingSlug) return;
    setEditingSlug(form.slug);
    try {
      const loaded = await getFormForEdit(form.slug);
      onEditForm?.(loaded);
    } catch (e) {
      if (handleError(e)) return; // 401 → login flow
      setLoadError(
        L(
          "载入这份表单进行编辑失败，请稍后重试。",
          "Couldn't load this form for editing. Please try again.",
        ),
      );
    } finally {
      setEditingSlug(null);
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
      setLoadError(L("删除表单失败，请稍后重试。", "Couldn't delete the form. Please try again."));
    } finally {
      setPendingDelete(null);
    }
  };

  // One form = one Card. data-slug is kept on the card so existing row-scoped tests
  // (and any DOM lookups) resolve a single card by slug. Lifecycle actions live in a
  // `⋯` DropdownMenu (PR-5 收敛); 复制链接 + 编辑 stay as direct foot buttons.
  const FormCardItem = (form) => {
    const link = publicFormUrl(form.slug);
    const published = form.status === "published";
    return (
      <Card key={form.slug} padding="md">
        <section className="d-formcard" data-slug={form.slug}>
          <div className="d-formcard__head">
            <div className="d-formcard__toprow">
              {/* The public fill link (via the publicFormUrl seam) — the card's eyebrow. */}
              <a
                className="d-formcard__link"
                href={link}
                target="_blank"
                rel="noreferrer"
                title={link}
              >
                {link}
              </a>
              <Badge variant={statusVariant(form.status)} dot>
                {statusLabel(form.status)}
              </Badge>
            </div>
            {/* h2: one level under PageSection's h1 ("你发布的表单") — no outline skip. */}
            <h2 className="d-formcard__title">
              {form.meta?.title || L("未命名表单", "Untitled form")}
            </h2>
            <p className="d-formcard__sub">
              {L("创建于 ", "Created ")}
              {formatCreatedAt(form.createdAt)}
            </p>
          </div>

          {/* 「查看全部提交」(§18): a DS Button (no hand-rolled clickable chrome) that swaps
              this same PanelSheet's content to the form's 提交数据 (SubmissionsContent) —
              NOT a new Dialog/panel (PR-6, chat13). 读真实 D1 数据 (#56). */}
          <div className="d-formcard__body">
            <div className="d-formcard__subs">
              <span className="ax-label">{L("最近提交", "Recent")}</span>
              <Button variant="ghost" size="sm" onClick={() => setViewing(form)}>
                {L("查看全部提交 ›", "View all submissions ›")}
              </Button>
            </div>
          </div>

          <div className="d-formcard__foot">
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="copy" size={14} />}
              onClick={() => copyLink(link)}
            >
              {L("复制链接", "Copy link")}
            </Button>
            <span className="d-formcard__foot-sp" />
            {/* 编辑/继续编辑 (PR-7「载回设计器编辑」): 拉取这份表单的 meta+fields → 交给 App
                载回设计器进入编辑态。载入中禁用以防双击触发两次载入。 */}
            <Button
              variant="secondary"
              size="sm"
              icon={<Icon name="pen" size={14} />}
              disabled={!!editingSlug}
              onClick={() => onEditCard(form)}
            >
              {editingSlug === form.slug
                ? L("载入中…", "Loading…")
                : published
                  ? L("继续编辑", "Edit")
                  : L("编辑", "Edit")}
            </Button>
            <DropdownMenu
              align="end"
              trigger={
                <Button variant="ghost" size="sm" aria-label={L("更多操作", "More actions")}>
                  ⋯
                </Button>
              }
              items={[
                {
                  label: published ? L("关闭收集", "Close") : L("重新发布", "Republish"),
                  icon: <Icon name={published ? "power" : "refresh"} size={15} />,
                  disabled: !!busy[form.slug],
                  onSelect: () => onToggle(form),
                },
                { type: "separator" },
                {
                  label: L("删除", "Delete"),
                  icon: <Icon name="trash" size={15} />,
                  danger: true,
                  onSelect: () => setPendingDelete(form),
                },
              ]}
            />
          </div>
        </section>
      </Card>
    );
  };

  // ── 同一面板内 列表 ↔ 提交数据 ↔ 记录详情 的内容切换（chat13）──────────────────────────
  // PanelSheet 本身始终挂载（不 remount）：只有内层 `.mf-swap` 随视图换 key 重挂、做内容级 fade。
  // 故面板首开有上浮动画；之后的内部切换没有面板级动效，只内容淡入。记录详情是面板内子页、非 Dialog。
  const inSubs = !!viewing;
  const inDetail = inSubs && !!detail;
  // 返回「我的表单」列表：清掉提交视图 + 详情子页。
  const backToList = () => {
    setDetail(null);
    setViewing(null);
  };

  // 面包屑随当前视图加级回退：我的表单 → 提交数据 → #记录号（各级可点回退）。
  const crumb = inSubs ? (
    <span className="sb-crumb">
      <button type="button" className="sb-crumb__back" onClick={backToList}>
        {L("我的表单", "My forms")}
      </button>
      <span className="sb-crumb__sep" aria-hidden="true">
        /
      </span>
      {inDetail ? (
        <React.Fragment>
          <button type="button" className="sb-crumb__back" onClick={() => setDetail(null)}>
            {L("提交数据", "Submissions")}
          </button>
          <span className="sb-crumb__sep" aria-hidden="true">
            /
          </span>
          <span className="sb-crumb__cur">{detail._label}</span>
        </React.Fragment>
      ) : (
        <span className="sb-crumb__cur">{L("提交数据", "Submissions")}</span>
      )}
    </span>
  ) : (
    L("我的表单", "My forms")
  );
  const barLabel = inSubs ? L("提交数据", "Submissions") : L("我的表单", "My forms");

  // The bar's right slot: in the submissions view, the form's collection status; in the
  // list view, the form count once loaded (no count while loading / on error / empty —
  // the empty state speaks for itself).
  const countBadge =
    !loading && !loadError && forms.length > 0 ? (
      <Badge variant="neutral">
        {forms.length}
        {L(" 个表单", " forms")}
      </Badge>
    ) : null;
  const barActions = inSubs ? (
    <Badge variant={viewing.status === "published" ? "ok" : "neutral"} dot>
      {viewing.status === "published" ? L("收集中", "Collecting") : L("已关闭", "Closed")}
    </Badge>
  ) : (
    countBadge
  );

  return (
    <PanelSheet
      open={open}
      crumb={crumb}
      label={barLabel}
      onClose={onClose}
      barFullWidth
      actions={barActions}
    >
      {/* 内容交换层：换 key → 内层重挂 → `.mf-swap` 内容淡入；PanelSheet 不重新过场。 */}
      <div className="mf-swap" key={inSubs ? "subs:" + viewing.slug : "list"}>
        {inSubs ? (
          // 数据后台「查看全部提交」(§18): 同一面板内内联渲染提交数据（content-only，非 Dialog）。
          // 读 owner-only submissionsClient（Bearer）；401 → 同一 onNeedLogin（关面板 + 弹登录）。
          <SubmissionsContent
            form={viewing}
            detail={detail}
            setDetail={setDetail}
            onBackToList={backToList}
            onNeedLogin={() => {
              setViewing(null);
              setDetail(null);
              onNeedLogin?.();
            }}
            // per-form 飞书表已建（viewing.feishuTable 两列都有）→ 拼出打开链接，工具栏显示
            // 「飞书表格↗」外链（§16.9）；未建表 → undefined（不显示）。
            feishuUrl={
              viewing?.feishuTable
                ? feishuTableUrl(viewing.feishuTable.appToken, viewing.feishuTable.tableId)
                : undefined
            }
            listSubmissions={listSubmissions}
          />
        ) : (
          <PageSection
            eyebrow={L("我的表单 · MY FORMS", "MY FORMS")}
            title={L("你发布的表单", "Your published forms")}
            description={L(
              "这里汇总你创建并发布的所有表单。复制链接分享给填表人、查看收集到的提交，或随时关闭收集与删除。",
              "Every form you've created and published. Copy a link to share, view the submissions you've collected, or close and delete anytime.",
            )}
          >
            {loadError ? (
              <Alert variant="danger" title={L("出错了", "Something went wrong")}>
                {loadError}
              </Alert>
            ) : null}

            {loading ? (
              <div className="d-forms__loading">
                <Spinner size="md" />
              </div>
            ) : forms.length === 0 ? (
              <Empty
                icon={<Icon name="folder" size={18} />}
                title={L("还没有发布过表单", "No published forms yet")}
                description={L(
                  "在设计器里搭好一份表单后点「发布」，发布过的表单会出现在这里。",
                  "Build a form in the designer and hit Publish — your published forms will show up here.",
                )}
              />
            ) : (
              <div className="d-forms__cards">{forms.map((f) => FormCardItem(f))}</div>
            )}
          </PageSection>
        )}
      </div>

      {/* Confirmation surface (§21.4 destructive action). Exactly one element matches
          the spec's confirm-prompt regex — the title — so the test's findByText resolves
          a single node (the description deliberately avoids 删除/撤销/恢复 wording). */}
      <AlertDialog
        open={!!pendingDelete}
        tone="danger"
        title={L("确认删除这份表单？", "Delete this form?")}
        description={L(
          "该公开链接将立即失效，已收集到飞书的数据不受影响。",
          "The public link stops working immediately. Data already collected in Feishu is unaffected.",
        )}
        cancelLabel={L("取消", "Cancel")}
        confirmLabel={L("确定", "Confirm")}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </PanelSheet>
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
      setError(
        e instanceof ApiError
          ? e.message
          : L("发布失败，请稍后重试。", "Publish failed. Please try again."),
      );
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
      title={result ? L("表单已发布", "Form published") : L("发布表单", "Publish form")}
      onClose={onClose}
      footer={
        result ? (
          <Button
            variant="primary"
            icon={<Icon name="check" size={14} />}
            onClick={() => copyLink(displayLink)}
          >
            {L("复制链接", "Copy link")}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={!canPublish || publishing || routedToLogin}
            onClick={doPublish}
          >
            {publishing ? L("发布中…", "Publishing…") : L("发布", "Publish")}
          </Button>
        )
      }
    >
      <div className="d-publish">
        {error ? (
          <Alert variant="danger" title={L("发布失败", "Publish failed")}>
            {error}
          </Alert>
        ) : null}

        {result ? (
          <div className="d-publish__done">
            <div className="ax-label">{L("公开填写链接", "Public fill link")}</div>
            <a className="d-publish__url" href={displayLink} target="_blank" rel="noreferrer">
              {displayLink}
            </a>
            <p className="d-publish__note">
              {L(
                "任何拿到链接的人都可以填写，提交会进入你连接的飞书多维表格。",
                "Anyone with the link can fill it out, and submissions land in the Feishu base you connected.",
              )}
            </p>
          </div>
        ) : publishing ? (
          <div className="d-publish__loading">
            <Spinner size="md" />
          </div>
        ) : !canPublish ? (
          <p className="d-publish__hint">
            {L(
              "先在设计器里添加至少一个字段，再发布表单。",
              "Add at least one field in the designer before publishing.",
            )}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
