#!/usr/bin/env node
// Restore test: imports an export into a SECOND, fresh local backend, exports again and
// compares both.
//
//   node tooling/backup/verify-restore.mjs <export.zip> [--port 13440] [--keep]
//
// Steps:
//   1. Temporary project under /tmp/selfbound-restore-…: copy of backend/convex, backend/package.json,
//      node_modules as a symlink. Its own HOME, so its own anonymous deployment
//      (via tooling/convex.mjs, local only).
//   2. `convex dev` on 127.0.0.1:<port>/<port+1> starts the backend and uploads the functions
//      including the schema (the import validates the data against the schema).
//   3. `convex import --replace-all -y <export.zip>`
//   4. `convex export --include-file-storage` and comparison per table: row count and checksum
//      over the sorted documents (with _id and _creationTime, both preserved by the import),
//      plus all files.
//   5. Stop the backend, delete the temporary folder.
// Exit code 0 only if everything is equal.

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareSummaries, formatComparison, summarizeSnapshot } from './snapshot.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const zipPath = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--port');
const port = Number(opt('port', '13440'));
const keep = argv.includes('--keep');
const log = (msg) => console.log(`\x1b[36m▸\x1b[0m ${msg}`);

if (!zipPath || !existsSync(zipPath)) {
  console.error('Usage: node tooling/backup/verify-restore.mjs <export.zip> [--port 13440] [--keep]');
  process.exit(2);
}

// Environment variables the function upload needs (auth.config.ts).
// "none" disables the sign-in providers: the test backend is only there for the comparison.
const RESTORE_ENV = { CLERK_JWT_ISSUER_DOMAIN: 'none', SELFBOUND_DEV_JWKS: 'none' };

async function reachable(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

async function waitFor(check, label, timeoutMs = 240_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label}: timed out after ${timeoutMs / 1000} s`);
}

async function main() {
  const source = resolve(zipPath);
  const work = mkdtempSync(join(tmpdir(), 'selfbound-restore-'));
  let backend;
  const stop = () => {
    if (!backend) return;
    try {
      process.kill(-backend.pid, 'SIGTERM');
    } catch {
      backend.kill('SIGTERM');
    }
    backend = undefined;
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => (stop(), process.exit(130)));

  try {
    if (await reachable(`http://127.0.0.1:${port}/version`)) {
      throw new Error(`Port ${port} is in use. The test needs a fresh backend (pick another port with --port).`);
    }
    // 1. Temporary project
    cpSync(join(root, 'backend', 'convex'), join(work, 'convex'), { recursive: true });
    cpSync(join(root, 'backend', 'package.json'), join(work, 'package.json'));
    symlinkSync(join(root, 'backend', 'node_modules'), join(work, 'node_modules'), 'dir');
    writeFileSync(join(work, 'README.txt'), 'Temporary project for tooling/backup/verify-restore.mjs. Safe to delete.\n');
    process.env.SELFBOUND_BACKEND_DIR = work;
    const { runConvex } = await import('../convex.mjs');

    const run = (args, label) =>
      new Promise((resolvePromise, reject) => {
        let out = '';
        const child = runConvex(args, { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('exit', (code) => (code === 0 ? resolvePromise(out) : reject(new Error(`${label} failed:\n${out}`))));
      });

    // 2. Fresh backend with functions
    log(`Starting fresh local backend on 127.0.0.1:${port} (temporary: ${work}) …`);
    const logFile = join(work, 'convex-dev.log');
    const logFd = openSync(logFile, 'a');
    backend = runConvex(
      ['dev', '--local-cloud-port', String(port), '--local-site-port', String(port + 1), '--tail-logs', 'disable', '--typecheck', 'disable'],
      { stdio: ['ignore', logFd, logFd], detached: true },
    );
    await waitFor(() => reachable(`http://127.0.0.1:${port}/version`), 'Backend');
    await waitFor(() => existsSync(join(work, '.env.local')), '.env.local');
    for (const [key, value] of Object.entries(RESTORE_ENV)) await run(['env', 'set', key, value], `env set ${key}`);
    // auth.config.ts is evaluated on upload: trigger a new upload after setting the variables.
    const authFile = join(work, 'convex', 'auth.config.ts');
    if (existsSync(authFile)) utimesSync(authFile, new Date(), new Date());
    await waitFor(() => /Convex functions ready/.test(readFileSync(logFile, 'utf8')), 'Function upload');
    log('Functions and schema are uploaded.');

    // 3. Import
    log(`Importing ${source} …`);
    await run(['import', '--replace-all', '-y', source], 'convex import');

    // 4. Export again and compare
    const again = join(work, 'restored.zip');
    log('Exporting again …');
    await run(['export', '--include-file-storage', '--path', again], 'convex export');
    const result = compareSummaries(summarizeSnapshot(source), summarizeSnapshot(again));
    console.log('');
    console.log(formatComparison(result));
    console.log('');
    if (result.ok) log('Restore verified: all tables and files are equal.');
    else console.error('Restore NOT equal. Details in the table above.');
    return result.ok ? 0 : 1;
  } finally {
    stop();
    if (keep) log(`Temporary folder kept: ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
