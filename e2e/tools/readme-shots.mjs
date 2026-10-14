#!/usr/bin/env node
// Screenshots for README.md: list, issue detail and command menu, dark and light, English, demo data only.
// Usage: node e2e/tools/readme-shots.mjs <base-url> <output-dir>
// Start the app with `pnpm dev` first (sample data). Output is PNG; docs/images/ holds the compressed WebP
// versions: for f in <output-dir>/*.png; do magick $f -quality 82 -define webp:method=6 docs/images/$(basename $f .png).webp; done
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [base = 'http://127.0.0.1:5412', out = '/tmp/selfbound-readme'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();

async function ready(p, path) {
  await p.goto(base + path);
  await p.waitForSelector('[data-testid="issue-row"]', { timeout: 20000 });
  await p.mouse.move(1430, 890);
  await p.waitForTimeout(800);
}

const scenes = {
  async list(p) {
    await ready(p, '/team/ORB');
    await p.keyboard.press('j');
    await p.keyboard.press('j');
  },
  async detail(p) {
    await ready(p, '/team/ORB');
    await p.keyboard.press('j');
    await p.keyboard.press('Enter');
    await p.waitForSelector('[data-testid="detail"]');
    await p.waitForTimeout(900);
  },
  async command(p) {
    await ready(p, '/team/ORB');
    await p.keyboard.press('Control+k');
    await p.waitForTimeout(400);
  },
};

for (const scheme of ['dark', 'light']) {
  for (const [name, run] of Object.entries(scenes)) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: scheme,
      locale: 'en-US',
      timezoneId: 'Europe/Berlin',
    });
    const p = await context.newPage();
    await run(p);
    await p.screenshot({ path: join(out, `${name}-${scheme}.png`) });
    await context.close();
  }
}
await browser.close();
console.log(`Screenshots in ${out}`);
