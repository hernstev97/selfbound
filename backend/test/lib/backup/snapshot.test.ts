import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import {
  canonicalJson,
  compareSummaries,
  formatComparison,
  readZip,
  summarizeSnapshot,
} from '../../../../tooling/backup/snapshot.mjs';

/** Minimal ZIP writer for tests (stored or deflate). */
function makeZip(files: Record<string, string | Buffer>, deflate = true) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const packed = deflate ? deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const jsonl = (docs: object[]) => docs.map((d) => JSON.stringify(d)).join('\n') + '\n';
const fileBytes = Buffer.from([0, 1, 2, 255]);
const fileSha = createHash('sha256').update(fileBytes).digest('base64');

function exportZip(change: (f: Record<string, string | Buffer>) => void = () => {}, deflate = true) {
  const files: Record<string, string | Buffer> = {
    'README.md': 'Export',
    '_tables/documents.jsonl': jsonl([{ name: 'teams', id: 10001 }]),
    'teams/documents.jsonl': jsonl([
      { _id: 'b', _creationTime: 2.5, key: 'XLR', name: 'XLR8' },
      { _id: 'a', _creationTime: 1.25, name: 'Acme', key: 'KIU' },
    ]),
    'teams/generated_schema.jsonl': '"any"\n',
    'issues/documents.jsonl': '',
    '_storage/documents.jsonl': jsonl([
      { _id: 'kg1', _creationTime: 3, sha256: fileSha, size: 4, contentType: 'application/octet-stream', internalId: 'x-1' },
    ]),
    '_storage/kg1.bin': fileBytes,
  };
  change(files);
  return makeZip(files, deflate);
}

describe('Reading ZIP', () => {
  test('stored and deflate', () => {
    for (const deflate of [true, false]) {
      const entries = readZip(exportZip(() => {}, deflate));
      expect([...entries.keys()]).toContain('teams/documents.jsonl');
      expect(entries.get('_storage/kg1.bin')).toEqual(fileBytes);
    }
  });

  test('not a ZIP file', () => {
    expect(() => readZip(Buffer.from('not a zip'.repeat(10)))).toThrow(/Not a ZIP file/);
  });
});

describe('Summary and comparison', () => {
  test('rows and checksum independent of row and key order', () => {
    const a = summarizeSnapshot(exportZip());
    const b = summarizeSnapshot(
      exportZip((f) => {
        f['teams/documents.jsonl'] = jsonl([
          { _id: 'a', key: 'KIU', name: 'Acme', _creationTime: 1.25 },
          { name: 'XLR8', key: 'XLR', _creationTime: 2.5, _id: 'b' },
        ]);
        // internalId may change on restore
        f['_storage/documents.jsonl'] = jsonl([
          { _id: 'kg1', _creationTime: 3, sha256: fileSha, size: 4, contentType: 'application/octet-stream', internalId: 'y-2' },
        ]);
      }),
    );
    expect(a.tables.teams!.rows).toBe(2);
    expect(a.tables.issues!.rows).toBe(0);
    expect(a.tables._tables).toBeUndefined();
    expect(a.storage).toMatchObject({ files: 1, bytes: 4, problems: [] });
    const result = compareSummaries(a, b);
    expect(result.ok).toBe(true);
    expect(formatComparison(result)).toMatch(/teams\s+2\s+2\s+equal/);
  });

  test('changed value, missing row and changed _creationTime are detected', () => {
    const base = summarizeSnapshot(exportZip());
    const variants = [
      (f: Record<string, string | Buffer>) =>
        (f['teams/documents.jsonl'] = jsonl([
          { _id: 'a', _creationTime: 1.25, key: 'KIU', name: 'Acme!' },
          { _id: 'b', _creationTime: 2.5, key: 'XLR', name: 'XLR8' },
        ])),
      (f: Record<string, string | Buffer>) => (f['teams/documents.jsonl'] = jsonl([{ _id: 'a', _creationTime: 1.25, key: 'KIU', name: 'Acme' }])),
      (f: Record<string, string | Buffer>) =>
        (f['teams/documents.jsonl'] = jsonl([
          { _id: 'a', _creationTime: 1.5, key: 'KIU', name: 'Acme' },
          { _id: 'b', _creationTime: 2.5, key: 'XLR', name: 'XLR8' },
        ])),
      (f: Record<string, string | Buffer>) => delete f['teams/documents.jsonl'],
    ];
    const reasons = variants.map((v) => {
      const r = compareSummaries(base, summarizeSnapshot(exportZip(v)));
      expect(r.ok).toBe(false);
      return r.rows.find((row) => row.name === 'teams')!.reason;
    });
    expect(reasons).toEqual(['content', 'row count', 'content', 'missing after restore']);
    expect(formatComparison(compareSummaries(base, summarizeSnapshot(exportZip(variants[0]))))).toContain('MISMATCH (content)');
  });

  test('files: missing, changed, without metadata', () => {
    const base = summarizeSnapshot(exportZip());
    const missing = summarizeSnapshot(exportZip((f) => delete f['_storage/kg1.bin']));
    expect(missing.storage.problems).toEqual(['File missing: kg1']);
    expect(compareSummaries(base, missing).ok).toBe(false);
    const changed = summarizeSnapshot(exportZip((f) => (f['_storage/kg1.bin'] = Buffer.from([9, 9, 9, 9]))));
    expect(changed.storage.problems).toEqual(['Checksum does not match file: kg1']);
    const extra = summarizeSnapshot(exportZip((f) => (f['_storage/kg2.txt'] = 'x')));
    expect(extra.storage.problems).toEqual(['File without metadata: kg2']);
  });

  test('an empty table on one side only counts as equal', () => {
    const base = summarizeSnapshot(exportZip());
    const without = summarizeSnapshot(exportZip((f) => delete f['issues/documents.jsonl']));
    expect(compareSummaries(base, without).ok).toBe(true);
  });

  test('canonicalJson', () => {
    expect(canonicalJson({ b: [1, { d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[1,{"c":2,"d":1}]}');
  });
});
