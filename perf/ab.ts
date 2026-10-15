// A/B comparison of two revisions in alternation (A B B A …), each revision in its own worktree
// with its own perf/run.ts. So load on the machine hits both sides equally, and old revisions are
// measured with their own backend.
//
// Usage:
//   node perf/ab.ts --a=main --b=. -- --only=starts --cells=P1-large
//   node perf/ab.ts --a=58d7f07 --b=f6c765b --pairs=3 -- --only=starts --cells=P1-large
//   node perf/ab.ts --report=perf/results/ab-<timestamp>      only recompute the comparison
// Switches:
//   --a, --b       git ref or "." (this worktree, including local changes). Default: main and "."
//   --pairs=N      number of pairs (default 2, so 4 runs)
//   --name=…       folder name under perf/results (default ab-<timestamp>)
//   --max-load=N   before each run, wait until the load (1 min) is below N (at most 15 min)
//   after "--"     switches for run.ts (default --full). ab.ts sets --no-budget and --out itself.
//
// Worktrees of other revisions live under ~/.cache/selfbound-perf/refs/<commit> (SELFBOUND_PERF_REFS), not
// under /tmp: tmpfs makes the measurement backend's writes faster (about 10 ms).
// Metric names must match on both sides: revisions from before the metrics were renamed to English
// cannot be compared with newer ones.
// Output: perf/results/<name>/{<side>-<n>/…, ab.md, ab.json}

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { cacheDir, envVar } from '../tooling/lib/env.mjs';
import { fmt } from './report.ts';
import { here, root } from './stack.ts';

interface Sample {
  profile: string;
  ws: string;
  metric: string;
  value: number | null;
}

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const own = sep === -1 ? argv : argv.slice(0, sep);
const passthrough = sep === -1 ? ['--full'] : argv.slice(sep + 1);
const opt = (name: string) => own.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const git = (args: string[], cwd = root) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout.trim();
};

// ---------- Worktrees ----------

interface Side {
  label: 'A' | 'B';
  ref: string;
  commit: string;
  dir: string;
  built: boolean;
}

function prepare(label: 'A' | 'B', ref: string): Side {
  if (ref === '.') return { label, ref, commit: `${git(['rev-parse', '--short=10', 'HEAD'])}${git(['status', '--porcelain', '--', 'app', 'core', 'backend']) ? '+local' : ''}`, dir: root, built: false };
  const commit = git(['rev-parse', '--short=10', `${ref}^{commit}`]);
  const base = envVar('PERF_REFS') ?? join(cacheDir({ suffix: '-perf' }), 'refs');
  const dir = join(base, commit);
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(base, { recursive: true });
    console.log(`▸ Worktree for ${ref} (${commit}) …`);
    git(['worktree', 'add', '--detach', dir, commit]);
  }
  if (!existsSync(join(dir, 'node_modules'))) {
    console.log(`▸ Dependencies for ${commit} …`);
    const r = spawnSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], { cwd: dir, stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`pnpm install in ${dir} failed`);
  }
  return { label, ref, commit, dir, built: false };
}

// ---------- Runs ----------

