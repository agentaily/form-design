// sse.ts — Server-Sent Events parsing for the streaming backend (SPEC §13.3).
// Two layers: a pure, stream-agnostic decoder (buffers text, emits each event's
// `data` payload) and a thin I/O wrapper that pumps a ReadableStream through it.
// The decoder is where the tricky cross-chunk buffering lives, so it's pure and
// heavily unit-tested; the wrapper just owns the reader + TextDecoder.

/**
 * Stateful SSE decoder. Feed it text chunks (in arrival order) via `push`, which
 * returns the `data` payload of every event that completed in that chunk. Events
 * are separated by a blank line; multiple `data:` lines within one event are
 * joined with "\n" (per the SSE spec). Non-`data` fields (`event:`/`id:`/`:`comments)
 * are ignored — this app only consumes the data channel.
 */
export function createSSEDecoder() {
  let buffer = "";

  function takeEvents(flush: boolean): string[] {
    const out: string[] = [];
    // Normalize CRLF/CR to LF so the blank-line split is uniform.
    buffer = buffer.replace(/\r\n?/g, "\n");
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = blockData(block);
      if (data !== null) out.push(data);
    }
    if (flush && buffer.trim() !== "") {
      const data = blockData(buffer);
      buffer = "";
      if (data !== null) out.push(data);
    }
    return out;
  }

  return {
    /** Feed one chunk of decoded text; returns the data payloads of any completed events. */
    push(chunk: string): string[] {
      buffer += chunk;
      return takeEvents(false);
    },
    /** Flush a trailing event that wasn't terminated by a blank line (best-effort). */
    flush(): string[] {
      return takeEvents(true);
    },
  };
}

/** Extract the joined `data:` payload of one event block, or null if it has none. */
function blockData(block: string): string | null {
  const dataLines: string[] = [];
  for (const raw of block.split("\n")) {
    if (raw === "" || raw.startsWith(":")) continue; // blank or comment
    const colon = raw.indexOf(":");
    const field = colon === -1 ? raw : raw.slice(0, colon);
    if (field !== "data") continue;
    let value = colon === -1 ? "" : raw.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1); // strip one leading space
    dataLines.push(value);
  }
  return dataLines.length ? dataLines.join("\n") : null;
}

/**
 * Pump a ReadableStream of bytes through the SSE decoder, invoking `onData` for
 * each event's data payload (in order). Resolves when the stream ends. Honors an
 * AbortSignal by stopping the read loop. The caller decides what `[DONE]` means.
 */
export async function streamSSE(
  stream: ReadableStream<Uint8Array>,
  onData: (data: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = createSSEDecoder();
  const td = new TextDecoder();
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      for (const data of decoder.push(td.decode(value, { stream: true }))) onData(data);
    }
    for (const data of decoder.flush()) onData(data);
  } finally {
    reader.releaseLock();
  }
}
