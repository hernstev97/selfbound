import { describe, expect, test } from 'vitest';
import { EXPORT_FORMAT, EXPORT_TABLES, EXPORT_VERSION } from '@selfbound/backend/shared/export';
import { buildExport, exportFileName, type ExportFile, type ExportTables } from '../src/export/index.ts';
import { relativePath, safeName } from '../src/export/markdown.ts';
import { ZipWriter, crc32 } from '../src/export/zip.ts';

// Data export (SELF-46): the ZIP is read back with the backup's own reader (tooling/backup).

type Entries = Map<string, Buffer>;
const snapshotModule = new URL('../../tooling/backup/snapshot.mjs', import.meta.url).href;
const { readZip } = (await import(snapshotModule)) as { readZip: (buf: Buffer) => Entries };
const unzip = (parts: Uint8Array[]) => readZip(Buffer.concat(parts));
const text = (entries: Entries, path: string) => entries.get(path)?.toString('utf8');

const TOKEN = 'A'.repeat(43);
const T0 = Date.UTC(2026, 9, 19, 8, 30);
const owner = { kind: 'owner' as const };

function fixture(): ExportTables {
  const tables = Object.fromEntries(EXPORT_TABLES.map((t) => [t, []])) as unknown as Record<string, unknown[]>;
  const row = (id: string, fields: Record<string, unknown>) => ({ _id: id, _creationTime: T0, ...fields });
  tables.teams = [row('team1', { key: 'ACME', name: 'Acme', hue: 0, dormant: false, order: 0, updatedAt: T0, logoId: 'logo1', logoType: 'image/svg+xml' })];
  tables.workflowStates = [row('st1', { teamId: 'team1', name: 'In Progress', type: 'started', position: 0, createdAt: T0, updatedAt: T0 })];
  tables.labels = [row('lab1', { name: 'Bug', hue: 10 })];
  tables.projects = [row('proj1', { teamId: 'team1', name: 'Launch', state: 'active', order: 0, updatedAt: T0 })];
  tables.sprints = [row('spr1', { number: 1, name: 'Sprint 1', goal: 'Ship', startDate: '2026-10-19', endDate: '2026-10-30', state: 'active', source: 'selfbound', updatedAt: T0 })];
  const issue = { teamId: 'team1', bucket: 0, rank: 'a0', labelIds: ['lab1'], status: 'in_progress', priority: 2, createdBy: owner, createdAt: T0, updatedAt: T0 };
  tables.issues = [
    row('iss1', { ...issue, seq: 1, number: 1, title: 'Fix the login / sign-in', stateId: 'st1', projectId: 'proj1', sprintId: 'spr1', dueDate: '2026-10-23' }),
    row('iss2', { ...issue, seq: 2, number: 2, title: 'Child', parentId: 'iss1', priority: 0 }),
    row('iss3', { ...issue, seq: 3, number: 3, title: 'Old', deletedAt: T0 }),
  ];
  tables.issueBodies = [row('b1', { issueId: 'iss1', markdown: `Steps\n\n![shot](https://example.convex.site/img/${TOKEN})`, version: 2, updatedAt: T0, updatedBy: owner })];
  tables.comments = [
    row('c1', { issueId: 'iss1', body: 'Looks good', author: { kind: 'agent', agentId: 'ag1' }, createdAt: T0 + 1000 }),
    row('c2', { issueId: 'iss1', body: 'removed', author: owner, createdAt: T0 + 2000, deletedAt: T0 + 3000 }),
  ];
  tables.relations = [row('r1', { fromId: 'iss1', toId: 'iss2', type: 'blocks', createdAt: T0, createdBy: owner })];
  tables.history = [
    row('h1', { issueId: 'iss1', field: 'created', actor: owner, at: T0 }),
    row('h2', { issueId: 'iss1', field: 'priority', from: 0, to: 2, actor: { kind: 'agent', agentId: 'ag1' }, at: T0 + 500 }),
    row('h3', { issueId: 'iss1', field: 'labelIds', from: [], to: ['lab1'], actor: owner, at: T0 + 600 }),
  ];
  tables.agents = [row('ag1', { name: 'Claude Code', createdAt: T0 })];
  tables.profile = [row('p1', { name: 'Jane', updatedAt: T0 })];
  tables.files = [
    row('f1', { token: TOKEN, storageId: 'stor1', contentType: 'image/png', size: 4, createdAt: T0, uploadedBy: owner }),
    row('f2', { token: 'B'.repeat(43), storageId: 'stor2', contentType: 'image/png', size: 4, createdAt: T0, uploadedBy: owner, deleteAfter: T0 }),
  ];
  tables.wikiTopics = [row('top1', { teamId: 'team1', name: 'Design', hue: 0 })];
  tables.articles = [
    row('a1', { teamId: 'team1', title: 'Guide', rank: 'a0', topicIds: ['top1'], createdAt: T0, createdBy: owner, updatedAt: T0, updatedBy: owner }),
    row('a2', { teamId: 'team1', parentId: 'a1', title: 'Setup', rank: 'a0', topicIds: [], createdAt: T0, createdBy: owner, updatedAt: T0, updatedBy: owner }),
    row('a3', { teamId: 'team1', parentId: 'a1', title: 'Setup', rank: 'a1', topicIds: [], createdAt: T0, createdBy: owner, updatedAt: T0, updatedBy: owner }),
  ];
  tables.articleBodies = [row('ab1', { articleId: 'a2', markdown: `See ![x](/img/${TOKEN})`, version: 1, updatedAt: T0, updatedBy: owner })];
  tables.articleSources = [row('src1', { articleId: 'a1', url: 'https://example.com', title: 'Example', accessedAt: '2026-10-19', order: 0, createdAt: T0, createdBy: owner })];
  return tables as unknown as ExportTables;
}

