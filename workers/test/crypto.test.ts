import { describe, it, expect } from "vitest";
import { testEnv } from "./helpers";
import { importConfigKey, encryptSecret, decryptSecret, maskSecret } from "../src/crypto";

// Inner-loop unit specs for crypto.ts. Realizes the feature scenario
// "密钥加密往返可还原" (workers/features/owner-config.feature) at the pure-function
// level, plus the maskSecret rules from SPEC.md §12.4.
//
// The AES-GCM master key comes from the test CONFIG_KEY binding (base64 256-bit),
// the same shape prod reads from `wrangler secret`.

describe("crypto round-trip (feature: 密钥加密往返可还原)", () => {
  it("decrypts back to the original plaintext under the same master key", async () => {
    // Given 一个用于加密的 AES-GCM 主密钥
    const key = await importConfigKey(testEnv.CONFIG_KEY);
    const plaintext = "sk-abcdef0123456789ZYXW";

    // When 对一段密钥明文加密再用同一主密钥解密
    const sealed = await encryptSecret(plaintext, key);
    const back = await decryptSecret(sealed.ciphertext, sealed.iv, key);

    // Then 解密结果与原始明文一致
    expect(back).toBe(plaintext);
  });

  it("uses a different iv for each encryption of the same plaintext", async () => {
    const key = await importConfigKey(testEnv.CONFIG_KEY);
    const plaintext = "yyyy-the-same-secret";

    // And 同一段明文两次加密得到不同的 iv
    const a = await encryptSecret(plaintext, key);
    const b = await encryptSecret(plaintext, key);

    expect(a.iv).not.toBe(b.iv);
    // GCM iv reuse leaks plaintext; distinct ivs also yield distinct ciphertext.
    expect(a.ciphertext).not.toBe(b.ciphertext);

    // Both still decrypt back to the same plaintext under the same key.
    expect(await decryptSecret(a.ciphertext, a.iv, key)).toBe(plaintext);
    expect(await decryptSecret(b.ciphertext, b.iv, key)).toBe(plaintext);
  });

  it("emits base64 ciphertext + iv (D1 stores them as TEXT)", async () => {
    const key = await importConfigKey(testEnv.CONFIG_KEY);
    const sealed = await encryptSecret("some-secret-value", key);

    const base64 = /^[A-Za-z0-9+/]+=*$/;
    expect(sealed.ciphertext).toMatch(base64);
    expect(sealed.iv).toMatch(base64);
  });

  it("fails to decrypt when the ciphertext is tampered (GCM auth)", async () => {
    const key = await importConfigKey(testEnv.CONFIG_KEY);
    const sealed = await encryptSecret("tamper-target-secret", key);

    // Flip a byte in the ciphertext; GCM auth tag must reject it.
    const bytes = Uint8Array.from(atob(sealed.ciphertext), (ch) => ch.charCodeAt(0));
    bytes[0] = bytes[0] ^ 0xff;
    const tampered = btoa(String.fromCharCode(...bytes));

    await expect(decryptSecret(tampered, sealed.iv, key)).rejects.toThrow();
  });
});

describe("maskSecret (SPEC.md §12.4 掩码规则)", () => {
  it("keeps a few leading/trailing chars joined with the … ellipsis", () => {
    const masked = maskSecret("sk-abcdefghijklwxyz");
    expect(masked).toBe("sk-…wxyz");
  });

  it("never echoes the full secret in the masked form", () => {
    const secret = "sk-abcdefghijklwxyz";
    const masked = maskSecret(secret);
    expect(masked).not.toBe(secret);
    expect(masked).not.toContain("abcdefghijkl");
    // The U+2026 ellipsis is the only allowed bridge between head and tail.
    expect(masked).toContain("…");
  });

  it("fully masks a short secret rather than revealing plaintext", () => {
    const short = "abc";
    const masked = maskSecret(short);
    // Must not fall back to plaintext just because the input is short.
    expect(masked).not.toBe(short);
    expect(masked).not.toContain("abc");
    expect(masked.length).toBeGreaterThan(0);
  });
});
