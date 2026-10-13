#!/usr/bin/env node
// Screenshots of the running app (e.g. for pull requests and visual review).
// Usage: node e2e/tools/shoot.mjs <base-url> <output-dir> [scene …]
// Scenes: see `scenes` and `mobileScenes` below (list, list-light, peek, detail, command, picker, context, create, inbox, triage, mobile, …).
// SCALE=2 for 2x screenshots, CLIP=x,y,w,h for a crop.
import { chromium, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [base = 'http://127.0.0.1:5462', out = '/tmp/xlr8-f1', ...only] = process.argv.slice(2);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const errors = [];

async function page(opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: Number(process.env.SCALE ?? 1), colorScheme: 'dark', ...opts });
  const p = await context.newPage();
  p.on('pageerror', (e) => errors.push(`${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  return p;
}

async function ready(p, path) {
  await p.goto(base + path);
  await p.waitForSelector('[data-testid="issue-row"], [data-testid="empty-state"], [data-testid="detail"], [data-testid="plan-create"]', { timeout: 20000 });
  await p.mouse.move(1430, 890);
  await p.waitForTimeout(400);
}

const scenes = {
  async list(p) {
    await ready(p, '/team/ORB');
  },
  async 'list-light'(p) {
    await p.emulateMedia({ colorScheme: 'light' });
    await ready(p, '/team/ORB');
  },
  async 'all-team'(p) {
    await ready(p, '/all');
  },
  async peek(p) {
    await ready(p, '/team/NOVA');
    await p.keyboard.press('j');
    await p.keyboard.press('j');
    await p.keyboard.press(' ');
    await p.waitForTimeout(500);
  },
  async detail(p) {
    await ready(p, '/team/ORB');
    await p.keyboard.press('Enter');
    await p.waitForSelector('[data-testid="detail"]');
    await p.waitForTimeout(800);
  },
  async 'detail-activity'(p) {
    await ready(p, '/team/ORB');
    await p.keyboard.press('j');
    await p.keyboard.press('Enter');
    await p.waitForSelector('[data-testid="activity"]');
    await p.waitForTimeout(600);
    await p.locator('.detail-main').evaluate((el) => (el.scrollTop = el.scrollHeight));
    await p.waitForTimeout(200);
  },
  async 'detail-light'(p) {
    await p.emulateMedia({ colorScheme: 'light' });
    await ready(p, '/team/NOVA');
    await p.keyboard.press('Enter');
    await p.waitForSelector('[data-testid="detail"]');
    await p.waitForTimeout(800);
  },
  async 'peek-light'(p) {
    await p.emulateMedia({ colorScheme: 'light' });
    await ready(p, '/all');
    await p.keyboard.press('j');
    await p.keyboard.press(' ');
    await p.waitForTimeout(500);
  },
  async trash(p) {
    await ready(p, '/trash');
  },
  async sprint(p) {
    await ready(p, '/sprint');
  },
  async 'sprint-light'(p) {
    await p.emulateMedia({ colorScheme: 'light' });
    await ready(p, '/sprint');
  },
  async plan(p) {
    await ready(p, '/sprint/plan');
    await p.waitForTimeout(400);
  },
  async 'plan-light'(p) {
    await p.emulateMedia({ colorScheme: 'light' });
    await ready(p, '/sprint/plan');
    await p.waitForTimeout(400);
  },
  async close(p) {
    await ready(p, '/sprint/close');
    for (const key of ['1', '1', '2', '3']) await p.keyboard.press(key);
    await p.keyboard.press('x');
    await p.keyboard.press('Shift+j');
    await p.waitForTimeout(200);
  },
  async sprints(p) {
    await p.goto(base + '/sprints');
    await p.waitForSelector('[data-testid="sprint-row"]');
    await p.waitForTimeout(600);
  },
  async 'settings-team'(p) {
    await p.goto(base + '/settings/teams/ORB');
    await p.waitForSelector('[data-testid="team-detail"]');
    await p.waitForTimeout(400);
  },
  async 'settings-agents'(p) {
    await p.goto(base + '/settings/agents');
    await p.waitForSelector('[data-testid="agent-row"]');
    await p.waitForTimeout(300);
  },
  async 'settings-ops'(p) {
    await p.goto(base + '/settings/ops');
    await p.waitForSelector('[data-testid="ops-page"]');
    await p.waitForTimeout(300);
  },
  async 'settings-labels'(p) {
    await p.goto(base + '/settings/labels');
    await p.waitForSelector('[data-testid="label-row"]');
    await p.waitForTimeout(300);
  },
  async projects(p) {
    await p.goto(base + '/team/ORB/projects');
    await p.waitForSelector('[data-testid="projects-page"]');
    await p.waitForTimeout(400);
  },
  async settings(p) {
    await p.goto(base + '/settings');
    await p.waitForSelector('[data-testid="settings-page"]');
    await p.waitForTimeout(400);
  },
  async help(p) {
    await ready(p, '/team/ORB');
    await p.keyboard.press('?');
    await p.waitForTimeout(200);
  },
  async filter(p) {
    await ready(p, '/team/ORB');
    await p.keyboard.press('f');
    await p.waitForTimeout(200);
  },
  async due(p) {
    await ready(p, '/team/ORB');
    await p.keyboard.press('Shift+D');
    await p.keyboard.type('end of week');
    await p.waitForTimeout(200);
  },
  async command(p) {
    await ready(p, '/team/ORB');
    await p.keyboard.press('Control+k');
    await p.waitForTimeout(200);
  },
  async picker(p) {
    await ready(p, '/team/ORB');
    await p.keyboard.press('s');
    await p.waitForTimeout(200);
  },
  async labels(p) {
    await ready(p, '/team/ORB');
    await p.getByTestId('issue-row').nth(2).getByTestId('row-status').click();
    await p.waitForTimeout(200);
  },
  async context(p) {
    await ready(p, '/team/ORB');
    const row = p.getByTestId('issue-row').nth(3);
    const box = await row.boundingBox();
    await p.mouse.click(box.x + 420, box.y + 20, { button: 'right' });
    await p.waitForTimeout(150);
    await p.getByTestId('context-item').filter({ hasText: 'Priority' }).hover();
    await p.waitForTimeout(200);
  },
  async create(p) {
    await ready(p, '/team/ORB');
    await p.keyboard.press('c');
    await p.keyboard.type('Load the start screen faster');
    await p.waitForTimeout(200);
  },
  async inbox(p) {
    await ready(p, '/inbox');
  },
  async triage(p) {
    await ready(p, '/triage');
  },
  async display(p) {
    await ready(p, '/team/ORB');
    await p.keyboard.press('Shift+V');
    await p.waitForTimeout(200);
  },
  async search(p) {
    await ready(p, '/team/ORB');
    await p.keyboard.press('/');
    await p.keyboard.type('export');
    await p.waitForTimeout(600);
  },
};

const mobileScenes = {
  async mobile(p) {
    await ready(p, '/team/ORB');
  },
  async 'mobile-sprint'(p) {
    await ready(p, '/sprint');
  },
  async 'mobile-plan'(p) {
    await ready(p, '/sprint/plan');
  },
  async 'mobile-detail'(p) {
    await ready(p, '/team/ORB');
    await p.getByTestId('issue-row').nth(1).click();
    await p.waitForSelector('[data-testid="detail"]');
    await p.waitForTimeout(600);
  },
  async 'mobile-drawer'(p) {
    await ready(p, '/team/ORB');
    await p.getByTestId('mobile-menu').click();
    await p.waitForTimeout(300);
  },
};

for (const [name, run] of Object.entries(scenes)) {
  if (only.length && !only.includes(name)) continue;
  const p = await page();
  await run(p);
  // CLIP=x,y,w,h: only a crop
  const clip = process.env.CLIP?.split(',').map(Number);
  await p.screenshot({ path: join(out, `${name}.png`), ...(clip ? { clip: { x: clip[0], y: clip[1], width: clip[2], height: clip[3] } } : {}) });
  await p.context().close();
}
for (const [name, run] of Object.entries(mobileScenes)) {
  if (only.length && !only.includes(name)) continue;
  const { defaultBrowserType: _, ...iphone } = devices['iPhone 13'];
  const p = await page({ ...iphone, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await run(p);
  await p.screenshot({ path: join(out, `${name}.png`) });
  await p.context().close();
}
await browser.close();
if (errors.length) console.log('Browser errors:\n' + [...new Set(errors)].join('\n'));
console.log(`Screenshots in ${out}`);
