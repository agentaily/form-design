// queue.ts — Continuous send: FIFO message queue + single-consumer pump +
// batch merge (SPEC §4.1). Decouples user input from agent execution so the
// user can keep typing while a turn is running.

const MIDWORK_NOTE =
  "以下消息是你处理上一轮时陆续输入的，请按顺序一并处理，而不是当作对上一条输出的回应";

let _uid = 0;
const uid = (): string => `q_${(++_uid).toString(36)}`;

export type QueueStatus = "pending" | "running";

export interface QueueItem {
  id: string;
  text: string;
  ts: number;
  status: QueueStatus;
  typedWhileBusy: boolean;
}

/** A turn runner: takes the merged user input and resolves when the turn ends. */
export type RunTurn = (merged: string) => Promise<unknown>;

/**
 * Merge a batch of queued messages into a single agent input.
 * - 1 message → its text verbatim.
 * - N messages → a numbered list.
 * - If any were typed while the consumer was busy, wrap in a <context> tag so
 *   the model treats them as mid-work input, not a reply to its last output.
 */
export function mergeBatch(batch: Pick<QueueItem, "text" | "typedWhileBusy">[]): string {
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
  queue: QueueItem[] = [];
  running = false;
  runTurn: RunTurn;
  onChange: ((items: QueueItem[]) => void) | null = null; // optional UI hook (renderQueue)

  constructor(runTurn: RunTurn) {
    this.runTurn = runTurn;
  }

  private emit(): void {
    if (this.onChange) this.onChange(this.queue.slice());
  }

  /** Enqueue a user message and kick the pump. Returns the queue item. */
  enqueue(text: string): QueueItem {
    const item: QueueItem = {
      id: uid(),
      text,
      ts: Date.now(),
      status: "pending",
      typedWhileBusy: this.running,
    };
    this.queue.push(item);
    this.emit();
    void this.pump();
    return item;
  }

  /** Cancel a still-pending (not yet consumed) message. */
  cancel(id: string): boolean {
    const i = this.queue.findIndex((m) => m.id === id && m.status === "pending");
    if (i < 0) return false;
    this.queue.splice(i, 1);
    this.emit();
    return true;
  }

  pending(): QueueItem[] {
    return this.queue.filter((m) => m.status === "pending");
  }

  /** Idempotent: if a consumer loop is already running, returns immediately. */
  async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.queue.length); // atomic flush
        batch.forEach((m) => (m.status = "running"));
        this.emit();
        await this.runTurn(mergeBatch(batch));
      }
    } finally {
      this.running = false;
      this.emit();
    }
  }
}