async function waitForLoad(max: number) {
  const start = Date.now();
  while (os.loadavg()[0] > max && Date.now() - start < 15 * 60_000) {
    console.log(`  Load ${os.loadavg()[0].toFixed(1)} > ${max}, waiting 30 s …`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

function runOnce(side: Side, out: string): Promise<number> {
  const args = ['perf/run.ts', ...passthrough.filter((a) => !a.startsWith('--out=') && a !== '--no-budget'), '--no-budget', `--out=${out}`];
  if (side.built && !args.includes('--skip-build')) args.push('--skip-build');
  mkdirSync(out, { recursive: true });
  const log = createWriteStream(join(out, 'run.log'));
  return new Promise((done) => {
    const child = spawn('node', args, { cwd: side.dir, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('close', (code) => {
      log.end();
      done(code ?? 2);
    });
  });
}

// ---------- Comparison ----------

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = (s.length - 1) / 2;
  return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
}

/** Difference of the medians (B − A) with a bootstrap 95 % interval; resampling happens within each run. */
function bootstrapDiff(a: number[][], b: number[][], iterations = 2000) {
  let seed = 7;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const draw = (runs: number[][]) => median(runs.flatMap((xs) => xs.map(() => xs[Math.floor(rand() * xs.length)])));
  const diffs: number[] = [];
  for (let i = 0; i < iterations; i++) diffs.push(draw(b) - draw(a));
  diffs.sort((x, y) => x - y);
  return { lo: diffs[Math.floor(iterations * 0.025)], hi: diffs[Math.floor(iterations * 0.975)] };
}

const unitOf = (metric: string) =>
  metric.endsWith('Pct') ? '%' : metric.includes('heapMB') ? 'MB' : metric.includes('bytes') ? 'kB' : /domNodes|loafCount|fromCache|\.failed$/.test(metric) ? '' : 'ms';

export function compare(dir: string) {
  const meta = JSON.parse(readFileSync(join(dir, 'ab.json'), 'utf8')) as { a: Omit<Side, 'dir' | 'built'>; b: Omit<Side, 'dir' | 'built'>; runs: { side: 'A' | 'B'; out: string; code: number; load: number[] }[]; args: string[] };
  const bySide = { A: new Map<string, number[][]>(), B: new Map<string, number[][]>() };
  for (const run of meta.runs) {
    const file = join(run.out, 'samples.json');
    if (run.code === 2 || !existsSync(file)) continue;
    const perMetric = new Map<string, number[]>();
    for (const s of JSON.parse(readFileSync(file, 'utf8')) as Sample[]) {
      if (s.value === null) continue;
      const key = `${s.profile}|${s.ws}|${s.metric}`;
      perMetric.set(key, [...(perMetric.get(key) ?? []), s.value]);
    }
    for (const [key, values] of perMetric) bySide[run.side].set(key, [...(bySide[run.side].get(key) ?? []), values]);
  }

  interface Line { key: string; unit: string; a: number; b: number; diff: number; pct: number; ci: { lo: number; hi: number }; runsA: number[]; runsB: number[]; separated: boolean; verdict: string }
  const lines: Line[] = [];
  for (const [key, runsA] of bySide.A) {
    const runsB = bySide.B.get(key);
    if (!runsB) continue;
    const unit = unitOf(key);
    const a = median(runsA.flat());
    const b = median(runsB.flat());
    const ci = bootstrapDiff(runsA, runsB);
    const medA = runsA.map(median);
    const medB = runsB.map(median);
    // All runs of one side above all runs of the other: with two or more runs each, a sign that
    // the gap is not just variation between runs.
    const separated = medA.length > 1 && medB.length > 1 && (Math.min(...medB) > Math.max(...medA) || Math.max(...medB) < Math.min(...medA));
    const floor = unit === 'ms' ? 1 : unit === 'kB' ? 1024 : unit === 'MB' ? 0.5 : unit === '%' ? 0.5 : 1;
    const real = (ci.lo > 0 || ci.hi < 0) && Math.abs(b - a) >= floor;
    const worse = b > a ? (unit === '' && key.includes('fromCache') ? 'better' : 'slower') : unit === '' && key.includes('fromCache') ? 'worse' : 'faster';
    const verdict = !real ? 'same' : separated ? worse : `likely ${worse}`;
    lines.push({ key, unit, a, b, diff: b - a, pct: a ? (100 * (b - a)) / a : 0, ci, runsA: medA, runsB: medB, separated, verdict });
  }
  const rank = (l: Line) => (l.verdict === 'same' ? 2 : l.verdict.startsWith('likely') ? 1 : 0);
  lines.sort((x, y) => rank(x) - rank(y) || Math.abs(y.pct) - Math.abs(x.pct));

  const f = (v: number, u: string) => fmt(v, u);
  const runList = (xs: number[], u: string) => xs.map((x) => f(x, u).replace(/ (ms|%|MB|kB)$/, '')).join(' · ');
  let md = `# A/B comparison · ${dir.split('/').filter(Boolean).pop()}\n\n`;
  md += `A = \`${meta.a.ref}\` (${meta.a.commit}), B = \`${meta.b.ref}\` (${meta.b.commit}). Runs in alternation, run.ts switches: \`${meta.args.join(' ')}\`.\n\n`;
  md += '| Run | Side | Exit | Load at start |\n|---|---|---|---|\n';
  const why = (out: string) => {
    const file = join(out, 'aborted.md');
    return existsSync(file) ? `: ${(/```\n(.*)/.exec(readFileSync(file, 'utf8'))?.[1] ?? '').slice(0, 160)}` : ', see run.log';
  };
  meta.runs.forEach((r, i) => (md += `| ${i + 1} | ${r.side} | ${r.code}${r.code === 2 ? ` (aborted${why(r.out)})` : ''} | ${r.load.join(' / ')} |\n`));
  md += '\n"Difference": the bootstrap 95 % interval of the difference of the medians excludes 0 and the gap is at least 1 ms. "Runs separated": every run median of one side lies above every run median of the other. Only both together count as slower or faster, otherwise "likely".\n\n';
  md += '| Metric | A median | B median | B − A | 95 % interval | Runs A | Runs B | Verdict |\n|---|---|---|---|---|---|---|---|\n';
  for (const l of lines) {
    const sign = l.diff >= 0 ? '+' : '−';
    md += `| ${l.key.replaceAll('|', ' · ')} | ${f(l.a, l.unit)} | ${f(l.b, l.unit)} | ${sign}${f(Math.abs(l.diff), l.unit)} (${sign}${Math.abs(l.pct).toFixed(0)} %) | ${f(l.ci.lo, l.unit)} … ${f(l.ci.hi, l.unit)} | ${runList(l.runsA, l.unit)} | ${runList(l.runsB, l.unit)} | ${l.verdict === 'same' ? 'same' : `**${l.verdict}**`} |\n`;
  }
  writeFileSync(join(dir, 'ab.md'), md);
  writeFileSync(join(dir, 'ab.json'), JSON.stringify({ ...meta, lines }, null, 2));
  return lines;
}

// ---------- Main ----------

async function main() {
  const reportOnly = opt('report');
  if (reportOnly) {
    const lines = compare(resolve(reportOnly));
    for (const l of lines.filter((x) => x.verdict !== 'same')) console.log(`${l.verdict}: ${l.key} ${fmt(l.a, l.unit)} → ${fmt(l.b, l.unit)}`);
    console.log(`Report: ${join(resolve(reportOnly), 'ab.md')}`);
    return;
  }
  const pairs = Number(opt('pairs') ?? 2);
  const maxLoad = opt('max-load') ? Number(opt('max-load')) : null;
  const name = opt('name') ?? `ab-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const dir = join(here, 'results', name);
  mkdirSync(dir, { recursive: true });
  const a = prepare('A', opt('a') ?? 'main');
  const b = prepare('B', opt('b') ?? '.');
  if (a.dir === b.dir && a.ref === b.ref) console.log('Note: A and B are the same revision (null comparison, measures only the variation).');

  const order = Array.from({ length: pairs }, (_, i) => (i % 2 ? [b, a] : [a, b])).flat();
  const runs: { side: 'A' | 'B'; out: string; code: number; load: number[] }[] = [];
  const save = () => writeFileSync(join(dir, 'ab.json'), JSON.stringify({ a: { label: 'A', ref: a.ref, commit: a.commit }, b: { label: 'B', ref: b.ref, commit: b.commit }, runs, args: passthrough }, null, 2));
  const t0 = Date.now();
  for (const [i, side] of order.entries()) {
    if (maxLoad !== null) await waitForLoad(maxLoad);
    const n = runs.filter((r) => r.side === side.label).length + 1;
    const out = join(dir, `${side.label}-${n}`);
    const load = os.loadavg().map((x) => Math.round(x * 10) / 10);
    process.stdout.write(`Run ${i + 1}/${order.length}: ${side.label} (${side.commit}) … `);
    const t = Date.now();
    let code = await runOnce(side, out);
    // Repeat an aborted run (exit 2 or no report) once; the reason is in run.log.
    if (code !== 2 && !existsSync(join(out, 'summary.md'))) code = 2;
    if (code === 2) {
      process.stdout.write(`aborted, retrying … `);
      code = await runOnce(side, out);
      if (code !== 2 && !existsSync(join(out, 'summary.md'))) code = 2;
    }
    if (code !== 2) side.built = true;
    runs.push({ side: side.label, out, code, load });
    save();
    console.log(`${code === 2 ? 'ABORTED, see run.log' : 'done'} (${((Date.now() - t) / 60000).toFixed(1)} min)`);
  }
  const lines = compare(dir);
  console.log(`\n${order.length} runs in ${((Date.now() - t0) / 60000).toFixed(0)} min.`);
  for (const l of lines.filter((x) => x.verdict !== 'same')) console.log(`  ${l.verdict}: ${l.key} ${fmt(l.a, l.unit)} → ${fmt(l.b, l.unit)}`);
  console.log(`Report: ${join(dir, 'ab.md')}`);
  if (runs.some((r) => r.code === 2)) process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 2;
  }
}
