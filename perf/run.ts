// Performance regression test for the app (app/ + core/) against its own local Convex.
// Method: input event timestamp until after the next frame, random offset 0–17 ms, warm-up,
// median and p95 (perf/README.md). Starts backend, builds, vite preview and proxy itself and
// stops them afterwards.
//
// Usage:
//   node perf/run.ts --full     full run (idle machine!): P1/P2 × small/large, 2 rounds × (5 + 15)
//   node perf/run.ts --quick    short, only P1-large, 1 + 3 repetitions, budget threshold 250 ms (CI)
// More switches:
//   --only=starts,interactions,scroll,memory   only these parts
//   --cells=P1-large,P2-large,P1-small          only these cells
//   --bootstrap        95 % intervals of the medians in the report
//   --reuse-data       reuse backend and data set (otherwise: fresh backend per data set)
//   --skip-build       use existing builds in perf/.dist
//   --keep             keep the backend running afterwards (stop: node perf/run.ts --stop)
//   --no-pin           do not separate cores (taskset)
//   --no-budget        exit code always 0
//   --visible          visible browser (cross-check against headless mode)
//   --out=<folder>     output folder
//
// Output: perf/results/<timestamp>/{environment.json, samples.json, summary.md, summary.json} (gitignored)
// Exit code: 0 budget met, 1 budget violated, 2 run aborted.

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import type { ConvexHttpClient } from 'convex/browser';
import { api } from '@selfbound/backend/api';
import type { Id } from '@selfbound/backend/dataModel';
import { startBundleBytes } from './bundle.ts';
import { installProbe } from './probe.ts';
import { buildReport } from './report.ts';
import { appBase, CPU_RATE, DELAY_MS, here, mcpAgent, PORTS, root, startStack, stopBackend, type Dataset, type Profile, type Stack } from './stack.ts';

const argv = process.argv.slice(2);
const args = new Set(argv);
const opt = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

if (args.has('--stop')) {
  stopBackend();
  console.log('Performance run backend stopped.');
  process.exit(0);
}

const QUICK = args.has('--quick');
const MODE = QUICK ? 'quick' : 'full';
const ONLY = opt('only')?.split(',') ?? ['starts', 'interactions', 'scroll', 'memory'];
const CELLS = opt('cells')?.split(',') ?? (QUICK ? ['P1-large'] : ['P1-large', 'P2-large', 'P1-small']);
const VISIBLE = args.has('--visible');

const WARMUP = QUICK ? 1 : 5;
const PER_ROUND = QUICK ? 3 : 15;
const ROUNDS = QUICK ? 1 : 2;
const START_RUNS = QUICK ? 3 : 20;
const SCROLL_REPS = QUICK ? 2 : 5;
const MEMORY_REPS = QUICK ? 1 : 3;
const VIEWPORT = { width: 1440, height: 900 };
// List without groups, newest first: changed rows stay in place, new ones appear on top.
const LIST = '/all?group=none&order=created';
const SEARCH_WORD = 'error';

const CHROMIUM_FLAGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-features=CalculateNativeWinOcclusion',
];

export interface Sample {
  profile: string;
  ws: Dataset;
  round: number;
  metric: string;
  value: number | null;
  extra?: Record<string, unknown>;
}

const samples: Sample[] = [];
const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = opt('out') ?? join(here, 'results', runId);
mkdirSync(outDir, { recursive: true });

let stack!: Stack;
let convex!: ConvexHttpClient;
let agent!: ReturnType<typeof mcpAgent>;

function record(s: Sample) {
  samples.push(VISIBLE ? { ...s, profile: `${s.profile} visible` } : s);
}

async function launch(): Promise<Browser> {
  return chromium.launch({ channel: 'chromium', headless: !VISIBLE, args: CHROMIUM_FLAGS });
}

async function newPage(browser: Browser, profile: Profile, context?: BrowserContext) {
  const ctx = context ?? (await browser.newContext({ viewport: VIEWPORT, colorScheme: 'dark' }));
  await ctx.addInitScript(installProbe);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE[profile] });
  await cdp.send('HeapProfiler.enable');
  await cdp.send('Performance.enable');
  return { ctx, page, cdp };
}

async function waitSynced(page: Page, timeout = 60_000) {
  await page.waitForFunction(() => performance.getEntriesByName('selfbound-synced').length > 0, null, { timeout, polling: 50 });
}

async function openList(page: Page, profile: Profile, path = LIST) {
  await page.goto(`${appBase(profile)}${path}`);
  await page.getByTestId('issue-row').first().waitFor({ timeout: 60_000 });
  await waitSynced(page);
  await park(page);
  await settle(page, 300);
}

async function park(page: Page) {
  // Mouse to the bottom left of the sidebar, so hover does not move the focus.
  await page.mouse.move(2, VIEWPORT.height - 10);
}

async function gc(cdp: CDPSession) {
  await cdp.send('HeapProfiler.collectGarbage');
}

async function settle(page: Page, ms = 30) {
  await page.waitForTimeout(ms);
}

async function press(page: Page, key: string) {
  await page.keyboard.press(key);
}

async function waitGone(page: Page, testid: string) {
  await page.waitForFunction((t) => !document.querySelector(`[data-testid="${t}"]`), testid, { polling: 'raf' });
}

async function waitSaves(page: Page) {
  await page.waitForFunction(() => ((window as any).__selfbound?.saves ?? []).every((s: any) => s.confirmed !== undefined || s.failed), null, { polling: 20, timeout: 20_000 });
}

// ---------- Measuring one interaction ----------

type Fn = (ctx: any) => unknown;
interface Measured {
  preds: Record<string, Fn>;
  ctx?: () => unknown;
  act: (page: Page) => Promise<void>;
  manualStart?: (page: Page) => Promise<number>;
  timeout?: number;
}
type Result = { start: number; matched: Record<string, number>; painted: Record<string, number>; timedOut: boolean; eventTiming: number | null; ctx: unknown };

