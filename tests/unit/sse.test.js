import { describe, it, expect } from "vitest";
import { createSSEDecoder, streamSSE } from "../../src/core/sse";

// Build a ReadableStream<Uint8Array> from a list of string chunks.
function streamOf(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

describe("sse · createSSEDecoder", () => {
  it("emits one event's data payload on a blank-line terminator", () => {
    const d = createSSEDecoder();
    expect(d.push("data: hello\n\n")).toEqual(["hello"]);
  });

  it("joins multiple data: lines within one event with newlines", () => {
    const d = createSSEDecoder();
    expect(d.push("data: a\ndata: b\n\n")).toEqual(["a\nb"]);
  });

  it("buffers an event split across pushes until it completes", () => {
    const d = createSSEDecoder();
    expect(d.push("data: hel")).toEqual([]);
    expect(d.push("lo\n\n")).toEqual(["hello"]);
  });

  it("parses several events arriving in a single chunk", () => {
    const d = createSSEDecoder();
    expect(d.push("data: one\n\ndata: two\n\ndata: three\n\n")).toEqual(["one", "two", "three"]);
  });

  it("ignores comments and non-data fields", () => {
    const d = createSSEDecoder();
    expect(d.push(": keep-alive\n\n")).toEqual([]);
    expect(d.push('event: ping\nid: 7\ndata: {"x":1}\n\n')).toEqual(['{"x":1}']);
  });

  it("normalizes CRLF terminators", () => {
    const d = createSSEDecoder();
    expect(d.push("data: hi\r\n\r\n")).toEqual(["hi"]);
  });

  it("passes the OpenAI [DONE] sentinel through as data", () => {
    const d = createSSEDecoder();
    expect(d.push("data: [DONE]\n\n")).toEqual(["[DONE]"]);
  });

  it("flush() emits a trailing event with no final blank line", () => {
    const d = createSSEDecoder();
    expect(d.push("data: tail")).toEqual([]);
    expect(d.flush()).toEqual(["tail"]);
  });
});

describe("sse · streamSSE", () => {
  it("invokes onData for each event, preserving order, across chunk boundaries", async () => {
    const got = [];
    await streamSSE(streamOf(["data: a\n\ndata: b", "\n\ndata: c\n\n"]), (d) => got.push(d));
    expect(got).toEqual(["a", "b", "c"]);
  });

  it("stops early when the signal is already aborted", async () => {
    const got = [];
    const ac = new AbortController();
    ac.abort();
    await streamSSE(streamOf(["data: a\n\n"]), (d) => got.push(d), ac.signal);
    expect(got).toEqual([]);
  });
});
