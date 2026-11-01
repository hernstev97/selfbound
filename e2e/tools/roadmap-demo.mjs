#!/usr/bin/env node
// Sample roadmap for screenshots (SELF-113): the fictional team "Emberfall" (EMB) with stages,
// categories, public issues and cover pictures, on a LOCAL backend with SELFBOUND_ALLOW_SEED=1.
// Usage: node e2e/tools/roadmap-demo.mjs [convex-url]   (default: VITE_CONVEX_URL from app/.env.local)
// The cover pictures are drawn here (gradients and shapes, no photos) and uploaded like any image.
import { ConvexHttpClient } from 'convex/browser';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { anyApi } from 'convex/server';
import { devToken } from '../../tooling/dev-auth.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const envUrl = () => {
  try {
    return /VITE_CONVEX_URL=(\S+)/.exec(readFileSync(join(root, 'app/.env.local'), 'utf8'))?.[1];
  } catch {
    return undefined;
  }
};
const url = process.argv[2] ?? envUrl();
if (!url || !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error('A local backend URL is needed (http://127.0.0.1:…).');
  process.exit(1);
}

// ---- PNG

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x / width, y / height);
      const i = y * (width * 3 + 1) + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const clamp = (v) => Math.max(0, Math.min(1, v));
/** Six moods: a gradient, a glowing disc and a horizon. */
const MOODS = [
  { top: [40, 18, 10], bottom: [214, 104, 38], glow: [255, 196, 102], cx: 0.62, cy: 0.42 },
  { top: [20, 22, 30], bottom: [120, 62, 30], glow: [255, 150, 60], cx: 0.3, cy: 0.55 },
  { top: [12, 10, 12], bottom: [90, 28, 18], glow: [255, 90, 40], cx: 0.5, cy: 0.35 },
  { top: [36, 34, 40], bottom: [120, 110, 104], glow: [230, 210, 190], cx: 0.7, cy: 0.5 },
  { top: [30, 16, 8], bottom: [180, 92, 24], glow: [255, 210, 120], cx: 0.42, cy: 0.62 },
  { top: [14, 18, 24], bottom: [66, 84, 98], glow: [255, 170, 80], cx: 0.55, cy: 0.48 },
];
const cover = (m) =>
  png(640, 360, (x, y) => {
    let c = mix(m.top, m.bottom, y);
    const d = Math.hypot((x - m.cx) * 1.8, y - m.cy);
    c = mix(c, m.glow, clamp(1 - d * 3.2) ** 2);
    const horizon = 0.72 + Math.sin(x * 9 + m.cx * 7) * 0.04;
    if (y > horizon) c = mix(c, [10, 8, 8], clamp((y - horizon) * 6));
    return c;
  });

// ---- Upload and create

const client = new ConvexHttpClient(url);
client.setAuth(devToken());
const images = [];
for (const mood of MOODS) {
  const uploadUrl = await client.mutation(anyApi.files.generateUploadUrl, {});
  const response = await fetch(uploadUrl, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: cover(mood) });
  const { storageId } = await response.json();
  const { url: imageUrl } = await client.action(anyApi.files.register, { storageId });
  images.push(imageUrl);
}
const result = await client.mutation(anyApi.seed.roadmapDemo, { images });
console.log(result.created ? 'Sample roadmap created: team EMB (Emberfall).' : 'Team EMB exists already, nothing changed.');
