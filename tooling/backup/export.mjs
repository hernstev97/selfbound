#!/usr/bin/env node
// Exports a Convex deployment including files as a ZIP and optionally encrypts it with age.
//
//   node tooling/backup/export.mjs [--out <folder>] [--encrypt] [--recipient age1… …] [--remove-plain]
//   node tooling/backup/export.mjs --source deploy-key …   (CI only, see below)
//
// Sources:
//   local (default)   the local anonymous backend via tooling/convex.mjs
//                     (the wrapper allows only anonymous/local deployments).
//   deploy-key        the deployment behind CONVEX_DEPLOY_KEY. Only in GitHub Actions
//                     (CI=true), where the daily backup workflow runs.
//
// Output in <folder> (default ~/.local/share/xlr8/backups):
//   xlr8-<source>-<time>.zip            export (tables as JSONL, files in _storage)
//   xlr8-<source>-<time>.manifest.json  rows per table, files, SHA-256 of the ZIP
//   xlr8-<source>-<time>.zip.age        with --encrypt: encrypted for the recipients
// Recipients: --recipient (repeatable), --recipients-file <file> or AGE_RECIPIENTS
// (separated by commas or newlines). Public keys only, never the private one.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeSnapshot } from './snapshot.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const all = (name) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1]] : []));
const flag = (name) => argv.includes(`--${name}`);
const log = (msg) => console.log(`\x1b[36m▸\x1b[0m ${msg}`);

const sourceKind = opt('source', 'local');
const outDir = resolve(opt('out', join(homedir(), '.local', 'share', 'xlr8', 'backups')));

function stamp(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-');
}

function hasAge() {
  return spawnSync('age', ['--version'], { stdio: 'ignore' }).status === 0;
}

function recipients() {
  const list = [...all('recipient')];
  const file = opt('recipients-file');
  if (file) list.push(...readFileSync(file, 'utf8').split('\n'));
  if (process.env.AGE_RECIPIENTS) list.push(...process.env.AGE_RECIPIENTS.split(/[,\n]/));
  return [...new Set(list.map((r) => r.trim()).filter((r) => r && !r.startsWith('#')))];
}

function exec(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'], ...options });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`${command} ${args[0]} exited with ${code}`))));
  });
}

async function exportTo(zip) {
  const args = ['export', '--include-file-storage', '--path', zip];
  if (sourceKind === 'local') {
    process.env.XLR8_BACKEND_DIR = 'backend';
    const { runConvex } = await import('../convex.mjs');
    await new Promise((resolvePromise, reject) => {
      const child = runConvex(args, { stdio: ['ignore', 'inherit', 'inherit'] });
      child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`convex export exited with ${code}`))));
    });
    return;
  }
  if (sourceKind === 'deploy-key') {
    if (process.env.CI !== 'true' || !process.env.CONVEX_DEPLOY_KEY) {
      throw new Error('--source deploy-key runs only in CI (CI=true) with CONVEX_DEPLOY_KEY. Locally: --source local.');
    }
    await exec(join(root, 'backend', 'node_modules', '.bin', 'convex'), args, { cwd: join(root, 'backend'), env: process.env });
    return;
  }
  throw new Error(`Unknown source: ${sourceKind} (allowed: local, deploy-key)`);
}

async function main() {
  const encrypt = flag('encrypt');
  const keys = recipients();
  if (encrypt && keys.length === 0) throw new Error('--encrypt needs at least one recipient (--recipient age1…).');
  if (encrypt && !hasAge()) {
    throw new Error('--encrypt needs the age program, which is not installed (e.g. "sudo pacman -S age" or "apt install age").');
  }

  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const base = join(outDir, `xlr8-${sourceKind}-${stamp()}`);
  const zip = `${base}.zip`;
  log(`Exporting (${sourceKind}) to ${zip} …`);
  await exportTo(zip);
  // One handle for mode, size and content: the file cannot be swapped in between.
  const fd = openSync(zip, 'r');
  let bytes;
  let digest;
  try {
    fchmodSync(fd, 0o600);
    bytes = fstatSync(fd).size;
    digest = createHash('sha256').update(readFileSync(fd)).digest('hex');
  } finally {
    closeSync(fd);
  }
  const summary = summarizeSnapshot(zip);
  const tables = Object.fromEntries(Object.entries(summary.tables).map(([name, t]) => [name, t.rows]));
  const manifest = {
    file: zip.split('/').at(-1),
    source: sourceKind,
    createdAt: new Date().toISOString(),
    bytes,
    sha256: digest,
    tables,
    storage: { files: summary.storage.files, bytes: summary.storage.bytes },
    problems: summary.storage.problems,
  };
  writeFileSync(`${base}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const nonEmpty = Object.entries(tables).filter(([, n]) => n > 0);
  log(
    `Export: ${(bytes / 1024).toFixed(1)} KB, ${nonEmpty.length} tables with data (${nonEmpty.reduce((a, [, n]) => a + n, 0)} documents), ${summary.storage.files} files.`,
  );
  if (summary.storage.problems.length) throw new Error(`Export incomplete: ${summary.storage.problems.join('; ')}`);

  // In GitHub Actions, output the paths for the next steps.
  const output = (key, value) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  output('zip', zip);
  output('manifest', `${base}.manifest.json`);
  if (encrypt) {
    const target = `${zip}.age`;
    output('encrypted', target);
    await exec('age', [...keys.flatMap((k) => ['-r', k]), '-o', target, zip]);
    chmodSync(target, 0o600);
    log(`Encrypted for ${keys.length} recipient(s): ${target}`);
    if (flag('remove-plain')) {
      rmSync(zip);
      log('Unencrypted ZIP deleted.');
    }
  } else if (!hasAge()) {
    log('Note: age is not installed. The ZIP stays unencrypted (fine locally; CI encrypts).');
  } else {
    log('Note: unencrypted. Encrypt with --encrypt --recipient age1….');
  }
  console.log(zip);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
