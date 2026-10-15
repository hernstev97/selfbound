// Summarizes a performance run, checks the budget and compares with the baseline.
//
// Usage: node perf/report.ts perf/results/<run> [--bootstrap] [--update-baseline | --update-sizes]
//   writes summary.md and summary.json into the run folder; exit code 1 if the budget is violated.
//   --update-baseline copies the medians of this run into perf/baseline.json.
//   --update-sizes copies only bytes and DOM nodes (load-independent, also from a quick run).
//
// Budget (fixed in advance):
//   - core actions P1 · 10,000 issues: p95 < 100 ms (quick run --quick: < 250 ms), no timeouts
//   - scrolling through 10,000 issues: 0 % frames over 25 ms (quick run: at most 5 % at CPU 1×; CPU 4× only a note)
//   - cold start P2 · 10,000 issues: list visible at p95 < 2 s
//   - initial bundle (brotli) and DOM nodes of the list: at most 5 % above the baseline (load-independent, also in quick runs)
// Baseline: warning (not an error) when a median is more than 25 % worse than in perf/baseline.json.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(fileURLToPath(import.meta.url), '..');
const BASELINE_FILE = join(here, 'baseline.json');

interface Sample {
  profile: string;
  ws: string;
  round: number;
  metric: string;
  value: number | null;
  extra?: { eventTiming?: number | null; toDom?: number | null; timedOut?: boolean };
}

interface Stats {
  n: number;
  median: number;
  p75: number;
  p95: number;
  max: number;
}

export interface Row {
  profile: string;
  ws: string;
  metric: string;
  unit: string;
  stats: Stats;
  timeouts: number;
  ci: { lo: number; hi: number } | null;
  toDom: number | null;
  eventTiming: number | null;
  baseline: { median: number; p95: number } | null;
}

interface Check {
  rule: string;
  limit: string;
  value: string;
  ok: boolean;
  skipped?: boolean;
}

// ---------- Statistics ----------

function quantile(sorted: number[], q: number) {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function summarize(values: number[]): Stats {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, median: quantile(s, 0.5), p75: quantile(s, 0.75), p95: quantile(s, 0.95), max: s[s.length - 1] ?? NaN };
}

/** Bootstrap 95 % interval of the median (fixed seed, reproducible). */
function bootstrapMedian(xs: number[], iterations = 4000) {
  let seed = 42;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const medians: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const r = xs.map(() => xs[Math.floor(rand() * xs.length)]).sort((a, b) => a - b);
    medians.push(quantile(r, 0.5));
  }
  medians.sort((a, b) => a - b);
  return { lo: quantile(medians, 0.025), hi: quantile(medians, 0.975) };
}

// ---------- Formatting ----------

const num = (v: number, digits: number) => v.toFixed(digits);
const thousands = (v: number) => Math.round(v).toLocaleString('en-US');

export function fmt(v: number | null | undefined, unit = 'ms') {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  switch (unit) {
    case 'ms':
      return v >= 1000 ? `${thousands(v)} ms` : `${v < 10 ? num(v, 1) : num(v, 0)} ms`;
    case '%':
      return `${num(v, 1)} %`;
    case 'MB':
      return `${num(v, 1)} MB`;
    case 'kB':
      return `${num(v / 1024, 0)} kB`;
    default:
      return thousands(v);
  }
}

/** Value without unit, for "median (p95)" */
const bare = (v: number, unit: string) => fmt(v, unit).replace(/ (ms|%)$/, '');

function unitOf(metric: string) {
  if (metric.endsWith('Pct')) return '%';
  if (metric.includes('heapMB')) return 'MB';
  if (metric.includes('bytes')) return 'kB';
  if (metric.includes('domNodes') || metric.includes('loafCount') || metric.includes('fromCache') || metric.endsWith('.failed')) return '';
  return 'ms';
}

// ---------- Core actions, labels ----------

/** Core actions for the budget (main measurement, without ":content"/":confirmed"). */
export const CORE = [
  'focus.next', 'focus.prev', 'peek.open', 'peek.next', 'detail.open', 'detail.close', 'picker.open', 'status.set', 'priority.set',
  'palette.open', 'palette.key', 'search.key', 'search.id', 'quicksearch.key', 'quicksearch.clear', 'filter.apply', 'filter.remove',
  'nav.backlog', 'nav.all', 'nav.triage', 'nav.sprint', 'nav.team', 'click.row', 'click.status', 'bulk50.status', 'create.submit', 'comment.send', 'triage.accept',
  'layout.board', 'layout.list', 'board.column', 'board.move', 'wiki.page',
];
const isCore = (metric: string) => !metric.includes(':') && CORE.some((c) => metric === c || metric.startsWith(`${c} `));

