#!/usr/bin/env node
// Short speed run of the core actions against a running build with ?perf=1.
// Measured like the overlay: time from the input event (event.timeStamp) until after the next
// frame. Requires a backend with --seed large and an app build served by vite preview.
// The full performance harness is perf/ (perf/README.md).
//
// Usage: [THROTTLE=4] node e2e/tools/bench.mjs [base-url] [repetitions]
// Output: p50/p95/max per action in ms; scrolling: share of frames > 25 ms.
// Note: a full measurement run needs an otherwise idle machine.
import { chromium } from '@playwright/test';

const [base = 'http://127.0.0.1:5463', repsArg = '25'] = process.argv.slice(2);
const reps = Number(repsArg);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
// THROTTLE=4 slows the CPU down like a weak laptop.
if (process.env.THROTTLE) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.THROTTLE) });
  console.log(`CPU throttled: ${process.env.THROTTLE}×`);
}
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

async function settle() {
  await page.waitForFunction(() => (window.__selfbound?.saves ?? []).every((s) => s.confirmed !== undefined || s.failed), null, { timeout: 15000 });
}

async function last() {
  await page.waitForTimeout(40);
  return page.evaluate(() => window.__selfbound.app.perf.state.get().last?.ms ?? NaN);
}

const results = {};
async function measure(name, action, before) {
  const samples = [];
  for (let i = 0; i < reps; i++) {
    if (before) await before(i);
    await page.evaluate(() => window.__selfbound.app.perf.state.set({ ...window.__selfbound.app.perf.state.get(), last: null }));
    await action(i);
    samples.push(await last());
  }
  const sorted = samples.filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  results[name] = { n: sorted.length, p50: q(0.5), p95: q(0.95), max: sorted.at(-1) };
  console.log(`${name.padEnd(34)} p50 ${q(0.5).toFixed(1).padStart(6)} ms   p95 ${q(0.95).toFixed(1).padStart(6)} ms   max ${sorted.at(-1).toFixed(1).padStart(6)} ms`);
}

const t0 = Date.now();
await page.goto(`${base}/all?group=none&perf=1`);
await page.waitForFunction(() => window.__selfbound?.app?.store.sync.get().phase === 'live', null, { timeout: 120000 });
const total = await page.evaluate(() => window.__selfbound.app.list.list.get().count);
console.log(`Start to "live": ${Date.now() - t0} ms, ${total} issues in the list, ${await page.evaluate(() => window.__selfbound.app.store.all().length)} in memory`);
await page.mouse.move(2, 890);
await page.waitForTimeout(500);

await measure('J (focus down)', () => page.keyboard.press('j'));
await measure('K (focus up)', () => page.keyboard.press('k'));
await measure('Space (peek open/close)', () => page.keyboard.press(' '));
if (await page.evaluate(() => window.__selfbound.app.detail.peekOpen.get())) await page.keyboard.press(' ');
await measure('S (open status picker)', () => page.keyboard.press('s'), async () => {
  if (await page.evaluate(() => !!window.__selfbound.app.palette.state.get())) await page.keyboard.press('Escape');
});
await page.keyboard.press('Escape');
await measure('S + Enter (set status)', () => page.keyboard.press('Enter'), async (i) => {
  await page.keyboard.press('s');
  await page.keyboard.type(i % 2 ? 'todo' : 'prog');
});
await settle();
await measure('Ctrl K (command menu)', () => page.keyboard.press('Control+k'), async () => {
  if (await page.evaluate(() => !!window.__selfbound.app.palette.state.get())) await page.keyboard.press('Escape');
});
await page.keyboard.press('Escape');
await measure('Set filter (F, "high", Enter)', () => page.keyboard.press('Enter'), async (i) => {
  if (i > 0) await page.evaluate(() => window.__selfbound.app.list.clearFilters());
  await page.keyboard.press('f');
  await page.keyboard.type(i % 2 ? 'low' : 'high');
});
await page.evaluate(() => window.__selfbound.app.list.clearFilters());
await page.keyboard.press('/');
await measure('Typing in / (search)', (i) => page.keyboard.press('abcdefghijklmnopqrstuvwxyz'[i % 26]), async (i) => {
  if (i % 6 === 0) await page.evaluate(() => window.__selfbound.app.palette.setQuery(''));
});
await page.keyboard.press('Escape');
await measure('Ctrl F + typing (quick search)', (i) => page.keyboard.press('aeinrst'[i % 7]), async (i) => {
  if (i === 0) await page.keyboard.press('Control+f');
  if (i % 4 === 0) await page.evaluate(() => window.__selfbound.app.list.setQuick(''));
});
await page.keyboard.press('Escape');
await measure('Enter (open issue)', () => page.keyboard.press('Enter'), async () => {
  if (await page.evaluate(() => window.__selfbound.app.nav.page.get().name === 'issue')) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(60);
  }
  await page.keyboard.press('j');
});
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await measure('G then A/B (switch view)', (i) => page.keyboard.press(i % 2 ? 'a' : 'b'), () => page.keyboard.press('g'));
await page.goto(`${base}/all?group=none&perf=1`);
await page.waitForFunction(() => window.__selfbound?.app?.store.sync.get().phase === 'live', null, { timeout: 120000 });

// Scrolling: measure frame intervals during fast mouse wheel scrolling.
await page.mouse.move(700, 400);
await page.evaluate(() => {
  window.__frames = [];
  let prev = performance.now();
  const tick = (now) => {
    window.__frames.push(now - prev);
    prev = now;
    if (window.__frames.length < 400) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
for (let i = 0; i < 120; i++) {
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(16);
}
const frames = await page.evaluate(() => window.__frames.slice(5));
const slow = frames.filter((f) => f > 25).length;
console.log(`Scrolling: ${frames.length} frames, ${slow} over 25 ms (${((slow / frames.length) * 100).toFixed(1)} %), longest ${Math.max(...frames).toFixed(1)} ms`);
results.scroll = { frames: frames.length, over25: slow, max: Math.max(...frames) };
// Warm start: reload with a filled IndexedDB mirror.
await page.waitForTimeout(4500);
await page.reload();
await page.waitForSelector('[data-testid="issue-row"]');
const marks = await page.evaluate(() => {
  const at = (n) => performance.getEntriesByName(n)[0]?.startTime ?? null;
  return { boot: at('selfbound-boot'), cache: at('selfbound-cache'), synced: at('selfbound-synced'), fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null };
});
await page.waitForFunction(() => window.__selfbound?.app?.store.sync.get().phase === 'live', null, { timeout: 120000 });
const synced = await page.evaluate(() => performance.getEntriesByName('selfbound-synced')[0]?.startTime ?? null);
const fmt = (n) => (n === null ? '–' : `${Math.round(n)} ms`);
console.log(`Warm start: shell (FCP) ${fmt(marks.fcp)}, data from the mirror ${fmt(marks.cache)}, everything from the server ${fmt(synced)}`);
results.warm = { fcp: marks.fcp, cache: marks.cache, synced };
const heap = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null));
if (heap) console.log(`JS-Heap: ${heap} MB`);
if (errors.length) console.log('Errors:', errors.join('\n'));
console.log(JSON.stringify(results));
await browser.close();
