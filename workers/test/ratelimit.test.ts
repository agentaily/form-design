import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  windowStartFor,
  rateLimitKeyFor,
  checkRateLimit,
  UNKNOWN_IP_BUCKET,
  type RateLimitBucket,
} from "../src/ratelimit";

// Inner-loop unit specs for the PURE / mockable primitives in ratelimit.ts
// (SPEC.md §25.2 / §25.3 / §25.6 / §25.7). These are KV-double driven — a tiny
// in-memory fake KV + a fixed `now` is enough to walk the fixed-window math.
// The SELF.fetch 429 / Retry-After header / OPTIONS / owner-only paths are the
// OUTER loop (left to outer-tester); here we only drive the window arithmetic,
// the key derivation (raw IP never in the key), and the count→decide→increment
// primitive incl. fail-open.

// --- a minimal in-memory KV double (only the surface checkRateLimit uses) -----
//
// Models KV's get/put with an optional expirationTtl. We don't simulate real
// expiry by wall-clock here — the window math is driven by passing distinct
// `now` values (different windowStart → different key → fresh count), which is
// exactly how a fixed window resets. `failOn` lets a test force get/put to throw
// to exercise the §25.7 fail-open path.
interface PutOpts {
  expirationTtl?: number;
}
interface FakeKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: PutOpts): Promise<void>;
  readonly store: Map<string, { value: string; expirationTtl?: number }>;
  readonly puts: { key: string; value: string; opts?: PutOpts }[];
}
function makeKV(opts: { failOn?: "get" | "put" | "both" } = {}): FakeKV {
  const store = new Map<string, { value: string; expirationTtl?: number }>();
  const puts: { key: string; value: string; opts?: PutOpts }[] = [];
  return {
    store,
    puts,
    async get(key: string) {
      if (opts.failOn === "get" || opts.failOn === "both") {
        throw new TypeError("KV get boom");
      }
      const hit = store.get(key);
      return hit ? hit.value : null;
    },
    async put(key: string, value: string, putOpts?: PutOpts) {
      if (opts.failOn === "put" || opts.failOn === "both") {
        throw new TypeError("KV put boom");
      }
      puts.push({ key, value, opts: putOpts });
      store.set(key, { value, expirationTtl: putOpts?.expirationTtl });
    },
  };
}

// checkRateLimit only touches kv.get / kv.put — a structural cast is enough.
const asKV = (k: FakeKV): KVNamespace => k as unknown as KVNamespace;

describe("windowStartFor (SPEC.md §25.2 窗口对齐)", () => {
  it("floors now to the start of the fixed window", () => {
    // 60s window: any second within [120, 180) floors to 120.
    expect(windowStartFor(120, 60)).toBe(120);
    expect(windowStartFor(125, 60)).toBe(120);
    expect(windowStartFor(179, 60)).toBe(120);
  });

  it("returns a value divisible by windowSeconds", () => {
    expect(windowStartFor(3661, 3600) % 3600).toBe(0);
    expect(windowStartFor(3661, 3600)).toBe(3600);
  });

  it("rolls to the next window exactly at the boundary", () => {
    // 180 is the first second of the NEXT 60s window.
    expect(windowStartFor(179, 60)).toBe(120);
    expect(windowStartFor(180, 60)).toBe(180);
  });

  it("is pure: same inputs → same output, no side effects", () => {
    expect(windowStartFor(1_700_000_123, 60)).toBe(windowStartFor(1_700_000_123, 60));
  });
});

