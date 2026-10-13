// Size of the initial bundle (brotli): index.html, entry, static imports and CSS, without lazily
// loaded chunks. Same rule as tooling/bundle-size.mjs, here for the builds of a performance run.
// Unlike the bytes transferred on cold start, this number does not depend on timing: in CI those
// varied between about 200 and 300 kB depending on which lazy chunks were already loaded.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';

export function startBundleBytes(dist: string): number {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const files = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    if (!file.endsWith('.js')) return;
    const code = readFileSync(join(dist, file), 'utf8');
    // Only static imports (import … from "./x.js"), not import("./x.js").
    for (const m of code.matchAll(/(?:^|[;\n}])\s*import\s*(?:[\w${},\s*]+from\s*)?["']\.\/([^"']+)["']/g)) visit(`assets/${m[1]}`);
  };
  for (const m of html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)) visit(m[1]);
  const brotli = (buf: Buffer) => brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  let total = brotli(Buffer.from(html));
  for (const file of files) total += brotli(readFileSync(join(dist, file)));
  return total;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dist = process.argv[2] ?? join(import.meta.dirname, '.dist', 'p1');
  console.log(`Initial bundle ${dist}: ${(startBundleBytes(dist) / 1024).toFixed(1)} kB brotli`);
}