async function measure(page: Page, m: Measured): Promise<Result> {
  const predSources = Object.fromEntries(Object.entries(m.preds).map(([k, f]) => [k, f.toString()]));
  const ctx = await page.evaluate(([preds, ctxSrc, manual]) => (window as any).__bench.arm(preds, ctxSrc, manual), [predSources, m.ctx ? m.ctx.toString() : null, !!m.manualStart] as const);
  // Random position in the 16.7 ms frame grid, otherwise the key order determines the wait for the frame.
  await page.waitForTimeout(Math.random() * 17);
  await m.act(page);
  if (m.manualStart) {
    const epoch = await m.manualStart(page);
    await page.evaluate((e) => (window as any).__bench.setStart(e - performance.timeOrigin), epoch);
  }
  const res = await page.evaluate((t) => (window as any).__bench.wait(t), m.timeout ?? 5000);
  return { ...res, ctx };
}

function store(base: Omit<Sample, 'metric' | 'value' | 'extra'>, metric: string, res: Result) {
  for (const name of Object.keys(res.painted).length ? Object.keys(res.painted) : ['main']) {
    const painted = res.painted[name];
    const key = name === 'main' ? metric : `${metric}:${name}`;
    record({
      ...base,
      metric: key,
      value: res.timedOut || painted === undefined ? null : painted - res.start,
      extra: { eventTiming: res.eventTiming, toDom: res.matched[name] !== undefined ? res.matched[name] - res.start : null },
    });
  }
  // Timeout without a single result: count the sub-metrics as missing too.
  if (res.timedOut && Object.keys(res.painted).length === 0) record({ ...base, metric, value: null, extra: { timedOut: true } });
}

/** Pass a value into the page as context (a function returning it). */
const constant = (value: unknown) => new Function(`return () => (${JSON.stringify(value)})`)() as () => unknown;

// Predicates (run in the page, must not use anything from outside)
const focusedId = () => (document.querySelector('[data-testid="issue-row"].focused') as HTMLElement | null)?.dataset.id ?? null;
const focusChanged = (prev: string | null) => {
  const el = document.querySelector('[data-testid="issue-row"].focused') as HTMLElement | null;
  return !!el && el.dataset.id !== prev;
};
const viewCount = () => document.querySelector('[data-testid="view-count"]')?.textContent ?? '';
const paletteMatches = (q: string) => {
  const p = (window as any).__selfbound.app.palette.state.get();
  if (!p || p.query !== q) return false;
  return [...document.querySelectorAll('[data-testid="palette-item"]')].map((e) => (e as HTMLElement).dataset.id).join('|') === p.items.map((i: any) => i.id).join('|');
};
const viewShown = (title: string) => {
  const t = document.querySelector('[data-testid="view-title"]')?.textContent ?? '';
  return (title === 'Sprint' ? t.startsWith('Sprint') : t === title) && !!document.querySelector('[data-testid="issue-row"], [data-testid="empty-state"]');
};

// ---------- Reset data after the run ----------

interface Restore {
  id: string;
  status?: string;
  priority?: number;
}

