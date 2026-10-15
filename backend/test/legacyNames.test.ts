import { describe, expect, test } from 'vitest';
import { api, internal } from '../convex/_generated/api';
import type { TableNames } from '../convex/_generated/dataModel';
import { ACTOR_FIELDS, legacyPatch, TABLES, type MigratedTable } from '../convex/legacyNames';
import schema from '../convex/schema';
import { createOne, fixture, setup, type T } from './helpers';

// legacy-xlr8: data migration of the legacy names (legacyNames.ts): 'steven' → 'owner', theme 'xlr8' →
// 'selfbound', sprint source 'xlr8' → 'selfbound'. The test writes data the normal way, turns it
// into what production holds today (legacy values), migrates it and expects exactly the data it
// started with: nothing but the legacy values may change.

const LEGACY = 'steven'; // legacy-xlr8

type Json = Record<string, unknown>;

/** Every document of the migrated tables, in a stable order, as plain data. */
async function snapshot(t: T) {
  return await t.run(async (ctx) => {
    const out: Record<string, Json[]> = {};
    for (const table of TABLES) out[table] = (await ctx.db.query(table).collect()) as unknown as Json[];
    return out;
  });
}

/** Turns the current ('owner'/'selfbound') values of a document into the legacy ones. */
function toLegacy(table: MigratedTable, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((x) => toLegacy(table, x));
  if (!value || typeof value !== 'object') return value;
  const doc: Json = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'kind' && v === 'owner') doc[k] = LEGACY;
    else doc[k] = toLegacy(table, v);
  }
  if (table === 'requests' && doc.owner === 'owner') doc.owner = LEGACY;
  if (table === 'sprints' && doc.source === 'selfbound') doc.source = 'xlr8'; // legacy-xlr8
  if (table === 'appearance') {
    for (const f of ['dark', 'light']) if (doc[f] === 'selfbound') doc[f] = 'xlr8'; // legacy-xlr8
    if (Array.isArray(doc.overrides)) doc.overrides = doc.overrides.map((o) => ({ ...(o as Json), theme: (o as Json).theme === 'selfbound' ? 'xlr8' : (o as Json).theme })); // legacy-xlr8
  }
  return doc;
}

/** Writes the same data the app writes today, then rewrites it to the legacy form. Returns what the data looked like before. */
async function legacyData() {
  const { t, owner } = setup();
  const f = await fixture(owner);
  const a = await createOne(owner, f.orb, { title: 'A' });
  const b = await createOne(owner, f.orb, { title: 'B' });
  await owner.mutation(api.comments.add, { issueId: a.id, body: 'First' });
  await owner.mutation(api.relations.add, { fromId: a.id, toId: b.id, type: 'blocks' });
  await owner.mutation(api.issues.create, { requestId: 'req-legacy-1', issues: [{ teamId: f.orb, title: 'With request' }] });
  const { id: sprintId } = await owner.mutation(api.sprints.create, { goal: 'Focus' });
  await owner.mutation(api.sprints.add, { sprintId, issueIds: [a.id] });
  await owner.mutation(api.teams.update, { teamId: f.orb, wiki: 'on' });
  const { articleId } = await owner.mutation(api.wiki.create, { teamId: f.orb, title: 'Page', markdown: 'Text' });
  await owner.mutation(api.wiki.create, { teamId: f.orb, title: 'Child', parentId: articleId });
  await owner.mutation(api.appearance.save, {
    dark: 'selfbound',
    light: 'nord',
    sans: 'inter',
    mono: 'system',
    overrides: [{ theme: 'selfbound', colors: { accent: '#112233' } }],
  });
  // Rows that need an agent or files, inserted directly.
  await t.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', { name: 'Codex', keyHash: 'c'.repeat(64), keyPrefix: 'selfbound_ccccc', createdAt: 0 });
    await ctx.db.insert('inboxEntries', {
      issueId: a.id,
      kind: 'changed',
      actor: { kind: 'agent', agentId },
      changes: [
        { field: 'comment', actor: { kind: 'agent', agentId }, at: 1 },
        { field: 'priority', actor: { kind: 'owner' }, at: 2, value: '1' },
      ],
      createdAt: 1,
      updatedAt: 2,
    });
    await ctx.db.insert('files', { token: 't'.repeat(43), storageId: await ctx.storage.store(new Blob(['x'])), contentType: 'image/png', size: 1, createdAt: 1, uploadedBy: { kind: 'owner' } });
    await ctx.db.insert('bodyRevisions', { issueId: a.id, markdown: 'old', version: 1, at: 1, actor: { kind: 'owner' }, reason: 'import_overwrite' });
  });
  const current = await snapshot(t);
  // Legacy form: the same documents with the old values, written back in place.
  await t.run(async (ctx) => {
    for (const table of TABLES) {
      for (const doc of await ctx.db.query(table).collect()) {
        const { _id, _creationTime, ...fields } = doc as unknown as Json & { _id: never; _creationTime: number };
        const old = toLegacy(table, fields) as Json;
        if (JSON.stringify(old) !== JSON.stringify(fields)) await ctx.db.replace(_id, old as never);
      }
    }
  });
  return { t, current };
}

