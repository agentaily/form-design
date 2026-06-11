import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { importConfigKey } from "./crypto";
import {
  ConfigValidationError,
  getMaskedConfig,
  getOwnerConfig,
  saveConfig,
  type OwnerConfigInput,
} from "./config";
import {
  DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  DeepSeekNotConfiguredError,
  parseChatRequest,
  type ChatRequest,
} from "./chat";
import { testDeepSeek, testFeishu, type ConnProbe, type ConnTestResult } from "./conntest";
import { getFeishuTenantToken, FeishuTokenError } from "./feishu";
import {
  answersToFields,
  parseSubmitRequest,
  writeToBitable,
  BitableWriteError,
  FeishuNotConfiguredError,
  type SubmitRequest,
} from "./submit";

/** Worker bindings (see wrangler.toml + vitest.config.ts). */
interface Env {
  /** D1 binding for the owner_config table. */
  DB: D1Database;
  /** base64 256-bit AES-GCM master key (Worker secret in prod). */
  CONFIG_KEY: string;
}

// Agentaily Forms backend. Routes get added per feature (owner config, LLM
// proxy, Feishu submit). For now: health + owner config (SPEC.md §12).
const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, service: "form-design-api" }));

// POST /api/config — validate + persist the owner config, echo the masked view.
app.post("/api/config", async (c) => {
  let input: OwnerConfigInput;
  try {
    input = (await c.req.json()) as OwnerConfigInput;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof input !== "object" || input === null) {
    return c.json({ error: "body must be a JSON object" }, 400);
  }
  const key = await importConfigKey(c.env.CONFIG_KEY);
  try {
    await saveConfig(c.env.DB, key, input);
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      // Missing / invalid required field → 400, nothing written.
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
  const masked = await getMaskedConfig(c.env.DB, key);
  return c.json(masked, 200);
});

// GET /api/config — read the masked config (all-null skeleton when never set).
app.get("/api/config", async (c) => {
  const key = await importConfigKey(c.env.CONFIG_KEY);
  const masked = await getMaskedConfig(c.env.DB, key);
  return c.json(masked, 200);
});

// POST /api/chat — LLM proxy: decrypt owner DeepSeek key, forward to upstream
// /chat/completions with stream:true, and stream the SSE response through
// untouched. The owner key only ever rides the upstream Authorization header —
// it never appears in any response to the client. See SPEC.md §13.
app.post("/api/chat", async (c) => {
  // 1) Parse + validate the request body. Non-JSON / missing messages → 400,
  //    nothing forwarded upstream.
  let request: ChatRequest;
  try {
    const raw = await c.req.json();
    request = parseChatRequest(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid JSON body";
    // A JSON parse failure surfaces as a SyntaxError; map it to the spec's wording.
    const error = err instanceof SyntaxError ? "invalid JSON body" : message;
    return c.json({ error }, 400);
  }

  // 2) Read + decrypt the owner config (plaintext, in-Worker view only).
  const key = await importConfigKey(c.env.CONFIG_KEY);
  const owner = await getOwnerConfig(c.env.DB, key);

  // 3) No DeepSeek configured → 409, never touch upstream.
  try {
    if (owner.deepseek === null) {
      throw new DeepSeekNotConfiguredError();
    }
  } catch (err) {
    if (err instanceof DeepSeekNotConfiguredError) {
      return c.json({ error: err.message }, 409);
    }
    throw err;
  }
  const deepseek = owner.deepseek;

  // 4) Forward to upstream with the owner key, forcing stream:true. `messages` /
  //    `tools` pass through untouched; `model` falls back to the default.
  let upstream: Response;
  try {
    upstream = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deepseek.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: deepseek.model || DEFAULT_DEEPSEEK_MODEL,
        messages: request.messages,
        ...(request.tools !== undefined ? { tools: request.tools } : {}),
        stream: true,
      }),
    });
  } catch {
    // Upstream unreachable (network error / timeout) → 502, no key leakage.
    return c.json({ error: "上游 DeepSeek 不可达" }, 502);
  }

  // 5) Upstream error → recognizable JSON error, normalized to 502 for 5xx and
  //    passing the upstream status through for 4xx. The owner key is never echoed.
  if (!upstream.ok) {
    // upstream.status is a runtime number outside Hono's literal status union,
    // so we annotate it as a ContentfulStatusCode (all our codes carry a body).
    const status = (upstream.status >= 500 ? 502 : upstream.status) as ContentfulStatusCode;
    return c.json({ error: `上游 DeepSeek 返回错误（${upstream.status}）` }, status);
  }

  // 6) Success → stream the upstream SSE bytes through unchanged (no buffering,
  //    no rewriting). Content-Type is forced to text/event-stream.
  return new Response(upstream.body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
});

