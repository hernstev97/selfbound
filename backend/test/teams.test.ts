import { describe, expect, test } from 'vitest';
import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import type { Actor } from '../convex/lib/actor';
import { checkLogo, checkSvgText } from '../convex/lib/logo';
import { createTeam, removeTeamLogo, reorderTeams, setTeamLogo, updateTeam } from '../convex/ops/teams';
import { LIMITS } from '../convex/shared/constants';
import { createOne, expectCode, fixture, setup, type T } from './helpers';

const AGENT = (agentId: Id<'agents'>): Actor => ({ kind: 'agent', agentId });

function png(width: number, height: number, extraBytes = 0) {
  const bytes = new Uint8Array(33 + extraBytes);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}
const SVG_OK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" fill="#c33"/><use href="#a"/></svg>';

async function upload(t: T, content: Uint8Array<ArrayBuffer> | string, type: string) {
  return await t.run(async (ctx) => await ctx.storage.store(new Blob([content], { type })));
}
async function storageExists(t: T, id: Id<'_storage'>) {
  return await t.run(async (ctx) => (await ctx.db.system.get('_storage', id)) !== null);
}

describe('Teams, projects, labels', () => {
  test('key follows TEAM_KEY_RE and is unique; without issues a rename frees the old key', async () => {
    const { t, owner } = setup();
    await expectCode(owner.mutation(api.teams.create, { key: 'A', name: 'Too short' }), 'invalid');
    await expectCode(owner.mutation(api.teams.create, { key: 'ABCDEFG', name: 'Too long' }), 'invalid');
    await expectCode(owner.mutation(api.teams.create, { key: '1AB', name: 'Leading digit' }), 'invalid');
    const { teamId, key } = await owner.mutation(api.teams.create, { key: 'kiu2', name: 'Acme' });
    expect(key).toBe('KIU2');
    await expectCode(owner.mutation(api.teams.create, { key: 'KIU2', name: 'Duplicate' }), 'invalid');
    await owner.mutation(api.teams.update, { teamId, key: 'KIU', dormant: true, name: 'Acme Corp' });
    await createOne(owner, teamId);
    await owner.mutation(api.teams.update, { teamId, key: 'KIU', name: 'Acme Corp 2' });
    const team = await t.run(async (ctx) => await ctx.db.get('teams', teamId));
    expect(team).toMatchObject({ key: 'KIU', name: 'Acme Corp 2', dormant: true });
    expect(team?.previousKeys).toBeUndefined();
    await owner.mutation(api.teams.create, { key: 'KIU2', name: 'Takes the free key' });
    // Renaming a team with issues: see teamRename.test.ts.
  });

  test('new team: the backend rejects an existing key, also in other spellings and on concurrent creation', async () => {
    const { owner } = setup();
    const f = await fixture(owner);
    const before = (await owner.query(api.meta.get, {})).teams;
    for (const key of ['ORB', 'orb', ' Orb ', 'NOVA']) {
      await expectCode(owner.mutation(api.teams.create, { key, name: 'Second Orbit' }), 'invalid');
    }
    // Two requests with the same new key: exactly one wins.
    const results = await Promise.allSettled([
      owner.mutation(api.teams.create, { key: 'NEW1', name: 'One' }),
      owner.mutation(api.teams.create, { key: 'new1', name: 'Two' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const after = (await owner.query(api.meta.get, {})).teams;
    expect(after.filter((x) => x.key === 'NEW1')).toHaveLength(1);
    expect(after).toHaveLength(before.length + 1);
    // Existing teams stay untouched.
    expect(after.find((x) => x._id === f.orb)).toEqual(before.find((x) => x._id === f.orb));
  });

  test('order of teams and projects', async () => {
    const { owner } = setup();
    const f = await fixture(owner);
    const { teamId: third } = await owner.mutation(api.teams.create, { key: 'THREE', name: 'Three' });
    await owner.mutation(api.teams.reorder, { teamIds: [third, f.orb] });
    expect((await owner.query(api.meta.get, {})).teams.map((t) => t.key)).toEqual(['THREE', 'ORB', 'NOVA']);
    const { projectId } = await owner.mutation(api.projects.create, { teamId: f.orb, name: 'Orbit · Two', state: 'planned' });
    await owner.mutation(api.projects.reorder, { teamId: f.orb, projectIds: [projectId] });
    const projects = (await owner.query(api.meta.get, {})).projects.filter((p) => p.teamId === f.orb);
    expect(projects.map((p) => p.name)).toEqual(['Orbit · Two', 'Orbit · Search']);
    await owner.mutation(api.projects.update, { projectId, state: 'done' });
  });

  test('labels: single-choice groups, team scope, archive', async () => {
    const { owner } = setup();
    const f = await fixture(owner);
    await expectCode(
      owner.mutation(api.labels.create, { name: 'X', hue: 1, groupId: (await owner.mutation(api.labelGroups.create, { name: 'Nova', exclusive: false, teamId: f.nova })).groupId, teamId: f.orb }),
      'invalid',
    );
    await owner.mutation(api.labels.update, { labelId: f.docs, archived: true });
    await expectCode(createOne(owner, f.orb, { labelIds: [f.docs] }), 'invalid');
    await owner.mutation(api.labels.update, { labelId: f.feature, groupId: null });
    await createOne(owner, f.orb, { labelIds: [f.bug, f.feature] });
    await owner.mutation(api.labelGroups.update, { groupId: f.area, exclusive: true });
    await expectCode(createOne(owner, f.orb, { labelIds: [f.design, f.docs] }), 'invalid');
    await expectCode(owner.mutation(api.labels.create, { name: 'Color', hue: 400 }), 'invalid');
  });

  test('agents must not change teams or logos', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const agentId = await t.run(
      async (ctx) => await ctx.db.insert('agents', { name: 'Codex', keyHash: 'c'.repeat(64), keyPrefix: 'selfbound_ccccc', createdAt: 0, canManageTeams: true }),
    );
    const agent = AGENT(agentId);
    const storageId = await upload(t, SVG_OK, 'image/svg+xml');
    await expectCode(t.run(async (ctx) => await createTeam(ctx, agent, { key: 'AGT', name: 'Agent' })), 'access_denied');
    await expectCode(t.run(async (ctx) => await updateTeam(ctx, agent, { teamId: f.orb, name: 'Hijacked' })), 'access_denied');
    await expectCode(t.run(async (ctx) => await reorderTeams(ctx, agent, { teamIds: [f.nova] })), 'access_denied');
    await expectCode(
      t.run(async (ctx) => await setTeamLogo(ctx, agent, { teamId: f.orb, storageId, variant: 'light', contentType: 'image/svg+xml' })),
      'access_denied',
    );
    await expectCode(t.run(async (ctx) => await removeTeamLogo(ctx, agent, { teamId: f.orb, variant: 'light' })), 'access_denied');
    await expectCode(
      t.mutation(internal.teams.applyLogo, { teamId: f.orb, storageId, variant: 'dark', contentType: 'image/svg+xml', actor: agent }),
      'access_denied',
    );
    // Neither may GitHub or the system; the importer may maintain teams, but not logos.
    await expectCode(t.run(async (ctx) => await updateTeam(ctx, { kind: 'github' }, { teamId: f.orb, name: 'x' })), 'access_denied');
    await t.run(async (ctx) => await updateTeam(ctx, { kind: 'import' }, { teamId: f.orb, name: 'Orbit (Import)' }));
    await expectCode(
      t.run(async (ctx) => await setTeamLogo(ctx, { kind: 'import' }, { teamId: f.orb, storageId, variant: 'light', contentType: 'image/svg+xml' })),
      'access_denied',
    );
    const team = await t.run(async (ctx) => await ctx.db.get('teams', f.orb));
    expect(team?.logoId).toBeUndefined();
  });
});

describe('Team logos', () => {
  test('PNG and SVG accepted, old logo is deleted, URLs in meta.get, remove', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    expect(typeof (await owner.mutation(api.teams.generateLogoUploadUrl, {}))).toBe('string');
    const first = await upload(t, png(64, 64), 'image/png');
    expect(await owner.action(api.teams.setLogo, { teamId: f.orb, storageId: first, variant: 'light' })).toEqual({
      teamId: f.orb,
      contentType: 'image/png',
    });
    const second = await upload(t, SVG_OK, 'image/svg+xml');
    await owner.action(api.teams.setLogo, { teamId: f.orb, storageId: second, variant: 'light' });
    expect(await storageExists(t, first)).toBe(false);
    const dark = await upload(t, png(32, 32), 'image/png');
    await owner.action(api.teams.setLogo, { teamId: f.orb, storageId: dark, variant: 'dark' });
    const meta = await owner.query(api.meta.get, {});
    const orb = meta.teams.find((team) => team._id === f.orb)!;
    expect(orb.logoType).toBe('image/svg+xml');
    expect(orb.logoUrl).toMatch(/^https?:\/\//);
    expect(orb.logoDarkUrl).toMatch(/^https?:\/\//);
    expect(await owner.mutation(api.teams.removeLogo, { teamId: f.orb, variant: 'dark' })).toEqual({ teamId: f.orb, removed: true });
    expect(await storageExists(t, dark)).toBe(false);
    expect((await owner.query(api.meta.get, {})).teams.find((team) => team._id === f.orb)?.logoDarkUrl).toBeNull();
  });

  test('rejected and deleted: SVG with script, too large, not square, wrong type', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const cases: [Uint8Array<ArrayBuffer> | string, string, string][] = [
      ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>alert(1)</script></svg>', 'image/svg+xml', '<script>'],
      [png(64, 64, LIMITS.logoMaxBytes), 'image/png', 'too large'],
      [png(64, 32), 'image/png', 'square'],
      ['GIF89a....', 'image/gif', 'SVG and PNG'],
    ];
    for (const [content, type, reason] of cases) {
      const storageId = await upload(t, content, type);
      const data = await expectCode(owner.action(api.teams.setLogo, { teamId: f.orb, storageId, variant: 'light' }), 'invalid');
      expect(String(data.message)).toContain(reason);
      expect(await storageExists(t, storageId)).toBe(false);
    }
    expect((await t.run(async (ctx) => await ctx.db.get('teams', f.orb)))?.logoId).toBeUndefined();
  });

  test('SVG check in detail', () => {
    const svg = (inner: string, attrs = 'viewBox="0 0 10 10"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`;
    expect(checkSvgText(svg('<rect width="10" height="10"/>'))).toBeNull();
    expect(checkSvgText(svg('<image href="data:image/png;base64,AAAA"/>'))).toBeNull();
    expect(checkSvgText(svg('<rect onclick="x()"/>'))).toContain('on…=');
    expect(checkSvgText(svg('<rect/>', 'viewBox="0 0 10 10" onload="x()"'))).toContain('on…=');
    expect(checkSvgText(svg('<a href="#x"><rect/></a>'))).toContain('<a>');
    expect(checkSvgText(svg('<use href="javascript:alert(1)"/>'))).toContain('javascript');
    expect(checkSvgText(svg('<use href="&#106;avascript:alert(1)"/>'))).toContain('javascript');
    expect(checkSvgText(svg('<foreignObject><div/></foreignObject>'))).toContain('foreignObject');
    expect(checkSvgText(svg('<image href="https://example.com/x.png"/>'))).toContain('external');
    expect(checkSvgText(svg('<image xlink:href="//example.com/x.png"/>'))).toContain('external');
    expect(checkSvgText(svg('<image href="data:image/svg+xml;base64,AAAA"/>'))).toContain('external');
    expect(checkSvgText(svg('<rect style="fill:url(http://x/y)"/>'))).toContain('url()');
    expect(checkSvgText(svg('<rect style="fill:url(#g)"/>'))).toBeNull();
    expect(checkSvgText(svg('<rect/>', 'viewBox="0 0 20 10"'))).toContain('square');
    expect(checkSvgText(svg('<rect/>', 'width="20" height="10"'))).toContain('square');
    expect(checkSvgText('<!DOCTYPE svg [<!ENTITY x "y">]>' + svg('<rect/>'))).toContain('DOCTYPE');
    expect(checkLogo(new TextEncoder().encode('not an image'))).toMatchObject({ ok: false });
    expect(checkLogo(png(16, 16))).toEqual({ ok: true, contentType: 'image/png' });
    expect(checkLogo(new Uint8Array())).toMatchObject({ ok: false });
    // The type declared in the storage metadata must match the content.
    const svgBytes = new TextEncoder().encode(svg('<rect/>'));
    expect(checkLogo(svgBytes, 'image/svg+xml')).toEqual({ ok: true, contentType: 'image/svg+xml' });
    expect(checkLogo(svgBytes, 'image/png')).toMatchObject({ ok: false, reason: expect.stringContaining('PNG signature') });
    expect(checkLogo(png(16, 16), 'image/svg+xml')).toMatchObject({ ok: false, reason: expect.stringContaining('does not match') });
    expect(checkLogo(png(16, 16), 'image/gif')).toMatchObject({ ok: false, reason: 'Only SVG and PNG are allowed.' });
  });
});
