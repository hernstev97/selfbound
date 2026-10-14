import { describe, expect, test } from 'vitest';
import { base64url } from '../../convex/lib/keys';
import { decryptPush as decrypt, fakeBrowser as browser } from './pushBrowser';
import {
  buildPushRequest,
  concat,
  encryptPayload,
  fromBase64url,
  generateVapidKeys,
  pushTopic,
  vapidAuthorization,
} from '../../convex/lib/webpush';

describe('Web Push', () => {
  test("the payload decrypts with the browser's key", async () => {
    const receiver = await browser();
    const payload = JSON.stringify({ title: 'Assistant · New issue', body: 'TST-1 Test issue äöü', url: '/issue/TST-1' });
    const body = await encryptPayload(payload, receiver.target);
    const out = await decrypt(body, receiver);
    expect(out).toEqual({ rs: 4096, idlen: 65, delimiter: 2, text: payload });
  });

  test('every message has its own salt and sender key', async () => {
    const receiver = await browser();
    const a = await encryptPayload('x', receiver.target);
    const b = await encryptPayload('x', receiver.target);
    expect(base64url(a.slice(0, 86))).not.toBe(base64url(b.slice(0, 86)));
  });

  test('a payload that is too large is rejected', async () => {
    const receiver = await browser();
    await expect(encryptPayload('x'.repeat(4000), receiver.target)).rejects.toThrow('too large');
  });

  test('the VAPID JWT verifies with the public key', async () => {
    const keys = await generateVapidKeys();
    expect(fromBase64url(keys.publicKey)).toHaveLength(65);
    expect(fromBase64url(keys.privateKey)).toHaveLength(32);
    const now = Date.UTC(2026, 9, 11, 12);
    const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', { ...keys, subject: 'https://selfbound.example.com' }, now);
    const match = header.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
    expect(match).not.toBeNull();
    const [, head, claims, signature, k] = match!;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(new TextDecoder().decode(fromBase64url(head!)))).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(new TextDecoder().decode(fromBase64url(claims!)))).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: now / 1000 + 12 * 3600,
      sub: 'https://selfbound.example.com',
    });
    const pub = await crypto.subtle.importKey('raw', fromBase64url(keys.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pub,
      fromBase64url(signature!),
      new TextEncoder().encode(`${head}.${claims}`),
    );
    expect(ok).toBe(true);
  });

  test('the request to the push service has all headers', async () => {
    const receiver = await browser();
    const keys = await generateVapidKeys();
    const topic = await pushTopic('issue:abc');
    const req = await buildPushRequest(
      { endpoint: 'https://push.example/x', ...receiver.target },
      '{}',
      { ...keys, subject: 'https://selfbound.example.com' },
      { ttl: 60, urgency: 'high', topic },
    );
    expect(req.url).toBe('https://push.example/x');
    expect(req.init.headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', TTL: '60', Urgency: 'high', Topic: topic });
    expect(topic).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect((await decrypt(req.init.body, receiver)).text).toBe('{}');
  });

  test('concat and base64url fit together', () => {
    const bytes = concat(new Uint8Array([1, 2]), new Uint8Array([250, 251, 252]));
    expect([...fromBase64url(base64url(bytes))]).toEqual([1, 2, 250, 251, 252]);
  });
});
