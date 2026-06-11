// crypto.ts — AES-GCM secret encryption + masking for owner config.
// See SPEC.md §12.2 (加密方案) and §12.4 (掩码规则).
//
// Pure, network-free logic built on Web Crypto (crypto.subtle), available in the
// workerd runtime. These functions are the inner-loop unit-test targets:
//   - importConfigKey: turn the raw CONFIG_KEY secret into a CryptoKey,
//   - encryptSecret / decryptSecret: AES-GCM round-trip with a fresh per-call iv,
//   - maskSecret: one-way display masking for read-back.
//
// Scope of this module: encryption + masking only. D1 orchestration, request
// parsing and HTTP shaping live in config.ts / the Hono routes.

/**
 * A secret ciphertext bundle: AES-GCM ciphertext and the iv it was sealed with,
 * both base64 strings. The pair is stored together in D1 (`*_cipher` / `*_iv`)
 * and must never be split — decryption needs both.
 */
export interface SealedSecret {
  /** AES-GCM ciphertext, base64. */
  ciphertext: string;
  /** The 96-bit iv used for this ciphertext, base64. Never reused. */
  iv: string;
}

/**
 * Import the raw CONFIG_KEY secret into an AES-GCM {@link CryptoKey}.
 *
 * `raw` is the value of the Worker secret CONFIG_KEY: a base64-encoded 256-bit
 * key. The returned key is used for both {@link encryptSecret} and
 * {@link decryptSecret}.
 *
 * @param raw base64 of a 32-byte (256-bit) AES key.
 * @throws if `raw` is not valid base64 of a supported key length.
 */
export async function importConfigKey(raw: string): Promise<CryptoKey> {
  const rawBytes = base64ToBytes(raw);
  return crypto.subtle.importKey("raw", rawBytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Encrypt a plaintext secret under `key` with AES-GCM, generating a **fresh
 * random 96-bit iv** for this call. Returns the ciphertext and iv as base64.
 *
 * Each secret field gets its own iv — iv must never be reused under the same
 * key (GCM iv reuse leaks plaintext). See SPEC.md §12.2.
 *
 * @returns `{ ciphertext, iv }`, both base64.
 */
export async function encryptSecret(plaintext: string, key: CryptoKey): Promise<SealedSecret> {
  // Fresh 96-bit iv per call — GCM iv reuse under the same key leaks plaintext.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
  };
}

/**
 * Decrypt an AES-GCM secret back to plaintext. Inverse of {@link encryptSecret}:
 * `decryptSecret((await encryptSecret(p, k)), k)` === `p`.
 *
 * Used only inside the Worker by later features (LLM proxy, write-to-Feishu);
 * `GET /api/config` never calls this — it returns masked values only.
 *
 * @param ciphertext base64 ciphertext.
 * @param iv base64 iv that sealed this ciphertext.
 * @throws if the ciphertext/iv don't authenticate under `key` (tampering / wrong key).
 */
export async function decryptSecret(
  ciphertext: string,
  iv: string,
  key: CryptoKey,
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv) },
    key,
    base64ToBytes(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

/**
 * One-way display mask for a secret, for read-back in the UI. See SPEC.md §12.4.
 *
 * - Keeps a few leading/trailing chars, joins with "…" (U+2026), e.g. `sk-…wxyz`.
 * - For inputs too short to safely reveal head+tail, masks the whole thing — never
 *   falls back to plaintext just because the secret is short.
 * - Masking is irreversible and serves only UI echo; it never participates in
 *   decryption.
 *
 * Note: empty / unset secret fields are mapped to `null` by the caller
 * (config.ts), not passed here — `maskSecret` always returns a masked string.
 *
 * @example maskSecret("sk-abcdefghijklwxyz") === "sk-…wxyz"
 */
export function maskSecret(plaintext: string): string {
  const HEAD = 3;
  const TAIL = 4;
  // Only reveal head+tail when at least one character stays hidden in between;
  // otherwise mask the whole thing — never fall back to plaintext for short inputs.
  if (plaintext.length > HEAD + TAIL) {
    return `${plaintext.slice(0, HEAD)}…${plaintext.slice(-TAIL)}`;
  }
  return "••••";
}

/** Decode a base64 string into bytes. */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Encode bytes into a base64 string. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
