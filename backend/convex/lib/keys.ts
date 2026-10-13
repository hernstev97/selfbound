// Agent keys: "xlr8_" + 32 random bytes (base64url). Only the SHA-256 hash (hex) and a short
// prefix for recognition are stored.
// Call only in actions: in queries and mutations, randomness is deterministic.

export const KEY_PREFIX = 'xlr8_';
export const KEY_PREFIX_LENGTH = 10;

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function base64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = [(n >> 18) & 63, (n >> 12) & 63, (n >> 6) & 63, n & 63].map((c) => B64URL[c]);
    out += chars.slice(0, i + 2 < bytes.length ? 4 : i + 1 < bytes.length ? 3 : 2).join('');
  }
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function generateAgentKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = KEY_PREFIX + base64url(bytes);
  return { key, keyHash: await sha256Hex(key), keyPrefix: key.slice(0, KEY_PREFIX_LENGTH) };
}

/** Random secret (32 bytes) with a prefix, plus its hash, e.g. for OAuth tokens and codes. */
export async function generateSecret(prefix: string) {
  const value = prefix + base64url(crypto.getRandomValues(new Uint8Array(32)));
  return { value, hash: await sha256Hex(value) };
}

/** Random ID (base64url) without a hash, e.g. a client ID or request ID. */
export function randomId(bytes = 18) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
