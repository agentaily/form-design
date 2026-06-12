// email.ts — type contracts for transactional email（走 Resend 纯 HTTP API，无 SDK）.
// See SPEC.md §22 (发信) / §23 (邮箱验证) / §24 (找回密码).
//
// 发信抽象：一个薄的 `sendEmail`（POST https://api.resend.com/emails，读 RESEND_API_KEY /
// EMAIL_FROM）+ 两个模板构造函数（verify 链接邮件、reset 链接邮件，入参含落地页 URL）。
//
// 安全核心（§22.3）：
//   - RESEND_API_KEY 只在 Worker 内用于拼 `Authorization: Bearer <key>` 发往 Resend，
//     **绝不**写进任何响应体、HTTP 头、日志、或抛出的错误信息。
//   - 邮件链接里的 token 是高熵一次性串（tokens.ts），但模板本身不持有 / 不打印 key。
//
// best-effort 解耦（§22.2 / §23.2）：
//   - 注册成功后异步发验证邮件，发信失败**不**让注册失败 —— 调用方据 sendEmail 抛错决定是否吞。
//   - sendEmail 失败抛**可识别错误** {@link EmailSendError}，让调用方分流（注册吞、其它可上报）。
//
// Layering（测试 seam）：
//   - 纯函数(inner-loop 单测目标，network-free)：buildVerifyEmail / buildResetEmail
//     —— 给定落地页 URL → { subject, html }（断言链接拼接 / 文案，不外呼）。
//   - 外呼(outer-loop seam，mock fetch / Resend)：sendEmail —— 真打 Resend HTTP API。

// ---------------------------------------------------------------------------
// 约定常量
// ---------------------------------------------------------------------------

/** Resend 发信端点（§22.1）。Worker 直接 POST 此 URL，无 SDK。 */
export const RESEND_API_URL = "https://api.resend.com/emails";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 发信所需的 Worker env 切片（§22.3）。RESEND_API_KEY 是 secret，只在 Worker 内用。 */
export interface EmailEnv {
  /** Resend API key（Worker secret）；只用于 `Authorization: Bearer`，绝不出网 / 进日志（§22.3）。 */
  RESEND_API_KEY: string;
  /** 发件人，形如 `Agentaily Forms <noreply@mail.agentaily.com>`（已验证发件域，§22.1）。 */
  EMAIL_FROM: string;
}

/** 一封邮件的内容（{@link buildVerifyEmail} / {@link buildResetEmail} 的产物）。 */
export interface EmailContent {
  /** 邮件主题。 */
  subject: string;
  /** 邮件正文 HTML（含落地页链接）。 */
  html: string;
}

/** {@link sendEmail} 的入参：收件人 + 内容（内容通常来自模板构造函数）。 */
export interface SendEmailInput {
  /** 收件人邮箱。 */
  to: string;
  /** 邮件主题。 */
  subject: string;
  /** 邮件正文 HTML。 */
  html: string;
}

/**
 * 发信失败的可识别错误（§22.2）。供调用方分流：注册的验证邮件**吞掉**它（best-effort，
 * 不让注册失败，§23.2）；找回密码的 request 端点亦吞（仍回 200 防枚举，§24.1）。
 * **绝不**把 RESEND_API_KEY / 收件人明文携带进 message（§22.3）。
 */
export class EmailSendError extends Error {
  constructor(message = "email send failed") {
    super(message);
    this.name = "EmailSendError";
  }
}

// ---------------------------------------------------------------------------
// 发信（outer-loop seam；实现留给 implementer）
// ---------------------------------------------------------------------------

/**
 * 发一封事务邮件（走 Resend HTTP API，§22.1）。
 *
 * 契约（实现在合约内）：
 * - `fetch(RESEND_API_URL, { method: 'POST', headers: { Authorization: 'Bearer '+env.RESEND_API_KEY,
 *   'content-type': 'application/json' }, body: { from: env.EMAIL_FROM, to, subject, html } })`。
 * - 上游 2xx → resolve（无返回值即视为已投递给 Resend）。
 * - 上游非 2xx / 网络失败 → 抛 {@link EmailSendError}（**不**携带 key / 上游原始体里的敏感物）。
 * - **安全（§22.3）：** RESEND_API_KEY 只进 `Authorization` 头，绝不写进返回 / 抛出的 message /
 *   日志 / 任何响应体；本函数不回显收件人之外的任何凭据。
 *
 * 调用方语义：注册的验证邮件与找回密码 request 端点**吞**本错误（best-effort + 防枚举，
 * §23.2 / §24.1）；其它场景可按需上报。本函数本身只负责「发或抛」，不决定是否吞。
 *
 * @param env 含 {@link EmailEnv} 的 Worker env（实践中是 index.ts 的 Env，超集兼容）。
 * @param input 收件人 + 主题 + HTML。
 * @throws {@link EmailSendError} 上游非 2xx / 网络失败。
 */
export async function sendEmail(env: EmailEnv, input: SendEmailInput): Promise<void> {
  // RESEND_API_KEY 只进 Authorization 头，绝不写进返回 / 抛出的 message / 日志（§22.3）。
  let res: Response;
  try {
    res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: input.to,
        subject: input.subject,
        html: input.html,
      }),
    });
  } catch {
    // 网络失败 → 可识别错误，**不**携带 key / 上游原始体里的敏感物（§22.2 / §22.3）。
    throw new EmailSendError();
  }
  // 上游非 2xx → 抛 EmailSendError。绝不把上游响应体 / key 带进 message。
  if (!res.ok) {
    throw new EmailSendError();
  }
}

