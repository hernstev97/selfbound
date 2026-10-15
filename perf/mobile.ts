// Performance on a phone: Pixel 7 viewport (412 × 915, touch), network like P2 (+50 ms per direction
// through the latency proxy), CPU throttled (default 4× and 6×; a mid-range Android lies in
// between). Measured like run.ts from the input event until after the next frame in which the
// result is in the DOM. Taps are real touch events (Playwright tap).
//
// Usage:
//   node perf/mobile.ts                         440 and 10,000 issues, CPU 4× and 6× (about 16 minutes)
//   node perf/mobile.ts --cells=small --cpu=4   only 440 issues, only 4×
// More switches as in run.ts: --reuse-data, --skip-build, --keep, --no-pin, --out=<folder>
// Output: perf/results/<timestamp>-mobile/{environment.json, samples.json, summary.md}

import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { installProbe } from './probe.ts';
import { fmt } from './report.ts';
import { appBase, here, startStack, type Dataset } from './stack.ts';

const argv = process.argv.slice(2);
const args = new Set(argv);
const opt = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const CELLS = (opt('cells')?.split(',') ?? ['small', 'large']) as Dataset[];
const CPUS = (opt('cpu')?.split(',') ?? ['4', '6']).map(Number);
const STARTS = 8;
const WARMUP = 2;
const REPS = 12;
const DEVICE = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, colorScheme: 'dark' as const };

const runId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-mobile`;
const outDir = opt('out') ?? join(here, 'results', runId);
mkdirSync(outDir, { recursive: true });

interface Sample {
  ws: Dataset;
  cpu: number;
  metric: string;
  value: number | null;
}
const samples: Sample[] = [];
const failures: string[] = [];

async function newPage(browser: Browser, cpu: number) {
  const ctx = await browser.newContext(DEVICE);
  await ctx.addInitScript(installProbe);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  await cdp.send('Performance.enable');
  return { ctx, page, cdp };
}

type Pred = (ctx: any) => boolean;
async function measure(page: Page, pred: Pred, act: (p: Page) => Promise<void>, ctxFn?: () => unknown, timeout = 8000) {
  await page.evaluate(([p, c]) => (window as any).__bench.arm({ main: p }, c, false), [pred.toString(), ctxFn ? ctxFn.toString() : null] as const);
  await page.waitForTimeout(Math.random() * 17);
  await act(page);
  const res = await page.evaluate((t) => (window as any).__bench.wait(t), timeout);
  return res.timedOut || res.painted.main === undefined ? null : (res.painted.main as number) - (res.start as number);
}

async function starts(browser: Browser, ws: Dataset, cpu: number) {
  for (let i = 0; i < STARTS; i++) {
    const { ctx, page } = await newPage(browser, cpu);
    for (const kind of ['cold', 'warm'] as const) {
      await page.goto(`${appBase('P2')}/all`);
      try {
        await page.waitForFunction(() => (window as any).__bench?.state.marks.list > 0, null, { timeout: 60_000, polling: 50 });
        await page.waitForFunction(() => performance.getEntriesByName('selfbound-synced').length > 0, null, { timeout: 90_000, polling: 100 });
      } catch {
        samples.push({ ws, cpu, metric: `${kind}.failed`, value: 1 });
        break;
      }
      const t = await page.evaluate(() => ({
        fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
        list: (window as any).__bench.state.marks.list,
        synced: performance.getEntriesByName('selfbound-synced')[0]?.startTime ?? null,
      }));
      samples.push({ ws, cpu, metric: `${kind}.fcp`, value: t.fcp }, { ws, cpu, metric: `${kind}.list`, value: t.list }, { ws, cpu, metric: `${kind}.synced`, value: t.synced });
      await page.waitForTimeout(2500);
    }
    await ctx.close();
  }
}

async function interactions(browser: Browser, ws: Dataset, cpu: number) {
  const { page, cdp } = await newPage(browser, cpu);
  const keep = (warm: boolean, metric: string, value: number | null) => !warm && samples.push({ ws, cpu, metric, value });
  try {
    await page.goto(`${appBase('P2')}/all?group=none&order=created`);
    await page.getByTestId('issue-row').first().waitFor({ timeout: 60_000 });
    await page.waitForFunction(() => performance.getEntriesByName('selfbound-synced').length > 0, null, { timeout: 90_000 });
    await page.waitForTimeout(500);
    const reps = [...Array(WARMUP).fill(true), ...Array(REPS).fill(false)] as boolean[];

    for (const [i, warm] of reps.entries()) {
      const row = page.getByTestId('issue-row').nth(2 + (i % 5));
      keep(warm, 'tap.row (open issue)', await measure(page, () => !!document.querySelector('[data-testid="detail-title"]'), () => row.tap()));
      await page.waitForTimeout(300);
      keep(warm, 'tap.status (picker in issue)', await measure(page, () => !!document.querySelector('[data-testid="palette"] [data-testid="palette-item"]'), (p) => p.locator('.mobile-props .chip').first().tap()));
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('[data-testid="palette"]'));
      await page.waitForTimeout(200);
      keep(warm, 'tap.back (back to list)', await measure(page, () => !document.querySelector('[data-testid="detail"]') && !!document.querySelector('[data-testid="issue-row"]'), (p) => p.getByTestId('detail-back-mobile').tap()));
      await page.waitForTimeout(300);
    }

    for (const warm of reps) {
      keep(warm, 'tap.menu (open drawer)', await measure(page, () => !!document.querySelector('[data-testid="app"].drawer [data-testid="sidebar"]'), (p) => p.getByTestId('mobile-menu').tap()));
      await page.waitForTimeout(400);
      keep(warm, 'tap.scrim (close drawer)', await measure(page, () => !document.querySelector('[data-testid="app"].drawer'), (p) => p.locator('.drawer-scrim').tap({ position: { x: DEVICE.viewport.width - 16, y: 400 } })));
      await page.waitForTimeout(400);
    }

    // Switch team in the drawer: open the drawer, tap a team, until the team's list is shown.
    for (const [i, warm] of reps.entries()) {
      const key = i % 2 ? 'PX' : 'NOVA';
      await page.getByTestId('mobile-menu').tap();
      await page.waitForTimeout(400);
      const card = page.locator(`[data-testid="nav-team-${key}"]`).first();
      keep(warm, 'tap.team (switch team in drawer)', await measure(page, (k) => !document.querySelector('[data-testid="app"].drawer') && !!document.querySelector('[data-testid="issue-row"]')?.getAttribute('data-key')?.startsWith(`${k}-`), () => card.tap(), Object.assign(() => key, { toString: () => `() => (${JSON.stringify(key)})` })));
      await page.waitForTimeout(400);
    }

    // Scrolling: 3 s evenly at 2,400 px/s (a brisk swipe) through the list
    await page.goto(`${appBase('P2')}/all`);
    await page.getByTestId('issue-row').first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(800);
    for (let rep = 0; rep < 3; rep++) {
      const r = await page.evaluate(async () => {
        const el = document.querySelector('[data-testid="list"]') as HTMLElement;
        el.scrollTop = 0;
        await new Promise((res) => setTimeout(res, 200));
        const frames: number[] = [];
        const start = performance.now();
        await new Promise<void>((resolve) => {
          const step = (t: number) => {
            frames.push(t);
            el.scrollTop = ((t - start) / 1000) * 2400;
            if (t - start < 3000) requestAnimationFrame(step);
            else resolve();
          };
          requestAnimationFrame(step);
        });
        const d = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b);
        return { long: (100 * d.filter((x) => x > 25).length) / d.length, p95: d[Math.floor(d.length * 0.95)] };
      });
      samples.push({ ws, cpu, metric: 'scroll.longFramePct', value: r.long }, { ws, cpu, metric: 'scroll.p95Frame', value: r.p95 });
    }
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    samples.push({ ws, cpu, metric: 'memory.heapMB', value: (metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0) / 1048576 });
    samples.push({ ws, cpu, metric: 'memory.domNodes', value: metrics.find((m) => m.name === 'Nodes')?.value ?? 0 });
  } finally {
    await page.context().close();
  }
}

function summary() {
  const q = (s: number[], p: number) => s[Math.min(s.length - 1, Math.floor((s.length - 1) * p + 0.5))];
  const keys = [...new Set(samples.map((s) => `${s.ws}|${s.cpu}|${s.metric}`))];
  let md = `# Performance on a phone · ${runId}\n\n412 × 915 px, touch, network +50 ms per direction (P2 build through the latency proxy), CPU throttled. Median (p95), n.\n\n| Data set | CPU | Metric | Median (p95) | n |\n|---|---|---|---|---|\n`;
  for (const key of keys) {
    const [ws, cpu, metric] = key.split('|');
    const values = samples.filter((s) => `${s.ws}|${s.cpu}|${s.metric}` === key && s.value !== null).map((s) => s.value!).sort((a, b) => a - b);
    const missing = samples.filter((s) => `${s.ws}|${s.cpu}|${s.metric}` === key && s.value === null).length;
    const unit = metric.endsWith('Pct') ? '%' : metric.includes('heapMB') ? 'MB' : metric.includes('domNodes') || metric.endsWith('.failed') ? '' : 'ms';
    md += `| ${ws === 'large' ? '10,000' : '440'} | ${cpu}× | ${metric} | ${fmt(q(values, 0.5), unit)} (${fmt(q(values, 0.95), unit)}) | ${values.length}${missing ? ` · ${missing} timeout(s)` : ''} |\n`;
  }
  return md;
}

