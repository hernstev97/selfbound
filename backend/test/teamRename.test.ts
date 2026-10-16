import { describe, expect, test } from 'vitest';
import { api } from '../convex/_generated/api';
import { teamByKey } from '../convex/lib/identifiers';
import { updateTeam } from '../convex/ops/teams';
import { createOne, expectCode, fixture, setup } from './helpers';

// Renaming the key of a team that has issues (XLR8-72): identifiers follow the new key, old ones
// keep resolving through teams.previousKeys, and old keys stay reserved for the team.

describe('Team key rename', () => {
  test('identifiers follow the new key; old ones resolve in every spelling; the counter continues', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb);
    const b = await createOne(owner, f.orb);
    expect(a.identifier).toBe('ORB-1');
    await owner.mutation(api.teams.update, { teamId: f.orb, key: 'obt' });
    expect(await t.run(async (ctx) => await ctx.db.get('teams', f.orb))).toMatchObject({ key: 'OBT', previousKeys: ['ORB'] });
    for (const identifier of ['ORB-1', 'orb-1', 'orb1', 'ORB 1', 'OBT-1']) {
      expect(await owner.query(api.issues.resolve, { identifier })).toEqual({ id: a.id, identifier: 'OBT-1' });
    }
    expect((await owner.query(api.issues.resolve, { identifier: 'ORB-2' }))?.id).toBe(b.id);
    expect(await owner.query(api.issues.resolve, { identifier: 'ORB-3' })).toBeNull();
    expect((await createOne(owner, f.orb)).identifier).toBe('OBT-3');
    expect((await owner.query(api.meta.get, {})).teams.find((x) => x._id === f.orb)?.previousKeys).toEqual(['ORB']);
  });

  test('old keys stay reserved; renames chain; taking an old key back makes it current again', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb);
    await owner.mutation(api.teams.update, { teamId: f.orb, key: 'OBT' });
    await expectCode(owner.mutation(api.teams.create, { key: 'orb', name: 'Copy' }), 'invalid');
    await expectCode(owner.mutation(api.teams.update, { teamId: f.nova, key: 'ORB' }), 'invalid');
    await owner.mutation(api.teams.update, { teamId: f.orb, key: 'ORX' });
    expect((await t.run(async (ctx) => await ctx.db.get('teams', f.orb)))?.previousKeys).toEqual(['ORB', 'OBT']);
    for (const identifier of ['ORB-1', 'OBT-1', 'ORX-1']) expect((await owner.query(api.issues.resolve, { identifier }))?.id).toBe(a.id);

    await owner.mutation(api.teams.update, { teamId: f.orb, key: 'ORB' });
    expect((await t.run(async (ctx) => await ctx.db.get('teams', f.orb)))?.previousKeys).toEqual(['OBT', 'ORX']);
    for (const identifier of ['ORB-1', 'OBT-1', 'ORX-1']) {
      expect(await owner.query(api.issues.resolve, { identifier })).toEqual({ id: a.id, identifier: 'ORB-1' });
    }
    await expectCode(owner.mutation(api.teams.create, { key: 'OBT', name: 'Copy' }), 'invalid');
  });

  test('a team without issues frees its old key; only the owner renames a team with issues', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    await owner.mutation(api.teams.update, { teamId: f.nova, key: 'NOV' });
    expect((await t.run(async (ctx) => await ctx.db.get('teams', f.nova)))?.previousKeys).toBeUndefined();
    await owner.mutation(api.teams.create, { key: 'NOVA', name: 'New Nova' });

    await createOne(owner, f.orb);
    // The import may change teams, but never the key of one with issues.
    await expectCode(t.run(async (ctx) => await updateTeam(ctx, { kind: 'import' }, { teamId: f.orb, key: 'IMP' })), 'access_denied');
    expect((await t.run(async (ctx) => await ctx.db.get('teams', f.orb)))?.key).toBe('ORB');
  });

  test('issues moved out before or after the rename keep their old identifiers', async () => {
    const { owner } = setup();
    const f = await fixture(owner);
    const before = await createOne(owner, f.orb);
    const after = await createOne(owner, f.orb);
    await owner.mutation(api.issues.moveTeam, { ids: [before.id], teamId: f.nova });
    await owner.mutation(api.teams.update, { teamId: f.orb, key: 'OBT' });
    await owner.mutation(api.issues.moveTeam, { ids: [after.id], teamId: f.nova });
    // ORB-1 has an alias row; ORB-2 resolves through the team's current key (alias OBT-2).
    expect(await owner.query(api.issues.resolve, { identifier: 'ORB-1' })).toEqual({ id: before.id, identifier: 'NOVA-1' });
    expect(await owner.query(api.issues.resolve, { identifier: 'ORB-2' })).toEqual({ id: after.id, identifier: 'NOVA-2' });
    expect(await owner.query(api.issues.resolve, { identifier: 'OBT-2' })).toEqual({ id: after.id, identifier: 'NOVA-2' });
  });

  test('knowledge pages: a bare identifier with the old key still links the issue', async () => {
    const { owner } = setup();
    const f = await fixture(owner);
    await owner.mutation(api.teams.update, { teamId: f.orb, wiki: 'on' });
    await createOne(owner, f.orb);
    await owner.mutation(api.teams.update, { teamId: f.orb, key: 'OBT' });
    const { articleId } = await owner.mutation(api.wiki.create, { teamId: f.orb, title: 'Notes', markdown: 'Decided in ORB-1 before the rename.' });
    expect((await owner.query(api.wiki.backlinks, { articleId })).mentions.map((i) => i.identifier)).toEqual(['OBT-1']);
  });

  test('team lookups by key (import, document import) find a renamed team by its old key', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    await createOne(owner, f.orb);
    await owner.mutation(api.teams.update, { teamId: f.orb, key: 'OBT' });
    expect((await t.run(async (ctx) => await teamByKey(ctx, 'ORB')))?._id).toBe(f.orb);
    expect((await t.run(async (ctx) => await teamByKey(ctx, 'OBT')))?._id).toBe(f.orb);
    expect(await t.run(async (ctx) => await teamByKey(ctx, 'ZZZ'))).toBeNull();
  });
});