describe("rateLimitKeyFor (SPEC.md §25.3 计数键设计，不存原始 IP)", () => {
  const IP = "203.0.113.7";
  const bucket: RateLimitBucket = "submit";

  it("is shaped rl:<bucket>:<hash>:<windowStart>", async () => {
    const key = await rateLimitKeyFor(IP, bucket, 1200);
    const parts = key.split(":");
    expect(parts[0]).toBe("rl");
    expect(parts[1]).toBe("submit");
    expect(parts[2].length).toBeGreaterThan(0); // the hash segment
    expect(parts[3]).toBe("1200"); // the windowStart
  });

  it("NEVER embeds the raw IP plaintext in the key", async () => {
    const key = await rateLimitKeyFor(IP, bucket, 1200);
    expect(key).not.toContain(IP);
  });

  it("is deterministic: same (ip, bucket, windowStart) → same key", async () => {
    const a = await rateLimitKeyFor(IP, bucket, 1200);
    const b = await rateLimitKeyFor(IP, bucket, 1200);
    expect(a).toBe(b);
  });

  it("hashes the IP one-way (key looks nothing like the IP, stable SHA-256)", async () => {
    const key = await rateLimitKeyFor(IP, bucket, 1200);
    // The hash segment is a hex SHA-256 digest — fixed width, hex alphabet only.
    const hash = key.split(":")[2];
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("different IPs land in different keys (no collision in the same window/bucket)", async () => {
    const a = await rateLimitKeyFor("198.51.100.1", bucket, 1200);
    const b = await rateLimitKeyFor("198.51.100.2", bucket, 1200);
    expect(a).not.toBe(b);
  });

  it("different buckets give different keys for the same IP+window (no cross-bucket leak)", async () => {
    const a = await rateLimitKeyFor(IP, "login", 1200);
    const b = await rateLimitKeyFor(IP, "register", 1200);
    expect(a).not.toBe(b);
  });

  it("same bucket but different windowStart → different keys (minute vs hour)", async () => {
    const minute = await rateLimitKeyFor(IP, "submit", 1200);
    const hour = await rateLimitKeyFor(IP, "submit", 0);
    expect(minute).not.toBe(hour);
  });
});

describe("checkRateLimit (SPEC.md §25.2 / §25.6 固定窗口原语)", () => {
  const NOW = 1200; // a 60s window starts at 1200
  const input = {
    ip: "203.0.113.9",
    bucket: "login" as RateLimitBucket,
    limit: 3,
    windowSeconds: 60,
  };

  it("allows the first request under the limit and increments the count", async () => {
    const kv = makeKV();
    const d = await checkRateLimit(asKV(kv), input, NOW);
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(2); // limit 3, this is the 1st → 2 left
    // exactly one count written under the window key, with TTL = windowSeconds.
    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0].value).toBe("1");
    expect(kv.puts[0].opts?.expirationTtl).toBe(60);
  });

  it("accumulates the count across requests within the same window", async () => {
    const kv = makeKV();
    const a = await checkRateLimit(asKV(kv), input, NOW);
    const b = await checkRateLimit(asKV(kv), input, NOW + 5);
    const c = await checkRateLimit(asKV(kv), input, NOW + 10);
    expect([a.remaining, b.remaining, c.remaining]).toEqual([2, 1, 0]);
    expect(a.allowed && b.allowed && c.allowed).toBe(true);
  });

  it("rejects once the count reaches the limit (does NOT increment further)", async () => {
    const kv = makeKV();
    await checkRateLimit(asKV(kv), input, NOW); // 1
    await checkRateLimit(asKV(kv), input, NOW); // 2
    await checkRateLimit(asKV(kv), input, NOW); // 3 (== limit)
    const putsBefore = kv.puts.length;
    const denied = await checkRateLimit(asKV(kv), input, NOW); // 4th → denied
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    // denial must NOT write a new count (no further increment on reject).
    expect(kv.puts.length).toBe(putsBefore);
  });

  it("computes retryAfter as the seconds left until the window resets", async () => {
    const kv = makeKV();
    // window [1200, 1260); at now=1205 → 55s to reset.
    const d = await checkRateLimit(asKV(kv), input, 1205);
    expect(d.retryAfter).toBe(55);
  });

  it("retryAfter on a denied request still reflects the window remainder", async () => {
    const kv = makeKV();
    for (let i = 0; i < input.limit; i++) {
      await checkRateLimit(asKV(kv), input, 1200);
    }
    const denied = await checkRateLimit(asKV(kv), input, 1210); // 50s left
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfter).toBe(50);
    expect(Number.isInteger(denied.retryAfter)).toBe(true);
    expect(denied.retryAfter).toBeGreaterThanOrEqual(0);
  });

  it("resets the count when time advances into the next window", async () => {
    const kv = makeKV();
    // Exhaust the window at NOW.
    for (let i = 0; i < input.limit; i++) {
      await checkRateLimit(asKV(kv), input, NOW);
    }
    const stillDenied = await checkRateLimit(asKV(kv), input, NOW + 10);
    expect(stillDenied.allowed).toBe(false);
    // Advance a full window — new windowStart → new key → fresh count → allowed.
    const next = await checkRateLimit(asKV(kv), input, NOW + 60);
    expect(next.allowed).toBe(true);
    expect(next.remaining).toBe(input.limit - 1);
  });

  it("keeps distinct IPs on independent counters (no cross-IP bleed)", async () => {
    const kv = makeKV();
    // Exhaust IP A.
    for (let i = 0; i < input.limit; i++) {
      await checkRateLimit(asKV(kv), input, NOW);
    }
    const a = await checkRateLimit(asKV(kv), input, NOW);
    expect(a.allowed).toBe(false);
    // A different IP is unaffected.
    const b = await checkRateLimit(asKV(kv), { ...input, ip: "203.0.113.99" }, NOW);
    expect(b.allowed).toBe(true);
  });

  it("keeps the constant unknown-IP bucket limited like any other", async () => {
    const kv = makeKV();
    const unknownInput = { ...input, ip: UNKNOWN_IP_BUCKET };
    for (let i = 0; i < input.limit; i++) {
      await checkRateLimit(asKV(kv), unknownInput, NOW);
    }
    const denied = await checkRateLimit(asKV(kv), unknownInput, NOW);
    expect(denied.allowed).toBe(false);
  });

  // --- fail-open (§25.7) -----------------------------------------------------

  it("fail-opens (allows) when KV.get throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const kv = makeKV({ failOn: "get" });
    const d = await checkRateLimit(asKV(kv), input, NOW);
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(input.limit);
    expect(d.retryAfter).toBe(0);
    errSpy.mockRestore();
  });

  it("fail-opens (allows) when KV.put throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const kv = makeKV({ failOn: "put" });
    const d = await checkRateLimit(asKV(kv), input, NOW);
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(input.limit);
    errSpy.mockRestore();
  });

  it("on fail-open logs only err.name — never the IP, key, or KV content", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const kv = makeKV({ failOn: "get" });
    await checkRateLimit(asKV(kv), input, NOW);
    expect(errSpy).toHaveBeenCalled();
    // Flatten every logged arg to text; assert neither the raw IP nor a count key leaked.
    const logged = errSpy.mock.calls.flat().map(String).join(" | ");
    expect(logged).not.toContain(input.ip);
    expect(logged).not.toContain("rl:");
    // The thrown error's name is fine to surface (TypeError here).
    expect(logged).toContain("TypeError");
    errSpy.mockRestore();
  });
});
