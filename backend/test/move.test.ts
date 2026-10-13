import { describe, expect, test } from 'vitest';
import { api } from '../convex/_generated/api';
import { OWNER_KIND } from '../convex/shared/constants';
import { createOne, expectCode, fixture, getIssue, historyOf, setup } from './helpers';

describe('Move to another team (issues.moveTeam)', () => {
  test('new identifier, old one stays as alias, bucket kept, project and team labels dropped', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    await createOne(owner, f.nova, { title: 'Existing' });
    const created = await createOne(owner, f.orb, { title: 'Moving', status: 'triage', labelIds: [f.bug, f.orbOnly], projectId: f.orbProject });
    const before = await getIssue(t, created.id);

    const result = await owner.mutation(api.issues.moveTeam, { ids: [created.id], teamId: f.nova });
    expect(result.moved).toEqual([{ id: created.id, identifier: 'NOVA-2', previous: 'ORB-1' }]);

    const after = await getIssue(t, created.id);
    expect(after.teamId).toBe(f.nova);
    expect(after.number).toBe(2);
    expect(after.seq).toBe(before.seq);
    expect(after.bucket).toBe(before.bucket);
    expect(after.projectId).toBeUndefined();
    expect(after.labelIds).toEqual([f.bug]);
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);

    // Old and new identifier resolve to the same issue.
    expect((await owner.query(api.issues.resolve, { identifier: 'ORB-1' }))?.id).toBe(created.id);
    expect((await owner.query(api.issues.resolve, { identifier: 'nova2' }))?.identifier).toBe('NOVA-2');

    const fields = (await historyOf(t, created.id)).map((h) => h.field);
    expect(fields).toEqual(expect.arrayContaining(['created', 'teamId', 'projectId', 'labelIds']));
    const row = (await historyOf(t, created.id)).find((h) => h.field === 'teamId')!;
    expect(row.from).toMatchObject({ identifier: 'ORB-1' });
    expect(row.to).toMatchObject({ identifier: 'NOVA-2' });
    expect(row.actor).toEqual({ kind: OWNER_KIND });

    // The next ORB issue does not get ORB-1 again.
    expect((await createOne(owner, f.orb)).identifier).toBe('ORB-2');
  });

  test('same team: no-op; trash: rejected; idempotent', async () => {
    const { owner } = setup();
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb);
    expect((await owner.mutation(api.issues.moveTeam, { ids: [a.id], teamId: f.orb })).moved).toEqual([]);
    const first = await owner.mutation(api.issues.moveTeam, { ids: [a.id], teamId: f.nova, requestId: 'move-1' });
    const again = await owner.mutation(api.issues.moveTeam, { ids: [a.id], teamId: f.nova, requestId: 'move-1' });
    expect(again).toEqual(first);
    await owner.mutation(api.issues.remove, { ids: [a.id] });
    await expectCode(owner.mutation(api.issues.moveTeam, { ids: [a.id], teamId: f.orb }), 'invalid');
  });

  test('owner only', async () => {
    const { owner, stranger } = setup();
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb);
    await expectCode(stranger.mutation(api.issues.moveTeam, { ids: [a.id], teamId: f.nova }), 'access_denied');
  });
});