const ACTIONS: [string, string][] = [
  ['focus.next (J)', '`J`: next issue'],
  ['focus.prev (K)', '`K`: previous issue'],
  ['peek.open (Space)', 'Space: open peek'],
  ['peek.open (Space):content', '… description visible in peek'],
  ['peek.next (↓)', '`↓` in peek'],
  ['detail.open (Enter)', '`Enter`: open issue'],
  ['detail.open (Enter):content', '… description visible'],
  ['detail.close (Esc)', '`Esc`: back to the list'],
  ['picker.open (S)', '`S`: open status picker'],
  ['status.set (Enter)', 'Set status (`Enter` → row changed)'],
  ['priority.set (Enter)', 'Set priority'],
  ['bulk50.status (Enter)', '50 issues to one status'],
  ['palette.open (Ctrl+K)', '`Ctrl K`: open command menu'],
  ['palette.key', 'Typing in the command menu (per key)'],
  ['search.key', 'Typing in search `/` (per key)'],
  ['search.id (identifier)', 'Search `/` for an identifier (last key → hit on top)'],
  ['quicksearch.key', 'Typing in quick search `Ctrl F`'],
  ['quicksearch.clear', 'Close quick search (`Esc`)'],
  ['filter.apply', 'Apply filter (`F`, "high", `Enter`)'],
  ['filter.remove (click)', 'Remove filter (click)'],
  ['nav.backlog (G B)', '`G` `B`: backlog'],
  ['nav.all (G A)', '`G` `A`: all issues'],
  ['nav.triage (G T)', '`G` `T`: triage'],
  ['nav.sprint (G S)', '`G` `S`: sprint (current sprint as a list)'],
  ['nav.team (click)', 'Switch team (click in the sidebar)'],
  ['inbox.next (J)', 'Inbox: next entry (`J`)'],
  ['inbox.next (J):content', '… description visible'],
  ['layout.board (Ctrl+B)', 'List → board (`Ctrl B`)'],
  ['layout.list (Ctrl+B)', 'Board → list (`Ctrl B`)'],
  ['board.column (→)', 'Board: next column (`→`)'],
  ['board.move (Shift →)', 'Board: move card (`⇧ →`)'],
  ['wiki.page (click in tree)', 'Knowledge: open page (click in the tree)'],
  ['click.row (opens issue)', 'Click on a row (opens issue)'],
  ['click.status (picker)', 'Click on the status icon'],
  ['create.submit (Ctrl+Enter)', 'Create: `C`, title, `Ctrl Enter` → row visible'],
  ['create.submit (Ctrl+Enter):confirmed', '… row with identifier from the server'],
  ['comment.send (Ctrl+Enter)', 'Send comment → visible'],
  ['comment.send (Ctrl+Enter):confirmed', '… confirmed by the server'],
  ['triage.accept (1, Enter)', 'Accept from triage (`1`, "todo", `Enter`)'],
];

const SAVES: [string, string][] = [
  ['status.set (Enter)', 'Status change visible (optimistic)'],
  ['save.confirmed (key → server confirmed)', 'Key → server saved and confirmed'],
  ['save.painted (key → confirmed visible)', 'Key → confirmation painted'],
  ['agent.change (server → row)', 'Agent changes an issue (mutation) → row updated'],
  ['agent.mcp (MCP call → row)', 'Agent over MCP (`set_status`) → row updated'],
];

const STARTS: [string, string][] = [
  ['cold.shell', 'Cold start: shell visible'],
  ['cold.fcp', 'Cold start: first paint (FCP)'],
  ['cold.list', 'Cold start: list visible'],
  ['cold.synced', 'Cold start: all issues synced'],
  ['warm.shell', 'Warm start: shell visible'],
  ['warm.list', 'Warm start: list visible'],
  ['warm.synced', 'Warm start: all issues synced'],
  ['warm.fromCache', 'Warm start: list from the IndexedDB mirror (share)'],
  ['cold.bytes', 'Transferred on cold start'],
];

