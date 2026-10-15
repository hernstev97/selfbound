#!/usr/bin/env node
// Linear import (read-only on the Linear side): fetches a one-time copy of a Linear workspace.
//
//   node tooling/linear-import/index.ts fetch [--dry-run] [--out <dir>] [--key-file <file>]
//                                             [--map-status "Name=status" …] [--time-zone <IANA name>]
//   node tooling/linear-import/index.ts push <dir-or-staging.jsonl> [--yes] [--backend-dir <dir>] [--prod]
//   node tooling/linear-import/index.ts files scan|download|upload|rewrite …   (files hosted by Linear, files.ts)
//   node tooling/linear-import/index.ts document <copy.md> --team <KEY> [--project <name>] [--yes] [--prod]
//                                             (one Linear document as a wiki page, document.ts)
//
// `fetch` writes to ~/.local/share/selfbound/import/<timestamp>/ (outside the repository):
//   snapshot.json     the normalized snapshot (backend/convex/shared/importTypes.ts)
//   staging.jsonl     rows {run, kind, linearId, payload} for the importStaging table
//   operations.jsonl  log of every GraphQL operation sent (proof: queries only)
//   summary.json      counts, notes, operations per name
// `--dry-run` fetches and checks everything but writes nothing and shows only counts.
//
// `push` uploads staging.jsonl to the local backend (with `--prod` to production) and
// processes the run after a typed confirmation (push.ts).
//
// The console shows only counts, ids and status names, never titles or texts.
// Format and further steps: docs/architecture/import.md.

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dataDir } from '../lib/env.mjs';
import { DEFAULT_KEY_FILE, LinearClient, readApiKey } from './client.ts';
import { normalize, parseStatusOverrides, snapshotCounts, stagingRows } from './normalize.ts';
import { runDocument } from './document.ts';
import { filesMain } from './files.ts';
import { runPush } from './push.ts';
import { fetchLinearData } from './queries.ts';
import type { ImportStatus } from '../../backend/convex/shared/importTypes.ts';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_OUT_ROOT = join(dataDir(), 'import');

export interface FetchCommandOptions {
  dryRun?: boolean;
  outRoot?: string;
  keyFile?: string;
  statusOverrides?: Record<string, ImportStatus>;
  timeZone?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  print?: (line: string) => void;
}

export interface FetchCommandResult {
  run: string;
  dir?: string;
  counts: Record<string, number>;
  operations: Record<string, number>;
  notes: string[];
}

/** "2026-10-08T21:30:00.123Z" → "2026-10-08T21-30-00Z" (usable as a directory name). */
export function runId(t: number) {
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-');
}

function assertOutsideRepo(dir: string) {
  const rel = relative(REPO_ROOT, dir);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error(`Aborted: ${dir} is inside the repository. The snapshot contains private data and belongs outside.`);
  }
}

