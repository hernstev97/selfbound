// Optional: performance runs while the machine is idle (perf/README.md, "When to measure").
//
// A pass first checks whether the machine is free (time window, no game running, GPU quiet, low
// load, no other performance run). Then:
//   1. main: full run if there is a new commit on origin/main since the last pass. Compared with
//      perf/baseline.json and the previous main run. If something stands out, an A/B run (before vs.
//      after, alternating) measures again before anything is reported.
//   2. Pull requests with the label "tempo": A/B against main, result as a PR comment.
// During every run a watchdog keeps checking every 30 s; if a game starts or the GPU gets busy, it
// aborts the run (values discarded) and the next pass tries again.
//
// Usage:
//   node perf/idle.ts check            check only (exit 0: free, 3: not free, with reason)
//   node perf/idle.ts run              one pass (this is what the timer runs)
//   node perf/idle.ts run --now        ignore the time window (e.g. you know the machine is free)
//   node perf/idle.ts run --dry-run    only show what would be measured
//   node perf/idle.ts status           latest state
// Environment:
//   SELFBOUND_PERF_STATE     state and results (default ~/.local/state/selfbound-perf)
//   SELFBOUND_PERF_WINDOW    time window, default 01:00-08:00
//   SELFBOUND_PERF_MAX_LOAD  load (1 min) above which no run starts, default 4
//   SELFBOUND_PERF_MAX_GPU   GPU utilization in %, default 40 (desktop with screen recording and Chrome: about 18 %)
//   SELFBOUND_PERF_MINUTES   time per pass, default 150 (no new run if it no longer fits)
// legacy-xlr8: the old XLR8_PERF_* names and the xlr8-perf directories still work, with a warning.
// Install as a systemd user timer (Linux): perf/idle/install.sh

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { cacheDir, envVar, stateDir } from '../tooling/lib/env.mjs';
import { compare } from './ab.ts';
import { root } from './stack.ts';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'status';
const NOW = argv.includes('--now');
const DRY = argv.includes('--dry-run');

const STATE = envVar('PERF_STATE') ?? stateDir({ suffix: '-perf' });
const WINDOW = envVar('PERF_WINDOW') ?? '01:00-08:00';
const MAX_LOAD = Number(envVar('PERF_MAX_LOAD') ?? 4);
const MAX_GPU = Number(envVar('PERF_MAX_GPU') ?? 40);
const BUDGET_MIN = Number(envVar('PERF_MINUTES') ?? 150);
const PORTS = [13520, 5522];
// Estimated duration per run in minutes, to decide whether it still fits into the window.
const EST = { full: 40, ab: 45, confirm: 30 };

mkdirSync(join(STATE, 'results'), { recursive: true });
const stateFile = join(STATE, 'state.json');
const logFile = join(STATE, 'idle.log');
const lockFile = join(STATE, 'lock');

interface State {
  lastMain?: { commit: string; dir: string; date: string; verdict: string };
  prs: Record<string, { commit: string; date: string; verdict: string }>;
  history: { date: string; job: string; result: string }[];
}
const load = (): State => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { prs: {}, history: [] });
const store = (s: State) => writeFileSync(stateFile, JSON.stringify({ ...s, history: s.history.slice(-50) }, null, 2));
const log = (msg: string) => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  appendFileSync(logFile, `${line}\n`);
};

const sh = (cmd: string, args: string[], cwd = root) => spawnSync(cmd, args, { cwd, encoding: 'utf8' });

// ---------- Is the machine free? ----------

function inWindow(date = new Date()) {
  const [from, to] = WINDOW.split('-').map((t) => t.split(':').map(Number)).map(([h, m]) => h * 60 + (m || 0));
  const now = date.getHours() * 60 + date.getMinutes();
  return from <= to ? now >= from && now < to : now >= from || now < to;
}

/**
 * Is a game running? Steam (including Proton), Gamescope, Lutris, Heroic. Wine alone does not
 * count: some desktop tools run permanently under Wine.
 */