const SCROLL_MEMORY: [string, string][] = [
  ['scroll.longFramePct', 'Scrolling (3 s, 4,800 px/s): frames over 25 ms'],
  ['scroll.p95Frame', '… p95 frame interval'],
  ['scroll.loafCount', '… long animation frames over 50 ms'],
  ['scroll (CPU 4×).longFramePct', 'Scrolling at CPU 4×: frames over 25 ms'],
  ['scroll (CPU 4×).p95Frame', '… p95 frame interval'],
  ['scroll (CPU 4×).loafCount', '… long animation frames over 50 ms'],
  ['memory.heapMB (loaded)', 'JS heap after loading'],
  ['memory.heapMB (after 20× detail)', 'JS heap after opening the detail 20×'],
  ['memory.domNodes (loaded)', 'DOM nodes (visible list)'],
];

// ---------- Report ----------

export interface ReportOptions {
  mode?: 'quick' | 'full';
  bootstrap?: boolean;
  updateBaseline?: boolean;
  /** Copy only the load-independent sizes (bytes, DOM nodes) into the baseline; works with a quick run too */
  updateSizes?: boolean;
}

/** Load-independent metrics: may go into the baseline from any run, including a quick run or CI. */
const isSize = (metric: string) => metric.startsWith('bundle.') || metric.endsWith('.bytes') || metric.startsWith('memory.domNodes');