function writePrivate(file: string, content: string) {
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export async function runFetch(options: FetchCommandOptions = {}): Promise<FetchCommandResult> {
  const print = options.print ?? ((line: string) => console.log(line));
  const now = options.now ?? Date.now;
  const outRoot = resolve(options.outRoot ?? DEFAULT_OUT_ROOT);
  if (!options.dryRun) assertOutsideRepo(outRoot);

  const client = new LinearClient({
    apiKey: readApiKey(options.keyFile ?? DEFAULT_KEY_FILE),
    fetch: options.fetch,
    sleep: options.sleep,
    now,
  });
  const started = now();
  const run = runId(started);
  print(`Linear import ${run}${options.dryRun ? ' (dry run, writes nothing)' : ''}: fetching data (read-only) …`);
  const raw = await fetchLinearData(client, (step, count) => print(`  ${step}: ${count}`));
  const snapshot = normalize(raw, { run, fetchedAt: started, statusOverrides: options.statusOverrides, timeZone: options.timeZone });
  const counts = snapshotCounts(snapshot);
  const operations = client.summary();

  print('Snapshot:');
  for (const [kind, n] of Object.entries(counts)) print(`  ${kind.padEnd(13)} ${n}`);
  if (snapshot.notes.length) {
    print('Notes:');
    for (const note of snapshot.notes) print(`  - ${note}`);
  }
  const total = client.log.length;
  print(`GraphQL requests: ${total}, all of type query (${Object.keys(operations).length} distinct operations).`);

  const result: FetchCommandResult = { run, counts, operations, notes: snapshot.notes };
  if (options.dryRun) return result;

  const dir = join(outRoot, run);
  assertOutsideRepo(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writePrivate(join(dir, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  writePrivate(join(dir, 'staging.jsonl'), stagingRows(snapshot).map((row) => JSON.stringify(row)).join('\n') + '\n');
  writePrivate(join(dir, 'operations.jsonl'), client.log.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  writePrivate(
    join(dir, 'summary.json'),
    `${JSON.stringify({ run, fetchedAt: started, counts, notes: snapshot.notes, operations, requests: total }, null, 2)}\n`,
  );
  print(`Written to ${dir}`);
  print('Next step (asks for confirmation first; local by default, production with --prod):');
  print(`  node tooling/linear-import/index.ts push ${dir}`);
  return { ...result, dir };
}

function usage() {
  return [
    'Usage: node tooling/linear-import/index.ts fetch [--dry-run] [--out <dir>] [--key-file <file>]',
    '                                                 [--map-status "Name=status" …] [--time-zone <IANA name>]',
    '       node tooling/linear-import/index.ts push <dir-or-staging.jsonl> [--yes] [--backend-dir <dir>] [--prod]',
    '       node tooling/linear-import/index.ts files scan|download|upload|rewrite [--prod | --backend-dir <dir>] [--dir <dir>]',
    '                                                 [--key-file <file>] [--substitute <sha256>=<file> …] [--link <sha256>=<url> …]',
    '       node tooling/linear-import/index.ts document <copy.md> --team <KEY> [--project <name>] [--yes] [--backend-dir <dir>] [--prod]',
    `  API key:  ${DEFAULT_KEY_FILE} (mode 600)`,
    `  Output:   ${DEFAULT_OUT_ROOT}/<timestamp>/`,
  ].join('\n');
}

export async function main(argv: string[]) {
  const [command, ...rest] = argv;
  if (command === 'files') {
    const code = await filesMain(rest);
    if (code === 2) console.log(usage());
    return code;
  }
  if (command === 'document') {
    const valueOf = (name: string) => {
      const i = rest.indexOf(name);
      return i >= 0 ? rest[i + 1] : undefined;
    };
    const valued = new Set(['--team', '--project', '--backend-dir', '--accessed']);
    const file = rest.find((arg, i) => !arg.startsWith('--') && !valued.has(rest[i - 1] ?? ''));
    const team = valueOf('--team');
    if (!file || !team) {
      console.log(usage());
      return 2;
    }
    await runDocument({
      file,
      team,
      project: valueOf('--project'),
      accessedAt: valueOf('--accessed'),
      yes: rest.includes('--yes'),
      backendDir: valueOf('--backend-dir'),
      prod: rest.includes('--prod'),
    });
    return 0;
  }
  if (command === 'push') {
    const valueOf = (name: string) => {
      const i = rest.indexOf(name);
      return i >= 0 ? rest[i + 1] : undefined;
    };
    const path = rest.find((arg, i) => !arg.startsWith('--') && rest[i - 1] !== '--backend-dir');
    if (!path) {
      console.log(usage());
      return 2;
    }
    const result = await runPush({ path, yes: rest.includes('--yes'), backendDir: valueOf('--backend-dir'), prod: rest.includes('--prod') });
    return result.status === 'done' ? 0 : 1;
  }
  if (command !== 'fetch') {
    console.log(usage());
    return command === undefined || command === 'help' || command === '--help' ? 0 : 2;
  }
  const value = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const statusPairs: string[] = [];
  rest.forEach((arg, i) => {
    if (arg === '--map-status' && rest[i + 1]) statusPairs.push(rest[i + 1]!);
  });
  await runFetch({
    dryRun: rest.includes('--dry-run'),
    outRoot: value('--out'),
    keyFile: value('--key-file'),
    statusOverrides: parseStatusOverrides(statusPairs),
    timeZone: value('--time-zone'),
  });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
