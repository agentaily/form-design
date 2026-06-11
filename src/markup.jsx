// markup.jsx — element-targeting mode for the form preview.
// Hover highlights the real node under the cursor; click selects it; type a
// message and it's sent to the left chat WITH that element's identity attached,
// so you locate precisely instead of describing in words. Personal tool — no
// persisted comments. Exports: MarkupLayer
import React, { useState, useRef, useEffect } from "react";
import { Icon } from "./chat.jsx";
import { formatMarkupMessage } from "./core/markup";

export function MarkupLayer({ onClose, onSend }) {
  const layerRef = useRef(null);
  const capRef = useRef(null);
  const [hover, setHover] = useState(null); // {left,top,w,h,label,kind}
  const [selected, setSelected] = useState(null); // same shape
  const [note, setNote] = useState("");

  // resolve the targetable element under a viewport point
  const findTarget = (cx, cy) => {
    const cap = capRef.current;
    if (!cap) return null;
    const prev = cap.style.pointerEvents;
    cap.style.pointerEvents = "none";
    const el = document.elementFromPoint(cx, cy);
    cap.style.pointerEvents = prev || "auto";
    if (!el) return null;
    return el.closest("[data-mk-label]") || null;
  };

  const boxFor = (el) => {
    const r = el.getBoundingClientRect();
    const lr = layerRef.current.getBoundingClientRect();
    return {
      left: r.left - lr.left,
      top: r.top - lr.top,
      w: r.width,
      h: r.height,
      label: el.getAttribute("data-mk-label"),
      kind: el.getAttribute("data-mk-kind") || "",
    };
  };

  const onMove = (e) => {
    if (selected) return; // freeze while composing
    const t = findTarget(e.clientX, e.clientY);
    setHover(t ? boxFor(t) : null);
  };
  const onLeave = () => {
    if (!selected) setHover(null);
  };
  const onClickCap = (e) => {
    const t = findTarget(e.clientX, e.clientY);
    if (!t) {
      setSelected(null);
      setNote("");
      return;
    }
    setSelected(boxFor(t));
    setNote("");
    setHover(null);
  };

  const send = () => {
    if (!selected || !note.trim()) return;
    if (onSend) onSend(formatMarkupMessage(selected.label, selected.kind, note));
    setSelected(null);
    setNote("");
  };

  const cancel = () => {
    setSelected(null);
    setNote("");
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (selected) {
        setSelected(null);
        setNote("");
      } else if (onClose) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, onClose]);

  const box = selected || hover;

  // composer placement: below the selected element, clamped to the layer
  const popStyle = () => {
    const W = layerRef.current ? layerRef.current.clientWidth : 800;
    const H = layerRef.current ? layerRef.current.clientHeight : 600;
    let left = selected.left;
    if (left + 268 > W) left = Math.max(8, W - 268);
    let top = selected.top + selected.h + 10;
    if (top + 150 > H) top = Math.max(8, selected.top - 158); // flip above if no room
    return { left, top };
  };

  return (
    <div className="d-markup" ref={layerRef}>
      <div
        className="d-markup__canvas"
        ref={capRef}
        onMouseMove={onMove}
        onMouseLeave={onLeave}
        onClick={onClickCap}
      />

      {/* highlight box (hover or selected) */}
      {box ? (
        <div
          className={"d-markup__box" + (selected ? " is-selected" : "")}
          style={{ left: box.left, top: box.top, width: box.w, height: box.h }}
        >
          <span className="d-markup__tag">
            {box.label}
            {box.kind ? <span className="d-markup__tagkind"> · {box.kind}</span> : null}
          </span>
        </div>
      ) : null}

      {/* composer for the selected element */}
      {selected ? (
        <div className="d-markup__pop" style={popStyle()} onClick={(e) => e.stopPropagation()}>
          <div className="d-markup__poptarget">
            <Icon name="target" size={13} />
            <span className="d-markup__poptag">
              {selected.label}
              {selected.kind ? ` · ${selected.kind}` : ""}
            </span>
          </div>
          <textarea
            className="d-markup__ta"
            autoFocus
            value={note}
            placeholder="告诉 Agentaily 这里要怎么改…"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="d-markup__popbtns">
            <button type="button" className="d-markup__cancel" onClick={cancel}>
              取消
            </button>
            <button type="button" className="d-markup__done" disabled={!note.trim()} onClick={send}>
              发送到对话
              <Icon name="arrow" size={13} />
            </button>
          </div>
        </div>
      ) : null}

      {/* top hint pill */}
      <div className="d-markup__pill">
        <span className="d-markup__dot" />
        <span className="d-markup__pilltxt">
          {selected ? "输入修改要求，发送到左侧对话" : "移到要改的地方，点击它再描述修改"}
        </span>
        <span className="d-markup__pillsep" />
        <button
          type="button"
          className="d-markup__pillx"
          onClick={() => onClose && onClose()}
          aria-label="退出"
        >
          <Icon name="x" size={14} />
          <span>退出</span>
        </button>
      </div>
    </div>
  );
}
