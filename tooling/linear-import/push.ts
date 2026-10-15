// Linear import, steps 2 and 3: upload staging.jsonl to the backend and process it.
//
//   node tooling/linear-import/index.ts push <dir-or-staging.jsonl> [--yes] [--backend-dir <dir>]
//   node tooling/linear-import/index.ts push <dir-or-staging.jsonl> --prod
//
// 1. Shows target and size and asks for a typed confirmation ("import").
//    `--yes` skips that (tests only, never with `--prod`).
// 2. `convex run importer:stage` in batches below STAGE_MAX_BYTES (a single argument may be at
//    most 128 KiB on Linux): locally through tooling/convex.mjs (local or anonymous deployments
//    only), with `--prod` through tooling/cloud.mjs (only with the deploy key of the production
//    deployment from the instance settings, see tooling/instance.mjs; cloud.mjs refuses any other
//    key). `convex import` does not work in production: a deploy key has no backup rights.
// 3. `convex run importer:process` and prints the counts per kind.
// Only counts and ids are printed, never titles or texts.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { loadInstance } from '../instance.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONVEX_WRAPPER = join(REPO_ROOT, 'tooling', 'convex.mjs');
const CLOUD_WRAPPER = join(REPO_ROOT, 'tooling', 'cloud.mjs');
export const CONFIRM_WORD = 'import';
/** Size of one `importer:stage` batch (JSON of the rows), well below 128 KiB per argument. */
export const STAGE_MAX_BYTES = 90_000;

/**
 * Splits the lines (one JSON text per line) into batches below `maxBytes` with at most `maxRows`
 * lines (matching STAGE_MAX_ROWS in the backend). A line that is too large aborts.
 */
export function stageBatches(lines: string[], maxBytes = STAGE_MAX_BYTES, maxRows = 500): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    const bytes = Buffer.byteLength(line) + 1;
    if (bytes + 20 > maxBytes) {
      const row = JSON.parse(line) as { kind: string; linearId: string };
      throw new Error(`Row ${row.kind} ${row.linearId} has ${bytes} bytes, too large for a batch (at most ${maxBytes}).`);
    }
    if (current.length > 0 && (size + bytes + 20 > maxBytes || current.length >= maxRows)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += bytes;
  }
  if (current.length) batches.push(current);
  return batches;
}

export interface PushOptions {
  path: string;
  yes?: boolean;
  /** Backend directory (default: backend/). Tests pass a temporary backend. */
  backendDir?: string;
  /** Target is production (through tooling/cloud.mjs). Always requires the typed confirmation. */
  prod?: boolean;
  /** Production target; defaults to loadInstance() (deploy/instance.json or SELFBOUND_* env vars). */
  instance?: { convexDeployment?: string; appUrl?: string };
  print?: (line: string) => void;
  ask?: (question: string) => Promise<string>;
}

export interface StepCounts {
  seen: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

export interface PushResult {
  run: string;
  rows: number;
  status: string;
  counts: Record<string, StepCounts>;
  deviations: string[];
  conflicts: string[];
}

export function convex(backendDir: string, args: string[], prod = false): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let out = '';
    const child = spawn(process.execPath, [prod ? CLOUD_WRAPPER : CONVEX_WRAPPER, ...args], {
      env: { ...process.env, SELFBOUND_BACKEND_DIR: backendDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => (code === 0 ? resolvePromise(out) : reject(new Error(`convex ${args[0]} failed:\n${out}`))));
  });
}

/** Reads URL and deployment from <backend>/.env.local; local or anonymous deployments only. */
export function targetOf(backendDir: string) {
  const file = join(backendDir, '.env.local');
  if (!existsSync(file)) throw new Error(`${file} is missing. Is the local backend running (node tooling/local.mjs)?`);
  const env = readFileSync(file, 'utf8');
  const deployment = /^CONVEX_DEPLOYMENT=(.*)$/m.exec(env)?.[1]?.split('#')[0]?.trim() ?? '';
  const url = /^CONVEX_URL=(.*)$/m.exec(env)?.[1]?.trim() ?? '';
  if (!/^(anonymous|local):/.test(deployment)) {
    throw new Error(`Aborted: the target is not a local deployment (${deployment || 'unknown'}).`);
  }
  return { url, deployment };
}

/** The JSON object in the output of `convex run` (the CLI prints the return value). */
export function parseRunOutput(out: string): unknown {
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`Unexpected output from convex run:\n${out}`);
  return JSON.parse(out.slice(start, end + 1));
}

/** Processing order (matches IMPORT_STEPS in the backend). */
const STEP_ORDER = ['team', 'labelGroup', 'label', 'project', 'sprint', 'issue', 'parent', 'comment', 'relation', 'pullRequest', 'link'];