async function main() {
  const t0 = Date.now();
  const stack = await startStack({ pin: !args.has('--no-pin'), build: !args.has('--skip-build'), keep: args.has('--keep'), fresh: !args.has('--reuse-data') });
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  writeFileSync(join(outDir, 'environment.json'), JSON.stringify({ date: new Date().toISOString(), cpu: os.cpus()[0].model, load: os.loadavg(), device: DEVICE, cells: CELLS, cpus: CPUS, browser: browser.version() }, null, 2));
  let seeded: Dataset | null = null;
  try {
    for (const ws of CELLS) {
      if (seeded !== ws) await stack.seed(ws, !args.has('--reuse-data'));
      seeded = ws;
      await stack.usePreview('P2');
      await stack.proxies(true);
      for (const cpu of CPUS) {
        process.stdout.write(`Mobile ${ws} CPU ${cpu}× … `);
        const t = Date.now();
        // An error in one cell costs only that cell; the rest continues and the reason goes into the report.
        try {
          await starts(browser, ws, cpu);
          await interactions(browser, ws, cpu);
          console.log(`${((Date.now() - t) / 1000).toFixed(0)} s`);
        } catch (error) {
          failures.push(`${ws} CPU ${cpu}×: ${String(error).split('\n')[0]}`);
          console.log(`aborted: ${failures.at(-1)}`);
        }
        writeFileSync(join(outDir, 'samples.json'), JSON.stringify(samples));
      }
    }
  } finally {
    await browser.close();
    await stack.stop();
  }
  const md = summary() + (failures.length ? `\n## Aborted\n\n${failures.map((f) => `- ${f}`).join('\n')}\n` : '');
  if (failures.length) process.exitCode = 2;
  writeFileSync(join(outDir, 'summary.md'), md);
  console.log(md);
  console.log(`${((Date.now() - t0) / 60000).toFixed(1)} min, report: ${join(outDir, 'summary.md')}`);
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 2;
}