/** No existsSync before the read: the file could change in between; a missing file is a normal case. */
function readBaseline(): Baseline | null {
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as Baseline;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function buildReport(dir: string, opts: ReportOptions = {}) {
  const samples = JSON.parse(readFileSync(join(dir, 'samples.json'), 'utf8')) as Sample[];
  const env = existsSync(join(dir, 'environment.json')) ? JSON.parse(readFileSync(join(dir, 'environment.json'), 'utf8')) : {};
  const mode: 'quick' | 'full' = opts.mode ?? env.mode ?? 'full';
  const runId = dir.split('/').filter(Boolean).pop()!;
  const baselineDoc = readBaseline();

  const cells = new Map<string, Sample[]>();
  for (const s of samples) {
    const key = `${s.profile}|${s.ws}|${s.metric}`;
    cells.set(key, [...(cells.get(key) ?? []), s]);
  }

  const rows: Row[] = [];
  for (const [key, list] of cells) {
    const [profile, ws, metric] = key.split('|');
    const values = list.filter((s) => s.value !== null).map((s) => s.value!);
    const median = (xs: number[]) => (xs.length ? summarize(xs).median : null);
    rows.push({
      profile,
      ws,
      metric,
      unit: unitOf(metric),
      stats: summarize(values),
      timeouts: list.filter((s) => s.value === null).length,
      ci: opts.bootstrap && values.length > 1 ? bootstrapMedian(values) : null,
      toDom: median(list.filter((s) => s.value !== null && typeof s.extra?.toDom === 'number').map((s) => s.extra!.toDom!)),
      eventTiming: median(list.filter((s) => typeof s.extra?.eventTiming === 'number').map((s) => s.extra!.eventTiming!)),
      baseline: baselineDoc?.metrics[key] ?? null,
    });
  }
  const order = (r: Row) => `${r.profile}|${r.ws === 'large' ? 0 : 1}|${r.metric}`;
  rows.sort((a, b) => order(a).localeCompare(order(b)));
  const find = (profile: string, ws: string, metric: string) => rows.find((r) => r.profile === profile && r.ws === ws && r.metric === metric);

  // ---------- Budget ----------
  const limit = mode === 'quick' ? 250 : 100;
  const scrollLimit = mode === 'quick' ? 5 : 0;
  const checks: Check[] = [];
  const core = rows.filter((r) => r.profile === 'P1' && r.ws === 'large' && isCore(r.metric));
  if (core.length === 0) checks.push({ rule: 'Core actions P1 · 10,000 issues: p95', limit: `< ${limit} ms`, value: 'not measured', ok: true, skipped: true });
  for (const r of core) {
    const ok = r.timeouts === 0 && r.stats.n > 0 && r.stats.p95 < limit;
    checks.push({ rule: `${r.metric}: p95`, limit: `< ${limit} ms`, value: `${fmt(r.stats.p95)}${r.timeouts ? ` · ${r.timeouts} timeout(s)` : ''}`, ok });
  }
  const scroll = rows.filter((r) => r.profile === 'P1' && r.ws === 'large' && r.metric.startsWith('scroll') && r.metric.endsWith('.longFramePct'));
  if (scroll.length === 0) checks.push({ rule: 'Scrolling: frames over 25 ms', limit: `≤ ${scrollLimit} %`, value: 'not measured', ok: true, skipped: true });
  for (const r of scroll) {
    const rule = `${r.metric.replace('.longFramePct', '')}: frames over 25 ms (worst repetition)`;
    // In the quick run (CI) the browser runs on a shared runner without a GPU; with the CPU
    // additionally throttled 4× it cannot scroll smoothly there, even if the app is unchanged.
    // So only a note there; the hard limit applies in the full run.
    if (mode === 'quick' && r.metric.includes('CPU 4×')) {
      checks.push({ rule: `${rule} (note only in the quick run)`, limit: `≤ ${scrollLimit} %`, value: fmt(r.stats.max, '%'), ok: true, skipped: true });
      continue;
    }
    checks.push({ rule, limit: scrollLimit === 0 ? '0 %' : `≤ ${scrollLimit} %`, value: fmt(r.stats.max, '%'), ok: r.stats.n > 0 && r.stats.max <= scrollLimit });
  }
  // Sizes that do not depend on load: the initial bundle of the build (brotli) and the DOM nodes of
  // the loaded list. They are the same on every machine (a CI runner and a desktop PC differed by one
  // node), so even the quick run on shared runners catches small regressions that timings there miss.
  // Not the bytes transferred on cold start: in CI those varied between about 200 and 300 kB
  // depending on which lazily loaded chunks were already fetched.
  for (const [metric, limitPct] of [['bundle.bytes (initial, brotli)', 5], ['memory.domNodes (loaded)', 5]] as const) {
    const r = find('P1', 'large', metric);
    const b = baselineDoc?.metrics[`P1|large|${metric}`];
    const rule = `${metric.replace(' (initial, brotli)', ': initial bundle brotli').replace(' (loaded)', ' of the loaded list')}, P1 · 10,000 issues, vs. baseline`;
    if (!r || !r.stats.n || !b) {
      checks.push({ rule, limit: `≤ +${limitPct} %`, value: r ? 'not in the baseline' : 'not measured', ok: true, skipped: true });
      continue;
    }
    const pct = (100 * (r.stats.median - b.median)) / b.median;
    checks.push({ rule, limit: `≤ +${limitPct} %`, value: `${fmt(r.stats.median, r.unit)} instead of ${fmt(b.median, r.unit)} (${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)} %)`, ok: pct <= limitPct });
  }
  const coldP2 = find('P2', 'large', 'cold.list');
  const coldFailed = find('P2', 'large', 'cold.failed');
  if (!coldP2) checks.push({ rule: 'Cold start P2 · 10,000 issues: list visible, p95', limit: '< 2,000 ms', value: 'not measured', ok: true, skipped: true });
  else checks.push({ rule: 'Cold start P2 · 10,000 issues: list visible, p95', limit: '< 2,000 ms', value: `${fmt(coldP2.stats.p95)}${coldFailed ? ` · ${coldFailed.stats.n} failures` : ''}`, ok: coldP2.stats.p95 < 2000 && !coldFailed });
  for (const r of rows.filter((x) => x.metric.endsWith('.failed') && !(x.profile === 'P2' && x.ws === 'large' && x.metric === 'cold.failed'))) {
    checks.push({ rule: `${r.profile} · ${r.ws}: ${r.metric}`, limit: '0', value: String(r.stats.n), ok: false });
  }
  const ok = checks.every((c) => c.ok);
  // Skipped rules (unmeasured cells, notes in the quick run) do not count as met: the report names
  // them so that "met" never promises more than was checked.
  const skipped = checks.filter((c) => c.skipped).length;
  const verdict = !ok ? 'violated' : skipped ? `met as far as checked (${skipped} rule${skipped === 1 ? '' : 's'} skipped)` : 'met';

  // ---------- Baseline ----------
  const FLOOR: Record<string, number> = { ms: 2, MB: 0.5, kB: 1024, '%': 0.5, '': 1 };
  const warnings: string[] = [];
  for (const r of rows) {
    if (!r.baseline || r.stats.n === 0) continue;
    // Bytes transferred at start depend on which lazily loaded chunks are already there; in the quick
    // run on the CI runner they vary by 50 %. No warning there (the initial bundle is what counts).
    if (mode === 'quick' && r.metric.endsWith('.bytes')) continue;
    // In the quick run, saves and agents go to a freshly started backend (three values, the first
    // writes are slow): 130 to 190 ms locally and in CI instead of about 40. Warn only in the full run.
    if (mode === 'quick' && (r.metric.startsWith('save.') || r.metric.startsWith('agent.'))) continue;
    const diff = r.stats.median - r.baseline.median;
    if (r.stats.median > r.baseline.median * 1.25 && diff >= (FLOOR[r.unit] ?? 0)) {
      warnings.push(`${r.profile} · ${r.ws} · ${r.metric}: median ${fmt(r.stats.median, r.unit)} instead of ${fmt(r.baseline.median, r.unit)} (+${Math.round((100 * diff) / Math.max(r.baseline.median, 1e-9))} %)`);
    }
  }

  // ---------- Markdown ----------
  const quick = mode === 'quick';
  const cell = (r: Row | undefined) => (r && r.stats.n ? `${fmt(r.stats.median, r.unit)}${r.unit === 'ms' || r.unit === '%' ? ` (${bare(r.stats.p95, r.unit)})` : ''}${r.timeouts ? ` · ${r.timeouts}× timeout` : ''}` : r?.timeouts ? `– · ${r.timeouts}× timeout` : '–');
  const has = (profile: string, ws: string) => rows.some((r) => r.profile === profile && r.ws === ws);

  let md = `# Performance run · ${runId}\n\n`;
  md += quick
    ? '> **Quick run (`--quick`), preliminary.** Few repetitions, only P1 · 10,000 issues, budget threshold 250 ms. Meant for catching regressions in CI, not for comparisons or decisions.\n\n'
    : '> Full run (`--full`). Meaningful only on an idle machine (see environment, load).\n\n';
  md += 'Method: from the input event timestamp until after the next frame in which the result is in the DOM; random offset 0–17 ms; warm-up runs; median and p95. Values as "median (p95)". Details in `perf/README.md`.\n\n';

  md += '## Environment\n\n| | |\n|---|---|\n';
  const envRows: [string, unknown][] = [
    ['Date', env.date],
    ['Commit', `${env.commit ?? '?'}${env.dirty ? ' (with local changes in app/core/backend)' : ''}`],
    ['Machine', `${env.cpu ?? '?'}, ${env.cores ?? '?'} threads, ${env.memGB ?? '?'} GiB, governor ${env.governor ?? '?'}`],
    ['Load (1/5/15 min) at start', Array.isArray(env.load) ? env.load.join(' / ') : '?'],
    ['Cores', env.pinned ? 'browser 0–7, backend and preview 8–15 (taskset)' : 'not separated'],
    ['System', `${env.os ?? '?'}, kernel ${env.kernel ?? '?'}, Node ${env.node ?? '?'}`],
    ['Browser', `${env.browser ?? '?'}, ${env.viewport?.width ?? 1440}×${env.viewport?.height ?? 900}`],
    ['Build', env.build],
    ['Profiles', env.profiles ? `P1 ${env.profiles.P1}; P2 ${env.profiles.P2}` : '?'],
    ['Repetitions', `${env.rounds ?? '?'} round(s) × (${env.warmup ?? '?'} warm-up + ${env.perRound ?? '?'} measurements), starts ${env.startRuns ?? '?'}×`],
  ];
  for (const [k, v] of envRows) md += `| ${k} | ${v ?? '?'} |\n`;

  md += `\n## Budget: ${ok ? verdict : '**violated**'}\n\n| Rule | Limit | Value | Result |\n|---|---|---|---|\n`;
  for (const c of checks) md += `| ${c.rule} | ${c.limit} | ${c.value} | ${c.skipped ? 'skipped' : c.ok ? 'met' : '**violated**'} |\n`;

  md += '\n## Comparison with the baseline (`perf/baseline.json`)\n\n';
  if (!baselineDoc) md += 'No baseline yet. After a full run on an idle machine: `node perf/report.ts perf/results/<run> --update-baseline`.\n';
  else {
    md += `Baseline: run ${baselineDoc.runId} (${baselineDoc.mode}, commit ${baselineDoc.commit}, ${baselineDoc.cpu}). Warning when a median is more than 25 % (and at least 2 ms) worse.\n\n`;
    if (baselineDoc.cpu !== env.cpu) md += `Note: different CPU than the baseline (${env.cpu}).\n\n`;
    md += warnings.length ? warnings.map((w) => `- Warning: ${w}`).join('\n') + '\n' : 'No regression over 25 %.\n';
  }

  if (has('P1', 'large') || has('P2', 'large')) {
    md += '\n## 1. Start · 10,000 issues\n\nCold start: empty browser cache, empty IndexedDB. Warm start: reload with cache and mirror.\n\n';
    md += '| | P1 | P2 |\n|---|---|---|\n';
    for (const [metric, label] of STARTS) {
      if (!find('P1', 'large', metric) && !find('P2', 'large', metric)) continue;
      md += `| ${label} | ${cell(find('P1', 'large', metric))} | ${cell(find('P2', 'large', metric))} |\n`;
    }

    md += '\n## 2. Response to a key press or click · 10,000 issues\n\nValues below about 17 ms: the result was already in the next frame.\n\n';
    md += '| Action | P1 | P2 |\n|---|---|---|\n';
    for (const [metric, label] of ACTIONS) {
      if (!find('P1', 'large', metric) && !find('P2', 'large', metric)) continue;
      md += `| ${label} | ${cell(find('P1', 'large', metric))} | ${cell(find('P2', 'large', metric))} |\n`;
    }

    md += '\n## 3. Saving and agents · 10,000 issues\n\n| | P1 | P2 |\n|---|---|---|\n';
    for (const [metric, label] of SAVES) {
      if (!find('P1', 'large', metric) && !find('P2', 'large', metric)) continue;
      md += `| ${label} | ${cell(find('P1', 'large', metric))} | ${cell(find('P2', 'large', metric))} |\n`;
    }

    if (SCROLL_MEMORY.some(([metric]) => find('P1', 'large', metric))) md += '\n## 4. Scrolling and memory · P1, 10,000 issues\n\n| | Value |\n|---|---|\n';
    for (const [metric, label] of SCROLL_MEMORY) {
      const r = find('P1', 'large', metric);
      if (!r) continue;
      md += `| ${label} | ${r.unit === '%' ? `${fmt(r.stats.median, '%')} (worst ${fmt(r.stats.max, '%')})` : cell(r)} |\n`;
    }
  }

  if (has('P1', 'small')) {
    md += '\n## 5. 440 issues · P1\n\n| Metric | Value |\n|---|---|\n';
    for (const r of rows.filter((x) => x.profile === 'P1' && x.ws === 'small')) md += `| ${r.metric} | ${cell(r)} |\n`;
  }

  md += '\n## All metrics\n';
  for (const profile of ['P1', 'P2', 'P1 visible', 'P2 visible']) {
    for (const ws of ['large', 'small']) {
      const list = rows.filter((r) => r.profile === profile && r.ws === ws);
      if (!list.length) continue;
      const name = profile.replace('P1', 'P1 local').replace('P2', 'P2 remote');
      md += `\n### ${name} · ${ws === 'large' ? '10,000 issues' : '440 issues'}\n\n`;
      md += `| Metric | Median | p95 | max |${opts.bootstrap ? ' Median 95 % interval |' : ''} DOM done (median) | Baseline median | n |\n|---|---|---|---|${opts.bootstrap ? '---|' : ''}---|---|---|\n`;
      for (const r of list) {
        const u = r.unit;
        const flag = profile === 'P1' && ws === 'large' && isCore(r.metric) && r.stats.p95 >= limit ? ' **over budget**' : '';
        const ci = opts.bootstrap ? ` ${r.ci ? `${fmt(r.ci.lo, u)} … ${fmt(r.ci.hi, u)}` : ''} |` : '';
        md += `| ${r.metric} | ${fmt(r.stats.median, u)} | ${fmt(r.stats.p95, u)}${flag} | ${fmt(r.stats.max, u)} |${ci} ${r.toDom !== null ? fmt(r.toDom) : ''} | ${r.baseline ? fmt(r.baseline.median, u) : ''} | ${r.stats.n}${r.timeouts ? ` · ${r.timeouts} timeout(s)` : ''} |\n`;
      }
    }
  }

  const eventRows = rows.filter((r) => r.eventTiming !== null);
  if (eventRows.length) {
    md += '\n### Cross-check: Event Timing from Chrome (only entries from 16 ms, rounded to 8 ms)\n\n| Profile | Data set | Metric | Median |\n|---|---|---|---|\n';
    for (const r of eventRows) md += `| ${r.profile} | ${r.ws} | ${r.metric} | ${fmt(r.eventTiming)} |\n`;
  }

  writeFileSync(join(dir, 'summary.md'), md);
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ runId, mode, environment: env, budget: { ok, complete: skipped === 0, checks }, baselineWarnings: warnings, rows }, null, 2));

  if (opts.updateBaseline) {
    const doc: Baseline = {
      runId,
      mode,
      commit: env.commit ?? '?',
      cpu: env.cpu ?? '?',
      date: env.date ?? new Date().toISOString(),
      metrics: Object.fromEntries(rows.filter((r) => r.stats.n > 0).map((r) => [`${r.profile}|${r.ws}|${r.metric}`, { median: round(r.stats.median), p95: round(r.stats.p95), n: r.stats.n }])),
    };
    writeFileSync(BASELINE_FILE, JSON.stringify(doc, null, 2) + '\n');
  } else if (opts.updateSizes && baselineDoc) {
    for (const r of rows.filter((x) => x.stats.n > 0 && isSize(x.metric))) {
      baselineDoc.metrics[`${r.profile}|${r.ws}|${r.metric}`] = { median: round(r.stats.median), p95: round(r.stats.p95), n: r.stats.n };
    }
    baselineDoc.sizesFrom = `${runId} (${mode}, commit ${env.commit ?? '?'})`;
    writeFileSync(BASELINE_FILE, JSON.stringify(baselineDoc, null, 2) + '\n');
  }

  // Short version for the console
  let out = `\nBudget (${mode === 'quick' ? 'quick run, threshold 250 ms' : 'full, threshold 100 ms'}): ${ok ? verdict : 'VIOLATED'}\n`;
  for (const c of checks) if (!c.ok || c.skipped) out += `  ${c.skipped ? 'skipped' : 'VIOLATED'}: ${c.rule} ${c.limit}, value ${c.value}\n`;
  const worst = core.filter((r) => r.stats.n).sort((a, b) => b.stats.p95 - a.stats.p95).slice(0, 5);
  if (worst.length) out += `  Highest p95 of the core actions: ${worst.map((r) => `${r.metric} ${fmt(r.stats.p95)}`).join(', ')}\n`;
  if (!baselineDoc) out += '  Baseline: none (perf/baseline.json missing)\n';
  for (const w of warnings) out += `  Warning: ${w}\n`;
  if (opts.updateBaseline) out += `  Baseline updated: ${BASELINE_FILE}\n`;
  else if (opts.updateSizes) out += `  Sizes (bytes, DOM nodes) copied into the baseline: ${BASELINE_FILE}\n`;
  out += `  Report: ${join(dir, 'summary.md')}\n`;
  return { ok, md, console: out, checks, warnings };
}

const round = (v: number) => Math.round(v * 100) / 100;

interface Baseline {
  runId: string;
  mode: string;
  commit: string;
  cpu: string;
  date: string;
  /** Run the sizes come from, when they were updated with --update-sizes */
  sizesFrom?: string;
  metrics: Record<string, { median: number; p95: number; n: number }>;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const dir = argv.find((a) => !a.startsWith('--'));
  if (!dir) {
    console.error('Usage: node perf/report.ts perf/results/<run> [--bootstrap] [--update-baseline | --update-sizes]');
    process.exit(2);
  }
  const report = buildReport(dir, {
    bootstrap: argv.includes('--bootstrap'),
    updateBaseline: argv.includes('--update-baseline'),
    updateSizes: argv.includes('--update-sizes'),
    mode: argv.includes('--quick') ? 'quick' : argv.includes('--full') ? 'full' : undefined,
  });
  console.log(report.console);
  process.exitCode = report.ok ? 0 : 1;
}
