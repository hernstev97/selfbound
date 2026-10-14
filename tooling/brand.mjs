#!/usr/bin/env node
// Generates every logo file from the four source files in brand/:
//   brand/symbol.svg    the symbol (loading screen, app icons, animated landing page background)
//   brand/wordmark.svg  the lettering "Selfbound"
//   brand/lockup.svg    symbol + wordmark (headers, sign-in screen, social image)
//   brand/favicon.svg   the symbol simplified for 16 px (favicons)
// Outputs: SVG variants, favicons, app icons (PNG, ICO), social image, web manifest, the inline paths
// for the app (app/src/lib/brand.ts) and the copies for the landing page and the docs site.
//
// Usage:  node tooling/brand.mjs        (needs rsvg-convert and ImageMagick)
//
// Source files: outlined shapes only (<path>, optional translate/scale transform; no text, strokes,
// gradients or masks), one colour (replaced by the two brand colours below), a viewBox.
// Drop new files over the old ones and run the script again; see docs/brand.md.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const src = join(root, 'brand');
const pub = join(root, 'app', 'public');
const brand = join(pub, 'brand');
const sitePub = join(root, 'site', 'public');
const docsPub = join(root, 'docs-site', 'public');
const docsAssets = join(root, 'docs-site', 'src', 'assets');

// The only two colours: white (--text-strong) and the dark theme's --bg-app, oklch(0.129 0.0009 286) in sRGB.
const INK = '#070707';
const PAPER = '#FFFFFF';
const LABEL = 'Selfbound';

function readShape(file) {
  const svg = readFileSync(join(src, file), 'utf8');
  const bad = svg.match(/<(text|image|rect|circle|ellipse|line|polyline|polygon|linearGradient|radialGradient|clipPath|mask|use|g)\b/);
  if (bad) throw new Error(`${file}: <${bad[1]}> is not supported, convert everything to outlined paths`);
  if (/\bstroke=|stroke:/.test(svg)) throw new Error(`${file}: strokes are not supported, outline them`);
  const vb = svg.match(/viewBox="([^"]+)"/)?.[1].trim().split(/[\s,]+/).map(Number);
  if (!vb || vb.length !== 4 || vb.some(Number.isNaN)) throw new Error(`${file}: viewBox missing`);
  const tags = [...svg.matchAll(/<path\b[^>]*>/g)].map((m) => m[0]);
  if (!tags.length) throw new Error(`${file}: no <path> found`);
  const paths = tags.map((t) => {
    const d = t.match(/\sd="([^"]+)"/)?.[1];
    if (!d) throw new Error(`${file}: <path> without d`);
    const transform = t.match(/\stransform="([^"]+)"/)?.[1];
    if (transform && !/^(translate\([^()]*\)|scale\([^()]*\)|\s)+$/.test(transform)) throw new Error(`${file}: only translate and scale transforms are supported`);
    return transform ? { d, transform } : { d };
  });
  const rules = new Set(tags.map((t) => t.match(/fill-rule="([^"]+)"/)?.[1] ?? 'nonzero'));
  if (rules.size !== 1) throw new Error(`${file}: mixed fill-rule`);
  const [x, y, w, h] = vb;
  return { viewBox: vb.join(' '), x, y, w, h, ratio: Math.round((w / h) * 1e4) / 1e4, paths, rule: [...rules][0] };
}

const symbol = readShape('symbol.svg');
const wordmark = readShape('wordmark.svg');
const lockup = readShape('lockup.svg');
const small = readShape('favicon.svg');

const attrs = (p) => (p.transform ? ` transform="${p.transform}"` : '');
const pathsIn = (s, fill) => s.paths.map((p) => `<path fill="${fill}" fill-rule="${s.rule}"${attrs(p)} d="${p.d}"/>`).join('');
const shapeSvg = (s, fill, title) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${s.viewBox}" width="${s.w}" height="${s.h}" role="img" aria-label="${title}">\n<title>${title}</title>\n${s.paths
    .map((p) => `<path fill="${fill}" fill-rule="${s.rule}"${attrs(p)} d="${p.d}"/>`)
    .join('\n')}\n</svg>\n`;

mkdirSync(brand, { recursive: true });
for (const [name, s] of [['symbol', symbol], ['wordmark', wordmark], ['lockup', lockup]]) {
  writeFileSync(join(brand, `selfbound-${name}.svg`), shapeSvg(s, 'currentColor', LABEL));
  writeFileSync(join(brand, `selfbound-${name}-ink.svg`), shapeSvg(s, INK, LABEL));
  writeFileSync(join(brand, `selfbound-${name}-paper.svg`), shapeSvg(s, PAPER, LABEL));
}

// ---- Favicon: simplified symbol, ink on light tabs and paper on dark tabs.
writeFileSync(
  join(pub, 'favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${small.viewBox}">\n<title>${LABEL}</title>\n<style>path{fill:${INK}}@media (prefers-color-scheme:dark){path{fill:${PAPER}}}</style>\n${small.paths
    .map((p) => `<path fill-rule="${small.rule}"${attrs(p)} d="${p.d}"/>`)
    .join('\n')}\n</svg>\n`,
);

