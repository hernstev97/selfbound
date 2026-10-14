// Copy files hosted by Linear into Selfbound storage. Four steps, each repeatable on its own;
// a second run changes nothing:
//
//   node tooling/linear-import/index.ts files scan     [--prod | --backend-dir <dir>] [--dir <dir>]
//   node tooling/linear-import/index.ts files download [--dir <dir>] [--key-file <file>]
//   node tooling/linear-import/index.ts files upload   [--prod | --backend-dir <dir>] [--dir <dir>]
//                                                      [--substitute <sha256>=<file> …]
//   node tooling/linear-import/index.ts files rewrite  [--prod | --backend-dir <dir>] [--dir <dir>]
//                                                      [--link <sha256>=<https-url> …] [--yes]
//
// scan      searches descriptions, comments, previous revisions and recurrences for references
//           to uploads.linear.app (read-only) → refs.json.
// download  downloads each file once with the Linear API key (GET on uploads.linear.app only)
//           → files/<sha256> and manifest.json. Files already downloaded are skipped.
// upload    uploads each image like a pasted image into storage and maps it to the Linear URLs
//           in `linearLinks`. Files already copied are skipped.
//           `--substitute`: upload an edited version instead of the Linear file (e.g. a
//           shrunken GIF over 5 MB). Non-images (videos, PDFs) are left alone.
// rewrite   replaces the references with /img/<token>; `--link` gives another URL for a file
//           (e.g. Google Drive for a video). Shows the counts first, then asks for confirmation
//           ("rewrite", always typed in production), then verifies.
//
// Working directory (default ~/.local/share/xlr8/linear-files/<prod|local>/, outside the
// repository, directories 700, files 600). The console shows only counts and ids, no content.

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '../../backend/convex/shared/constants.ts';
import { DEFAULT_KEY_FILE, readApiKey } from './client.ts';
import { loadInstance } from '../instance.mjs';
import { convex, parseRunOutput, targetOf } from './push.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FILES_ROOT = join(homedir(), '.local', 'share', 'xlr8', 'linear-files');
export const REWRITE_WORD = 'rewrite';
const TEXT_TABLES = ['issueBodies', 'comments', 'bodyRevisions', 'recurrences'] as const;
const UPLOAD_HOST = 'uploads.linear.app';

export interface FilesOptions {
  prod?: boolean;
  backendDir?: string;
  dir?: string;
  keyFile?: string;
  substitutes?: Record<string, string>;
  links?: Record<string, string>;
  yes?: boolean;
  fetch?: typeof fetch;
  print?: (line: string) => void;
  ask?: (question: string) => Promise<string>;
}

export interface Ref {
  table: string;
  id: string;
  issue: string;
  paths: string[];
  deleted?: boolean;
}

export interface ManifestEntry {
  sha256: string;
  size: number;
  type: string; // detected image type (image/…) or the response Content-Type
}

type Manifest = Record<string, ManifestEntry>;

function assertOutsideRepo(dir: string) {
  const rel = relative(REPO_ROOT, dir);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error(`Aborted: ${dir} is inside the repository. The files are private and belong outside.`);
  }
}

function workDir(o: FilesOptions) {
  const dir = resolve(o.dir ?? join(FILES_ROOT, o.prod ? 'prod' : 'local'));
  assertOutsideRepo(dir);
  mkdirSync(join(dir, 'files'), { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  chmodSync(join(dir, 'files'), 0o700);
  return dir;
}

/** Writes through a temporary file in the same directory: an abort never leaves a half-written file. */
function writePrivate(file: string, content: string | Uint8Array) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

const readJson = <T>(file: string, fallback: T): T => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : fallback);

function backend(o: FilesOptions) {
  if (o.prod && o.backendDir) throw new Error('Aborted: --prod and --backend-dir are mutually exclusive.');
  if (o.prod && o.yes) throw new Error('Aborted: --yes does not apply to production. The confirmation is always typed.');
  const dir = resolve(o.backendDir ?? join(REPO_ROOT, 'backend'));
  const run = async (fn: string, args: Record<string, unknown>) => parseRunOutput(await convex(dir, ['run', fn, JSON.stringify(args)], o.prod === true));
  return { run, label: o.prod ? prodLabel() : `${targetOf(dir).url} (local)` };
}

function prodLabel() {
  const { convexDeployment, appUrl } = loadInstance();
  return `PRODUCTION ${convexDeployment ?? '(convexDeployment not set)'} (app ${appUrl ?? '(appUrl not set)'})`;
}

/** Image type from the first bytes (like backend/convex/lib/image.ts), otherwise null. */
export function sniffImage(b: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x)) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------- scan