async function restore(items: Restore[]) {
  // Per issue and field the first remembered value counts (the state before the run).
  const original = new Map<string, string>();
  for (const item of items) {
    const field = item.status !== undefined ? `s:${item.id}` : `p:${item.id}`;
    if (!original.has(field)) original.set(field, item.status ?? String(item.priority));
  }
  const groups = new Map<string, string[]>();
  for (const [field, value] of original) {
    const [kind, id] = field.split(':');
    const key = `${kind}:${value}`;
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  for (const [key, ids] of groups) {
    const [field, value] = key.split(':');
    const patch = field === 's' ? { status: value as never } : { priority: Number(value) as never };
    for (let i = 0; i < ids.length; i += 200) {
      await convex.mutation(api.issues.update, { ids: ids.slice(i, i + 200) as Id<'issues'>[], patch });
    }
  }
}

async function removeCreated(ids: string[]) {
  const real = ids.filter((id) => !id.startsWith('tmp:'));
  for (let i = 0; i < real.length; i += 100) await convex.mutation(api.issues.remove, { ids: real.slice(i, i + 100) as Id<'issues'>[] });
}

// ---------- Interactions ----------

/** Test pages in the knowledge area of ORB: enable it, 40 pages with ~3 KB of text each. */
async function wikiPages(): Promise<void> {
  const meta = await convex.query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  if (!team.wiki) await convex.mutation(api.teams.update, { teamId: team._id, wiki: 'on' });
  const { articles } = await convex.query(api.wiki.list, { teamId: team._id });
  if (articles.length >= 40) return;
  const text = Array.from({ length: 12 }, (_, i) => `## Section ${i + 1}\n\nTest paragraph with some text so the page looks like a real note. `.repeat(2)).join('\n\n');
  let parentId: string | undefined;
  for (let i = 0; i < 40; i++) {
    const { articleId } = await convex.mutation(api.wiki.create, { teamId: team._id, title: `Test page ${i + 1}`, markdown: text, ...(i % 5 && parentId ? { parentId: parentId as never } : {}) });
    if (i % 5 === 0) parentId = articleId;
  }
}

async function runInteractions(profile: Profile, ws: Dataset, round: number, smallOnly: boolean) {
  const browser = await launch();
  const { page, cdp } = await newPage(browser, profile);
  const base = { profile, ws, round };
  const toRestore: Restore[] = [];
  const created: string[] = [];
  const reps = (n = PER_ROUND) => [...Array(WARMUP).fill(true), ...Array(n).fill(false)] as boolean[];
  const keep = (warm: boolean, metric: string, res: Result) => {
    if (!warm) store(base, metric, res);
  };
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  try {
    await openList(page, profile);
    const total = await page.evaluate(viewCount);

    // Filter (F, "high", Enter) and remove the chip
    for (const warm of reps()) {
      await gc(cdp);
      await press(page, 'f');
      await page.getByTestId('palette-input').waitFor();
      await page.keyboard.type('high');
      keep(warm, 'filter.apply', await measure(page, {
        ctx: viewCount,
        preds: { main: (prev) => !!document.querySelector('[data-testid="filter-chip"]') && document.querySelector('[data-testid="view-count"]')?.textContent !== prev },
        act: (p) => press(p, 'Enter'),
      }));
      await park(page);
      keep(warm, 'filter.remove (click)', await measure(page, {
        preds: { main: () => !document.querySelector('[data-testid="filter-chip"]') },
        act: (p) => p.getByTestId('filter-chip-remove').click(),
      }));
      await park(page);
      await page.waitForFunction((t) => document.querySelector('[data-testid="view-count"]')?.textContent === t, total);
    }

    // Quick search (Ctrl F), per key: input shows the text and every visible row matches
    for (const warm of reps(QUICK ? 3 : 6)) {
      await gc(cdp);
      await press(page, 'Control+f');
      await page.getByTestId('quick-search').waitFor();
      let typed = '';
      for (const ch of SEARCH_WORD) {
        typed += ch;
        keep(warm, 'quicksearch.key', await measure(page, {
          ctx: constant(typed),
          preds: {
            main: (q) => {
              const input = document.querySelector('[data-testid="quick-search"]') as HTMLInputElement | null;
              if (!input || input.value !== q) return false;
              const app = (window as any).__selfbound.app;
              if (document.querySelector('[data-testid="view-count"]')?.textContent !== String(app.list.list.get().count)) return false;
              return [...document.querySelectorAll('[data-testid="issue-row"]')].every((r) => app.store.haystack((r as HTMLElement).dataset.id)?.includes(q));
            },
          },
          act: (p) => p.keyboard.type(ch),
        }));
      }
      keep(warm, 'quicksearch.clear', await measure(page, {
        preds: { main: () => !document.querySelector('[data-testid="quick-search"]') && !!document.querySelector('[data-testid="issue-row"]') },
        act: (p) => press(p, 'Escape'),
      }));
      await park(page);
      await page.waitForFunction((t) => document.querySelector('[data-testid="view-count"]')?.textContent === t, total);
    }

    // Search (/), per key: hits in the DOM match the state
    for (const warm of reps(QUICK ? 3 : 5)) {
      await gc(cdp);
      await press(page, '/');
      await page.getByTestId('palette-input').waitFor();
      let typed = '';
      for (const ch of SEARCH_WORD) {
        typed += ch;
        keep(warm, 'search.key', await measure(page, { ctx: constant(typed), preds: { main: paletteMatches }, act: (p) => p.keyboard.type(ch) }));
      }
      await press(page, 'Escape');
      await waitGone(page, 'palette');
    }

    // Search for an identifier (/ "ORB-1897"): last key until the issue is on top
    for (const warm of reps()) {
      const target = await page.evaluate(() => {
        const all = (window as any).__selfbound.app.store.all() as { _id: string; key: string; deletedAt?: number }[];
        const live = all.filter((i) => !i.deletedAt);
        const hit = live[Math.floor(Math.random() * live.length)];
        return { id: hit._id, key: hit.key };
      });
      await press(page, '/');
      await page.getByTestId('palette-input').waitFor();
      await page.keyboard.type(target.key.slice(0, -1));
      keep(warm, 'search.id (identifier)', await measure(page, {
        ctx: constant(target.id),
        preds: { main: (id) => ((document.querySelector('[data-testid="palette-item"]') as HTMLElement | null)?.dataset.id ?? '').endsWith(`:${id}`) },
        act: (p) => p.keyboard.type(target.key.slice(-1)),
      }));
      await press(page, 'Escape');
      await waitGone(page, 'palette');
    }

    if (!smallOnly) {
      await openList(page, profile);

      // Move focus
      for (const warm of reps()) {
        keep(warm, 'focus.next (J)', await measure(page, { ctx: focusedId, preds: { main: focusChanged }, act: (p) => press(p, 'j') }));
      }
      for (const warm of reps()) {
        keep(warm, 'focus.prev (K)', await measure(page, { ctx: focusedId, preds: { main: focusChanged }, act: (p) => press(p, 'k') }));
      }

      // Peek (Space) with description, ↓ in peek
      for (const warm of reps()) {
        await gc(cdp);
        keep(warm, 'peek.open (Space)', await measure(page, {
          preds: { main: () => !!document.querySelector('[data-testid="peek-title"]'), content: () => !!document.querySelector('[data-testid="peek-description"]') },
          act: (p) => press(p, ' '),
        }));
        keep(warm, 'peek.next (↓)', await measure(page, {
          ctx: () => document.querySelector('[data-testid="peek-title"]')?.textContent ?? '',
          preds: { main: (prev) => { const t = document.querySelector('[data-testid="peek-title"]')?.textContent; return !!t && t !== prev; } },
          act: (p) => press(p, 'ArrowDown'),
        }));
        await press(page, 'Escape');
        await waitGone(page, 'peek');
      }

      // Open detail (Enter) with description, close (Esc)
      for (const warm of reps()) {
        await gc(cdp);
        await press(page, 'j');
        await settle(page);
        keep(warm, 'detail.open (Enter)', await measure(page, {
          preds: { main: () => !!document.querySelector('[data-testid="detail-title"]'), content: () => !!document.querySelector('[data-testid="detail-description"]') },
          act: (p) => press(p, 'Enter'),
        }));
        keep(warm, 'detail.close (Esc)', await measure(page, {
          preds: { main: () => !document.querySelector('[data-testid="detail"]') && !!document.querySelector('[data-testid="issue-row"].focused') },
          act: (p) => press(p, 'Escape'),
        }));
      }

      // Open the status picker
      for (const warm of reps()) {
        keep(warm, 'picker.open (S)', await measure(page, {
          preds: { main: () => (document.querySelector('[data-testid="palette"]') as HTMLElement | null)?.dataset.kind === 'status' && !!document.querySelector('[data-testid="palette-item"]') },
          act: (p) => press(p, 's'),
        }));
        await press(page, 'Escape');
        await waitGone(page, 'palette');
      }

      // Set status: S, search text; measured is Enter until the row changed; then server confirmation
      for (const warm of reps()) {
        await press(page, 'j');
        const info = await page.evaluate(() => {
          const el = document.querySelector('[data-testid="issue-row"].focused') as HTMLElement;
          return { id: el.dataset.id!, status: el.dataset.status! };
        });
        toRestore.push({ id: info.id, status: info.status });
        const target = info.status === 'in_progress' ? 'todo' : 'in_progress';
        await press(page, 's');
        await page.getByTestId('palette-input').waitFor();
        await page.keyboard.type(target === 'todo' ? 'todo' : 'prog');
        const res = await measure(page, {
          ctx: constant({ id: info.id, target }),
          preds: { main: (c) => document.querySelector(`[data-testid="issue-row"][data-id="${c.id}"]`)?.getAttribute('data-status') === c.target },
          act: (p) => press(p, 'Enter'),
        });
        keep(warm, 'status.set (Enter)', res);
        await waitSaves(page);
        if (!warm && !res.timedOut) {
          const save = await page.evaluate(() => (window as any).__selfbound.saves.at(-1));
          record({ ...base, metric: 'save.confirmed (key → server confirmed)', value: save.confirmed - res.start });
          record({ ...base, metric: 'save.painted (key → confirmed visible)', value: (save.painted ?? save.confirmed) - res.start });
        }
      }

      // Set priority
      for (const warm of reps()) {
        await press(page, 'j');
        const info = await page.evaluate(() => {
          const el = document.querySelector('[data-testid="issue-row"].focused') as HTMLElement;
          return { id: el.dataset.id!, priority: Number(el.dataset.priority) };
        });
        toRestore.push({ id: info.id, priority: info.priority });
        const target = info.priority === 2 ? 4 : 2;
        await press(page, 'p');
        await page.getByTestId('palette-input').waitFor();
        await page.keyboard.type(target === 2 ? 'high' : 'low');
        keep(warm, 'priority.set (Enter)', await measure(page, {
          ctx: constant({ id: info.id, target: String(target) }),
          preds: { main: (c) => document.querySelector(`[data-testid="issue-row"][data-id="${c.id}"]`)?.getAttribute('data-priority') === c.target },
          act: (p) => press(p, 'Enter'),
        }));
        await waitSaves(page);
      }

      // Open the command menu and type in it
      for (const warm of reps()) {
        await gc(cdp);
        keep(warm, 'palette.open (Ctrl+K)', await measure(page, {
          preds: { main: () => (document.querySelector('[data-testid="palette"]') as HTMLElement | null)?.dataset.kind === 'command' && !!document.querySelector('[data-testid="palette-item"]') },
          act: (p) => press(p, 'Control+k'),
        }));
        await press(page, 'Escape');
        await waitGone(page, 'palette');
      }
      for (const warm of reps(QUICK ? 3 : 6)) {
        await press(page, 'Control+k');
        await page.getByTestId('palette-input').waitFor();
        let typed = '';
        for (const ch of 'status') {
          typed += ch;
          keep(warm, 'palette.key', await measure(page, { ctx: constant(typed), preds: { main: paletteMatches }, act: (p) => p.keyboard.type(ch) }));
        }
        await press(page, 'Escape');
        await waitGone(page, 'palette');
      }

      // Navigation: G B, G A, G T, G S (sprint page, current sprint as a list)
      const hops: [string, string, string | null][] = [
        ['b', 'Backlog', 'nav.backlog (G B)'],
        ['a', 'All issues', 'nav.all (G A)'],
        ['t', 'Triage', 'nav.triage (G T)'],
        ['a', 'All issues', null],
        ['s', 'Sprint', 'nav.sprint (G S)'],
        ['a', 'All issues', null],
      ];
      for (const warm of reps()) {
        await gc(cdp);
        for (const [key, title, metric] of hops) {
          await press(page, 'g');
          const res = await measure(page, { ctx: constant(title), preds: { main: viewShown }, act: (p) => press(p, key) });
          if (metric) keep(warm, metric, res);
          await settle(page, 30);
        }
      }
      // Inbox: move between entries with J. Split view: the issue on the right follows (Space opens
      // it); older builds without the split view open the issue as its own page (Enter), then J.
      // Measured until the identifier of the shown issue changes, or also its description is there.
      await press(page, 'g');
      await measure(page, { ctx: constant('Inbox'), preds: { main: viewShown }, act: (p) => press(p, 'i') });
      await settle(page, 100);
      const splitView = (await page.getByTestId('inbox-split').count()) > 0;
      await press(page, splitView ? ' ' : 'Enter');
      await page.getByTestId('detail-key').waitFor();
      await settle(page, 300);
      const shownKey = () => document.querySelector('[data-testid="detail-key"]')?.textContent ?? '';
      for (const [warm, key] of [...reps()].map((w, n) => [w, n % 2 ? 'k' : 'j'] as const)) {
        await gc(cdp);
        keep(warm, `inbox.${key === 'j' ? 'next (J)' : 'prev (K)'}`, await measure(page, {
          ctx: shownKey,
          preds: {
            main: (prev) => { const k = document.querySelector('[data-testid="detail-key"]')?.textContent; return !!k && k !== prev; },
            content: (prev) => { const k = document.querySelector('[data-testid="detail-key"]')?.textContent; return !!k && k !== prev && !!document.querySelector('[data-testid="detail-description"]'); },
          },
          act: (p) => press(p, key),
        }));
        await settle(page, 300);
      }
      await press(page, 'Escape');
      await settle(page, 100);
      await park(page);

      // Switch team by clicking the team card in the sidebar. Older builds without cards: click on
      // "Issues" under the (expanded) team, same target.
      for (const key of ['NOVA', 'PX']) {
        const row = page.locator(`[data-testid="nav-team-${key}"] > button[aria-expanded="false"]`);
        if (await row.count()) await row.click();
      }
      for (const warm of reps()) {
        await gc(cdp);
        for (const key of ['NOVA', 'PX']) {
          const card = page.locator(`a.team-card[data-testid="nav-team-${key}"]`);
          const target = (await card.count()) ? card : page.getByTestId(`nav-team-${key}-issues`);
          await target.hover();
          keep(warm, 'nav.team (click)', await measure(page, {
            ctx: constant(key),
            preds: { main: (k) => document.querySelector('[data-testid="view-title"]')?.textContent === 'Active' && !!document.querySelector('[data-testid="issue-row"]')?.textContent?.includes(`${k}-`) },
            act: () => target.click(),
          }));
          await settle(page, 300);
        }
      }
      await park(page);

      // Knowledge: click a page in the tree (hovering preloads, as with the detail) until the page
      // title and text are there. Test pages in team ORB, created once per data set.
      await wikiPages();
      await page.evaluate(() => (window as any).__selfbound.app.nav.go({ name: 'wiki', team: 'ORB' }));
      await page.locator('[data-testid="wiki-row"]').first().waitFor();
      // The first two visible rows (top level, collapsed).
      const wikiIds = await page.locator('[data-testid="wiki-row"]').evaluateAll((els) => els.slice(0, 2).map((e) => (e as HTMLElement).dataset.id!));
      for (const warm of reps()) {
        await gc(cdp);
        for (const id of wikiIds.slice(0, 2)) {
          const target = page.locator(`[data-testid="wiki-row"][data-id="${id}"]`);
          await target.hover();
          await settle(page, 120);
          keep(warm, 'wiki.page (click in tree)', await measure(page, {
            ctx: constant(id),
            preds: { main: (i) => (document.querySelector('[data-testid="article"]') as HTMLElement | null)?.dataset.id === i && !!document.querySelector('[data-testid="article-body"] p') },
            act: () => target.click(),
          }));
          await settle(page, 200);
        }
      }
      await park(page);
      // Back to the starting list (G A restores the view's display settings, not our parameters)
      await openList(page, profile);

      // Board: Ctrl B there, → to the next column, Shift → moves the card, Ctrl B back.
      // Done and canceled columns are collapsed; per column only the visible cards are in the DOM.
      for (const warm of reps()) {
        await gc(cdp);
        keep(warm, 'layout.board (Ctrl+B)', await measure(page, {
          preds: { main: () => !!document.querySelector('[data-testid="issue-card"].focused') },
          act: (p) => press(p, 'Control+b'),
        }));
        await settle(page, 50);
        // First card of the first column: open columns lie to its right (not the collapsed ones).
        await press(page, 'Home');
        await settle(page, 30);
        keep(warm, 'board.column (→)', await measure(page, {
          ctx: () => document.querySelector('[data-testid="issue-card"].focused')?.getAttribute('data-id') ?? null,
          preds: { main: (c) => { const f = document.querySelector('[data-testid="issue-card"].focused'); return !!f && f.getAttribute('data-id') !== c; } },
          act: (p) => press(p, 'ArrowRight'),
        }));
        await settle(page, 30);
        const card = await page.evaluate(() => {
          const el = document.querySelector('[data-testid="issue-card"].focused') as HTMLElement;
          return { id: el.dataset.id!, status: el.dataset.status!, column: (el.closest('[data-testid="board-column"]') as HTMLElement).dataset.key! };
        });
        toRestore.push({ id: card.id, status: card.status });
        keep(warm, 'board.move (Shift →)', await measure(page, {
          ctx: constant(card),
          preds: { main: (c) => (document.querySelector(`[data-testid="issue-card"][data-id="${c.id}"]`)?.closest('[data-testid="board-column"]') as HTMLElement | null)?.dataset.key !== c.column && !!document.querySelector(`[data-testid="issue-card"][data-id="${c.id}"]`) },
          act: (p) => press(p, 'Shift+ArrowRight'),
        }));
        await waitSaves(page);
        await press(page, 'Control+z');
        await waitSaves(page);
        await settle(page, 50);
        keep(warm, 'layout.list (Ctrl+B)', await measure(page, {
          preds: { main: () => !!document.querySelector('[data-testid="issue-row"].focused') },
          act: (p) => press(p, 'Control+b'),
        }));
        await settle(page, 50);
      }
      await openList(page, profile);

      // Mouse: click on a row (opens issue), click on the status icon
      for (const warm of reps()) {
        await gc(cdp);
        const row = page.getByTestId('issue-row').nth(6);
        await row.hover();
        keep(warm, 'click.row (opens issue)', await measure(page, {
          preds: { main: () => !!document.querySelector('[data-testid="detail-title"]') },
          act: () => row.click(),
        }));
        await press(page, 'Escape');
        await page.getByTestId('list').waitFor();
        const icon = page.getByTestId('issue-row').nth(7).getByTestId('row-status');
        await icon.hover();
        keep(warm, 'click.status (picker)', await measure(page, {
          preds: { main: () => (document.querySelector('[data-testid="palette"]') as HTMLElement | null)?.dataset.kind === 'status' },
          act: () => icon.click(),
        }));
        await press(page, 'Escape');
        await waitGone(page, 'palette');
        await park(page);
      }

      // Multi-select: 50 issues to one status
      for (const warm of reps(QUICK ? 3 : 10)) {
        await gc(cdp);
        await press(page, 'Escape');
        await press(page, 'j');
        await press(page, 'x');
        for (let i = 0; i < 49; i++) await press(page, 'Shift+ArrowDown');
        const all = await page.evaluate(() => (window as any).__selfbound.app.targets() as string[]);
        const statuses = await page.evaluate((ids) => ids.map((id: string) => (window as any).__selfbound.app.store.get(id)?.status), all);
        all.forEach((id: string, i: number) => toRestore.push({ id, status: statuses[i] }));
        const target = statuses.every((s: string) => s === 'canceled') ? 'todo' : 'canceled';
        await press(page, 'Control+k');
        await page.getByTestId('palette-input').waitFor();
        await page.keyboard.type(target === 'canceled' ? 'status: canceled' : 'status: todo');
        keep(warm, 'bulk50.status (Enter)', await measure(page, {
          ctx: constant(target),
          preds: { main: (t) => { const rows = [...document.querySelectorAll('[data-testid="issue-row"].selected')]; return rows.length > 0 && rows.every((r) => r.getAttribute('data-status') === t); } },
          act: (p) => press(p, 'Enter'),
        }));
        await waitSaves(page);
        await press(page, 'Escape');
      }
      await openList(page, profile);

      // Create: C → title → Ctrl Enter, until the row is visible (optimistic) and until it is confirmed
      for (const [i, warm] of reps(QUICK ? 3 : 10).entries()) {
        const title = `Perf ${runId} ${profile}-${round}-${i}`;
        await press(page, 'c');
        await page.getByTestId('create-title').waitFor();
        await page.keyboard.type(title);
        keep(warm, 'create.submit (Ctrl+Enter)', await measure(page, {
          ctx: constant(title),
          preds: {
            main: (t) => [...document.querySelectorAll('[data-testid="issue-row"]')].some((r) => r.querySelector('[data-testid="row-title"]')?.textContent === t),
            confirmed: (t) => [...document.querySelectorAll('[data-testid="issue-row"]')].some((r) => r.querySelector('[data-testid="row-title"]')?.textContent === t && !r.classList.contains('pending') && !(r as HTMLElement).dataset.id?.startsWith('tmp:')),
          },
          act: (p) => press(p, 'Control+Enter'),
          timeout: 10_000,
        }));
        await waitSaves(page);
        const id = await page.evaluate((t) => ([...document.querySelectorAll('[data-testid="issue-row"]')].find((r) => r.querySelector('[data-testid="row-title"]')?.textContent === t) as HTMLElement | undefined)?.dataset.id ?? null, title);
        if (id) created.push(id);
        await settle(page, 50);
      }

      // Send a comment (Ctrl Enter) in the detail: visible (optimistic) and confirmed
      for (const [i, warm] of reps(QUICK ? 3 : 10).entries()) {
        await press(page, 'j');
        await press(page, 'Enter');
        await page.getByTestId('detail-description').waitFor();
        const text = `Perf comment ${runId} ${profile}-${round}-${i}`;
        await page.getByTestId('comment-input').fill(text);
        await gc(cdp);
        keep(warm, 'comment.send (Ctrl+Enter)', await measure(page, {
          ctx: constant(text),
          preds: {
            main: (t) => [...document.querySelectorAll('[data-testid="comment"]')].some((c) => c.querySelector('[data-testid="comment-body"]')?.textContent?.trim() === t),
            confirmed: (t) => [...document.querySelectorAll('[data-testid="comment"]')].some((c) => c.querySelector('[data-testid="comment-body"]')?.textContent?.trim() === t && !c.classList.contains('pending')),
          },
          act: (p) => press(p, 'Control+Enter'),
          timeout: 10_000,
        }));
        await waitSaves(page);
        // Leave the input first, then close the detail
        await press(page, 'Escape');
        if (await page.getByTestId('detail').count()) await press(page, 'Escape');
        await page.getByTestId('list').waitFor();
        await park(page);
      }

      // Accept from triage: 1 → "todo" → Enter, until the row has left triage
      await openList(page, profile, '/triage');
      for (const warm of reps(QUICK ? 3 : 10)) {
        const id = await page.evaluate(focusedId);
        if (!id) break;
        toRestore.push({ id, status: 'triage' });
        await press(page, '1');
        await page.waitForFunction(() => (document.querySelector('[data-testid="palette"]') as HTMLElement | null)?.dataset.kind === 'move');
        await page.keyboard.type('todo');
        keep(warm, 'triage.accept (1, Enter)', await measure(page, {
          ctx: constant(id),
          preds: { main: (i) => !document.querySelector(`[data-testid="issue-row"][data-id="${i}"]`) && !document.querySelector('[data-testid="palette"]') },
          act: (p) => press(p, 'Enter'),
        }));
        await waitSaves(page);
        await page.waitForFunction(() => !!document.querySelector('[data-testid="issue-row"].focused'), null, { timeout: 5000 }).catch(() => {});
      }
      await openList(page, profile);

      // An agent changes a visible issue: directly via mutation and over MCP
      for (const warm of reps(QUICK ? 3 : 10)) {
        const info = await page.evaluate(() => {
          const el = document.querySelectorAll('[data-testid="issue-row"]')[8] as HTMLElement;
          return { id: el.dataset.id!, priority: Number(el.dataset.priority) };
        });
        toRestore.push({ id: info.id, priority: info.priority });
        const target = info.priority === 1 ? 3 : 1;
        let epoch = 0;
        keep(warm, 'agent.change (server → row)', await measure(page, {
          ctx: constant({ id: info.id, target: String(target) }),
          preds: { main: (c) => document.querySelector(`[data-testid="issue-row"][data-id="${c.id}"]`)?.getAttribute('data-priority') === c.target },
          act: async () => {
            epoch = performance.timeOrigin + performance.now();
            void convex.mutation(api.issues.update, { ids: [info.id as Id<'issues'>], patch: { priority: target as never } });
          },
          manualStart: async () => epoch,
        }));
        await settle(page, 50);
      }
      for (const warm of reps(QUICK ? 3 : 10)) {
        const info = await page.evaluate(() => {
          const el = document.querySelectorAll('[data-testid="issue-row"]')[9] as HTMLElement;
          return { id: el.dataset.id!, key: el.dataset.key!, status: el.dataset.status! };
        });
        toRestore.push({ id: info.id, status: info.status });
        const target = info.status === 'in_review' ? 'todo' : 'in_review';
        let epoch = 0;
        let call: Promise<unknown> = Promise.resolve();
        keep(warm, 'agent.mcp (MCP call → row)', await measure(page, {
          ctx: constant({ id: info.id, target }),
          preds: { main: (c) => document.querySelector(`[data-testid="issue-row"][data-id="${c.id}"]`)?.getAttribute('data-status') === c.target },
          act: async () => {
            epoch = performance.timeOrigin + performance.now();
            call = agent('set_status', { identifiers: [info.key], status: target });
          },
          manualStart: async () => epoch,
        }));
        await call;
        await settle(page, 50);
      }
    }
  } finally {
    if (errors.length) console.log(`\n  Errors in the page: ${[...new Set(errors)].join(' | ')}`);
    await browser.close();
    if (toRestore.length) await restore(toRestore);
    if (created.length) await removeCreated(created);
  }
}

// ---------- Cold and warm start ----------

// Diagnosis of a stalled cold start: which buckets are missing in the store, which errors the page
// reported, whether the rest still arrives later, and what the backend log says.
async function diagnoseStall(page: Page, pageErrors: string[]) {
  const have = new Set<string>(await page.evaluate(() => [...((window as any).__selfbound.app.store.issues.keys() as Iterable<string>)]));
  const missing: Record<number, string> = {};
  for (let bucket = 0; ; bucket++) {
    const docs = (await convex.query(api.issues.bucket, { bucket })) as { _id: string }[];
    if (docs.length === 0) break;
    const lost = docs.filter((d) => !have.has(d._id)).length;
    if (lost) missing[bucket] = `${lost}/${docs.length}`;
  }
  console.log(`  Missing buckets (missing/total): ${JSON.stringify(missing)}`);
  console.log(`  Page errors: ${JSON.stringify([...new Set(pageErrors)].slice(0, 10))}`);
  const late = await waitSynced(page, 60_000).then(() => true, () => false);
  console.log(`  Synced later (60 s): ${late}`);
  try {
    const log = readFileSync(join(root, 'perf', '.backend', '.convex-local.log'), 'utf8').split('\n');
    console.log(`  Backend log (last 25 lines):\n${log.slice(-25).join('\n')}`);
  } catch {}
}

async function runStarts(profile: Profile, ws: Dataset, round: number, runs: number) {
  const browser = await launch();
  const base = { profile, ws, round };
  try {
    for (let i = 0; i < runs; i++) {
      const { ctx, page } = await newPage(browser, profile);
      const pageErrors: string[] = [];
      page.on('pageerror', (e) => pageErrors.push(`pageerror: ${String(e).slice(0, 300)}`));
      page.on('console', (m) => m.type() === 'error' && pageErrors.push(`console: ${m.text().slice(0, 300)}`));
      for (const kind of ['cold', 'warm'] as const) {
        await page.goto(`${appBase(profile)}/all`);
        try {
          await page.waitForFunction(() => (window as any).__bench?.state.marks.list > 0, null, { timeout: 30_000, polling: 20 });
          await waitSynced(page, 30_000);
        } catch {
          const state = await page
            .evaluate(() => {
              const app = (window as any).__selfbound?.app;
              return { marks: (window as any).__bench?.state.marks, sync: app?.store.sync.get(), issues: app?.store.issues?.size, rows: document.querySelectorAll('[data-testid="issue-row"]').length };
            })
            .catch((e) => ({ error: String(e) }));
          record({ ...base, metric: `${kind}.failed`, value: 1, extra: { state } as never });
          console.log(`\n  Failure ${kind} ${profile} ${ws}:`, JSON.stringify(state));
          await diagnoseStall(page, pageErrors).catch((e) => console.log(`  Diagnosis failed: ${e}`));
          break;
        }
        const t = await page.evaluate(() => {
          const marks = (window as any).__bench.state.marks;
          const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
          return {
            fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
            shell: marks.shell,
            list: marks.list,
            synced: performance.getEntriesByName('selfbound-synced')[0]?.startTime ?? null,
            cache: performance.getEntriesByName('selfbound-cache')[0]?.startTime ?? null,
            transfer: (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).reduce((n, r) => n + r.transferSize, nav.transferSize),
          };
        });
        record({ ...base, metric: `${kind}.fcp`, value: t.fcp });
        record({ ...base, metric: `${kind}.shell`, value: t.shell });
        record({ ...base, metric: `${kind}.list`, value: t.list });
        record({ ...base, metric: `${kind}.synced`, value: t.synced });
        record({ ...base, metric: `${kind}.bytes`, value: t.transfer });
        if (kind === 'warm') record({ ...base, metric: 'warm.fromCache', value: t.cache !== null && t.cache < (t.list ?? Infinity) + 1 ? 1 : 0 });
        // The IndexedDB mirror writes during idle time; wait for it before the warm start.
        await page.waitForTimeout(2500);
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
}

// ---------- Scrolling ----------

async function runScroll(profile: Profile, ws: Dataset, round: number, cpu: number) {
  const browser = await launch();
  const { page, cdp } = await newPage(browser, profile);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  const base = { profile, ws, round };
  try {
    await openList(page, profile, '/all');
    await settle(page, 500);
    for (let rep = 0; rep < SCROLL_REPS; rep++) {
      await gc(cdp);
      const result = await page.evaluate(async () => {
        const el = document.querySelector('[data-testid="list"]') as HTMLElement;
        el.scrollTop = 0;
        await new Promise((r) => setTimeout(r, 200));
        const loafBefore = (window as any).__bench.state.loaf.length;
        const frames: number[] = [];
        const start = performance.now();
        // Scroll evenly for 3 s: 4,800 px/s, with 44 px rows about 109 rows per second.
        await new Promise<void>((resolve) => {
          const step = (t: number) => {
            frames.push(t);
            el.scrollTop = ((t - start) / 1000) * 4800;
            if (t - start < 3000) requestAnimationFrame(step);
            else resolve();
          };
          requestAnimationFrame(step);
        });
        const deltas = frames.slice(1).map((t, i) => t - frames[i]);
        const loaf = (window as any).__bench.state.loaf.slice(loafBefore);
        return { deltas, loaf, reached: el.scrollTop };
      });
      const sorted = [...result.deltas].sort((a, b) => a - b);
      const long = result.deltas.filter((d) => d > 25).length;
      const label = `scroll${cpu > 1 ? ` (CPU ${cpu}×)` : ''}${VISIBLE ? ' visible' : ''}`;
      record({ ...base, metric: `${label}.longFramePct`, value: (100 * long) / result.deltas.length });
      record({ ...base, metric: `${label}.p95Frame`, value: sorted[Math.floor(sorted.length * 0.95)] });
      record({ ...base, metric: `${label}.medianFrame`, value: sorted[Math.floor(sorted.length / 2)] });
      record({ ...base, metric: `${label}.loafCount`, value: result.loaf.filter((l: any) => l.duration > 50).length });
      record({ ...base, metric: `${label}.loafBlockingMs`, value: result.loaf.reduce((n: number, l: any) => n + (l.blocking ?? 0), 0) });
    }
  } finally {
    await browser.close();
  }
}

// ---------- Memory ----------

async function heap(cdp: CDPSession) {
  await gc(cdp);
  await gc(cdp);
  const { metrics } = await cdp.send('Performance.getMetrics');
  const get = (name: string) => metrics.find((m) => m.name === name)?.value ?? 0;
  return { heapMB: get('JSHeapUsedSize') / 1024 / 1024, nodes: get('Nodes') };
}

async function runMemory(profile: Profile, ws: Dataset, round: number) {
  const browser = await launch();
  const base = { profile, ws, round };
  try {
    for (let rep = 0; rep < MEMORY_REPS; rep++) {
      const { ctx, page, cdp } = await newPage(browser, profile);
      await openList(page, profile);
      await settle(page, 1000);
      const loaded = await heap(cdp);
      record({ ...base, metric: 'memory.heapMB (loaded)', value: loaded.heapMB });
      record({ ...base, metric: 'memory.domNodes (loaded)', value: loaded.nodes });
      for (let i = 0; i < 20; i++) {
        await press(page, 'j');
        await press(page, 'Enter');
        await page.getByTestId('detail-description').waitFor();
        await press(page, 'Escape');
        await page.getByTestId('list').waitFor();
      }
      await settle(page, 500);
      const after = await heap(cdp);
      record({ ...base, metric: 'memory.heapMB (after 20× detail)', value: after.heapMB });
      record({ ...base, metric: 'memory.domNodes (after 20× detail)', value: after.nodes });
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
}

// ---------- Main ----------

function environment(browserVersion: string, pinned: boolean) {
  const sh = (cmd: string) => {
    try {
      return execSync(cmd, { encoding: 'utf8', cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return 'unknown';
    }
  };
  return {
    date: new Date().toISOString(),
    mode: MODE,
    cells: CELLS,
    only: ONLY,
    cpu: os.cpus()[0].model,
    cores: os.cpus().length,
    affinity: sh(`taskset -pc ${process.pid}`),
    pinned,
    load: os.loadavg().map((n) => Math.round(n * 10) / 10),
    memGB: Math.round(os.totalmem() / 1024 ** 3),
    kernel: os.release(),
    os: sh('grep PRETTY_NAME /etc/os-release | cut -d= -f2'),
    governor: sh('cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor'),
    node: process.version,
    browser: `Chromium ${browserVersion} (Playwright 1.63, channel chromium${VISIBLE ? ', visible' : ', headless'})`,
    commit: sh('git rev-parse --short HEAD'),
    // `convex dev` rewrites backend/convex/_generated on start; that does not count as a change.
    dirty: sh("git status --porcelain -- app core backend ':!backend/convex/_generated'") !== '',
    build: 'vite build with VITE_SELFBOUND_TEST=1 (measurement hooks globalThis.__selfbound, otherwise like production), vite preview',
    viewport: VIEWPORT,
    ports: PORTS,
    profiles: {
      P1: 'local: directly on vite preview and Convex (127.0.0.1), CPU 1×',
      P2: `remote: TCP proxy +${DELAY_MS} ms per direction for page and Convex WebSocket, CPU throttled ${CPU_RATE.P2}×`,
    },
    warmup: WARMUP,
    perRound: PER_ROUND,
    rounds: ROUNDS,
    startRuns: START_RUNS,
  };
}

async function main() {
  const t0 = Date.now();
  const fresh = !args.has('--reuse-data');
  stack = await startStack({ pin: !args.has('--no-pin'), build: !args.has('--skip-build'), keep: args.has('--keep'), fresh });
  convex = stack.client;
  agent = mcpAgent(convex, 'Perf-Agent');
  const probeBrowser = await launch();
  const env = environment(probeBrowser.version(), stack.pinned);
  await probeBrowser.close();
  writeFileSync(join(outDir, 'environment.json'), JSON.stringify(env, null, 2));
  console.log(`Run ${runId} (${MODE}) → ${outDir}`);

  const save = () => writeFileSync(join(outDir, 'samples.json'), JSON.stringify(samples));
  const step = async (label: string, fn: () => Promise<void>) => {
    const t = Date.now();
    process.stdout.write(`${label} … `);
    await fn();
    save();
    console.log(`${((Date.now() - t) / 1000).toFixed(0)} s`);
  };

  // Initial bundle of the P1 build (brotli), load-independent: budget limit against the baseline.
  if (CELLS.includes('P1-large')) record({ profile: 'P1', ws: 'large', round: 0, metric: 'bundle.bytes (initial, brotli)', value: startBundleBytes(join(here, '.dist', 'p1')) });

  let seeded: Dataset | null = null;
  const plan: [Profile, Dataset][] = [['P1', 'large'], ['P2', 'large'], ['P1', 'small']];
  try {
    for (const [profile, ws] of plan) {
      if (!CELLS.includes(`${profile}-${ws}`)) continue;
      if (seeded !== ws) {
        await stack.seed(ws, fresh);
        seeded = ws;
      }
      await stack.usePreview(profile);
      await stack.proxies(profile === 'P2');
      const smallOnly = ws === 'small';
      if (ONLY.includes('starts')) {
        for (let round = 0; round < ROUNDS; round++) await step(`Start ${profile} ${ws} R${round + 1}`, () => runStarts(profile, ws, round, Math.ceil(START_RUNS / ROUNDS)));
      }
      if (ONLY.includes('interactions')) {
        for (let round = 0; round < ROUNDS; round++) await step(`Interactions ${profile} ${ws} R${round + 1}`, () => runInteractions(profile, ws, round, smallOnly));
      }
      if (ONLY.includes('scroll') && profile === 'P1' && ws === 'large') {
        for (const cpu of [1, 4]) {
          for (let round = 0; round < ROUNDS; round++) await step(`Scrolling CPU ${cpu}× R${round + 1}`, () => runScroll(profile, ws, round, cpu));
        }
      }
      if (ONLY.includes('memory') && profile === 'P1' && ws === 'large') {
        await step('Memory', () => runMemory(profile, ws, 0));
      }
    }
  } finally {
    save();
    await stack.stop();
  }
  console.log(`Samples: ${join(outDir, 'samples.json')} (${samples.length} values, ${((Date.now() - t0) / 60000).toFixed(1)} min)`);

  const report = buildReport(outDir, { mode: MODE, bootstrap: args.has('--bootstrap') });
  console.log(report.console);
  process.exitCode = report.ok || args.has('--no-budget') ? 0 : 1;
}

try {
  await main();
} catch (error) {
  console.error(error);
  // No empty result folder: record why the run aborted (ab.ts and idle.ts read it).
  const reason = error instanceof Error ? (error.stack ?? error.message) : String(error);
  writeFileSync(join(outDir, 'aborted.md'), `# Performance run aborted\n\n${new Date().toISOString()}, exit code 2\n\n\`\`\`\n${reason}\n\`\`\`\n`);
  process.exitCode = 2;
}
