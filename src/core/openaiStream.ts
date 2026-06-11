// openaiStream.ts — consume DeepSeek's OpenAI-compatible streaming protocol
// (SPEC §13.3). The /api/chat proxy passes the upstream SSE through verbatim, so
// the wire format here is OpenAI chat-completion chunks: `delta.content` text
// fragments and `delta.tool_calls` fragments (assembled by `index`). The reducer
// (cross-fragment assembly) is pure and unit-tested; the consumer wires it to a
// Response body via streamSSE.

import { streamSSE } from "./sse";

export interface RawToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments string, exactly as streamed — echoed back to the model. */
  argsRaw: string;
}

interface ToolCallAcc {
  id: string;
  name: string;
  args: string;
}

export interface ChatAccumulator {
  text: string;
  toolCalls: ToolCallAcc[];
}

export function emptyAccumulator(): ChatAccumulator {
  return { text: "", toolCalls: [] };
}

/** OpenAI streaming delta shape (only the bits we read). */
export interface ChatDelta {
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

/**
 * Fold one streaming `delta` into the accumulator (mutates + returns it). Text is
 * concatenated; tool calls are assembled by their `index` — `id`/`name` arrive
 * once, `arguments` stream in fragments that are appended.
 */
export function reduceDelta(acc: ChatAccumulator, delta: ChatDelta | undefined): ChatAccumulator {
  if (!delta) return acc;
  if (typeof delta.content === "string") acc.text += delta.content;
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      const slot = (acc.toolCalls[tc.index] ??= { id: "", name: "", args: "" });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name = tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
    }
  }
  return acc;
}

/** Finalize the accumulator into a plain result; drops any empty tool-call slots. */
export function finalizeAccumulator(acc: ChatAccumulator): {
  text: string;
  toolCalls: RawToolCall[];
} {
  const toolCalls = acc.toolCalls
    .filter((tc) => tc && tc.name)
    .map((tc) => ({ id: tc.id, name: tc.name, argsRaw: tc.args }));
  return { text: acc.text, toolCalls };
}

export interface ConsumeOpts {
  /** Called with each text fragment as it streams (for live rendering). */
  onText?: (delta: string) => void;
  signal?: AbortSignal;
}

/**
 * Consume a streaming chat Response into assembled text + tool calls. Parses each
 * SSE `data:` line as an OpenAI chunk, ignores the `[DONE]` sentinel, and tolerates
 * the occasional non-JSON keep-alive line.
 */
export async function consumeChatStream(
  response: Response,
  opts: ConsumeOpts = {},
): Promise<{ text: string; toolCalls: RawToolCall[] }> {
  const acc = emptyAccumulator();
  const body = response.body;
  if (!body) return finalizeAccumulator(acc);

  await streamSSE(
    body,
    (data) => {
      if (data === "[DONE]") return;
      let chunk: { choices?: Array<{ delta?: ChatDelta }> };
      try {
        chunk = JSON.parse(data);
      } catch {
        return; // ignore non-JSON lines (comments / keep-alives)
      }
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) opts.onText?.(delta.content);
      reduceDelta(acc, delta);
    },
    opts.signal,
  );

  return finalizeAccumulator(acc);
}
