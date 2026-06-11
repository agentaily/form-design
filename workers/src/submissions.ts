// submissions.ts — type contracts for the data backend `GET /api/forms/:slug/submissions`.
// See SPEC.md §18 (后端 · 数据后台 · 提交列表).
//
// owner 登录后（§17，owner-only），在数据后台按 slug 拉取这份表单已收集到的提交列表——
// 从 owner 自己的飞书多维表格里 GET 记录（复用 §15 的凭据解密 + 换 token 路径，区别只在
// 从「写一条记录」换成「读记录列表」）。owner 的 app_secret / tenant_access_token 全程
// 留在 Worker 内、永不出网（§18.6，与 §15.7 同源）。
//
// route 流程（index.ts，§18.1）：requireAuth → formExists(404) → getOwnerConfig
// → 未配飞书(409) → getFeishuTenantToken → listSubmissions → 200 { submissions, count }。
//
// Layering: `listSubmissions` 是 inner-loop unit-test target 与 outer-loop seam——
// 它只做一次上游调用（GET 记录列表），返回映射后的提交数组或抛可辨识错误。route 在
// 其上编排，由 outer-loop 通过 SELF.fetch + 一个 mock 掉的 open.feishu.cn 驱动。

import { FEISHU_BITABLE_RECORDS_URL } from "./submit";
import { FEISHU_OK_CODE } from "./feishu";

// 复用 §15 写记录的同一 URL 模板（submit.ts 已导出）：读记录是对它的 `GET`、无 body（§18.3）。
// 这里 re-export 以便本模块的实现与测试就近引用，不重复字面量。
export { FEISHU_BITABLE_RECORDS_URL };

/**
 * 数据后台对外投影的一条提交（§18.2）。从上游飞书记录 `data.items[i]` 映射而来：
 * `recordId` ← `record_id`，`fields` ← `fields`（原样投影），`createdTime` ← `created_time`
 * （可选，上游无则省略）。**只**含提交数据本身，绝不含任何 owner 凭据 / `owner_id`（§18.6）。
 */
export interface Submission {
  /** 上游 record_id。 */
  recordId: string;
  /** 上游记录的 fields（列名 → 值），原样投影；多值列为数组。 */
  fields: Record<string, unknown>;
  /** 可选：上游 created_time（毫秒时间戳），无则省略。 */
  createdTime?: number;
}

/**
 * `GET /api/forms/:slug/submissions` 的成功响应（§18.2）。
 *
 * - `submissions`：上游 `data.items` 映射成的 {@link Submission}[]；空表 → `[]`（正常态）。
 * - `count`：`submissions.length`（本期不分页，等于这一批的条数；将来分页可换成上游 `total`）。
 *
 * 响应里**绝不**含 owner 凭据（DeepSeek key / app_secret / app_token / table_id）、
 * `tenant_access_token`、或 `owner_id`（§18.6）。
 */
export interface SubmissionsResult {
  submissions: Submission[];
  count: number;
}

/**
 * 非成功分支的统一错误体（§18.5）。`error` **绝不**含 `app_secret` /
 * `tenant_access_token` 或其片段；可携带飞书 `code` / HTTP 状态这类非敏感摘要（§18.6）。
 */
export interface SubmissionsErrorBody {
  error: string;
}

/**
 * 读飞书多维表格记录列表失败时抛出——上游非 2xx、body `code !== 0`、body 不可解析、
 * 或上游不可达。route 把它映射成 `502 { error }`（§18.5）。
 *
 * `message` **绝不**含 `tenant_access_token` 或 owner 的 `app_secret`；可带非敏感的
 * 上游 `code` / HTTP 状态作排障提示（§18.6，与 §15.7 同源）。
 */
export class BitableReadError extends Error {
  constructor(message = "飞书读取记录失败") {
    super(message);
    this.name = "BitableReadError";
  }
}

/**
 * 读 owner 飞书多维表格的记录列表（§18.3）。
 *
 * - 对 {@link FEISHU_BITABLE_RECORDS_URL}（`{app_token}` / `{table_id}` 填充后）发 `GET`，
 *   带 `Authorization: Bearer <token>`，无 body。
 * - 成功要求上游 `2xx` 且 body `code === 0`（FEISHU_OK_CODE，飞书 200 也可能带非 0 业务码，
 *   §18.3）；把 `data.items` 每项映射成 {@link Submission}（`record_id` → `recordId`，
 *   `fields` → `fields`，`created_time` → `createdTime?`）。空 `items` → `[]`。
 * - 非 2xx / `code !== 0` / 不可解析 body / 上游不可达 → 抛 {@link BitableReadError}
 *   （route → `502 { error }`）。抛出的 `message` **绝不**含 `token`（§18.6）。
 * - 分页从简（§18.4）：MVP 一次性拉 / 只拉一页，是否带 `page_size` / `page_token` 由实现
 *   在合约内定，但对外契约不暴露分页参数。
 *
 * @param token tenant_access_token（来自 feishu.ts 的 getFeishuTenantToken）。
 * @param appToken owner 的 Bitable app token（来自 getOwnerConfig）。
 * @param tableId owner 的 Bitable table id（来自 getOwnerConfig）。
 * @returns 映射后的提交数组（route 据此组 `{ submissions, count }`）。
 * @throws {@link BitableReadError} when 读取失败。
 */
export async function listSubmissions(
  token: string,
  appToken: string,
  tableId: string,
): Promise<Submission[]> {
  const url = FEISHU_BITABLE_RECORDS_URL.replace("{app_token}", appToken).replace(
    "{table_id}",
    tableId,
  );
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        // The tenant_access_token's ONLY destination (§18.6, same boundary as §15.7).
        Authorization: `Bearer ${token}`,
      },
    });
  } catch {
    // Network error / timeout: the caught error may embed the request (incl. the
    // Authorization header), so NEVER fold it into the message — only a fixed,
    // token-free hint (§18.6).
    throw new BitableReadError("飞书读取记录失败：上游不可达");
  }

  // Feishu's quirk: HTTP 200 may still carry a non-zero business code, so success
  // requires BOTH 2xx AND body code === 0. An unparseable body is a failed read.
  // Only the non-sensitive HTTP status / upstream code may ride the message —
  // never the token or app_secret (§18.6).
  let body: {
    code?: number;
    data?: {
      items?: Array<{
        record_id?: string;
        fields?: Record<string, unknown>;
        created_time?: number;
      }>;
    };
  };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new BitableReadError(`飞书读取记录失败：上游返回 ${res.status}`);
  }

  if (!res.ok || body.code !== FEISHU_OK_CODE) {
    throw new BitableReadError(`飞书读取记录失败：code ${body.code}`);
  }

  // Map upstream data.items[] → Submission[]. Empty / absent items → [].
  const items = body.data?.items ?? [];
  return items.map((item) => ({
    recordId: item.record_id ?? "",
    fields: item.fields ?? {},
    ...(typeof item.created_time === "number" ? { createdTime: item.created_time } : {}),
  }));
}
