import { describe, expect, test } from 'vitest';
import { api } from '../convex/_generated/api';
import { DAY_MS } from '../convex/lib/dates';
import { cleanupOld } from '../convex/ops/maintenance';
import { TEAM_KEY_RE } from '../convex/shared/constants';
import { DATASETS, generateDataset } from '../data/generate';
import { seedLocal, seedWith, type SeedClient } from '../scripts/seed';
import { expectCode, expectSprintInvariant, setup } from './helpers';

describe('test data generator', () => {
  test('deterministic and consistent (small)', () => {
    const a = generateDataset('small');
    const b = generateDataset('small');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.issues).toHaveLength(DATASETS.small.count);
    expect(a.teams).toHaveLength(10);
    expect(a.teams.filter((t) => t.dormant)).toHaveLength(3);
    expect(a.teams.every((t) => TEAM_KEY_RE.test(t.key))).toBe(true);
    expect(a.labelGroups.some((g) => g.exclusive)).toBe(true);
    expect(a.agents).toHaveLength(2);
    expect(a.recurrences).toHaveLength(2);
    expect(a.sprints.map((s) => s.state)).toEqual(['closed', 'closed', 'closed', 'active', 'planning']);

    const typeLabels = new Set(a.labels.filter((l) => l.group === 'Type').map((l) => l.name));
    const counts = new Map<string, number>();
    for (const issue of a.issues) {
      counts.set(issue.status, (counts.get(issue.status) ?? 0) + 1);
      expect(issue.labels.filter((l) => typeLabels.has(l)).length).toBeLessThanOrEqual(1);
      expect(issue.description.length).toBeGreaterThanOrEqual(500);
      expect(issue.description.length).toBeLessThanOrEqual(3000);
      expect(issue.description).toContain('## ');
      expect(issue.comments.length).toBeLessThanOrEqual(10);
      expect(issue.history.filter((h) => h.field === 'created')).toHaveLength(1);
      if (issue.parentSeq !== undefined) expect(issue.parentSeq).toBeLessThan(issue.seq);
      // Invariant: sprint ⇔ exactly one open entry in that sprint.
      const open = issue.sprintItems.filter((i) => i.removedAt === undefined);
      expect(open.length).toBeLessThanOrEqual(1);
      expect(open[0]?.sprint).toBe(issue.sprint);
      if (issue.deletedAt) expect(issue.sprintItems).toHaveLength(0);
      for (const item of issue.sprintItems) expect(item.addedAt).toBeGreaterThan(issue.createdAt);
    }
    // Status distribution roughly as configured (dormant teams close part of the open ones).
    expect(counts.get('done')! + counts.get('canceled')! + counts.get('duplicate')!).toBeGreaterThan(180);
    expect(counts.get('triage')).toBeGreaterThan(0);
    expect(new Set(a.issues.map((i) => i.rank)).size).toBe(a.issues.length);
    expect(a.issues.filter((i) => i.deletedAt).length).toBeGreaterThan(0);
    expect(a.issues.filter((i) => i.createdBy.kind === 'agent' && i.reviewedAt === undefined).length).toBeGreaterThan(0);
    expect(a.issues.filter((i) => i.estimate !== undefined).length).toBeGreaterThan(0);
    expect(a.issues.filter((i) => i.dueDate).length).toBeGreaterThan(0);
    expect(a.relations.length).toBeGreaterThan(0);
    const active = a.issues.flatMap((i) => i.sprintItems.filter((s) => s.sprint === 4 && s.removedAt === undefined));
    expect(active.some((s) => s.kind === 'planned') && active.some((s) => s.kind === 'late')).toBe(true);
    expect(active.some((s) => s.carriedFrom === 3)).toBe(true);
  });

  test('large has 10,000 issues', () => {
    const large = generateDataset('large');
    expect(large.issues).toHaveLength(10_000);
    expect(new Set(large.issues.map((i) => `${i.teamKey}-${i.number}`)).size).toBe(10_000);
  });
});