type Step = { table: MigratedTable; scanned: number; legacy: number; written: number; next: { table: MigratedTable; cursor: string | null } | null };

/** Runs the whole migration; returns the sums per table and how many pages it took. */
async function sweepStep(t: T, apply: boolean, pageSize?: number) {
  const totals: Record<string, { legacy: number; written: number }> = {};
  let pages = 0;
  let args: Json = { apply, ...(pageSize ? { pageSize } : {}) };
  for (;;) {
    const out = (await t.mutation(internal.legacyNames.step, args as never)) as Step;
    pages++;
    const row = (totals[out.table] ??= { legacy: 0, written: 0 });
    row.legacy += out.legacy;
    row.written += out.written;
    if (!out.next) return { totals, pages };
    args = { apply, ...out.next, ...(pageSize ? { pageSize } : {}) };
  }
}

async function sweepVerify(t: T, pageSize?: number) {
  let remaining = 0;
  let args: Json = pageSize ? { pageSize } : {};
  for (;;) {
    const out = await t.query(internal.legacyNames.verify, args as never);
    remaining += out.remaining;
    if (!out.next) return remaining;
    args = { ...out.next, ...(pageSize ? { pageSize } : {}) };
  }
}

describe('legacyNames migration', () => {
  test('the test data really holds legacy values in every kind of table', async () => {
    const { t } = await legacyData();
    expect(await sweepVerify(t)).toBeGreaterThan(10);
    const { totals } = await sweepStep(t, false);
    for (const table of ['issues', 'comments', 'history', 'inboxEntries', 'sprintItems', 'files', 'articles', 'articleBodies', 'requests', 'sprints', 'appearance', 'relations', 'issueBodies']) {
      expect(totals[table]?.legacy, table).toBeGreaterThan(0);
    }
  });

  test('dry run counts and writes nothing', async () => {
    const { t } = await legacyData();
    const before = await snapshot(t);
    const { totals } = await sweepStep(t, false);
    expect(Object.values(totals).reduce((n, x) => n + x.legacy, 0)).toBeGreaterThan(0);
    expect(Object.values(totals).every((x) => x.written === 0)).toBe(true);
    expect(await snapshot(t)).toEqual(before);
  });

  test('apply turns the legacy values into the current ones and changes nothing else', async () => {
    const { t, current } = await legacyData();
    const { totals } = await sweepStep(t, true);
    expect(Object.values(totals).reduce((n, x) => n + x.written, 0)).toBeGreaterThan(0);
    // Same documents as before the legacy rewrite: ids, timestamps, versions, ranks untouched.
    expect(await snapshot(t)).toEqual(current);
    expect(await sweepVerify(t)).toBe(0);
  });

  test('a second apply finds nothing and writes nothing', async () => {
    const { t, current } = await legacyData();
    await sweepStep(t, true);
    const again = await sweepStep(t, true);
    expect(Object.values(again.totals).every((x) => x.legacy === 0 && x.written === 0)).toBe(true);
    expect(await snapshot(t)).toEqual(current);
  });

  test('pages of two documents give the same result as the default page size', async () => {
    const { t, current } = await legacyData();
    const dry = await sweepStep(t, false);
    const small = await sweepStep(t, false, 2);
    expect(small.pages).toBeGreaterThan(dry.pages);
    expect(small.totals).toEqual(dry.totals);
    expect(await sweepVerify(t, 2)).toBeGreaterThan(0);
    await sweepStep(t, true, 2);
    expect(await snapshot(t)).toEqual(current);
    expect(await sweepVerify(t, 2)).toBe(0);
  });

  test('verify reports a single leftover legacy value', async () => {
    const { t } = await legacyData();
    await sweepStep(t, true);
    expect(await sweepVerify(t)).toBe(0);
    await t.run(async (ctx) => {
      const sprint = (await ctx.db.query('sprints').first())!;
      await ctx.db.patch('sprints', sprint._id, { source: 'xlr8' }); // legacy-xlr8
    });
    expect(await sweepVerify(t)).toBe(1);
  });

  test('a legacy idempotency record next to an existing one for the owner is dropped, not duplicated', async () => {
    const { t } = setup();
    await t.run(async (ctx) => {
      const row = { requestId: 'same', argsHash: 'h', operation: 'op', result: null, createdAt: 1 };
      await ctx.db.insert('requests', { ...row, owner: LEGACY });
      await ctx.db.insert('requests', { ...row, owner: 'owner' });
      await ctx.db.insert('requests', { ...row, requestId: 'only-legacy', owner: LEGACY });
    });
    await sweepStep(t, true);
    const rows = await t.run(async (ctx) => await ctx.db.query('requests').collect());
    expect(rows.map((r) => `${r.owner}:${r.requestId}`).sort()).toEqual(['owner:only-legacy', 'owner:same']);
  });

  test('appearance: overrides of both theme IDs are merged, the new ID wins', () => {
    const doc = {
      dark: 'xlr8', // legacy-xlr8
      light: 'nord',
      overrides: [
        { theme: 'xlr8', colors: { accent: '#111111', bg: '#222222' } }, // legacy-xlr8
        { theme: 'nord', colors: { accent: '#333333' } },
        { theme: 'selfbound', colors: { accent: '#444444' } },
      ],
    };
    expect(legacyPatch('appearance', doc)).toEqual({
      dark: 'selfbound',
      overrides: [
        { theme: 'nord', colors: { accent: '#333333' } },
        { theme: 'selfbound', colors: { accent: '#444444', bg: '#222222' } },
      ],
    });
    expect(legacyPatch('appearance', { dark: 'selfbound', light: 'nord', overrides: [] })).toBeNull();
  });

  test('the migration covers every field of the schema that can hold the legacy actor kind', () => {
    // Walks the validators of all tables and lists the top-level fields containing the literal.
    const holds = (json: unknown, literal: string): boolean => JSON.stringify(json).includes(`"${literal}"`);
    const found: Record<string, string[]> = {};
    for (const [table, def] of Object.entries(schema.tables)) {
      const fields = (def as unknown as { validator: { json: { value: Record<string, { fieldType: unknown }> } } }).validator.json.value;
      for (const [name, field] of Object.entries(fields)) {
        if (holds(field.fieldType, LEGACY)) (found[table] ??= []).push(name);
      }
    }
    const expected: Record<string, string[]> = {};
    for (const [table, fields] of Object.entries(ACTOR_FIELDS)) expected[table] = [...fields];
    expected.inboxEntries = [...(expected.inboxEntries ?? []), 'changes'];
    expect(Object.fromEntries(Object.entries(found).map(([k, v]) => [k, [...v].sort()]))).toEqual(
      Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, [...v].sort()])),
    );
    // Every table the migration lists exists.
    for (const table of TABLES) expect(Object.keys(schema.tables)).toContain(table satisfies TableNames);
  });
});
