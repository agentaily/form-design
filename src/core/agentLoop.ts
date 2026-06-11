// agentLoop.ts — Single-turn ReAct loop (SPEC §4). Runs one turn: take user
// input, call the LLM, execute returned tool_use blocks, backfill tool_results,
// repeat until the LLM returns plain text (no tool_use) — the sole stop condition.
//
// All side effects are injected (callLLM, executeTool, render hooks) so the loop
// is pure orchestration and fully testable with a fake LLM.

import type { ToolDef } from "./tools";

export const MAX_ITERS = 25; // 防死循环

export interface TextBlock {
  type: "text";
  text: string;
}
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: any;
}
export type ContentBlock = TextBlock | ToolUseBlock | { type: string; [k: string]: any };

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface Message {
  role: "user" | "assistant";
  content: string | unknown[];
}

export interface LLMResponse {
  content: ContentBlock[];
}

export type CallLLM = (args: {
  system?: string;
  messages: Message[];
  tools?: ToolDef[];
}) => Promise<LLMResponse>;

export interface RunAgentTurnOptions {
  /** Merged user input for this turn. */
  userText: string;
  /** The LLM message list (mutated: turns are pushed onto it). */
  messages: Message[];
  system?: string;
  tools?: ToolDef[];
  callLLM: CallLLM;
  executeTool: (name: string, input: any) => Promise<unknown>;
  /** Called once on the terminating text response. */
  onAssistantText?: (content: ContentBlock[]) => void;
  /** Called after each tool batch (rerender the canvas). */
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

export async function runAgentTurn({
  userText,
  messages,
  system,
  tools,
  callLLM,
  executeTool,
  onAssistantText,
  onPreview,
  maxIters = MAX_ITERS,
}: RunAgentTurnOptions): Promise<TurnResult> {
  messages.push({ role: "user", content: userText });

  for (let i = 0; i < maxIters; i++) {
    // 1) call the LLM
    const res = await callLLM({ system, messages, tools });
    messages.push({ role: "assistant", content: res.content });

    // 2) collect tool_use blocks
    const toolUses = res.content.filter((b) => b.type === "tool_use") as ToolUseBlock[];

    // 3) stop condition: no tool calls → emit text, end the turn
    if (toolUses.length === 0) {
      onAssistantText?.(res.content);
      return { stopped: "text", iters: i + 1 };
    }

    // 4) execute each tool; a failure is backfilled as is_error so the Agent self-heals
    const results: ToolResultBlock[] = [];
    for (const tu of toolUses) {
      try {
        const out = await executeTool(tu.name, tu.input);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: stringify(out) });
      } catch (e) {
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: String((e as Error)?.message || e),
          is_error: true,
        });
      }
    }

    // 5) backfill results, rerender the canvas
    messages.push({ role: "user", content: results });
    onPreview?.();
  }

  // safety valve tripped
  return { stopped: "max_iters", iters: maxIters };
}
