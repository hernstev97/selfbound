#!/usr/bin/env node
// Size of the app's initial bundle (brotli/gzip): everything index.html loads at start
// (entry + static imports + CSS), separate from lazily loaded chunks.
// Usage after `pnpm build`: node tooling/bundle-size.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const dist = join(import.meta.dirname, '..', 'app', 'dist');
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const sizes = (file) => {
  const buf = readFileSync(join(dist, file));
  return {
    raw: buf.length,
    gzip: gzipSync(buf, { level: 9 }).length,
    brotli: brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  };
};

const initial = new Set();
const visit = (file) => {
  if (initial.has(file)) return;
  initial.add(file);
  if (!file.endsWith('.js')) return;
  const code = readFileSync(join(dist, file), 'utf8');
  // Only static imports count towards the start (import … from "./x.js"), not import("./x.js").
  for (const m of code.matchAll(/(?:^|[;\n}])\s*import\s*(?:[\w${},\s*]+from\s*)?["']\.\/([^"']+)["']/g)) visit(`assets/${m[1]}`);
};
for (const m of html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)) visit(m[1]);

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
let total = { raw: 0, gzip: 0, brotli: 0 };
console.log('Initial bundle:');
for (const file of initial) {
  const s = sizes(file);
  total = { raw: total.raw + s.raw, gzip: total.gzip + s.gzip, brotli: total.brotli + s.brotli };
  console.log(`  ${file.padEnd(48)} ${kb(s.raw).padStart(10)} raw ${kb(s.gzip).padStart(9)} gzip ${kb(s.brotli).padStart(9)} brotli`);
}
console.log(`  ${'Total'.padEnd(48)} ${kb(total.raw).padStart(10)} raw ${kb(total.gzip).padStart(9)} gzip ${kb(total.brotli).padStart(9)} brotli`);
// Welcome page (welcome.html, its own entry): what it needs to load. Must contain nothing from the
// app start and nothing from Clerk (Clerk loads only on /sign-in).
const welcome = new Set();
try {
  const whtml = readFileSync(join(dist, 'welcome.html'), 'utf8');
  const before = new Set(initial);
  for (const m of whtml.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)) visit(m[1]);
  for (const f of initial) if (!before.has(f)) welcome.add(f);
  for (const f of before) if (whtml.includes(`/${f}`)) welcome.add(f);
  let w = { raw: 0, brotli: 0 };
  console.log('Welcome page (welcome.html):');
  for (const file of welcome) {
    const s = sizes(file);
    w = { raw: w.raw + s.raw, brotli: w.brotli + s.brotli };
    console.log(`  ${file.padEnd(48)} ${kb(s.raw).padStart(10)} raw ${kb(s.brotli).padStart(9)} brotli`);
  }
  console.log(`  ${'Total'.padEnd(48)} ${kb(w.raw).padStart(10)} raw ${kb(w.brotli).padStart(9)} brotli`);
} catch {
  // no welcome.html (old build): nothing
}
console.log('Lazily loaded (on demand only):');
for (const file of readdirSync(join(dist, 'assets'))) {
  const path = `assets/${file}`;
  if (initial.has(path) || welcome.has(path) || !/\.(js|css)$/.test(file)) continue;
  const s = sizes(path);
  console.log(`  ${path.padEnd(48)} ${kb(s.raw).padStart(10)} raw ${kb(s.brotli).padStart(9)} brotli`);
}