describe('seed', () => {
  test('only with SELFBOUND_ALLOW_SEED=1 and only for the owner', async () => {
    const { t, owner } = setup({ allowSeed: false });
    await expectCode(owner.mutation(api.seed.reset, {}), 'access_denied');
    await expectCode(owner.query(api.seed.status, {}), 'access_denied');
    process.env.SELFBOUND_ALLOW_SEED = '1';
    await expectCode(t.mutation(api.seed.reset, {}), 'access_denied');
  });

  test('seedLocal refuses non-local URLs', async () => {
    const fake = { url: 'https://happy-otter-123.convex.cloud' } as unknown as Parameters<typeof seedLocal>[0];
    await expect(seedLocal(fake, 'small')).rejects.toThrow(/local backend/);
  });

  test('loading small: invariant, counters, identifiers; a second run is skipped', async () => {
    const { t, owner } = setup();
    const client = owner as unknown as SeedClient;
    expect(await seedWith(client, 'small')).toEqual({ skipped: false, count: 440 });
    expect(await seedWith(client, 'small')).toEqual({ skipped: true, count: 440 });
    const counts = await t.run(async (ctx) => ({
      issues: (await ctx.db.query('issues').collect()).length,
      bodies: (await ctx.db.query('issueBodies').collect()).length,
      teams: (await ctx.db.query('teams').collect()).length,
      agents: await ctx.db.query('agents').collect(),
    }));
    expect(counts).toMatchObject({ issues: 440, bodies: 440, teams: 10 });
    expect(counts.agents.every((a) => /^[0-9a-f]{64}$/.test(a.keyHash ?? ''))).toBe(true);
    expect(await owner.query(api.meta.counter, {})).toEqual({ maxSeq: 439 });
    const audit = await expectSprintInvariant(t);
    expect(audit.sprints).toBe(5);
    const meta = await owner.query(api.meta.get, {});
    expect(meta.sprints.map((s) => s.state)).toEqual(['planning', 'active', 'closed', 'closed', 'closed']);
    expect((await owner.query(api.sprints.capacitySuggestion, {})).capacity).toBeGreaterThan(0);
    // New issue after seeding: numbers continue.
    const orb = meta.teams.find((team) => team.key === 'ORB')!;
    const max = await t.run(async (ctx) =>
      Math.max(...(await ctx.db.query('issues').collect()).filter((i) => i.teamId === orb._id).map((i) => i.number)),
    );
    const created = await owner.mutation(api.issues.create, { issues: [{ teamId: orb._id, title: 'After the seed' }] });
    expect(created.issues[0].identifier).toBe(`ORB-${max + 1}`);
    expect(await owner.query(api.meta.counter, {})).toEqual({ maxSeq: 440 });
    // An old identifier resolves.
    expect(await owner.query(api.issues.resolve, { identifier: 'PIX-1' })).not.toBeNull();
    // Forced reload: data is replaced, not doubled.
    await seedWith(client, 'small', { force: true });
    expect(await t.run(async (ctx) => (await ctx.db.query('issues').collect()).length)).toBe(440);
    await expectSprintInvariant(t);
  });
});

describe('cleanup', () => {
  test('requests older than 30 days and old rate windows are deleted', async () => {
    const { t, owner } = setup();
    const { teamId } = await owner.mutation(api.teams.create, { key: 'ORB', name: 'Orbit' });
    await owner.mutation(api.issues.create, { issues: [{ teamId, title: 'x' }], requestId: 'old' });
    expect(await t.run(async (ctx) => await cleanupOld(ctx, Date.now() + 29 * DAY_MS))).toMatchObject({ requests: 0 });
    expect(await t.run(async (ctx) => await cleanupOld(ctx, Date.now() + 31 * DAY_MS))).toMatchObject({ requests: 1, more: false });
    expect(await t.run(async (ctx) => (await ctx.db.query('requests').collect()).length)).toBe(0);
  });
});
