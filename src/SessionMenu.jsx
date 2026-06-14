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
// `activeId`, `onNewChat`, `onSelect(id)`, `onDelete(id)`. This component is pure presentation
// — it never fetches; App owns listChatSessions / deleteChatSession.
import React from "react";
import { IconButton, Icon, Popover } from "@agentaily/design-system";

// Format an ISO-8601 updatedAt into a short, relative-ish Chinese label for the meta line
// (刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 本地日期). Best-effort: an unparseable value
// falls back to the raw string so a row never renders blank.
export function formatSessionTime(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return String(iso);
  const diffMs = Date.now() - then;
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "昨天";
  if (day < 7) return `${day} 天前`;
  // older than a week → a plain local date (YYYY-M-D), stable across locales.
  const d = new Date(then);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function SessionMenu({ sessions = [], activeId, onNewChat, onSelect, onDelete }) {
  return (
    <Popover
      side="bottom"
      align="end"
      trigger={
        <IconButton label="会话" size="sm" variant="outline">
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
            <Icon name="plus" size={15} /> 新会话
          </button>
          <div className="cs-menu__sep" />
          <div className="cs-menu__label ax-label">最近会话</div>
          <div className="cs-menu__list">
            {sessions.map((s) => {
              const active = s.sessionId === activeId;
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
                      {s.turnCount} 轮 · {formatSessionTime(s.updatedAt)}
                    </div>
                  </div>
                  {active ? (
                    <span className="cs-item__check">
                      <Icon name="check" size={14} />
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="cs-item__del"
                      aria-label="删除会话"
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
