#!/usr/bin/env node
// Generates every logo file from the two source files in brand/:
//   brand/logo.svg   the logo (wordmark, or symbol + wordmark)
//   brand/mark.svg   the compact symbol (favicon, app icons, loading screen, landing page background)
// Outputs: SVG variants, favicons, app icons (PNG, ICO), social image, web manifest, the inline paths
// for the app (app/src/lib/brand.ts) and the copies for the landing page and the docs site.
//
// Usage:  node tooling/brand.mjs        (needs rsvg-convert and ImageMagick)
//
// Source files: outlined shapes only (<path>, no text, strokes, gradients or transforms), one colour,
// a viewBox. Drop new files over the old ones and run the script again; see docs/brand.md.

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

const BLACK = '#000000';
const WHITE = '#ffffff';
const DARK_BG = '#101113';

function readShape(file) {
  const svg = readFileSync(join(src, file), 'utf8');
  const bad = svg.match(/<(text|image|rect|circle|ellipse|line|polyline|polygon|linearGradient|radialGradient|clipPath|mask|use)\b/);
  if (bad) throw new Error(`${file}: <${bad[1]}> is not supported, convert everything to outlined paths`);
  if (/\btransform=|\bstroke=|stroke:/.test(svg)) throw new Error(`${file}: transform and stroke are not supported, outline them`);
  const vb = svg.match(/viewBox="([^"]+)"/)?.[1].trim().split(/[\s,]+/).map(Number);
  if (!vb || vb.length !== 4 || vb.some(Number.isNaN)) throw new Error(`${file}: viewBox missing`);
  const tags = [...svg.matchAll(/<path\b[^>]*>/g)].map((m) => m[0]);
  if (!tags.length) throw new Error(`${file}: no <path> found`);
  const paths = tags.map((t) => t.match(/\sd="([^"]+)"/)?.[1]).filter(Boolean);
  if (paths.length !== tags.length) throw new Error(`${file}: <path> without d`);
  const rules = new Set(tags.map((t) => t.match(/fill-rule="([^"]+)"/)?.[1] ?? 'nonzero'));
  if (rules.size !== 1) throw new Error(`${file}: mixed fill-rule`);
  const [x, y, w, h] = vb;
  return { viewBox: vb.join(' '), x, y, w, h, ratio: Math.round((w / h) * 1e4) / 1e4, paths, rule: [...rules][0] };
}

const mark = readShape('mark.svg');
const logo = readShape('logo.svg');
const LABEL = 'Selfbound';

const shapeSvg = (s, fill, title) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${s.viewBox}" width="${s.w}" height="${s.h}" role="img" aria-label="${title}">\n<title>${title}</title>\n${s.paths
    .map((d) => `<path fill="${fill}" fill-rule="${s.rule}" d="${d}"/>`)
    .join('\n')}\n</svg>\n`;
const pathsIn = (s, fill) => s.paths.map((d) => `<path fill="${fill}" fill-rule="${s.rule}" d="${d}"/>`).join('');

mkdirSync(brand, { recursive: true });
for (const [name, s, title] of [['mark', mark, `${LABEL} mark`], ['logo', logo, LABEL]]) {
  writeFileSync(join(brand, `selfbound-${name}.svg`), shapeSvg(s, 'currentColor', title));
  writeFileSync(join(brand, `selfbound-${name}-black.svg`), shapeSvg(s, BLACK, title));
  writeFileSync(join(brand, `selfbound-${name}-white.svg`), shapeSvg(s, WHITE, title));
}

// ---- Favicon: symbol with padding, follows the browser's colour scheme.
const pad = Math.max(mark.w, mark.h) * 0.12;
writeFileSync(
  join(pub, 'favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${mark.x - pad} ${mark.y - pad} ${mark.w + 2 * pad} ${mark.h + 2 * pad}">\n<title>${LABEL}</title>\n<style>path{fill:${BLACK}}@media (prefers-color-scheme:dark){path{fill:${WHITE}}}</style>\n${mark.paths
    .map((d) => `<path fill-rule="${mark.rule}" d="${d}"/>`)
    .join('\n')}\n</svg>\n`,
);

