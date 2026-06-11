import { Hono } from "hono";

// Agentaily Forms backend. Routes get added per feature (owner config, LLM
// proxy, Feishu submit). For now just a health check so the stack stands up.
const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, service: "form-design-api" }));

export default app;
