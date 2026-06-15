// SessionMenu.jsx — 对话头部的「新会话 + 最近会话列表」下拉 (SPEC §26.9, PR #65).
//
// Injected into the DS ConversationThread `actions` header slot (App.jsx). The trigger is a
// DS IconButton + Icon ("message"); the panel is a DS Popover (click-to-open, closes on
// outside-click / Escape — exactly the design-handoff prototype's behavior). The rows
// (标题 / N 轮 · 相对时间 / 当前打勾 / 非当前悬停删除) are composed at the APP layer with DS
// Icon + DS tokens, because the DS DropdownMenu's MenuItem exposes only a single onSelect per
// row and cannot carry the per-row delete side-action — so a Popover + app-composed list is
// the right seam here (we do NOT hand-roll a DS primitive, only an app-level panel keyed to
// DS tokens; see src/app.css `.cs-*`).
//
// DATA + ACTIONS are injected (real backend wired in App): `sessions` (ChatSessionSummary[]),
// `activeId`, `onNewChat`, `onSelect(id)`, `onDelete(id)`, `onRename(id, title)`. This component is
// pure presentation — it never fetches; App owns listChatSessions / deleteChatSession /
// renameChatSession. The rename affordance is an inline edit IN THIS app-composed panel (a DS-token
// styled <input>, consistent with the panel's existing app-level composition — NOT a new DS
// primitive; the polished rename interaction is「设计另拍」per §5).
import React, { useState } from "react";
import { IconButton, Icon, Popover } from "@agentaily/design-system";
import { L } from "./core/i18n";

// Format an ISO-8601 updatedAt into a short, relative-ish Chinese label for the meta line
// (刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 本地日期). Best-effort: an unparseable value
// falls back to the raw string so a row never renders blank.
export function formatSessionTime(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return String(iso);
  const diffMs = Date.now() - then;
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return L("刚刚", "just now");
  if (min < 60) return L(`${min} 分钟前`, `${min}m ago`);
  const hr = Math.floor(min / 60);
  if (hr < 24) return L(`${hr} 小时前`, `${hr}h ago`);
  const day = Math.floor(hr / 24);
  if (day === 1) return L("昨天", "yesterday");
  if (day < 7) return L(`${day} 天前`, `${day}d ago`);
  // older than a week → a plain local date (YYYY-M-D), stable across locales.
  const d = new Date(then);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function SessionMenu({ sessions = [], activeId, onNewChat, onSelect, onDelete, onRename }) {
  // Which row is being renamed (its sessionId) + the in-flight draft title. Local UI state only;
  // committing calls onRename(id, title) and App owns the persistence + list refresh.
  const [renamingId, setRenamingId] = useState(null);
  const [draft, setDraft] = useState("");

  const startRename = (s) => {
    setRenamingId(s.sessionId);
    setDraft(s.title || "");
  };
  const cancelRename = () => {
    setRenamingId(null);
    setDraft("");
  };
  const commitRename = (id) => {
    const next = (draft || "").trim();
    if (next) onRename && onRename(id, next);
    cancelRename();
  };

  return (
    <Popover
      side="bottom"
      align="end"
      trigger={
        <IconButton label={L("会话", "Sessions")} size="sm" variant="outline">
          <Icon name="message" size={15} />
        </IconButton>
      }
    >
      {({ close }) => (
        <div className="cs-menu__panel" role="menu">
          <button
            type="button"
            className="cs-menu__new"
            onClick={() => {
              close();
              onNewChat && onNewChat();
            }}
          >
            <Icon name="plus" size={15} /> {L("新会话", "New chat")}
          </button>
          <div className="cs-menu__sep" />
          <div className="cs-menu__label ax-label">{L("最近会话", "Recent")}</div>
          <div className="cs-menu__list">
            {sessions.map((s) => {
              const active = s.sessionId === activeId;
              const renaming = s.sessionId === renamingId;
              if (renaming) {
                // Inline rename: an app-level <input> styled with DS tokens (.cs-item__input). Enter
                // commits, Escape / blur cancels. stopPropagation so clicks don't select/close.
                return (
                  <div
                    key={s.sessionId}
                    className={"cs-item is-renaming" + (active ? " is-active" : "")}
                    data-session-id={s.sessionId}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      className="cs-item__input"
                      autoFocus
                      aria-label={L("重命名会话", "Rename session")}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitRename(s.sessionId);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          cancelRename();
                        }
                      }}
                      onBlur={() => commitRename(s.sessionId)}
                    />
                  </div>
                );
              }
              return (
                <div
                  key={s.sessionId}
                  className={"cs-item" + (active ? " is-active" : "")}
                  data-session-id={s.sessionId}
                  data-active={active ? "true" : "false"}
                  role="menuitem"
                  onClick={() => {
                    close();
                    onSelect && onSelect(s.sessionId);
                  }}
                >
                  <div className="cs-item__body">
                    <div className="cs-item__title">{s.title}</div>
                    <div className="cs-item__meta">
                      {s.turnCount} {L("轮", "turns")} · {formatSessionTime(s.updatedAt)}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="cs-item__rename"
                    aria-label={L("重命名会话", "Rename session")}
                    onClick={(e) => {
                      // stay in the panel; renaming is a row side-action, not a select.
                      e.stopPropagation();
                      startRename(s);
                    }}
                  >
                    <Icon name="pen" size={13} />
                  </button>
                  {active ? (
                    <span className="cs-item__check">
                      <Icon name="check" size={14} />
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="cs-item__del"
                      aria-label={L("删除会话", "Delete session")}
                      onClick={(e) => {
                        // stay in the panel; deleting is a row side-action, not a select.
                        e.stopPropagation();
                        onDelete && onDelete(s.sessionId);
                      }}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Popover>
  );
}