// ---- Raster sources: paper symbol on an ink tile (readable everywhere, in light and dark tabs).
const place = (s, box, share) => {
  const k = (box * share) / Math.max(s.w, s.h);
  return `translate(${(box - s.w * k) / 2 - s.x * k} ${(box - s.h * k) / 2 - s.y * k}) scale(${k})`;
};
const tile = (s, size, share, radiusShare) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${size * radiusShare}" fill="${INK}"/><g transform="${place(s, size, share)}">${pathsIn(s, PAPER)}</g></svg>`;
// Status bar icon for notifications (Android uses only the alpha channel): paper symbol, transparent.
const badge = (size) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><g transform="${place(symbol, size, 0.84)}">${pathsIn(symbol, PAPER)}</g></svg>`;
const og = () => {
  const w = 1200, h = 630, lw = 640;
  const k = lw / lockup.w;
  const lh = lockup.h * k;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${INK}"/><g transform="translate(${(w - lw) / 2 - lockup.x * k} ${(h - lh) / 2 - lockup.y * k}) scale(${k})">${pathsIn(lockup, PAPER)}</g></svg>`;
};

const tmp = mkdtempSync(join(tmpdir(), 'selfbound-brand-'));
function png(name, svg, size, outDir = brand) {
  const file = join(tmp, `${name}.svg`);
  writeFileSync(file, svg);
  const r = spawnSync('rsvg-convert', ['-w', String(size[0]), '-h', String(size[1]), '-o', join(outDir, `${name}.png`), file], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`rsvg-convert failed: ${name}`);
}
// App icon proportions: symbol 56 % of the tile, corner radius 22.5 %. Favicons use the simplified symbol.
const APP = [0.5625, 0.225];
// The simplified symbol fills the whole tile: its 2-unit gap then lands on whole pixels (16 → 2 px, 32 → 4 px, 48 → 6 px).
for (const s of [16, 32, 48]) png(`favicon-${s}`, tile(small, s, 1, 0.2), [s, s], pub);
png('apple-touch-icon', tile(symbol, 180, APP[0], 0), [180, 180], pub); // iOS rounds the corners itself
png('icon-192', tile(symbol, 192, APP[0], APP[1]), [192, 192], pub);
png('icon-512', tile(symbol, 512, APP[0], APP[1]), [512, 512], pub);
png('icon-maskable-512', tile(symbol, 512, 0.47, 0), [512, 512], pub); // symbol inside the safe zone (80 %)
png('badge-96', badge(96), [96, 96], pub);
png('og-image', og(), [1200, 630], brand);
png('clerk-logo', tile(symbol, 512, APP[0], APP[1]), [512, 512], brand);
const ico = spawnSync('magick', [join(pub, 'favicon-16.png'), join(pub, 'favicon-32.png'), join(pub, 'favicon-48.png'), join(pub, 'favicon.ico')], { stdio: 'inherit' });
if (ico.status !== 0) throw new Error('magick failed');
rmSync(tmp, { recursive: true, force: true });

writeFileSync(
  join(pub, 'site.webmanifest'),
  JSON.stringify(
    {
      // Installable app. `/` is the last visited view (the welcome page when signed out).
      id: '/',
      name: LABEL,
      short_name: LABEL,
      description: 'Issues, sprints and projects.',
      lang: 'en',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: INK,
      theme_color: INK,
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
      ],
      shortcuts: [
        { name: 'Inbox', url: '/inbox', icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }] },
        { name: 'New issue', url: '/new', icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }] },
      ],
      // Sharing from other apps: lands as an issue in the inbox (app/src/lib/pwa/share.ts).
      share_target: { action: '/share', method: 'GET', enctype: 'application/x-www-form-urlencoded', params: { title: 'title', text: 'text', url: 'url' } },
    },
    null,
    2,
  ) + '\n',
);

// ---- Paths for the app (inline SVG with currentColor, no request).
const q = (v) => `'${v}'`;
const entry = (s) =>
  `{ viewBox: ${q(s.viewBox)}, ratio: ${s.ratio}, rule: ${q(s.rule)}, paths: [${s.paths.map((p) => `{ d: ${q(p.d)}${p.transform ? `, transform: ${q(p.transform)}` : ''} }`).join(', ')}] }`;
writeFileSync(
  join(root, 'app', 'src', 'lib', 'brand.ts'),
  `// Generated by tooling/brand.mjs from brand/*.svg. Do not edit by hand.\nexport const BRAND = {\n  symbol: ${entry(symbol)},\n  wordmark: ${entry(wordmark)},\n  lockup: ${entry(lockup)},\n} as const;\n`,
);

// ---- Copies for the landing page and the docs site.
for (const f of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png']) {
  copyFileSync(join(pub, f), join(sitePub, f));
  copyFileSync(join(pub, f), join(docsPub, f));
}
copyFileSync(join(pub, 'favicon-32.png'), join(sitePub, 'favicon-32.png'));
mkdirSync(join(sitePub, 'brand'), { recursive: true });
for (const f of ['selfbound-lockup.svg', 'selfbound-symbol.svg']) copyFileSync(join(brand, f), join(sitePub, 'brand', f));
copyFileSync(join(brand, 'og-image.png'), join(sitePub, 'brand', 'og.png'));
copyFileSync(join(brand, 'og-image.png'), join(docsPub, 'og-image.png'));
copyFileSync(join(brand, 'selfbound-lockup-ink.svg'), join(docsAssets, 'logo-light.svg'));
copyFileSync(join(brand, 'selfbound-lockup-paper.svg'), join(docsAssets, 'logo-dark.svg'));
console.log('Logo files generated from brand/ in app/public, site/public, docs-site');
