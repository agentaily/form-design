// share-dialog.jsx — 发布 / 分享浮层（仅链接版，无二维码）。设计源 N-_ayo8x。
//
// 取代旧的 <PublishFeedback> 浮层：发布不再是「打开浮层 → 浮层里再点发布」的两步，而是
// 顶栏「发布」直接上线（见 App.jsx 的 doPublish），成功后弹本浮层。两个入口（mode）：
//   "publish" → 表单刚上线（庆祝式标题「表单已发布」），由「发布」直接动作打开。
//   "share"   → 已发布表单事后再取链接（标题「分享这份表单」），只读、不改状态、不发消息。
// 内容：公开填写链接 + 行内复制按钮（点击显示「已复制 ✓」，2s 复位，不关闭浮层；
// clipboard 不可用时回退 execCommand）。
//
// 全部 chrome 取自 @agentaily/design-system（Dialog/Button）+ 统一 Icon —— 不手搓。
// 注意：DS Dialog 没有 className prop，自定义样式挂在内层 .d-share 容器上。
import React, { useState, useEffect, useRef } from "react";
import { Dialog, Button } from "@agentaily/design-system";
import { Icon } from "./chat.jsx";

// 把展示用链接（可能是相对的 /f/:slug）补成可分享的绝对地址再复制：已是 http(s) 的原样，
// 否则拼上当前源。展示仍用传入的 url 原文（测试据此断言 /f/:slug）。
function toAbsolute(url) {
  const u = url || "";
  if (/^https?:\/\//i.test(u)) return u;
  const origin = typeof window !== "undefined" && window.location ? window.location.origin : "";
  return origin + u;
}

/**
 * 发布 / 分享浮层（纯展示，状态由 App 持有）。
 *
 * @param {object}   props
 * @param {boolean}  props.open               是否展示（关闭时不渲染）
 * @param {"publish"|"share"} props.mode       入口：刚发布（庆祝）/ 事后分享（只读）
 * @param {string}   props.url                展示用公开填写链接（如 /f/:slug 或绝对地址）
 * @param {() => void} props.onClose          关闭浮层
 */
export function ShareDialog({ open, mode, url, onClose }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);

  // 关闭时复位「已复制」反馈，并清掉挂起的复位定时器。
  useEffect(() => {
    if (!open) {
      setCopied(false);
      if (timerRef.current) clearTimeout(timerRef.current);
    }
  }, [open]);
  // 卸载时清定时器，避免对已卸载组件 setState。
  useEffect(() => () => timerRef.current && clearTimeout(timerRef.current), []);

  const copy = async () => {
    const full = toAbsolute(url);
    try {
      await navigator.clipboard.writeText(full);
    } catch {
      // clipboard 不可用（非安全上下文 / 被拒）→ 回退到隐藏 textarea + execCommand。
      try {
        const ta = document.createElement("textarea");
        ta.value = full;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        /* 连 execCommand 也不行就放弃——链接仍可见、可手动复制 */
      }
    }
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  if (!open) return null;

  const isPub = mode === "publish";
  const title = isPub ? "表单已发布" : "分享这份表单";
  const note = isPub
    ? "已上线收集，并存入「我的表单」——在那里看提交、关闭收集或继续编辑。把链接发出去，任何人打开即可填写。"
    : "任何拿到链接的人都可以填写。提交将实时进入你连接的飞书多维表格。";

  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <Button
          variant="primary"
          icon={<Icon name={copied ? "check" : "copy"} size={14} />}
          onClick={copy}
        >
          {copied ? "已复制" : "复制链接"}
        </Button>
      }
    >
      <div className="d-share">
        <div className="ax-label">公开填写链接</div>
        <a className="d-share__url" href={url} target="_blank" rel="noreferrer">
          {url}
        </a>
        <p className="d-share__note">{note}</p>
      </div>
    </Dialog>
  );
}
