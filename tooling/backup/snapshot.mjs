// Reads a Convex export (ZIP) and compares two exports.
//
// Layout of an export (convex export --include-file-storage):
//   <table>/documents.jsonl            one document per line, with _id and _creationTime
//   <table>/generated_schema.jsonl     inferred schema (irrelevant for the comparison)
//   _tables/documents.jsonl            table names and internal numbers
//   _storage/documents.jsonl           file metadata (sha256, size, contentType)
//   _storage/<id>[.<ext>]              the files themselves
//
// No dependencies: ZIP reading via the central directory and zlib.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/**
 * Reads all entries of a ZIP file (stored or deflate, including ZIP64).
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>}
 */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file (end of central directory missing).');
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || buf.readUInt32LE(loc) !== SIG_EOCD64_LOCATOR) throw new Error('ZIP64 directory missing.');
    const eocd64 = Number(buf.readBigUInt64LE(loc + 8));
    if (buf.readUInt32LE(eocd64) !== SIG_EOCD64) throw new Error('ZIP64 directory corrupt.');
    count = Number(buf.readBigUInt64LE(eocd64 + 32));
    cdOffset = Number(buf.readBigUInt64LE(eocd64 + 48));
  }
  const entries = new Map();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('ZIP central directory corrupt.');
    const method = buf.readUInt16LE(p + 10);
    let compressed = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // ZIP64 extra field: values in the order size, compressed, offset, where 0xffffffff
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = buf.readUInt16LE(e);
      const len = buf.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) (size = Number(buf.readBigUInt64LE(q))), (q += 8);
        if (compressed === 0xffffffff) (compressed = Number(buf.readBigUInt64LE(q))), (q += 8);
        if (local === 0xffffffff) local = Number(buf.readBigUInt64LE(q));
      }
      e += 4 + len;
    }
    p = extraEnd + commentLen;
    if (name.endsWith('/')) continue;
    if (buf.readUInt32LE(local) !== SIG_LOCAL) throw new Error(`ZIP local header corrupt: ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compressed);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`ZIP compression ${method} is not supported: ${name}`);
    if (data.length !== size) throw new Error(`Wrong size after decompression: ${name}`);
    entries.set(name, data);
  }
  return entries;
}

/** JSON with sorted keys, so equal documents look the same. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function jsonLines(buf) {
  return buf
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/** Storage metadata without fields that legitimately change on restore. */
function storageDoc(doc) {
  const { internalId: _internal, ...rest } = doc;
  return rest;
}

/**
 * @typedef {{ rows: number, checksum: string }} TableSummary
 * @typedef {{ tables: Record<string, TableSummary>, storage: { files: number, bytes: number, checksum: string, problems: string[] } }} SnapshotSummary
 */

/**
 * Summarizes an export: per table the row count and a checksum over the documents sorted by
 * `_id` (including `_id` and `_creationTime`), plus the files in `_storage` (metadata and content).
 * @param {Buffer | string} zip path or content
 * @returns {SnapshotSummary}
 */
export function summarizeSnapshot(zip) {
  const entries = readZip(typeof zip === 'string' ? readFileSync(zip) : zip);
  /** @type {Record<string, TableSummary>} */
  const tables = {};
  for (const [name, data] of entries) {
    const m = /^([^/]+)\/documents\.jsonl$/.exec(name);
    if (!m || m[1] === '_tables' || m[1] === '_storage') continue;
    const lines = jsonLines(data)
      .map((doc) => [String(doc._id), canonicalJson(doc)])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([, line]) => line);
    tables[m[1]] = { rows: lines.length, checksum: sha256(lines.join('\n')) };
  }

  const problems = [];
  const docs = entries.has('_storage/documents.jsonl') ? jsonLines(entries.get('_storage/documents.jsonl')) : [];
  const files = new Map();
  for (const [name, data] of entries) {
    const m = /^_storage\/([^/.]+)(?:\.[^/]*)?$/.exec(name);
    if (m && name !== '_storage/documents.jsonl') files.set(m[1], data);
  }
  let bytes = 0;
  const lines = [];
  for (const doc of docs.sort((a, b) => (a._id < b._id ? -1 : 1))) {
    const data = files.get(doc._id);
    if (!data) {
      problems.push(`File missing: ${doc._id}`);
      continue;
    }
    bytes += data.length;
    const digest = createHash('sha256').update(data).digest('base64');
    if (doc.sha256 && doc.sha256 !== digest) problems.push(`Checksum does not match file: ${doc._id}`);
    if (typeof doc.size === 'number' && doc.size !== data.length) problems.push(`Size does not match: ${doc._id}`);
    lines.push(`${canonicalJson(storageDoc(doc))} ${sha256(data)}`);
  }
  for (const id of files.keys()) if (!docs.some((d) => d._id === id)) problems.push(`File without metadata: ${id}`);
  return { tables, storage: { files: lines.length, bytes, checksum: sha256(lines.join('\n')), problems } };
}

/**
 * Compares two summaries.
 * @param {SnapshotSummary} source
 * @param {SnapshotSummary} restored
 */
export function compareSummaries(source, restored) {
  const names = [...new Set([...Object.keys(source.tables), ...Object.keys(restored.tables)])].sort();
  const rows = names.map((name) => {
    const a = source.tables[name];
    const b = restored.tables[name];
    const same = Boolean(a && b && a.rows === b.rows && a.checksum === b.checksum);
    // Empty tables that appear on one side only count as equal.
    const emptyOnBothSides = (a?.rows ?? 0) === 0 && (b?.rows ?? 0) === 0;
    return {
      name,
      sourceRows: a?.rows,
      restoredRows: b?.rows,
      ok: same || emptyOnBothSides,
      reason: same || emptyOnBothSides ? '' : !a ? 'missing in source' : !b ? 'missing after restore' : a.rows !== b.rows ? 'row count' : 'content',
    };
  });
  const storageOk =
    source.storage.files === restored.storage.files &&
    source.storage.checksum === restored.storage.checksum &&
    source.storage.problems.length === 0 &&
    restored.storage.problems.length === 0;
  rows.push({
    name: '_storage (files)',
    sourceRows: source.storage.files,
    restoredRows: restored.storage.files,
    ok: storageOk,
    reason: storageOk ? '' : [...source.storage.problems, ...restored.storage.problems].join('; ') || 'content',
  });
  return { ok: rows.every((r) => r.ok), rows };
}

/** Table for the console. */
export function formatComparison(result) {
  const head = ['Table', 'Source', 'Restored', 'Result'];
  const body = result.rows.map((r) => [
    r.name,
    String(r.sourceRows ?? '–'),
    String(r.restoredRows ?? '–'),
    r.ok ? 'equal' : `MISMATCH (${r.reason})`,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 1 || i === 2 ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ');
  return [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)].join('\n');
}