export function formatCounts(counts: Record<string, StepCounts>): string[] {
  const lines = [`  ${'kind'.padEnd(12)} ${'seen'.padStart(8)} ${'new'.padStart(6)} ${'changed'.padStart(9)} ${'same'.padStart(7)} ${'skipped'.padStart(13)}`];
  const rank = (step: string) => (STEP_ORDER.includes(step) ? STEP_ORDER.indexOf(step) : STEP_ORDER.length);
  for (const [step, c] of Object.entries(counts).sort(([a], [b]) => rank(a) - rank(b))) {
    lines.push(
      `  ${step.padEnd(12)} ${String(c.seen).padStart(8)} ${String(c.created).padStart(6)} ${String(c.updated).padStart(9)} ${String(c.unchanged).padStart(7)} ${String(c.skipped).padStart(13)}`,
    );
  }
  return lines;
}

export async function runPush(options: PushOptions): Promise<PushResult> {
  const print = options.print ?? ((line: string) => console.log(line));
  const backendDir = resolve(options.backendDir ?? join(REPO_ROOT, 'backend'));
  const given = resolve(options.path);
  const file = existsSync(given) && statSync(given).isDirectory() ? join(given, 'staging.jsonl') : given;
  if (!existsSync(file)) throw new Error(`${file} does not exist.`);
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new Error(`${file} is empty.`);
  const perKind = new Map<string, number>();
  const runs = new Set<string>();
  for (const line of lines) {
    const row = JSON.parse(line) as { run: string; kind: string };
    runs.add(row.run);
    perKind.set(row.kind, (perKind.get(row.kind) ?? 0) + 1);
  }
  if (runs.size !== 1) throw new Error(`${file} contains ${runs.size} runs; expected exactly one.`);
  const run = [...runs][0]!;
  const summaryFile = join(dirname(file), 'summary.json');
  const notes: string[] = existsSync(summaryFile) ? ((JSON.parse(readFileSync(summaryFile, 'utf8')).notes as string[]) ?? []) : [];
  const prod = options.prod === true;
  if (prod && options.yes) throw new Error('Aborted: --yes does not apply to production. The confirmation is always typed.');
  if (prod && options.backendDir) throw new Error('Aborted: --prod and --backend-dir are mutually exclusive.');

  if (prod) {
    const { convexDeployment, appUrl } = options.instance ?? loadInstance();
    if (!convexDeployment || !appUrl) {
      throw new Error(
        'Aborted: production target unknown. Set convexDeployment and appUrl in deploy/instance.json (see deploy/instance.example.json) or SELFBOUND_CONVEX_DEPLOYMENT and SELFBOUND_APP_URL.',
      );
    }
    print(`Target: PRODUCTION ${convexDeployment} (https://${convexDeployment}.convex.cloud, app ${appUrl})`);
    print('        Real data. Existing records are reconciled, not deleted.');
  } else {
    const target = targetOf(backendDir);
    print(`Target: ${target.url} (${target.deployment.split(':')[0]}, local)`);
  }
  print(`Run:    ${run}, ${lines.length} rows: ${[...perKind].map(([k, n]) => `${k} ${n}`).join(', ')}`);
  if (prod || !options.yes) {
    const ask =
      options.ask ??
      (async (question: string) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await rl.question(question);
        } finally {
          rl.close();
        }
      });
    const answer = await ask(`Type "${CONFIRM_WORD}" to start${prod ? ' in PRODUCTION' : ''}: `);
    if (answer.trim() !== CONFIRM_WORD) throw new Error('Cancelled, nothing uploaded.');
  }

  const batches = stageBatches(lines);
  print(`Uploading staging.jsonl (importStaging, append, ${batches.length} batches) …`);
  for (const batch of batches) {
    await convex(backendDir, ['run', 'importer:stage', `{"rows":[${batch.join(',')}]}`], prod);
  }
  print('Processing (importer:process) …');
  const out = await convex(backendDir, ['run', 'importer:process', JSON.stringify({ run, notes })], prod);
  let result = parseRunOutput(out) as Omit<PushResult, 'rows'> & { runId?: string; error?: string | null };
  // A run consists of many scheduled steps. If it takes longer than the action may wait,
  // it returns `running`: keep polling here until it is done.
  while (result.status === 'running' && result.runId) {
    print(`  still running (${Object.values(result.counts ?? {}).reduce((sum, c) => sum + c.seen, 0)} rows processed) …`);
    await new Promise((r) => setTimeout(r, 5000));
    result = parseRunOutput(await convex(backendDir, ['run', 'importer:summary', JSON.stringify({ runId: result.runId })], prod)) as typeof result;
  }
  if (result.status !== 'done') throw new Error(`Import ${result.status}: ${result.error ?? 'unknown error'}`);
  print(`Result: ${result.status}`);
  for (const line of formatCounts(result.counts)) print(line);
  if (result.conflicts.length) {
    print(`Conflicts (${result.conflicts.length}):`);
    for (const c of result.conflicts) print(`  - ${c}`);
  }
  if (result.deviations.length) {
    print(`Deviations (${result.deviations.length}):`);
    for (const d of result.deviations.slice(0, 50)) print(`  - ${d}`);
  }
  return { ...result, run, rows: lines.length };
}
