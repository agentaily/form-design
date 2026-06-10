// queue.js — Continuous send: FIFO message queue + single-consumer pump +
// batch merge (SPEC §4.1). Decouples user input from agent execution so the
// user can keep typing while a turn is running.

const MIDWORK_NOTE =
  "以下消息是你处理上一轮时陆续输入的，请按顺序一并处理，而不是当作对上一条输出的回应";

let _uid = 0;
const uid = () => `q_${(++_uid).toString(36)}`;

/**
 * Merge a batch of queued messages into a single agent input.
 * - 1 message → its text verbatim.
 * - N messages → a numbered list.
 * - If any were typed while the consumer was busy, wrap in a <context> tag so
 *   the model treats them as mid-work input, not a reply to its last output.
 */
export function mergeBatch(batch) {
  const typedWhileBusy = batch.some((m) => m.typedWhileBusy);
  const body =
    batch.length === 1
      ? batch[0].text
      : batch.map((m, i) => `${i + 1}. ${m.text}`).join("\n");
  if (!typedWhileBusy) return body;
  return `<context note="${MIDWORK_NOTE}">\n${body}\n</context>`;
}

/**
 * Single-consumer message queue. `runTurn(mergedText)` is injected — it runs one
 * full agent turn (ReAct until no tool_use). Connect-send N times → exactly one
 * consumer loop; extras queue and are atomically batched at the flush point.
 */
export class MessageQueue {
  /** @param {(merged: string) => Promise<any>} runTurn */
  constructor(runTurn) {
    this.queue = [];
    this.running = false;
    this.runTurn = runTurn;
    this.onChange = null; // optional UI hook (renderQueue)
  }

  _emit() {
    if (this.onChange) this.onChange(this.queue.slice());
  }

  /** Enqueue a user message and kick the pump. Returns the queue item. */
  enqueue(text) {
    const item = { id: uid(), text, ts: Date.now(), status: "pending", typedWhileBusy: this.running };
    this.queue.push(item);
    this._emit();
    this.pump();
    return item;
  }

  /** Cancel a still-pending (not yet consumed) message. */
  cancel(id) {
    const i = this.queue.findIndex((m) => m.id === id && m.status === "pending");
    if (i < 0) return false;
    this.queue.splice(i, 1);
    this._emit();
    return true;
  }

  pending() {
    return this.queue.filter((m) => m.status === "pending");
  }

  /** Idempotent: if a consumer loop is already running, returns immediately. */
  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.queue.length); // atomic flush
        batch.forEach((m) => (m.status = "running"));
        this._emit();
        await this.runTurn(mergeBatch(batch));
      }
    } finally {
      this.running = false;
      this._emit();
    }
  }
}
