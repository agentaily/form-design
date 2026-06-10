// agentLoop.js — Single-turn ReAct loop (SPEC §4). Runs one turn: take user
// input, call the LLM, execute returned tool_use blocks, backfill tool_results,
// repeat until the LLM returns plain text (no tool_use) — the sole stop condition.
//
// All side effects are injected (callLLM, executeTool, render hooks) so the loop
// is pure orchestration and fully testable with a fake LLM.

export const MAX_ITERS = 25; // 防死循环

function stringify(out) {
  if (out == null) return "";
  return typeof out === "string" ? out : JSON.stringify(out);
}

/**
 * @param {object}   o
 * @param {string}   o.userText        merged user input for this turn
 * @param {Array}    o.messages        the LLM message list (mutated: pushed onto)
 * @param {string=}  o.system
 * @param {Array=}   o.tools
 * @param {(args:{system?:string,messages:Array,tools?:Array})=>Promise<{content:Array}>} o.callLLM
 * @param {(name:string,input:any)=>Promise<any>} o.executeTool
 * @param {(content:Array)=>void=} o.onAssistantText  called once on the terminating text
 * @param {()=>void=} o.onPreview     called after each tool batch (rerender canvas)
 * @param {number=}  o.maxIters
 * @returns {Promise<{ stopped: 'text'|'max_iters', iters: number }>}
 */
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
}) {
  messages.push({ role: "user", content: userText });

  for (let i = 0; i < maxIters; i++) {
    // 1) call the LLM
    const res = await callLLM({ system, messages, tools });
    messages.push({ role: "assistant", content: res.content });

    // 2) collect tool_use blocks
    const toolUses = res.content.filter((b) => b.type === "tool_use");

    // 3) stop condition: no tool calls → emit text, end the turn
    if (toolUses.length === 0) {
      onAssistantText?.(res.content);
      return { stopped: "text", iters: i + 1 };
    }

    // 4) execute each tool; a failure is backfilled as is_error so the Agent self-heals
    const results = [];
    for (const tu of toolUses) {
      try {
        const out = await executeTool(tu.name, tu.input);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: stringify(out) });
      } catch (e) {
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: String(e?.message || e),
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
