// designerLoop.ts — single-turn ReAct loop in OpenAI-native message shape
// (SPEC §4), the designer counterpart to core/agentLoop. The backend /api/chat
// proxies DeepSeek's OpenAI-compatible API, so messages/tool-calls stay in that
// wire shape end-to-end (no Anthropic↔OpenAI conversion). All side effects are
// injected (callChat streams one LLM turn; executeTool mutates the form model;
// onToolStart/onToolEnd/onPreview drive the UI), so the loop is pure orchestration.

import type { RawToolCall } from "./openaiStream";

export const MAX_ITERS = 25; // 防死循环

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/** Runs (and streams) exactly one LLM turn; returns the assembled text + tool calls. */
export type CallChat = (args: { messages: ChatMessage[] }) => Promise<{
  text: string;
  toolCalls: RawToolCall[];
}>;

/** A tool call surfaced to the UI: raw + parsed input + (on end) error flag. */
export interface ToolEvent {
  id: string;
  name: string;
  input: Record<string, unknown>;
  error?: boolean;
}

export interface RunDesignerTurnOptions {
  /** LLM message history (mutated: assistant + tool turns are pushed onto it). */
  messages: ChatMessage[];
  callChat: CallChat;
  executeTool: (name: string, input: Record<string, unknown>) => unknown | Promise<unknown>;
  onToolStart?: (ev: ToolEvent) => void;
  onToolEnd?: (ev: ToolEvent, result: string) => void;
  /** Called once after each tool batch, to rerender the preview. */
  onPreview?: () => void;
  maxIters?: number;
}

export interface TurnResult {
  stopped: "text" | "max_iters";
  iters: number;
}

function stringify(out: unknown): string {
  if (out == null) return "";
  return typeof out === "string" ? out : JSON.stringify(out);
}

export async function runDesignerTurn({
  messages,
  callChat,
  executeTool,
  onToolStart,
  onToolEnd,
  onPreview,
  maxIters = MAX_ITERS,
}: RunDesignerTurnOptions): Promise<TurnResult> {
  for (let i = 0; i < maxIters; i++) {
    // 1) stream one LLM turn
    const { text, toolCalls } = await callChat({ messages });

    // 2) record the assistant turn in OpenAI shape (content null when tool-only)
    messages.push({
      role: "assistant",
      content: text || null,
      ...(toolCalls.length
        ? {
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.argsRaw || "" },
            })),
          }
        : {}),
    });

    // 3) stop condition: no tool calls → the turn's prose is the final answer
    if (toolCalls.length === 0) return { stopped: "text", iters: i + 1 };

    // 4) execute each tool; failures backfill as error results so the model self-heals
    for (const tc of toolCalls) {
      let input: Record<string, unknown> = {};
      let parseError: string | null = null;
      try {
        input = tc.argsRaw ? JSON.parse(tc.argsRaw) : {};
      } catch (e) {
        parseError = `invalid tool arguments: ${(e as Error).message}`;
      }
      const ev: ToolEvent = { id: tc.id, name: tc.name, input };
      onToolStart?.(ev);

      let result: string;
      if (parseError) {
        result = parseError;
        ev.error = true;
      } else {
        try {
          result = stringify(await executeTool(tc.name, input));
        } catch (e) {
          result = String((e as Error)?.message || e);
          ev.error = true;
        }
      }
      onToolEnd?.(ev, result);
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }

    // 5) rerender after the batch
    onPreview?.();
  }

  return { stopped: "max_iters", iters: maxIters };
}
