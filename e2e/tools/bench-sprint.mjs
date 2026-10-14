#!/usr/bin/env node
// Speed of the sprint pages against --seed large (production build with ?perf=1): opening the
// sprint view and planning, focus, move into the sprint (→), move back (←), reorder (Alt ↓).
// Measured like the overlay: from the input event until after the next frame; "open" from the
// navigation call until after the next frame.
//
// Usage: [THROTTLE=4] node e2e/tools/bench-sprint.mjs [base-url] [repetitions]
// Note: a full measurement run needs an otherwise idle machine.
import { chromium } from '@playwright/test';

const [base = 'http://127.0.0.1:5503', repsArg = '20'] = process.argv.slice(2);
const reps = Number(repsArg);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
if (process.env.THROTTLE) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.THROTTLE) });
  console.log(`CPU throttled: ${process.env.THROTTLE}×`);
}
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const settle = () => page.waitForFunction(() => (window.__selfbound?.saves ?? []).every((s) => s.confirmed !== undefined || s.failed), null, { timeout: 15000 });
async function last() {
  await page.waitForTimeout(40);
  return page.evaluate(() => window.__selfbound.app.perf.state.get().last?.ms ?? NaN);
}
function report(name, samples) {
  const sorted = samples.filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  console.log(`${name.padEnd(36)} p50 ${q(0.5).toFixed(1).padStart(6)} ms   p95 ${q(0.95).toFixed(1).padStart(6)} ms   max ${sorted.at(-1).toFixed(1).padStart(6)} ms   (n=${sorted.length})`);
}
async function measure(name, action, before) {
  const samples = [];
  for (let i = 0; i < reps; i++) {
    if (before) await before(i);
    await page.evaluate(() => window.__selfbound.app.perf.state.set({ ...window.__selfbound.app.perf.state.get(), last: null }));
    await action(i);
    samples.push(await last());
  }
  report(name, samples);
}
/** Triggers a navigation in the core; time until after the next frame. */
async function open(name, route, from) {
  const samples = [];
  for (let i = 0; i < reps; i++) {
    await page.evaluate((r) => window.__selfbound.app.nav.goView(r), from);
    await page.waitForTimeout(80);
    samples.push(
      await page.evaluate(
        (r) =>
          new Promise((resolve) => {
            const t = performance.now();
            window.__selfbound.app.nav.goView(r);
            requestAnimationFrame(() => {
              const ch = new MessageChannel();
              ch.port1.onmessage = () => resolve(performance.now() - t);
              ch.port2.postMessage(null);
            });
          }),
        route,
      ),
    );
    await page.waitForTimeout(80);
  }
  report(name, samples);
}

const t0 = Date.now();
await page.goto(`${base}/sprint?perf=1`);
await page.waitForFunction(() => window.__selfbound?.app?.store.sync.get().phase === 'live', null, { timeout: 120000 });
await page.waitForSelector('[data-testid="sprint-head"]');
console.log(`Start to "live": ${Date.now() - t0} ms, ${await page.evaluate(() => window.__selfbound.app.store.all().length)} issues in memory, sprint: ${await page.evaluate(() => window.__selfbound.app.main.list.get().count)} issues`);
// Load the chunks once (as after idle preloading), then measure.
await page.evaluate(() => window.__selfbound.app.nav.goView({ kind: 'plan', team: null, sprint: null }));
await page.waitForSelector('[data-testid="plan-backlog"] [data-testid="issue-row"]');
console.log(`Planning: ${await page.evaluate(() => window.__selfbound.app.main.list.get().count)} in the backlog, ${await page.evaluate(() => window.__selfbound.app.side.list.get().count)} in the sprint`);
await page.mouse.move(2, 890);

const all = { kind: 'all', team: null };
const sprint = { kind: 'sprint', team: null };
const plan = { kind: 'plan', team: null, sprint: null };
await open('Open sprint view (from All issues)', sprint, all);
await open('Open planning (from All issues)', plan, all);
await open('Open planning (from the sprint view)', plan, sprint);

await page.evaluate(() => window.__selfbound.app.nav.goView({ kind: 'plan', team: null, sprint: null }));
await page.waitForSelector('[data-testid="plan-backlog"] [data-testid="issue-row"]');
await page.waitForTimeout(300);
await measure('Planning: J (focus)', () => page.keyboard.press('j'));
await measure('Planning: → (into the sprint)', () => page.keyboard.press('ArrowRight'));
await settle();
await page.keyboard.press('Tab');
await measure('Planning: ← (back to the backlog)', () => page.keyboard.press('ArrowLeft'));
await settle();
await page.keyboard.press('Tab');
await measure('Planning: Alt ↓ (reorder)', () => page.keyboard.press('Alt+ArrowDown'));
await settle();
await measure('Planning: Tab (switch column)', () => page.keyboard.press('Tab'));

await page.evaluate(() => window.__selfbound.app.nav.goView({ kind: 'sprint', team: null }));
await page.waitForTimeout(300);
await measure('Sprint: J (focus)', () => page.keyboard.press('j'));
await measure('Sprint: S + Enter (Status)', () => page.keyboard.press('Enter'), async (i) => {
  await page.keyboard.press('s');
  await page.keyboard.type(i % 2 ? 'todo' : 'prog');
});
await settle();
if (errors.length) console.log('Browser errors:', [...new Set(errors)].join('\n'));
await browser.close();