// POST /api/config/test — probe whether the SAVED owner config can connect.
// Reads + decrypts the stored config (credentials are NOT taken from the request
// body), then probes DeepSeek and Feishu INDEPENDENTLY: an unconfigured block is
// reported as ok:false "未配置" without touching its upstream, and one probe's
// failure never blocks the other. HTTP is always 200 — "can't connect" is a
// normal result, not an HTTP error. The owner key / app_secret never appear in
// any message, header, or body. See SPEC.md §14.
app.post("/api/config/test", async (c) => {
  const key = await importConfigKey(c.env.CONFIG_KEY);
  const owner = await getOwnerConfig(c.env.DB, key);

  // DeepSeek: unconfigured → "未配置" (no upstream call); otherwise probe.
  const deepseek: ConnProbe =
    owner.deepseek === null
      ? { ok: false, message: "未配置" }
      : await testDeepSeek(owner.deepseek.apiKey);

  // Feishu: independent of DeepSeek's outcome. Unconfigured → "未配置" (no
  // upstream call); otherwise probe with the saved app_id + app_secret.
  const feishu: ConnProbe =
    owner.feishu === null
      ? { ok: false, message: "未配置" }
      : await testFeishu(owner.feishu.appId, owner.feishu.appSecret);

  const result: ConnTestResult = { deepseek, feishu };
  return c.json(result, 200);
});

// POST /api/submit — write one answerer's submission into the owner's Feishu
// Bitable. Reads the owner's SAVED Feishu creds (never from the request body),
// exchanges them for a tenant_access_token, then writes one record. The owner's
// app_secret / tenant_access_token stay in-Worker and never appear in any
// response, header, or log. See SPEC.md §15.
app.post("/api/submit", async (c) => {
  // 1) Parse + validate the request body. Non-JSON / missing / empty / mis-shaped
  //    answers → 400, nothing forwarded upstream.
  let request: SubmitRequest;
  try {
    const raw = await c.req.json();
    request = parseSubmitRequest(raw);
  } catch (err) {
    const error = err instanceof SyntaxError ? "invalid JSON body" : "answers is required";
    return c.json({ error }, 400);
  }

  // 2) Read + decrypt the owner config (plaintext, in-Worker view only).
  const key = await importConfigKey(c.env.CONFIG_KEY);
  const owner = await getOwnerConfig(c.env.DB, key);

  // 3) No Feishu configured → 409, never touch upstream.
  try {
    if (owner.feishu === null) {
      throw new FeishuNotConfiguredError();
    }
  } catch (err) {
    if (err instanceof FeishuNotConfiguredError) {
      return c.json({ error: err.message }, 409);
    }
    throw err;
  }
  const feishu = owner.feishu;

  // 4) Exchange the owner's saved app_id/app_secret for a tenant_access_token.
  //    The plaintext app_secret rides ONLY this request body (§15.7); any failure
  //    surfaces as 502 with no credential in the error.
  let token: string;
  try {
    token = await getFeishuTenantToken(feishu.appId, feishu.appSecret);
  } catch (err) {
    if (err instanceof FeishuTokenError) {
      return c.json({ error: err.message }, 502);
    }
    throw err;
  }

  // 5) Map answers → Feishu fields and write one record. The tenant_access_token
  //    rides ONLY the add-record Authorization header (§15.7); any failure
  //    surfaces as 502 with neither token nor secret in the error.
  const fields = answersToFields(request.answers);
  let recordId: string;
  try {
    ({ recordId } = await writeToBitable(token, feishu.appToken, feishu.tableId, fields));
  } catch (err) {
    if (err instanceof BitableWriteError) {
      return c.json({ error: err.message }, 502);
    }
    throw err;
  }

  // 6) Success → only ok + recordId; never the written fields, token, or creds.
  return c.json({ ok: true, recordId }, 200);
});

export default app;
