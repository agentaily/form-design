---
"agentaily-forms": minor
---

前端接入后端(第 1+2 步):新增 API client 层(`core/apiClient` + `core/sse`,fetch 封装 + `VITE_API_BASE` + Bearer token + SSE 流解析),并把对话设计器接到真后端 `POST /api/chat`——用 DeepSeek 流式(OpenAI 协议)替换写死脚本,客户端跑单回合 ReAct(`core/designerLoop`,自愈 + 安全阀)并就地执行 UI 字段模型工具(`core/designerTools`:set_meta / add / update / remove / duplicate / reorder),结果实时渲染到预览。对话引擎对测试可注入。
