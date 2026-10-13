// Web Push without extra packages, WebCrypto only (runs in the Convex runtime, in Node and in browsers):
//   - payload encryption per RFC 8291 (Content-Encoding aes128gcm, RFC 8188)
//   - sender identification with VAPID per RFC 8292 (JWT with ES256)
// Keys are base64url: public 65 bytes (uncompressed P-256 point), private 32 bytes (d).
// Call only from actions: encryption needs randomness.

import { base64url } from './keys';

export type PushTarget = { endpoint: string; p256dh: string; auth: string };
export type VapidKeys = { publicKey: string; privateKey: string; subject: string };
export type PushOptions = {
  /** Seconds the push service keeps the message if the device is unreachable right now. */
  ttl?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  /** Replaces a not yet delivered message with the same topic (at most 32 base64url characters). */
  topic?: string;
};

const encoder = new TextEncoder();
const RECORD_SIZE = 4096;

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, length: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/** Content key and nonce (RFC 8291 §3.4, RFC 8188 §2.2); used for both encryption and decryption. */
export async function contentKeys(
  ecdhSecret: Uint8Array<ArrayBuffer>,
  authSecret: Uint8Array<ArrayBuffer>,
  receiverPublic: Uint8Array,
  senderPublic: Uint8Array,
  salt: Uint8Array<ArrayBuffer>,
) {
  const keyInfo = concat(encoder.encode('WebPush: info\0'), receiverPublic, senderPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);
  return { cek, nonce };
}

/** Encrypts the payload for a subscription (a single record, at most ~3.9 kB). */
export async function encryptPayload(payload: string, target: Pick<PushTarget, 'p256dh' | 'auth'>): Promise<Uint8Array<ArrayBuffer>> {
  const plain = encoder.encode(payload);
  if (plain.length > RECORD_SIZE - 17 - 103) throw new Error('Push payload too large');
  const receiverPublic = fromBase64url(target.p256dh);
  const receiverKey = await crypto.subtle.importKey('raw', receiverPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sender = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const senderPublic = new Uint8Array(await crypto.subtle.exportKey('raw', sender.publicKey));
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: receiverKey }, sender.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const { cek, nonce } = await contentKeys(ecdhSecret, fromBase64url(target.auth), receiverPublic, senderPublic, salt);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // Padding delimiter 0x02: last (and only) record.
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(plain, new Uint8Array([2]))));
  const header = new Uint8Array(16 + 4 + 1);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = senderPublic.length;
  return concat(header, senderPublic, cipher);
}

/** VAPID header (RFC 8292) for the endpoint's push service, valid for 12 h. */
export async function vapidAuthorization(endpoint: string, vapid: VapidKeys, now = Date.now()): Promise<string> {
  const pub = fromBase64url(vapid.publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY is not a P-256 point');
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: base64url(pub.slice(1, 33)),
    y: base64url(pub.slice(33, 65)),
    d: vapid.privateKey,
    ext: true,
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const part = (value: object) => base64url(encoder.encode(JSON.stringify(value)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: vapid.subject,
  })}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(unsigned)));
  return `vapid t=${unsigned}.${base64url(signature)}, k=${vapid.publicKey}`;
}

/** Builds the request to the push service; send it with fetch(url, init). */
export async function buildPushRequest(target: PushTarget, payload: string, vapid: VapidKeys, options: PushOptions = {}) {
  const headers: Record<string, string> = {
    Authorization: await vapidAuthorization(target.endpoint, vapid),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(options.ttl ?? 24 * 3600),
    Urgency: options.urgency ?? 'normal',
  };
  if (options.topic) headers.Topic = options.topic;
  return { url: target.endpoint, init: { method: 'POST', headers, body: await encryptPayload(payload, target) } };
}

/** Generates a new VAPID key pair (for tooling/vapid.mjs and tests). */
export async function generateVapidKeys() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicKey = base64url(concat(new Uint8Array([4]), fromBase64url(jwk.x!), fromBase64url(jwk.y!)));
  return { publicKey, privateKey: jwk.d! };
}

/** Short value for the Topic header derived from any key (SHA-256, 24 characters). */
export async function pushTopic(key: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(key)));
  return base64url(digest).slice(0, 24);
}
