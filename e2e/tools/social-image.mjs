#!/usr/bin/env node
// Social image (1200x630) for the landing page: logo, headline and a cut-off screenshot of the app.
// Usage: node e2e/tools/social-image.mjs <screenshot.png> <output.png>
// The screenshot is a still from demo-video.mjs (--shots), sample data only. Inter comes from the landing
// page's dependency, the logo from app/public/brand.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { chromium } = createRequire(join(root, 'e2e', 'package.json'))('@playwright/test');
const [shot, out] = process.argv.slice(2);
if (!shot || !out) throw new Error('usage: social-image.mjs <screenshot.png> <output.png>');

const font = createRequire(join(root, 'site', 'package.json')).resolve('@fontsource-variable/inter/files/inter-latin-wght-normal.woff2');
const b64 = (file) => readFileSync(file).toString('base64');
const logo = readFileSync(join(root, 'app', 'public', 'brand', 'selfbound-lockup-paper.svg'), 'utf8');

const html = `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: Inter; font-weight: 100 900; src: url(data:font/woff2;base64,${b64(font)}) format('woff2'); }
* { box-sizing: border-box; margin: 0; }
body { width: 1200px; height: 630px; overflow: hidden; position: relative; background: #0d0d10; color: #fff; font-family: Inter, sans-serif;
  background-image: radial-gradient(circle at 50% 0%, #1d1d33 0, transparent 60%); }
.logo { position: absolute; left: 64px; top: 52px; width: 190px; height: auto; }
.logo svg { display: block; width: 190px; height: auto; }
h1 { position: absolute; left: 64px; top: 112px; width: 1000px; font-size: 54px; line-height: 1.08; letter-spacing: -0.035em; font-weight: 650; }
p { position: absolute; left: 64px; top: 258px; font-size: 22px; color: #a3a3b0; letter-spacing: -0.005em; }
.shot { position: absolute; left: 64px; top: 322px; width: 1072px; border-radius: 14px 14px 0 0; border: 1px solid #ffffff22; border-bottom: 0; overflow: hidden;
  box-shadow: 0 -10px 60px #00000099; }
.shot img { display: block; width: 100%; }
</style>
<div class="logo">${logo.replace(/ width="[^"]*" height="[^"]*"/, '')}</div>
<h1>The issue tracker for solo developers and their AI agents.</h1>
<p>Keyboard-first. Self-hosted. Open to agents over MCP.</p>
<div class="shot"><img src="data:image/png;base64,${b64(shot)}"></div>`;

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out });
await browser.close();
console.log(out);