function game(): string | null {
  const r = sh('pgrep', ['-af', 'SteamLaunch|gamescope|steamapps/common|lutris-wrapper|legendary|gogdl']);
  const hit = r.stdout.split('\n').find((l) => l.trim() && !/pgrep|idle\.ts/.test(l));
  return hit ? hit.slice(0, 120) : null;
}

/** GPU utilization in % (median of three samples), null without nvidia-smi. */
function gpu(): number | null {
  const probes: number[] = [];
  for (let i = 0; i < 3; i++) {
    const r = sh('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits']);
    if (r.status !== 0) return null;
    probes.push(Math.max(...r.stdout.trim().split('\n').map(Number)));
    if (i < 2) spawnSync('sleep', ['1']);
  }
  return probes.sort((a, b) => a - b)[1];
}

function portsBusy() {
  const r = sh('ss', ['-ltnH']);
  return PORTS.filter((p) => new RegExp(`:${p}\\s`).test(r.stdout));
}

function lockHolder(): number | null {
  if (!existsSync(lockFile)) return null;
  const pid = Number(readFileSync(lockFile, 'utf8'));
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** Reasons not to measure now (empty = free). `during`: check while a run is going (its own load does not count). */
function blockers(during = false): string[] {
  const out: string[] = [];
  if (!during && !NOW && !inWindow()) out.push(`outside the time window ${WINDOW}`);
  const g = game();
  if (g) out.push(`game running: ${g}`);
  const util = gpu();
  if (util !== null && util > MAX_GPU) out.push(`GPU at ${util} % (limit ${MAX_GPU} %)`);
  if (!during) {
    const l = os.loadavg()[0];
    if (l > MAX_LOAD) out.push(`load ${l.toFixed(1)} (limit ${MAX_LOAD})`);
    const busy = portsBusy();
    if (busy.length) out.push(`ports ${busy.join(', ')} in use (another performance run?)`);
    const holder = lockHolder();
    if (holder) out.push(`a pass is already running (PID ${holder})`);
  }
  return out;
}

// ---------- Runs with a watchdog ----------

/** Starts a run as its own process group; aborts when the machine is no longer free or time runs out. */
function guarded(label: string, args: string[], cwd: string, minutes: number): Promise<{ code: number; aborted?: string }> {
  log(`${label}: node ${args.join(' ')} (at most ${minutes} min)`);
  return new Promise((done) => {
    const child = spawn('node', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const out = join(STATE, 'current.log');
    writeFileSync(out, '');
    child.stdout.on('data', (d) => appendFileSync(out, d));
    child.stderr.on('data', (d) => appendFileSync(out, d));
    let aborted: string | undefined;
    const stop = (why: string) => {
      if (aborted) return;
      aborted = why;
      log(`${label}: aborted, ${why}`);
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {}
      setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {}
      }, 15_000);
    };
    const timer = setTimeout(() => stop(`time is up (${minutes} min)`), minutes * 60_000);
    const watch = setInterval(() => {
      const why = blockers(true);
      if (why.length) stop(why.join('; '));
    }, 30_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(watch);
      done({ code: code ?? 2, aborted });
    });
  });
}

// ---------- Worktree of main ----------

const mainDir = join(cacheDir({ suffix: '-perf' }), 'main');

