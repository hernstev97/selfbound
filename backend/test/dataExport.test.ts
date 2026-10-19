import { describe, expect, test } from 'vitest';
import { api } from '../convex/_generated/api';
import { EXPORT_PAGE_ROWS, EXPORT_TABLES, EXPORT_URL_BATCH } from '../convex/shared/export';
import schema from '../convex/schema';
import { createOne, expectCode, fixture, setup, type Client } from './helpers';

// Data export (SELF-46): dataExport.page reads every export table page by page, owner only.

async function readAll(owner: Client, table: string) {
  const rows: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const page: { rows: Record<string, unknown>[]; cursor: string; isDone: boolean } = await owner.query(api.dataExport.page, { table, cursor });
    rows.push(...page.rows);
    pages++;
    if (page.isDone) return { rows, pages };
    cursor = page.cursor;
  }
}

describe('data export', () => {
  test('every export table exists in the schema', () => {
    const tables = Object.keys(schema.tables);
    for (const table of EXPORT_TABLES) expect(tables).toContain(table);
  });

  test('owner only; unknown and secret tables are refused', async () => {
    const { owner, stranger } = setup();
    await expectCode(stranger.query(api.dataExport.page, { table: 'issues', cursor: null }), 'access_denied');
    await expectCode(stranger.query(api.dataExport.fileUrls, { storageIds: [] }), 'access_denied');
    await expectCode(owner.query(api.dataExport.page, { table: 'oauthTokens', cursor: null }), 'invalid');
    await expectCode(owner.query(api.dataExport.page, { table: 'pushSubscriptions', cursor: null }), 'invalid');
    await expectCode(owner.query(api.dataExport.page, { table: 'nope', cursor: null }), 'invalid');
  });

  test('rows as stored, agents without key hash and prefix', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const issue = await createOne(owner, f.orb, { title: 'Exported' });
    await t.run(async (ctx) => {
      await ctx.db.insert('agents', { name: 'Claude Code', keyHash: 'f'.repeat(64), keyPrefix: 'sb_abc', createdAt: 1 });
    });
    const { rows: issues } = await readAll(owner, 'issues');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ _id: issue!.id, title: 'Exported', teamId: f.orb });
    const { rows: agents } = await readAll(owner, 'agents');
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: 'Claude Code', createdAt: 1 });
    expect(agents[0]).not.toHaveProperty('keyHash');
    expect(agents[0]).not.toHaveProperty('keyPrefix');
    const { rows: history } = await readAll(owner, 'history');
    expect(history.map((h) => h.field)).toContain('created');
  });

  test('large tables come in several pages without losing rows', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const issue = await createOne(owner, f.orb);
    const count = EXPORT_PAGE_ROWS + 5;
    await t.run(async (ctx) => {
      for (let i = 0; i < count; i++) await ctx.db.insert('history', { issueId: issue!.id, field: 'title', from: `a${i}`, to: `b${i}`, actor: { kind: 'owner' }, at: i });
    });
    const { rows, pages } = await readAll(owner, 'history');
    expect(pages).toBeGreaterThan(1);
    expect(rows).toHaveLength(count + 1); // plus the created row
    expect(new Set(rows.map((r) => r._id)).size).toBe(count + 1);
  });

  test('large texts: pages end at the byte limit, no row is lost', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const issue = await createOne(owner, f.orb);
    // 50 texts of 190,000 characters: more than a query may read (8 MiB), so it needs several pages.
    await t.run(async (ctx) => {
      for (let i = 0; i < 50; i++) await ctx.db.insert('bodyRevisions', { issueId: issue!.id, markdown: String(i % 10).repeat(190_000), version: i, reason: 'import_overwrite', at: i, actor: { kind: 'import' } });
    });
    const { rows, pages } = await readAll(owner, 'bodyRevisions');
    expect(pages).toBeGreaterThan(1);
    expect(rows).toHaveLength(50);
    expect(new Set(rows.map((r) => r.version)).size).toBe(50);
  });

  test('file URLs for stored files, null for deleted ones, batch limit', async () => {
    const { t, owner } = setup();
    const [kept, gone] = await t.run(async (ctx) => {
      const a = await ctx.storage.store(new Blob([new Uint8Array([1])]));
      const b = await ctx.storage.store(new Blob([new Uint8Array([2])]));
      await ctx.storage.delete(b);
      return [a, b];
    });
    const urls = await owner.query(api.dataExport.fileUrls, { storageIds: [kept, gone] });
    expect(urls[0]).toMatchObject({ storageId: kept });
    expect(typeof urls[0]!.url).toBe('string');
    expect(urls[1]).toEqual({ storageId: gone, url: null });
    await expectCode(owner.query(api.dataExport.fileUrls, { storageIds: Array.from({ length: EXPORT_URL_BATCH + 1 }, () => kept) }), 'invalid');
  });
});