async function scanAll(run: (fn: string, args: Record<string, unknown>) => Promise<unknown>) {
  const refs: Ref[] = [];
  for (const table of TEXT_TABLES) {
    let cursor: string | null = null;
    for (;;) {
      const page = (await run('linearFiles:scan', { table, cursor })) as { refs: Ref[]; isDone: boolean; cursor: string };
      refs.push(...page.refs);
      if (page.isDone) break;
      cursor = page.cursor;
    }
  }
  return refs;
}

export function summarizeRefs(refs: Ref[]) {
  const perTable: Record<string, { texts: number; refs: number }> = {};
  for (const r of refs) {
    perTable[r.table] ??= { texts: 0, refs: 0 };
    perTable[r.table]!.texts++;
    perTable[r.table]!.refs += r.paths.length;
  }
  return {
    perTable,
    files: new Set(refs.flatMap((r) => r.paths)).size,
    issues: [...new Set(refs.map((r) => r.issue))].sort(),
  };
}

export async function runScan(o: FilesOptions = {}) {
  const print = o.print ?? console.log;
  const { run, label } = backend(o);
  const dir = workDir(o);
  print(`Target: ${label} (read-only)`);
  const refs = await scanAll(run);
  writePrivate(join(dir, 'refs.json'), `${JSON.stringify({ at: new Date().toISOString(), refs }, null, 2)}\n`);
  const s = summarizeRefs(refs);
  for (const [table, c] of Object.entries(s.perTable)) print(`  ${table.padEnd(14)} ${c.texts} texts, ${c.refs} references`);
  print(`Distinct Linear files: ${s.files}, issues: ${s.issues.length}${s.issues.length ? ` (${s.issues.join(', ')})` : ''}`);
  const deleted = refs.filter((r) => r.deleted).length;
  if (deleted) print(`Of these in deleted comments (left untouched): ${deleted}`);
  print(`List: ${join(dir, 'refs.json')}`);
  return { refs, ...s };
}

// ---------------------------------------------------------------- download

