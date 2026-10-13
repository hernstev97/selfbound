#!/usr/bin/env node
// Generates VAPID keys for Web Push notifications and stores them directly in the Convex
// environment variables VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT.
// The private key is never printed; it only goes to the Convex CLI via stdin.
//
// Usage:  node tooling/vapid.mjs                           production (via tooling/cloud.mjs)
//         node tooling/vapid.mjs --local [--dir <folder>]   local backend (default: backend)
//         … --subject <url>   https: or mailto: contact for push services (default: appUrl from
//                             tooling/instance.mjs; with --local https://xlr8.example.com)
//         … --force           replace existing keys. Every device re-subscribes the next time it
//                             opens XLR8 (app/src/lib/pwa/push.ts, syncPush).
//
// No need to back the key up anywhere: if it is lost, generate a new one with --force.

import { webcrypto } from 'node:crypto';

const argv = process.argv.slice(2);
const local = argv.includes('--local');
const force = argv.includes('--force');
const dirIndex = argv.indexOf('--dir');
const subjectIndex = argv.indexOf('--subject');

let run;
if (local) {
  process.env.XLR8_BACKEND_DIR = dirIndex >= 0 ? argv[dirIndex + 1] : 'backend';
  run = (await import('./convex.mjs')).runConvex;
} else {
  run = (await import('./cloud.mjs')).runCloud;
}
const SUBJECT =
  (subjectIndex >= 0 ? argv[subjectIndex + 1] : undefined) ??
  (local ? 'https://xlr8.example.com' : (await import('./instance.mjs')).requireInstance(['appUrl']).appUrl);

/** Calls the Convex CLI; `input` goes via stdin, output is only collected (never shown). */
function cli(args, input) {
  return new Promise((resolve, reject) => {
    const child = run(args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.stdin.end(input ?? '');
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`convex ${args.slice(0, 3).join(' ')} … (exit ${code})`))));
  });
}

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

const existing = (await cli(['env', 'get', 'VAPID_PUBLIC_KEY']).catch(() => '')).trim();
if (/^[A-Za-z0-9_-]{80,}$/.test(existing.split('\n').at(-1) ?? '') && !force) {
  console.log(`VAPID keys are already set up ${local ? 'locally' : 'in production'}. Replace them with --force.`);
  process.exit(0);
}

const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
const publicKey = b64url(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));

// Private key first (via stdin), then the public one: push counts as set up only when both exist.
await cli(['env', 'set', 'VAPID_PRIVATE_KEY'], jwk.d);
await cli(['env', 'set', 'VAPID_SUBJECT', SUBJECT]);
await cli(['env', 'set', 'VAPID_PUBLIC_KEY', publicKey]);
console.log(`VAPID keys set ${local ? 'locally' : 'in production'} (public key starts with ${publicKey.slice(0, 8)}…).`);