// ---------------------------------------------------------------------------
// 模板构造函数（inner-loop 单测目标；实现留给 implementer）
// ---------------------------------------------------------------------------

/**
 * 构造「邮箱验证」邮件内容（§23.3）。纯函数：给定确认落地页 URL → `{ subject, html }`。
 *
 * 契约（实现在合约内）：
 * - 入参 `confirmUrl` 是后端拼好的完整确认链接（形如
 *   `${APP_BASE_URL}/.../verify-email/confirm?token=<明文>` 或直接指向后端 confirm 端点，
 *   由 §23.3 调用方拼好传入；本函数不拼 token、不读 env）。
 * - 文案表「点此验证你的邮箱」，正文含一个指向 `confirmUrl` 的可点击链接；语气与品牌一致
 *   （Agentaily Forms）。`subject` 简短可读（如「验证你的 Agentaily Forms 邮箱」）。
 * - **不**在正文打印任何 secret；token 只藏在 `confirmUrl` 里（它本身就是一次性凭据）。
 *
 * @param confirmUrl 完整的验证确认链接（含一次性 token）。
 * @returns `{ subject, html }`，交给 {@link sendEmail}。
 */
export function buildVerifyEmail(confirmUrl: string): EmailContent {
  // confirmUrl 已由调用方（§23.3）用 APP_BASE_URL 拼好（含一次性 token）；本函数不读 env、
  // 不拼 token、不打印任何别的 secret（§22.3）。HTML 转义 URL 防属性注入。
  const href = escapeHtmlAttr(confirmUrl);
  const subject = "验证你的 Agentaily Forms 邮箱";
  const html = renderEmail({
    heading: "验证你的邮箱",
    body: "感谢注册 Agentaily Forms。请点击下面的按钮验证你的邮箱，锁定这个邮箱归你所有：",
    ctaLabel: "点此验证邮箱",
    href,
    footer: "如果不是你本人操作，可以忽略这封邮件。",
  });
  return { subject, html };
}

/**
 * 构造「找回密码」邮件内容（§24.2）。纯函数：给定前端重置页 URL → `{ subject, html }`。
 *
 * 契约（实现在合约内）：
 * - 入参 `resetUrl` 是后端拼好的完整重置链接，形如 `${APP_BASE_URL}/reset-password?token=<明文>`
 *   （由 §24.2 调用方拼好传入；本函数不拼 token、不读 env）。
 * - 文案表「你（或他人）发起了找回密码，点此设置新密码；若非本人操作可忽略」；正文含一个
 *   指向 `resetUrl` 的可点击链接，并点明链接有效期短（§24.4，1h）。`subject` 如「重置你的
 *   Agentaily Forms 密码」。
 * - **不**在正文打印任何 secret；token 只藏在 `resetUrl` 里。
 *
 * @param resetUrl 完整的重置密码链接（指向前端 /reset-password?token=...，含一次性 token）。
 * @returns `{ subject, html }`，交给 {@link sendEmail}。
 */
export function buildResetEmail(resetUrl: string): EmailContent {
  // resetUrl 已由调用方（§24.2）用 APP_BASE_URL 拼好（前端 /reset-password?token=...）；
  // 正文点明窗口短（1 小时，§24.4）。本函数不读 env、不打印任何别的 secret（§22.3）。
  const href = escapeHtmlAttr(resetUrl);
  const subject = "重置你的 Agentaily Forms 密码";
  const html = renderEmail({
    heading: "重置你的密码",
    body: "你（或他人）为这个邮箱发起了找回密码。点击下面的按钮设置新密码，链接 1 小时内有效：",
    ctaLabel: "点此设置新密码",
    href,
    footer: "如果不是你本人操作，可以忽略这封邮件，你的密码不会被更改。",
  });
  return { subject, html };
}

// ---------------------------------------------------------------------------
// HTML 渲染辅助（纯函数，不读 env / 不打印 secret，§22.3）
// ---------------------------------------------------------------------------

/** 把品牌化的事务邮件渲染成一段简洁的 HTML（含一个可点击的 CTA 链接）。 */
function renderEmail(parts: {
  heading: string;
  body: string;
  ctaLabel: string;
  href: string;
  footer: string;
}): string {
  return [
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;max-width:480px;margin:0 auto;padding:24px">`,
    `<p style="font-size:13px;color:#888;margin:0 0 16px;letter-spacing:.04em">AGENTAILY FORMS</p>`,
    `<h1 style="font-size:20px;margin:0 0 12px">${escapeHtmlText(parts.heading)}</h1>`,
    `<p style="font-size:14px;line-height:1.6;margin:0 0 24px">${escapeHtmlText(parts.body)}</p>`,
    `<p style="margin:0 0 24px"><a href="${parts.href}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;font-size:14px;padding:12px 20px;border-radius:8px">${escapeHtmlText(parts.ctaLabel)}</a></p>`,
    `<p style="font-size:13px;line-height:1.6;color:#888;margin:0 0 8px">如果按钮无法点击，请复制以下链接到浏览器打开：</p>`,
    `<p style="font-size:13px;word-break:break-all;margin:0 0 24px"><a href="${parts.href}" style="color:#555">${escapeHtmlText(parts.href)}</a></p>`,
    `<p style="font-size:13px;color:#888;margin:0">${escapeHtmlText(parts.footer)}</p>`,
    `</div>`,
  ].join("");
}

/** HTML 属性值转义（防 href 注入）。 */
function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** HTML 文本节点转义。 */
function escapeHtmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