function prepareMain(): string {
  sh('git', ['fetch', '-q', 'origin', 'main']);
  const commit = sh('git', ['rev-parse', '--short=10', 'origin/main']).stdout.trim();
  if (!existsSync(join(mainDir, '.git'))) {
    mkdirSync(join(mainDir, '..'), { recursive: true });
    const r = sh('git', ['worktree', 'add', '--detach', mainDir, 'origin/main']);
    if (r.status !== 0) throw new Error(`git worktree add: ${r.stderr}`);
  } else {
    sh('git', ['checkout', '-q', '--detach', 'origin/main'], mainDir);
  }
  const install = sh('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], mainDir);
  if (install.status !== 0) throw new Error(`pnpm install: ${install.stderr.slice(-500)}`);
  return commit;
}

// ---------- Evaluation ----------

interface Summary {
  budget: { ok: boolean };
  baselineWarnings: string[];
}

/** Compares two single runs (before, after) with the A/B evaluation; returns the notable lines. */
function diffRuns(before: string, after: string, dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ab.json'), JSON.stringify({ a: { ref: 'before', commit: before.split('/').pop() }, b: { ref: 'after', commit: after.split('/').pop() }, runs: [{ side: 'A', out: before, code: 0, load: [] }, { side: 'B', out: after, code: 0, load: [] }], args: ['--full'] }));
  // Only main measurements at P1 · 10,000 issues, at least 10 % and 2 ms worse.
  return compare(dir).filter((l) => l.key.startsWith('P1|large|') && l.verdict.includes('slower') && l.pct >= 10 && l.diff >= 2);
}

function notify(title: string, body: string) {
  sh('notify-send', ['--app-name=Selfbound performance', title, body]);
}

function openIssue(title: string, body: string) {
  const r = sh('gh', ['issue', 'create', '--title', title, '--body', body, '--label', 'tempo']);
  if (r.status !== 0) sh('gh', ['issue', 'create', '--title', title, '--body', body]);
}

// ---------- Pass ----------

async function run() {
  const why = blockers();
  if (why.length) {
    log(`not free: ${why.join('; ')}`);
    process.exitCode = 3;
    return;
  }
  writeFileSync(lockFile, String(process.pid));
  const t0 = Date.now();
  const left = () => BUDGET_MIN - (Date.now() - t0) / 60000;
  const state = load();
  try {
    const commit = prepareMain();
    // 1. main
    if (state.lastMain?.commit !== commit) {
      if (DRY) log(`would run a full measurement of main ${commit} (previous: ${state.lastMain?.commit ?? 'none'})`);
      else if (left() >= EST.full) {
        const dir = join(STATE, 'results', `main-${commit}-${new Date().toISOString().slice(0, 16).replace(/:/g, '-')}`);
        const res = await guarded(`main ${commit}`, ['perf/run.ts', '--full', `--out=${dir}`], mainDir, 60);
        if (res.aborted || res.code === 2) {
          state.history.push({ date: new Date().toISOString(), job: `main ${commit}`, result: `aborted: ${res.aborted ?? 'exit 2, see current.log'}` });
        } else {
          const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as Summary;
          const slower = state.lastMain ? diffRuns(state.lastMain.dir, dir, `${dir}-vs-previous`) : [];
          let verdict = summary.budget.ok && summary.baselineWarnings.length === 0 && slower.length === 0 ? 'ok' : 'notable';
          // Notable: measure again in alternation first, so a disturbed run raises no alarm.
          if (verdict === 'notable' && state.lastMain && left() >= EST.confirm) {
            const name = `ab-main-${state.lastMain.commit.slice(0, 7)}-${commit.slice(0, 7)}`;
            const ab = await guarded('Confirmation', ['perf/ab.ts', `--a=${state.lastMain.commit}`, `--b=${commit}`, '--pairs=2', `--name=${name}`, '--', '--full', '--cells=P1-large', '--only=starts,interactions'], mainDir, 90);
            const abDir = join(mainDir, 'perf', 'results', name);
            const confirmed = !ab.aborted && existsSync(join(abDir, 'ab.json')) ? compare(abDir).filter((l) => l.verdict === 'slower' && l.pct >= 5) : null;
            if (confirmed && confirmed.length === 0 && summary.budget.ok) verdict = 'ok (confirmation run: same)';
            if (confirmed?.length) {
              const lines = confirmed.map((l) => `- ${l.key.replaceAll('|', ' · ')}: ${l.a.toFixed(1)} → ${l.b.toFixed(1)} (+${l.pct.toFixed(0)} %)`).join('\n');
              openIssue(`Performance: main ${commit} slower than ${state.lastMain.commit}`, `Idle measurement (perf/idle.ts), confirmed in alternation (2 pairs, P1 · 10,000 issues):\n\n${lines}\n\nReport: ${abDir}/ab.md`);
              verdict = `slower (confirmed): ${confirmed.length} metric(s)`;
            }
          }
          if (!summary.budget.ok) verdict += ', budget violated';
          state.lastMain = { commit, dir, date: new Date().toISOString(), verdict };
          state.history.push({ date: new Date().toISOString(), job: `main ${commit}`, result: verdict });
          notify(`main ${commit}: ${verdict}`, `${summary.baselineWarnings.length} warning(s) against the baseline. ${dir}/summary.md`);
        }
        store(state);
      }
    }
    // 2. Pull requests with the label "tempo"
    const prs = sh('gh', ['pr', 'list', '--label', 'tempo', '--state', 'open', '--json', 'number,headRefOid,title']);
    const list = prs.status === 0 ? (JSON.parse(prs.stdout) as { number: number; headRefOid: string; title: string }[]) : [];
    for (const pr of list) {
      const head = pr.headRefOid.slice(0, 10);
      if (state.prs[pr.number]?.commit === head) continue;
      if (DRY) {
        log(`would measure PR #${pr.number} (${head}) in alternation with main ${commit}`);
        continue;
      }
      if (left() < EST.ab) break;
      sh('git', ['fetch', '-q', 'origin', `pull/${pr.number}/head`]);
      const name = `pr${pr.number}-${head.slice(0, 7)}`;
      const ab = await guarded(`PR #${pr.number}`, ['perf/ab.ts', `--a=${commit}`, `--b=${head}`, '--pairs=2', `--name=${name}`, '--', '--full', '--cells=P1-large'], mainDir, 120);
      const abDir = join(mainDir, 'perf', 'results', name);
      if (ab.aborted || !existsSync(join(abDir, 'ab.md'))) {
        state.history.push({ date: new Date().toISOString(), job: `PR #${pr.number}`, result: `aborted: ${ab.aborted ?? `exit ${ab.code}`}` });
        store(state);
        break;
      }
      const lines = compare(abDir).filter((l) => l.verdict !== 'same');
      const verdict = lines.some((l) => l.verdict === 'slower') ? 'slower' : lines.some((l) => l.verdict === 'faster') ? 'faster' : 'same';
      const md = readFileSync(join(abDir, 'ab.md'), 'utf8');
      const head5 = md.split('\n').filter((l) => !l.startsWith('| ') || !l.endsWith('| same |')).join('\n');
      sh('gh', ['pr', 'comment', String(pr.number), '--body', `**Idle performance run (perf/idle.ts): ${verdict}**\n\nmain \`${commit}\` vs. PR \`${head}\`, 2 pairs in alternation, P1 · 10,000 issues. Only metrics that are not "same" are shown.\n\n${head5.slice(0, 60_000)}`]);
      state.prs[pr.number] = { commit: head, date: new Date().toISOString(), verdict };
      state.history.push({ date: new Date().toISOString(), job: `PR #${pr.number}`, result: verdict });
      store(state);
      notify(`PR #${pr.number}: ${verdict}`, pr.title);
    }
    if (!DRY) store(state);
  } finally {
    rmSync(lockFile, { force: true });
  }
}

function status() {
  const s = load();
  console.log(`State: ${STATE}`);
  console.log(`main: ${s.lastMain ? `${s.lastMain.commit} on ${s.lastMain.date.slice(0, 16)}: ${s.lastMain.verdict}` : 'never measured'}`);
  for (const [n, p] of Object.entries(s.prs)) console.log(`PR #${n}: ${p.commit} on ${p.date.slice(0, 16)}: ${p.verdict}`);
  for (const h of s.history.slice(-8)) console.log(`  ${h.date.slice(0, 16)} ${h.job}: ${h.result}`);
  const why = blockers();
  console.log(why.length ? `Not free now: ${why.join('; ')}` : 'Free for a pass now.');
}

if (command === 'check') {
  const why = blockers();
  console.log(why.length ? `not free: ${why.join('; ')}` : 'free');
  process.exitCode = why.length ? 3 : 0;
} else if (command === 'run') {
  try {
    await run();
  } catch (error) {
    log(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
} else status();
