import { describe, it, expect, vi } from "vitest";
import { mergeBatch, MessageQueue } from "../../src/core/queue";

const tick = () => new Promise((r) => setTimeout(r, 0));
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

describe("queue · mergeBatch", () => {
  it("returns a single message verbatim", () => {
    expect(mergeBatch([{ text: "hi", typedWhileBusy: false }])).toBe("hi");
  });

  it("numbers multiple messages", () => {
    const out = mergeBatch([
      { text: "a", typedWhileBusy: false },
      { text: "b", typedWhileBusy: false },
    ]);
    expect(out).toBe("1. a\n2. b");
  });

  it("wraps mid-work input in a <context> tag so it is not read as a reply", () => {
    const out = mergeBatch([{ text: "也改下标题", typedWhileBusy: true }]);
    expect(out).toContain("<context");
    expect(out).toContain("也改下标题");
    expect(out).toMatch(/陆续输入/);
  });
});

describe("queue · single consumer + atomic batching", () => {
  it("connect-sending N messages starts exactly one loop; extras batch on next flush", async () => {
    let gate = deferred();
    const calls = [];
    const runTurn = vi.fn(async (text) => {
      calls.push(text);
      await gate.promise;
    });
    const q = new MessageQueue(runTurn);

    q.enqueue("a"); // idle → starts consuming "a"
    expect(q.running).toBe(true);
    q.enqueue("b"); // busy → queued
    q.enqueue("c"); // busy → queued
    await tick();

    expect(calls).toEqual(["a"]); // only one turn in flight
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(q.pending()).toHaveLength(2);

    // finish turn "a" → loop atomically flushes [b, c] as ONE merged batch
    const next = deferred();
    const prev = gate;
    gate = next;
    prev.resolve();
    await tick();

    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(calls[1]).toContain("1. b");
    expect(calls[1]).toContain("2. c");
    expect(calls[1]).toContain("<context"); // typed while busy
  });

  it("goes idle after the queue drains", async () => {
    const runTurn = vi.fn(async () => {});
    const q = new MessageQueue(runTurn);
    q.enqueue("only");
    await tick();
    expect(q.running).toBe(false);
    expect(q.pending()).toHaveLength(0);
  });
});

describe("queue · cancel pending", () => {
  it("a cancelled pending message is never consumed", async () => {
    let gate = deferred();
    const calls = [];
    const runTurn = vi.fn(async (t) => {
      calls.push(t);
      await gate.promise;
    });
    const q = new MessageQueue(runTurn);

    q.enqueue("a"); // running
    const b = q.enqueue("b"); // pending
    expect(q.cancel(b.id)).toBe(true);

    gate.resolve();
    await tick();

    expect(calls).toEqual(["a"]); // "b" was cancelled before flush
  });
});
