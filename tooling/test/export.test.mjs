// tooling/export: the data export from a Convex export (snapshot), run as the user would run it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { ZipWriter } from '../../core/src/export/zip.ts';
import { readZip } from '../backup/snapshot.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKEN = 'C'.repeat(43);
const owner = { kind: 'owner' };

/** A small snapshot in the layout of `convex export --include-file-storage`. */
async function snapshot(dir) {
  const zip = new ZipWriter();
  const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const at = Date.UTC(2026, 9, 19);
  await zip.add('teams/documents.jsonl', jsonl([{ _id: 't1', _creationTime: at, key: 'ACME', name: 'Acme', hue: 0, dormant: false, order: 0, updatedAt: at }]));
  await zip.add(
    'issues/documents.jsonl',
    jsonl([{ _id: 'i1', _creationTime: at, seq: 1, bucket: 0, teamId: 't1', number: 7, title: 'Snapshot issue', status: 'todo', priority: 3, labelIds: [], rank: 'a0', createdBy: owner, createdAt: at, updatedAt: at }]),
  );
  await zip.add('issueBodies/documents.jsonl', jsonl([{ _id: 'b1', _creationTime: at, issueId: 'i1', markdown: `![x](https://old.example/img/${TOKEN})`, version: 1, updatedAt: at, updatedBy: owner }]));
  await zip.add('files/documents.jsonl', jsonl([{ _id: 'f1', _creationTime: at, token: TOKEN, storageId: 'kg2abc', contentType: 'image/png', size: 3, createdAt: at, uploadedBy: owner }]));
  await zip.add('agents/documents.jsonl', jsonl([{ _id: 'a1', _creationTime: at, name: 'Codex', keyHash: 'f'.repeat(64), keyPrefix: 'sb_x', createdAt: at }]));
  await zip.add('oauthTokens/documents.jsonl', jsonl([{ _id: 'o1', _creationTime: at, hash: 'secret' }]));
  await zip.add('_storage/kg2abc.png', new Uint8Array([7, 8, 9]), { compress: false });
  const path = join(dir, 'snapshot.zip');
  writeFileSync(path, Buffer.concat(zip.finish()));
  return path;
}

describe('tooling/export', () => {
  it('builds the export ZIP from a Convex export: JSON, Markdown, files, no secrets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'selfbound-export-test-'));
    const from = await snapshot(dir);
    const out = join(dir, 'out');
    const run = spawnSync(process.execPath, ['tooling/export/index.mjs', '--from', from, '--out', out], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const [name] = readdirSync(out);
    assert.match(name, /^selfbound-export-.*\.zip$/);
    assert.equal(statSync(join(out, name)).mode & 0o777, 0o600);

    const entries = readZip(readFileSync(join(out, name)));
    const manifest = JSON.parse(entries.get('json/manifest.json').toString('utf8'));
    assert.equal(manifest.format, 'selfbound-export');
    assert.equal(manifest.source, 'snapshot');
    assert.equal(manifest.tables.issues, 1);
    assert.deepEqual(manifest.missingFiles, []);
    assert.ok(!entries.has('json/oauthTokens.json'));
    assert.ok(!entries.get('json/agents.json').toString('utf8').includes('keyHash'));
    const md = entries.get('markdown/issues/ACME/ACME-7 Snapshot issue.md').toString('utf8');
    assert.match(md, /status: "Todo"/);
    assert.ok(md.includes(`![x](../../../files/images/${TOKEN}.png)`));
    assert.deepEqual([...entries.get(`files/images/${TOKEN}.png`)], [7, 8, 9]);
  });

  it('refuses a ZIP that is not a Selfbound export', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'selfbound-export-test-'));
    const zip = new ZipWriter();
    await zip.add('other/documents.jsonl', '{}\n');
    writeFileSync(join(dir, 'x.zip'), Buffer.concat(zip.finish()));
    const run = spawnSync(process.execPath, ['tooling/export/index.mjs', '--from', join(dir, 'x.zip'), '--out', join(dir, 'out')], { cwd: root, encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /No teams and no issues/);
  });
});