// ---- Raster sources: white symbol on a dark background (readable everywhere, in light and dark tabs).
const place = (s, box, share) => {
  const k = (box * share) / Math.max(s.w, s.h);
  return `translate(${(box - s.w * k) / 2 - s.x * k} ${(box - s.h * k) / 2 - s.y * k}) scale(${k})`;
};
const tile = (size, share, radiusShare) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${size * radiusShare}" fill="${DARK_BG}"/><g transform="${place(mark, size, share)}">${pathsIn(mark, WHITE)}</g></svg>`;
// Status bar icon for notifications (Android uses only the alpha channel): white symbol, transparent.
const badge = (size) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><g transform="${place(mark, size, 0.84)}">${pathsIn(mark, WHITE)}</g></svg>`;
const og = () => {
  const w = 1200, h = 630, lw = 560;
  const k = lw / logo.w;
  const lh = logo.h * k;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${DARK_BG}"/><g transform="translate(${(w - lw) / 2 - logo.x * k} ${(h - lh) / 2 - logo.y * k}) scale(${k})">${pathsIn(logo, WHITE)}</g></svg>`;
};

const tmp = mkdtempSync(join(tmpdir(), 'selfbound-brand-'));
function png(name, svg, size, outDir = brand) {
  const file = join(tmp, `${name}.svg`);
  writeFileSync(file, svg);
  const r = spawnSync('rsvg-convert', ['-w', String(size[0]), '-h', String(size[1]), '-o', join(outDir, `${name}.png`), file], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`rsvg-convert failed: ${name}`);
}
// Favicons: small padding, rounded; the large versions with more room.
for (const s of [16, 32, 48]) png(`favicon-${s}`, tile(s, s === 16 ? 0.84 : 0.7, 0.2), [s, s], pub);
png('apple-touch-icon', tile(180, 0.56, 0), [180, 180], pub); // iOS rounds the corners itself
png('icon-192', tile(192, 0.56, 0.2), [192, 192], pub);
png('icon-512', tile(512, 0.56, 0.2), [512, 512], pub);
png('icon-maskable-512', tile(512, 0.46, 0), [512, 512], pub); // symbol inside the safe zone (80 %)
png('badge-96', badge(96), [96, 96], pub);
png('og-image', og(), [1200, 630], brand);
png('clerk-logo', tile(512, 0.56, 0.2), [512, 512], brand);
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
const entry = (s) => `{ viewBox: '${s.viewBox}', ratio: ${s.ratio}, rule: '${s.rule}', paths: [${s.paths.map((d) => `'${d}'`).join(', ')}] }`;
writeFileSync(
  join(root, 'app', 'src', 'lib', 'brand.ts'),
  `// Generated by tooling/brand.mjs from brand/logo.svg and brand/mark.svg. Do not edit by hand.\nexport const BRAND = {\n  mark: ${entry(mark)},\n  logo: ${entry(logo)},\n} as const;\n`,
);

// ---- Copies for the landing page and the docs site.
for (const f of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png']) {
  copyFileSync(join(pub, f), join(sitePub, f));
  copyFileSync(join(pub, f), join(docsPub, f));
}
copyFileSync(join(pub, 'favicon-32.png'), join(sitePub, 'favicon-32.png'));
mkdirSync(join(sitePub, 'brand'), { recursive: true });
copyFileSync(join(brand, 'selfbound-logo.svg'), join(sitePub, 'brand', 'selfbound-logo.svg'));
copyFileSync(join(brand, 'selfbound-mark.svg'), join(sitePub, 'brand', 'selfbound-mark.svg'));
copyFileSync(join(brand, 'og-image.png'), join(sitePub, 'brand', 'og.png'));
copyFileSync(join(brand, 'og-image.png'), join(docsPub, 'og-image.png'));
copyFileSync(join(brand, 'selfbound-logo-black.svg'), join(docsAssets, 'logo-light.svg'));
copyFileSync(join(brand, 'selfbound-logo-white.svg'), join(docsAssets, 'logo-dark.svg'));
console.log('Logo files generated from brand/ in app/public, site/public, docs-site');