export async function runDownload(o: FilesOptions = {}) {
  const print = o.print ?? console.log;
  const doFetch = o.fetch ?? globalThis.fetch;
  const dir = workDir(o);
  if (!existsSync(join(dir, 'refs.json'))) throw new Error(`${join(dir, 'refs.json')} is missing. Run "files scan" first.`);
  const { refs } = readJson<{ refs: Ref[] }>(join(dir, 'refs.json'), { refs: [] });
  const paths = [...new Set(refs.flatMap((r) => r.paths))];
  const manifestFile = join(dir, 'manifest.json');
  const manifest = readJson<Manifest>(manifestFile, {});
  const todo = paths.filter((p) => !(manifest[p] && existsSync(join(dir, 'files', manifest[p]!.sha256))));
  print(`Linear files: ${paths.length}, already downloaded: ${paths.length - todo.length}, to download: ${todo.length}`);
  if (todo.length === 0) return { manifest, downloaded: 0, failed: 0 };
  const key = readApiKey(o.keyFile ?? DEFAULT_KEY_FILE);
  let downloaded = 0;
  let failed = 0;
  for (const path of todo) {
    const url = new URL(path);
    if (url.protocol !== 'https:' || url.hostname !== UPLOAD_HOST) throw new Error(`Not a Linear file: ${url.hostname}`);
    let response: Response | undefined;
    for (let attempt = 1; attempt <= 4; attempt++) {
      // Do not follow redirects automatically: the API key goes to uploads.linear.app only.
      response = await doFetch(path, { method: 'GET', headers: { Authorization: key }, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) {
        // Follow one redirect (e.g. to storage with a signed URL) once, without the key.
        const location = response.headers.get('location');
        const target = location ? new URL(location, path) : null;
        if (!target || target.protocol !== 'https:') break;
        response = await doFetch(target.href, { method: 'GET', redirect: 'manual' });
      }
      if (response.status !== 429 && response.status < 500) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
    if (!response?.ok) {
      failed++;
      print(`  Error HTTP ${response?.status} for file ${paths.indexOf(path) + 1}`);
      continue;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const hash = sha256(bytes);
    writePrivate(join(dir, 'files', hash), bytes);
    manifest[path] = { sha256: hash, size: bytes.length, type: sniffImage(bytes) ?? response.headers.get('content-type') ?? 'unknown' };
    writePrivate(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    downloaded++;
  }
  const types: Record<string, number> = {};
  for (const p of paths) if (manifest[p]) types[manifest[p]!.type] = (types[manifest[p]!.type] ?? 0) + 1;
  print(`Downloaded: ${downloaded}, errors: ${failed}. Types: ${Object.entries(types).map(([t, n]) => `${t} ${n}`).join(', ')}`);
  return { manifest, downloaded, failed };
}

// ---------------------------------------------------------------- upload

function groupBySha(manifest: Manifest) {
  const groups = new Map<string, { paths: string[]; entry: ManifestEntry }>();
  for (const [path, entry] of Object.entries(manifest)) {
    const g = groups.get(entry.sha256) ?? { paths: [], entry };
    g.paths.push(path);
    groups.set(entry.sha256, g);
  }
  return groups;
}

export async function runUpload(o: FilesOptions = {}) {
  const print = o.print ?? console.log;
  const doFetch = o.fetch ?? globalThis.fetch;
  const { run, label } = backend(o);
  const dir = workDir(o);
  const manifest = readJson<Manifest>(join(dir, 'manifest.json'), {});
  if (Object.keys(manifest).length === 0) throw new Error('manifest.json is missing or empty. Run "files download" first.');
  print(`Target: ${label}`);
  const known = new Map(((await run('linearFiles:mapping', {})) as { files: { path: string; token: string }[] }).files.map((f) => [f.path, f.token]));
  const counts = { uploaded: 0, linked: 0, already: 0, skipped: 0, rejected: 0 };
  let n = 0;
  for (const [sha, { paths, entry }] of groupBySha(manifest)) {
    n++;
    const open = paths.filter((p) => !known.has(p));
    if (open.length === 0) {
      counts.already++;
      continue;
    }
    const token = paths.map((p) => known.get(p)).find((t) => t !== undefined);
    if (token) {
      await run('linearFiles:linkPaths', { token, paths: open });
      counts.linked++;
      continue;
    }
    const file = o.substitutes?.[sha] ?? join(dir, 'files', sha);
    const bytes = new Uint8Array(readFileSync(file));
    const type = sniffImage(bytes);
    if (!type || bytes.length > LIMITS.imageMaxBytes) {
      counts.skipped++;
      print(`  File ${n} (${sha.slice(0, 12)}, ${entry.type}, ${(bytes.length / 1048576).toFixed(2)} MB): ${type ? 'too large' : 'not an image'}, not uploaded`);
      continue;
    }
    const { url } = (await run('linearFiles:uploadUrl', {})) as { url: string };
    const response = await doFetch(url, { method: 'POST', headers: { 'Content-Type': type }, body: bytes });
    if (!response.ok) throw new Error(`Upload failed (HTTP ${response.status}).`);
    const { storageId } = (await response.json()) as { storageId: string };
    const result = (await run('linearFiles:register', { storageId, paths: open })) as { ok: boolean; reason?: string; token?: string };
    if (!result.ok) {
      counts.rejected++;
      print(`  File ${n} (${sha.slice(0, 12)}) rejected: ${result.reason}`);
      continue;
    }
    for (const p of open) known.set(p, result.token!);
    counts.uploaded++;
  }
  print(
    `Files: ${groupBySha(manifest).size} distinct. Uploaded ${counts.uploaded}, linked ${counts.linked}, already copied ${counts.already}, not uploaded ${counts.skipped}, rejected ${counts.rejected}`,
  );
  return counts;
}

// ---------------------------------------------------------------- rewrite

interface RewriteDoc {
  table: string;
  id: string;
  issue: string;
  replaced: number;
  missing: number;
  deleted?: boolean;
  tooLong?: boolean;
  written: boolean;
}

async function rewriteAll(run: (fn: string, args: Record<string, unknown>) => Promise<unknown>, apply: boolean, external: { path: string; url: string }[]) {
  const docs: RewriteDoc[] = [];
  for (const table of TEXT_TABLES) {
    let cursor: string | null = null;
    for (;;) {
      const page = (await run('linearFiles:rewrite', { table, cursor, apply, external })) as { docs: RewriteDoc[]; isDone: boolean; cursor: string };
      docs.push(...page.docs);
      if (page.isDone) break;
      cursor = page.cursor;
    }
  }
  return docs;
}

function printDocs(print: (line: string) => void, docs: RewriteDoc[]) {
  for (const d of docs) {
    const notes = [d.deleted ? 'deleted, kept' : '', d.tooLong ? 'too long, kept' : '', d.missing ? `${d.missing} without target` : ''].filter(Boolean);
    print(`  ${d.issue.padEnd(9)} ${d.table.padEnd(14)} ${d.replaced} references${notes.length ? ` (${notes.join(', ')})` : ''}`);
  }
  const sum = (f: (d: RewriteDoc) => number) => docs.reduce((a, d) => a + f(d), 0);
  print(`  Total: ${docs.length} texts, ${sum((d) => d.replaced)} references replaceable, ${sum((d) => d.missing)} without target`);
}

export async function runRewrite(o: FilesOptions = {}) {
  const print = o.print ?? console.log;
  const { run, label } = backend(o);
  const dir = workDir(o);
  const manifest = readJson<Manifest>(join(dir, 'manifest.json'), {});
  const external: { path: string; url: string }[] = [];
  for (const [sha, url] of Object.entries(o.links ?? {})) {
    const paths = Object.entries(manifest)
      .filter(([, e]) => e.sha256 === sha)
      .map(([p]) => p);
    if (paths.length === 0) throw new Error(`--link: no file with sha256 ${sha} in manifest.json.`);
    for (const path of paths) external.push({ path, url });
  }
  print(`Target: ${label}`);
  print('Dry run (writes nothing):');
  const dry = await rewriteAll(run, false, external);
  printDocs(print, dry);
  if (!dry.some((d) => d.replaced > 0 && !d.deleted && !d.tooLong)) {
    print('Nothing to do.');
    return { written: 0, remaining: dry.reduce((a, d) => a + d.missing, 0) };
  }
  if (o.prod || !o.yes) {
    const ask =
      o.ask ??
      (async (question: string) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await rl.question(question);
        } finally {
          rl.close();
        }
      });
    const answer = await ask(`Type "${REWRITE_WORD}" to rewrite${o.prod ? ' in PRODUCTION' : ''}: `);
    if (answer.trim() !== REWRITE_WORD) throw new Error('Cancelled, nothing written.');
  }
  const applied = await rewriteAll(run, true, external);
  const written = applied.filter((d) => d.written).length;
  print(`Written: ${written} texts, ${applied.filter((d) => d.written).reduce((a, d) => a + d.replaced, 0)} references.`);
  const left = await scanAll(run);
  const remaining = left.reduce((a, r) => a + r.paths.length, 0);
  print(`Check: ${remaining} Linear references left${remaining ? ` (${[...new Set(left.map((r) => r.issue))].join(', ')})` : ''}.`);
  return { written, remaining };
}

// ---------------------------------------------------------------- CLI

export function parsePairs(rest: string[], flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  rest.forEach((arg, i) => {
    if (arg !== flag) return;
    const pair = rest[i + 1] ?? '';
    const at = pair.indexOf('=');
    if (at <= 0) throw new Error(`${flag} expects <sha256>=<value>.`);
    out[pair.slice(0, at)] = pair.slice(at + 1);
  });
  return out;
}

export async function filesMain(rest: string[]) {
  const [step, ...args] = rest;
  const value = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const o: FilesOptions = {
    prod: args.includes('--prod'),
    backendDir: value('--backend-dir'),
    dir: value('--dir'),
    keyFile: value('--key-file'),
    substitutes: parsePairs(args, '--substitute'),
    links: parsePairs(args, '--link'),
    yes: args.includes('--yes'),
  };
  if (step === 'scan') await runScan(o);
  else if (step === 'download') {
    const r = await runDownload(o);
    return r.failed ? 1 : 0;
  } else if (step === 'upload') {
    const r = await runUpload(o);
    return r.rejected ? 1 : 0;
  } else if (step === 'rewrite') await runRewrite(o);
  else return 2;
  return 0;
}