async function* reader(files: ExportFile[]) {
  for (const file of files) yield file.storageId === 'stor1' ? new Uint8Array([1, 2, 3, 4]) : file.storageId === 'logo1' ? new TextEncoder().encode('<svg/>') : null;
}

describe('export ZIP', () => {
  test('crc32 matches the reference value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  test('round trip: stored and deflated entries, UTF-8 names', async () => {
    const zip = new ZipWriter(T0);
    await zip.add('a.txt', 'x'.repeat(5000));
    await zip.add('bild/ä.bin', new Uint8Array([9, 8, 7]), { compress: false });
    const entries = unzip(zip.finish());
    expect(text(entries, 'a.txt')).toBe('x'.repeat(5000));
    expect([...entries.get('bild/ä.bin')!]).toEqual([9, 8, 7]);
    await expect(zip.add('a.txt', 'again')).rejects.toThrow(/Duplicate/);
  });

  test('65,535 entries and more get a ZIP64 directory', async () => {
    for (const count of [65_535, 65_600]) {
      const zip = new ZipWriter(T0);
      for (let i = 0; i < count; i++) await zip.add(`f${i}`, '');
      expect(unzip(zip.finish()).size).toBe(count);
    }
  }, 60_000);
});

describe('buildExport', () => {
  test('JSON: every table, manifest with format, version and files', async () => {
    const tables = fixture();
    const result = await buildExport(tables, { exportedAt: T0, source: 'app', readFiles: reader });
    const entries = unzip(result.parts);
    for (const table of EXPORT_TABLES) expect(JSON.parse(text(entries, `json/${table}.json`)!)).toEqual(tables[table]);
    const manifest = JSON.parse(text(entries, 'json/manifest.json')!);
    expect(manifest).toMatchObject({ format: EXPORT_FORMAT, version: EXPORT_VERSION, source: 'app', exportedAt: new Date(T0).toISOString() });
    expect(manifest.tables.issues).toBe(3);
    // The orphaned image (deleteAfter) is left out; the logo is in.
    expect(manifest.files.map((f: ExportFile) => f.path).sort()).toEqual([`files/images/${TOKEN}.png`, 'files/logos/ACME.svg']);
    expect(manifest.missingFiles).toEqual([]);
    expect([...entries.get(`files/images/${TOKEN}.png`)!]).toEqual([1, 2, 3, 4]);
    expect(result.files).toBe(2);
  });

  test('Markdown: one file per issue with names instead of ids, local image links', async () => {
    const entries = unzip((await buildExport(fixture(), { exportedAt: T0, source: 'app', readFiles: reader })).parts);
    const md = text(entries, 'markdown/issues/ACME/ACME-1 Fix the login sign-in.md')!;
    expect(md).toContain('status: "In Progress"');
    expect(md).toContain('priority: "High"');
    expect(md).toContain('labels: ["Bug"]');
    expect(md).toContain('project: "Launch"');
    expect(md).toContain('sprint: "Sprint 1"');
    expect(md).toContain('# ACME-1 Fix the login / sign-in');
    expect(md).toContain(`![shot](../../../files/images/${TOKEN}.png)`);
    expect(md).toContain('- Blocks ACME-2 Child');
    expect(md).toContain('## Sub-issues\n\n- ACME-2 Child');
    expect(md).toContain('### Claude Code (agent) · 2026-10-19 08:30 UTC');
    expect(md).not.toContain('removed');
    expect(md).toContain('· Claude Code (agent) · priority: None → High');
    expect(md).toContain('· Jane · labels: – → Bug');
    expect(text(entries, 'markdown/issues/ACME/ACME-2 Child.md')).toContain('parent: "ACME-1"');
    expect(text(entries, 'markdown/trash/issues/ACME/ACME-3 Old.md')).toContain('deleted: "2026-10-19 08:30 UTC"');
  });

  test('Markdown: knowledge pages follow the tree, same names get a number', async () => {
    const entries = unzip((await buildExport(fixture(), { exportedAt: T0, source: 'app', readFiles: reader })).parts);
    const guide = text(entries, 'markdown/knowledge/ACME/Guide.md')!;
    expect(guide).toContain('topics: ["Design"]');
    expect(guide).toContain('- [Example](https://example.com) (accessed 2026-10-19)');
    expect(text(entries, 'markdown/knowledge/ACME/Guide/Setup.md')).toContain(`![x](../../../../files/images/${TOKEN}.png)`);
    expect(entries.has('markdown/knowledge/ACME/Guide/Setup (2).md')).toBe(true);
    expect(text(entries, 'markdown/README.md')).toContain('| Issues | 2 (+1 in the trash) |');
  });

  test('files that cannot be read are listed, image links then keep the instance URL', async () => {
    const result = await buildExport(fixture(), { exportedAt: T0, source: 'snapshot' });
    const entries = unzip(result.parts);
    expect(JSON.parse(text(entries, 'json/manifest.json')!).missingFiles).toHaveLength(2);
    expect(text(entries, 'markdown/issues/ACME/ACME-1 Fix the login sign-in.md')).toContain(`https://example.convex.site/img/${TOKEN}`);
  });
});

