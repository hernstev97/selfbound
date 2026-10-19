#!/usr/bin/env node
// Data export without the app (SELF-46): builds the same ZIP as Settings → Data export (JSON and
// Markdown, images, logos) from a Convex export. For automation and for the nightly backup.
//
//   node tooling/export/index.mjs --from <convex-export.zip> [--out <folder>]
//   node tooling/export/index.mjs [--out <folder>]          (exports the local backend first)
//
// --from     a ZIP of `convex export --include-file-storage`, e.g. the decrypted nightly backup
//            (docs/backup.md) or `npx convex export --include-file-storage --path snap.zip` run
//            with the deploy key of your own deployment. Without --include-file-storage the export
//            has no images; the manifest lists them as missing.
// --out      target folder (default ~/.local/share/selfbound/exports)
//
// Output: <folder>/selfbound-export-<time>.zip (mode 600). The console shows only counts.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildExport } from '../../core/src/export/build.ts';
import { EXPORT_TABLES } from '../../backend/convex/shared/export.ts';
import { readZip } from '../backup/snapshot.mjs';
import { dataDir } from '../lib/env.mjs';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const log = (msg) => console.log(`\x1b[36m▸\x1b[0m ${msg}`);

/** Rows of every export table from a snapshot (`<table>/documents.jsonl`), and its stored files. */
export function snapshotSource(entries) {
  const tables = {};
  for (const table of EXPORT_TABLES) {
    const jsonl = entries.get(`${table}/documents.jsonl`);
    tables[table] = jsonl
      ? jsonl
          .toString('utf8')
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => JSON.parse(line))
      : [];
  }
  // Files are `_storage/<id>` with an optional extension.
  const storage = new Map();
  for (const [name, data] of entries) {
    const m = /^_storage\/([^/.]+)(\.[^/]*)?$/.exec(name);
    if (m) storage.set(m[1], data);
  }
  async function* readFiles(files) {
    for (const file of files) {
      const data = storage.get(file.storageId);
      yield data ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
    }
  }
  return { tables, readFiles };
}

async function localSnapshot(dir) {
  const zip = join(dir, 'snapshot.zip');
  process.env.SELFBOUND_BACKEND_DIR ??= 'backend';
  const { runConvex } = await import('../convex.mjs');
  await new Promise((resolvePromise, reject) => {
    const child = runConvex(['export', '--include-file-storage', '--path', zip], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`convex export exited with ${code}`))));
  });
  return zip;
}

async function main() {
  const from = opt('from');
  const outDir = resolve(opt('out') ?? join(dataDir(), 'exports'));
  const temp = from ? null : mkdtempSync(join(tmpdir(), 'selfbound-export-'));
  try {
    const snapshot = from ? resolve(from) : await localSnapshot(temp);
    log(`Reading ${from ? snapshot : 'the local backend'} …`);
    const { tables, readFiles } = snapshotSource(readZip(readFileSync(snapshot)));
    if (!tables.teams.length && !tables.issues.length) throw new Error('No teams and no issues found. Is this a Convex export of Selfbound?');
    const exportedAt = Date.now();
    const result = await buildExport(tables, { exportedAt, source: 'snapshot', readFiles });
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const target = join(outDir, `selfbound-export-${new Date(exportedAt).toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-')}.zip`);
    writeFileSync(target, Buffer.concat(result.parts), { mode: 0o600 });
    chmodSync(target, 0o600);
    const rows = Object.values(result.counts).reduce((a, n) => a + n, 0);
    log(`Export: ${(result.bytes / 1_048_576).toFixed(1)} MB, ${result.counts.issues} issues, ${result.counts.articles} pages, ${rows} rows, ${result.files} files.`);
    if (result.missingFiles.length) log(`${result.missingFiles.length} files missing in the snapshot (listed in json/manifest.json).`);
    console.log(target);
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
