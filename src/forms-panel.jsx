// forms-panel.jsx — owner "我的表单" management panel (SPEC §21, frontend). The
// post-publish surface is NO LONGER here: since N-_ayo8x 发布 is a direct action in App
// (POST /api/forms → ShareDialog), so the old in-panel <PublishFeedback> overlay is gone.
// The panel shell + primitives are
// @agentaily/design-system (PanelSheet/PageSection/Dialog/Button/Badge/
// Alert/AlertDialog/Spinner/Empty) — never hand-rolled chrome. The per-form CARD is
// app-level layout (.mf-card, design N-_ayo8x) — its border/bg/radius live in app.css and
// it consumes DS Badge/Button/Icon inside (mirrors the handoff's plain .mf-card section,
// not a DS Card wrapper). Recent-submission rows are omitted (the list endpoint carries
// none); the 累计 count rides the description when present + 「查看全部提交」 is the entry
// into the full submissions view.
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
//     are a FLAT foot row (design N-_ayo8x, no `⋯` overflow menu):
//       • 复制链接 — copy the ABSOLUTE public fill link (origin + /f/:slug) + an inline
//         「已复制链接」✓ feedback (2s, share-dialog pattern).
//       • 编辑 / 继续编辑 — 载回设计器编辑 (getFormForEdit → onEditForm).
//       • 关闭收集 / 重新发布 → updateForm(slug, { status }) published↔closed → reflect the
//         returned status on the card's Badge.
//       • 删除 → a confirmation step (AlertDialog, keeps 取消) → on confirm deleteForm(slug)
//         → drop the card; on cancel → no request, card stays.
//     Empty list → an empty state ("还没有发布过表单"), no error. A 401 from any call →
//     onNeedLogin() (App closes this + pops login, mirroring settings.jsx §17 flow),
//     NOT an inline error.

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  PanelSheet,
  PageSection,
  Dialog,
  Button,
  Badge,
  Alert,
  AlertDialog,
  Spinner,
  Empty,
} from "@agentaily/design-system";
import { Icon } from "./chat.jsx";
import { SubmissionsContent } from "./submissions-view.jsx";
import {
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

// Absolutize a possibly-relative public link (/f/:slug) into the shareable URL we hand to
// the clipboard: an already-absolute http(s) link stays as-is, otherwise prefix the current
// origin so the copied link opens directly (https://…/f/:slug, NOT a bare path). Same rule as
// share-dialog.jsx's toAbsolute; the link DISPLAYED on the card stays the short canonical path.
function toAbsolute(link) {
  const u = link || "";
  if (/^https?:\/\//i.test(u)) return u;
  const origin = typeof window !== "undefined" && window.location ? window.location.origin : "";
  return origin + u;
}

// Copy a public link to the clipboard (no-op when unavailable, e.g. SSR/sandbox). Callers pass
// the absolute URL (see toAbsolute) so what lands on the clipboard is directly openable.
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
  // The slug whose 复制链接 just fired, so its button shows an inline 「已复制链接」✓ feedback
  // (2s reset, mirroring share-dialog) instead of silently swallowing the clipboard write.
  const [copiedSlug, setCopiedSlug] = useState(null);
  const copiedTimer = useRef(null);
  // Clear the pending feedback-reset timer on unmount (no setState after unmount).
  useEffect(() => () => copiedTimer.current && clearTimeout(copiedTimer.current), []);

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

  // 复制公开填写链接 — copy the ABSOLUTE url (origin + /f/:slug) so the pasted link opens
  // directly, and flip this card's button to 「已复制链接」✓ for 2s (share-dialog feedback
  // pattern) so the click isn't a silent no-op.
  const handleCopy = (form) => {
    copyLink(toAbsolute(publicFormUrl(form.slug)));
    setCopiedSlug(form.slug);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopiedSlug(null), 2000);
  };

  // One form = one .mf-card (design N-_ayo8x layout). The card chrome is app-level layout
  // (border/bg/radius via .mf-card, matching the handoff's plain section) consuming DS
  // Badge/Button/Icon inside — not a DS Card wrapper. data-slug stays on the card so
  // row-scoped tests resolve a single card by slug ([class*='card'] / [data-slug]).
  // Foot = a FLAT row of direct buttons matching design N-_ayo8x: 复制链接 · 编辑/继续编辑 ·
  // 关闭收集/重新发布 · 删除 — NO `⋯` overflow menu (the earlier DropdownMenu was a deviation
  // to protect the form-publish-mgmt test contract; that test now asserts the flat buttons).
  // 删除 still routes through the AlertDialog confirm (DS, keeps the 取消 affordance) rather than
  // the prototype's inline two-click — we align the layout, not weaken the destructive confirm.
  // Recent-submission ROWS are omitted: the list endpoint's FormSummary carries no recent
  // rows and only an OPTIONAL submissionCount, so fabricating them would mean an N+1 fetch
  // per card (see PR notes). The 累计 count rides the description when present; 「查看全部提交」
  // stays the affordance into the full submissions view.
  const FormCardItem = (form) => {
    const published = form.status === "published";
    const count = typeof form.submissionCount === "number" ? form.submissionCount : null;
    return (
      <section
        key={form.slug}
        className={"mf-card" + (published ? " is-ok" : "")}
        data-slug={form.slug}
      >
        <div className="mf-card__head">
          <div className="mf-card__toprow">
            <span className="mf-card__icon">
              <Icon name="folder" size={16} />
            </span>
            {/* Public fill route (/f/:slug) as the card's eyebrow — the short canonical path,
                matching the design; the full URL is what 复制链接 copies. */}
            <span className="ax-label mf-card__eyebrow">/f/{form.slug}</span>
            <span className="mf-card__status">
              {published ? (
                <Badge variant="ok" dot>
                  {L("已发布", "Live")}
                </Badge>
              ) : (
                <Badge variant={statusVariant(form.status)}>{statusLabel(form.status)}</Badge>
              )}
            </span>
          </div>
          {/* h2: one level under PageSection's h1 ("你发布的表单") — no outline skip. */}
          <h2 className="mf-card__title">{form.meta?.title || L("未命名表单", "Untitled form")}</h2>
          <p className="mf-card__desc">
            {L("创建于 ", "Created ")}
            {formatCreatedAt(form.createdAt)}
            {count != null ? (
              <React.Fragment>
                {" · "}
                {L("累计 ", "")}
                {count}
                {L(" 份提交", " submissions")}
              </React.Fragment>
            ) : null}
          </p>
        </div>

        {/* 「查看全部提交」(§18): a DS Button that swaps this same PanelSheet's content to the
            form's 提交数据 (SubmissionsContent) — NOT a new Dialog (PR-6). 读真实 D1 数据 (#56). */}
        <div className="mf-card__body">
          {published ? (
            <div className="mf-subs__h">
              <span className="ax-label">{L("最近提交", "Recent")}</span>
              <Button variant="ghost" size="sm" onClick={() => setViewing(form)}>
                {L("查看全部提交 ›", "View all submissions ›")}
              </Button>
            </div>
          ) : (
            <div className="mf-closed">
              <Icon name="power" size={15} />
              <span>
                {L(
                  "表单已关闭，停止接收新提交。",
                  "Form closed — no longer accepting submissions.",
                )}
              </span>
              <span className="mf-foot__sp" />
              <Button variant="ghost" size="sm" onClick={() => setViewing(form)}>
                {L("查看全部 ›", "View all ›")}
              </Button>
            </div>
          )}
        </div>

        <div className="mf-foot">
          {/* 复制链接 — 复制完整可访问 URL(origin + /f/:slug);点后翻成「已复制链接」✓ 反馈 2s。 */}
          <Button
            variant="ghost"
            size="sm"
            icon={<Icon name={copiedSlug === form.slug ? "check" : "copy"} size={14} />}
            onClick={() => handleCopy(form)}
          >
            {copiedSlug === form.slug ? L("已复制链接", "Link copied") : L("复制链接", "Copy link")}
          </Button>
          <span className="mf-foot__sp" />
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
          {/* 关闭收集 / 重新发布 — 直接按钮(扁平,design N-_ayo8x):published↔closed。 */}
          <Button
            variant="secondary"
            size="sm"
            icon={<Icon name={published ? "power" : "refresh"} size={14} />}
            disabled={!!busy[form.slug]}
            onClick={() => onToggle(form)}
          >
            {published ? L("关闭收集", "Close") : L("重新发布", "Republish")}
          </Button>
          {/* 删除 — 直接 danger 按钮;点击打开 AlertDialog 确认(保留 取消)。 */}
          <Button
            variant="danger"
            size="sm"
            icon={<Icon name="trash" size={14} />}
            onClick={() => setPendingDelete(form)}
          >
            {L("删除", "Delete")}
          </Button>
        </div>
      </section>
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

  // 就绪栏派生量 (.mf-ready): 收集中 / 已关闭 计数从 status 派生;总提交数仅在每份表单都带
  // submissionCount 时才算(后端可省略该计数 → 否则部分和会误导)。
  const liveCount = forms.filter((f) => f.status === "published").length;
  const closedCount = forms.length - liveCount;
  const allHaveCount =
    forms.length > 0 && forms.every((f) => typeof f.submissionCount === "number");
  const totalSubs = allHaveCount ? forms.reduce((a, f) => a + f.submissionCount, 0) : null;

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
              <React.Fragment>
                {/* 就绪栏 (design N-_ayo8x .mf-ready): 正在收集 / 已关闭 计数,右侧累计提交总数。
                    live/closed 从 status 派生;总数仅当每份表单都带 submissionCount 时才显示
                    (后端可省略该计数 → 避免显示误导性的部分和)。 */}
                <div className="mf-ready">
                  <span className="mf-sum__icon">
                    <Icon name="inbox" size={15} />
                  </span>
                  <div className="mf-ready__txt">
                    <strong>
                      {liveCount}
                      {L(" 个表单正在收集", " forms collecting")}
                    </strong>
                    {closedCount > 0 ? (
                      <React.Fragment>
                        {L(" · 已关闭 ", " · ")}
                        {closedCount}
                        {L(" 个", " closed")}
                      </React.Fragment>
                    ) : null}
                  </div>
                  {totalSubs != null ? (
                    <span className="mf-ready__count">
                      {L("共 ", "")}
                      {totalSubs}
                      {L(" 份提交", " submissions")}
                    </span>
                  ) : null}
                </div>

                <div className="mf-cards">{forms.map((f) => FormCardItem(f))}</div>
              </React.Fragment>
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