describe('odd data', () => {
  test('duplicate issue numbers, a missing team, a page cycle and device names still export', async () => {
    const tables = fixture() as unknown as Record<string, Record<string, unknown>[]>;
    tables.teams![0]!.key = 'CON';
    const first = tables.issues![0]!;
    tables.issues!.push({ ...first, _id: 'iss4', seq: 4 }, { ...first, _id: 'iss5', seq: 5, teamId: 'gone', number: 9 });
    tables.articles![0]!.parentId = 'a2'; // a1 → a2 → a1
    tables.articles!.push({ ...tables.articles![0]!, _id: 'a4', parentId: undefined, title: 'aux.' });
    const result = await buildExport(tables as unknown as ExportTables, { exportedAt: T0, source: 'app', readFiles: reader });
    const names = [...unzip(result.parts).keys()];
    expect(names).toContain('markdown/issues/CON_/CON-1 Fix the login sign-in.md');
    expect(names).toContain('markdown/issues/CON_/CON-1 Fix the login sign-in (2).md');
    // The identifier of an issue without its team is "?-9"; the "?" is no valid file name character.
    expect(names).toContain('markdown/issues/unknown/-9 Fix the login sign-in.md');
    expect(names).toContain('files/logos/CON_.svg');
    expect(names).toContain('markdown/knowledge/CON_/aux_.md');
    expect(names.filter((n) => n.startsWith('markdown/knowledge/')).length).toBe(4);
  });
});

describe('names', () => {
  test('safe file names and relative links', () => {
    expect(safeName('a/b\\c:d*e?"f<g>h|i')).toBe('a b c d e f g h i');
    expect(safeName('  ..hidden ')).toBe('hidden');
    expect(safeName('///')).toBe('Untitled');
    expect(safeName('v1.0. ')).toBe('v1.0');
    expect(safeName('NUL')).toBe('NUL_');
    expect(safeName('com1.txt')).toBe('com1.txt_');
    expect(safeName('Cafe\u0301')).toBe('Café');
    expect(relativePath('markdown/issues/A/x.md', 'files/images/t.png')).toBe('../../../files/images/t.png');
    expect(relativePath('markdown/README.md', 'markdown/issues/A/x.md')).toBe('issues/A/x.md');
    expect(exportFileName(new Date(2026, 9, 5).getTime())).toBe('selfbound-export-2026-10-05.zip');
  });
});
