// Local test sign-in for the backend, without Clerk and without an account.
//
// Creates an RSA key pair once in backend/.dev-auth/ (gitignored), provides the public key as a
// JWKS data: URI for Convex and issues tokens for the owner. The backend accepts this issuer only
// when XLR8_DEV_JWKS is set, which happens only in local backends.

import { createPrivateKey, createPublicKey, createSign, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'backend', '.dev-auth');
const keyFile = join(dir, 'private.pem');

export const DEV_ISSUER = 'https://dev.xlr8.local';
export const DEV_AUDIENCE = 'xlr8-dev';
export const DEV_SUBJECT = 'owner';
export const DEV_OWNER_ID = `${DEV_ISSUER}|${DEV_SUBJECT}`;
const KID = 'xlr8-dev-1';

function privateKey() {
  if (!existsSync(keyFile)) {
    mkdirSync(dir, { recursive: true });
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  return createPrivateKey(readFileSync(keyFile));
}

/** JWKS with the public key as a data: URI (for XLR8_DEV_JWKS). */
export function devJwksDataUri() {
  const jwk = createPublicKey(privateKey()).export({ format: 'jwk' });
  const jwks = JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] });
  return `data:text/plain;charset=utf-8;base64,${Buffer.from(jwks).toString('base64')}`;
}

const b64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

/** Signed token for the owner (valid for one year by default, usable only locally). */
export function devToken({ subject = DEV_SUBJECT, ttlSeconds = 365 * 24 * 3600 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: KID };
  const payload = { iss: DEV_ISSUER, aud: DEV_AUDIENCE, sub: subject, iat: now, exp: now + ttlSeconds, name: 'Owner (local)' };
  const input = `${b64url(header)}.${b64url(payload)}`;
  const signature = createSign('RSA-SHA256').update(input).sign(privateKey()).toString('base64url');
  return `${input}.${signature}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === 'jwks') console.log(devJwksDataUri());
  else if (cmd === 'token') console.log(devToken({ subject: process.argv[3] ?? DEV_SUBJECT }));
  else console.log('Usage: node tooling/dev-auth.mjs jwks|token [subject]');
}
