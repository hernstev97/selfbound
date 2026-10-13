// Fake browser for Web Push tests: keys as from PushManager.subscribe() and decryption as in
// the browser (RFC 8291 §3.4, receiver side).
import { base64url } from '../../convex/lib/keys';
import { contentKeys } from '../../convex/lib/webpush';

export async function fakeBrowser() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pair, publicRaw, target: { p256dh: base64url(publicRaw), auth: base64url(auth) }, auth };
}

export type FakeBrowser = Awaited<ReturnType<typeof fakeBrowser>>;

export async function decryptPush(body: Uint8Array<ArrayBuffer>, receiver: FakeBrowser) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idlen = body[20]!;
  const senderPublic = body.slice(21, 21 + idlen);
  const cipher = body.slice(21 + idlen);
  const senderKey = await crypto.subtle.importKey('raw', senderPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: senderKey }, receiver.pair.privateKey, 256));
  const { cek, nonce } = await contentKeys(secret, receiver.auth, receiver.publicRaw, senderPublic, salt);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, cipher));
  return { rs, idlen, delimiter: plain.at(-1), text: new TextDecoder().decode(plain.slice(0, -1)) };
}
