#!/usr/bin/env node
// Generates all logo files from the original (app/public/brand/xlr8-logo-original.svg):
// mark (star), wordmark ("XLR8") and full logo as SVG, colour variants, favicon, app icons
// (PNG, ICO), social image and web manifest. The shapes stay unchanged; the path is only split
// into its subpaths and cropped via viewBox.
//
// Usage:  node tooling/brand.mjs        (needs rsvg-convert and ImageMagick)
//
// Never edit the original by hand; put a new version there and run the script again.
// Output file names: xlr8-mark, xlr8-wordmark, xlr8-logo, each also -black and -white

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const pub = join(root, 'app', 'public');
const brand = join(pub, 'brand');
const original = readFileSync(join(brand, 'xlr8-logo-original.svg'), 'utf8');

// ---- Subpaths; the star is the only one starting at x = 0, the lettering starts to its right.
const d = original.match(/ d="([^"]+)"/)[1];
const subs = d.split(/(?=M)/).map((s) => s.trim()).filter(Boolean).map((s) => {
  const n = s.replace(/[MZ]/g, ' ').trim().split(/\s+/).map(Number);
  const xs = n.filter((_, i) => i % 2 === 0);
  const ys = n.filter((_, i) => i % 2 === 1);
  return { s, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
});
const mark = subs.filter((p) => p.maxX <= 140);
const word = subs.filter((p) => p.minX > 140);
if (mark.length !== 1 || mark.length + word.length !== subs.length) throw new Error('Unexpected subpaths in the original');
const bounds = (ps) => {
  const minX = Math.min(...ps.map((p) => p.minX)), minY = Math.min(...ps.map((p) => p.minY));
  const maxX = Math.max(...ps.map((p) => p.maxX)), maxY = Math.max(...ps.map((p) => p.maxY));
  const r = (v) => Math.round(v * 100) / 100;
  return { x: r(minX), y: r(minY), w: r(maxX - minX), h: r(maxY - minY) };
};
const markPath = mark.map((p) => p.s).join('');
const wordPath = word.map((p) => p.s).join('');
const mb = bounds(mark);
const wb = bounds(word);
const lb = { x: 0, y: 0, w: 581.89, h: 138.62 };

const BLACK = '#000000';
const WHITE = '#ffffff';
const DARK_BG = '#101113';

const logoSvg = (b, path, fill, title, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.x} ${b.y} ${b.w} ${b.h}" width="${b.w}" height="${b.h}" role="img" aria-label="${title}">\n<title>${title}</title>\n<path fill="${fill}" fill-rule="evenodd"${extra} d="${path}"/>\n</svg>\n`;

const parts = [
  ['mark', mb, markPath, 'XLR8 mark'],
  ['wordmark', wb, wordPath, 'XLR8 wordmark'],
  ['logo', lb, d, 'XLR8 Logo'],
];
for (const [name, b, path, title] of parts) {
  writeFileSync(join(brand, `xlr8-${name}.svg`), logoSvg(b, path, 'currentColor', title));
  writeFileSync(join(brand, `xlr8-${name}-black.svg`), logoSvg(b, path, BLACK, title));
  writeFileSync(join(brand, `xlr8-${name}-white.svg`), logoSvg(b, path, WHITE, title));
}

// ---- Favicon: star with padding, follows the browser's colour scheme.
const pad = 12;
writeFileSync(
  join(pub, 'favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${mb.w + 2 * pad} ${mb.h + 2 * pad}">\n<title>XLR8</title>\n<style>path{fill:${BLACK}}@media (prefers-color-scheme:dark){path{fill:${WHITE}}}</style>\n<path fill-rule="evenodd" d="${markPath}"/>\n</svg>\n`,
);

// ---- PNG sources: white star on a dark background (readable everywhere, in light and dark tabs).
const tile = (size, share, radiusShare) => {
  const k = (size * share) / mb.w;
  const o = (size - mb.w * k) / 2;
  const rect = `<rect width="${size}" height="${size}" rx="${size * radiusShare}" fill="${DARK_BG}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${rect}<g transform="translate(${o} ${o}) scale(${k})"><path fill="${WHITE}" fill-rule="evenodd" d="${markPath}"/></g></svg>`;
};
// Status bar icon for notifications (Android uses only the alpha channel): white star, transparent.
const badge = (size) => {
  const k = (size * 0.84) / mb.w;
  const o = (size - mb.w * k) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><g transform="translate(${o} ${o}) scale(${k})"><path fill="${WHITE}" fill-rule="evenodd" d="${markPath}"/></g></svg>`;
};
const og = () => {
  const w = 1200, h = 630, lw = 640;
  const k = lw / lb.w;
  const lh = lb.h * k;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${DARK_BG}"/><g transform="translate(${(w - lw) / 2} ${(h - lh) / 2}) scale(${k})"><path fill="${WHITE}" fill-rule="evenodd" d="${d}"/></g></svg>`;
};

const tmp = mkdtempSync(join(tmpdir(), 'xlr8-brand-'));
function png(name, svg, size, outDir = brand) {
  const src = join(tmp, `${name}.svg`);
  writeFileSync(src, svg);
  const args = ['-w', String(size[0]), '-h', String(size[1]), '-o', join(outDir, `${name}.png`), src];
  const r = spawnSync('rsvg-convert', args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`rsvg-convert failed: ${name}`);
}
mkdirSync(brand, { recursive: true });
// Favicons: small padding, rounded; the large versions with more room.
for (const s of [16, 32, 48]) png(`favicon-${s}`, tile(s, s === 16 ? 0.84 : 0.76, 0.2), [s, s], pub);
png('apple-touch-icon', tile(180, 0.6, 0), [180, 180], pub); // iOS rounds the corners itself
png('icon-192', tile(192, 0.62, 0.2), [192, 192], pub);
png('icon-512', tile(512, 0.62, 0.2), [512, 512], pub);
png('icon-maskable-512', tile(512, 0.52, 0), [512, 512], pub); // star inside the safe zone (80 %)
png('badge-96', badge(96), [96, 96], pub);
png('og-image', og(), [1200, 630], brand);
png('clerk-logo', tile(512, 0.62, 0.2), [512, 512], brand);
const ico = spawnSync('magick', [join(pub, 'favicon-16.png'), join(pub, 'favicon-32.png'), join(pub, 'favicon-48.png'), join(pub, 'favicon.ico')], { stdio: 'inherit' });
if (ico.status !== 0) throw new Error('magick failed');
rmSync(tmp, { recursive: true, force: true });

writeFileSync(
  join(pub, 'site.webmanifest'),
  JSON.stringify(
    {
      // Installable app. `/` is the last visited view (the welcome page when signed out).
      id: '/',
      name: 'XLR8',
      short_name: 'XLR8',
      description: 'Issues, sprints and projects.',
      lang: 'en',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: DARK_BG,
      theme_color: DARK_BG,
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
writeFileSync(
  join(root, 'app', 'src', 'lib', 'brand.ts'),
  `// Generated by tooling/brand.mjs from app/public/brand/xlr8-logo-original.svg. Do not edit by hand.\nexport const BRAND = {\n  mark: { viewBox: '${mb.x} ${mb.y} ${mb.w} ${mb.h}', ratio: ${mb.w / mb.h}, d: '${markPath}' },\n  word: { viewBox: '${wb.x} ${wb.y} ${wb.w} ${wb.h}', ratio: ${wb.w / wb.h}, d: '${wordPath}' },\n  full: { viewBox: '${lb.x} ${lb.y} ${lb.w} ${lb.h}', ratio: ${lb.w / lb.h}, d: '${d}' },\n} as const;\n`,
);
console.log('Logo files generated in', pub);
