import { generateNKeysBetween } from 'fractional-indexing';
import { describe, expect, test } from 'vitest';
import { normalize, stagingRows } from '../../tooling/linear-import/normalize.ts';
import { api, internal } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import { DAY_MS } from '../convex/lib/dates';
import { signBody } from '../convex/lib/github';
import { checkLogo, checkSvgText } from '../convex/lib/logo';
import { dayWindow } from '../convex/ops/agents';
import { BODY_SEARCH_CHARS } from '../convex/ops/bodies';
import { STALE_RUN_MS } from '../convex/ops/import';
import { purgeTrash } from '../convex/ops/issues';
import { OWNER_KIND } from '../convex/shared/constants';
import { createOne, expectCode, expectSprintInvariant, fixture, getIssue, setup, type T } from './helpers';
import { rawData } from './lib/linear-import/fixtures.ts';

// Regression tests from a backend audit. Each test would fail without the corresponding fix.

type Json = Record<string, any>;
type Summary = { status: string; counts: Record<string, Json>; deviations: string[]; conflicts: string[] };

async function runImport(t: T, run: string, raw = rawData()) {
  await t.run(async (ctx) => {
    for (const row of stagingRows(normalize(raw, { run, fetchedAt: Date.UTC(2026, 9, 8) }))) await ctx.db.insert('importStaging', row);
  });
  return (await t.action(internal.importer.process, { run })) as Summary;
}

async function find(t: T, identifier: string): Promise<Doc<'issues'> | null> {
  return await t.run(async (ctx) => {
    const [key, n] = identifier.split('-');
    const team = await ctx.db
      .query('teams')
      .withIndex('by_key', (q) => q.eq('key', key))
      .unique();
    return await ctx.db
      .query('issues')
      .withIndex('by_team_number', (q) => q.eq('teamId', team!._id).eq('number', Number(n)))
      .unique();
  });
}

async function bodyOf(t: T, issueId: Id<'issues'>) {
  return await t.run(async (ctx) => await ctx.db.query('issueBodies').withIndex('by_issue', (q) => q.eq('issueId', issueId)).unique());
}

function mcp(t: T, key: string) {
  let id = 0;
  const rpc = async (method: string, params?: Json, auth = `Bearer ${key}`) => {
    const response = await t.fetch('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth, 'MCP-Protocol-Version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    return { status: response.status, body: (await response.json()) as Json };
  };
  const call = async (name: string, args: Json = {}) => {
    const { status, body } = await rpc('tools/call', { name, arguments: args });
    expect(status).toBe(200);
    const result = (body.result ?? {}) as Json;
    return result.isError
      ? { ok: false as const, error: String(result.content[0].text), value: undefined as any }
      : { ok: true as const, value: result.structuredContent as any, error: '' };
  };
  return { rpc, call };
}

async function rateCount(t: T, agentId: Id<'agents'>) {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query('rateWindows')
      .withIndex('by_agent_window', (q) => q.eq('agentId', agentId).eq('window', dayWindow(Date.now())))
      .unique();
    return row?.count ?? 0;
  });
}

describe('Re-import with three-way merge', () => {
  test('if Linear only changes updatedAt, Selfbound changes to status, priority and description stay', async () => {
    const { t, owner } = setup();
    await runImport(t, 'r1');
    const kiu5 = (await find(t, 'KIU-5'))!;
    await owner.mutation(api.issues.update, { ids: [kiu5._id], patch: { status: 'done', priority: 1 } });
    // Done clears the priority; that is a Selfbound change too, which the re-import does not revert.
    await owner.mutation(api.issues.setDescription, { id: kiu5._id, markdown: 'Long Selfbound note from the owner', baseVersion: 1 });
    const raw = rawData();
    const i7 = raw.issues.find((i) => i.id === 'i-7')!;
    i7.updatedAt = new Date(Date.parse(i7.updatedAt) + 1000).toISOString();
    i7.url = 'https://linear.app/acme/issue/other';
    const summary = await runImport(t, 'r2', raw);
    expect(summary.counts.issue).toMatchObject({ updated: 0, created: 0 });
    const after = await getIssue(t, kiu5._id);
    expect(after).toMatchObject({ status: 'done', priority: 0 });
    expect(after.completedAt).toBeDefined();
    expect((await bodyOf(t, kiu5._id))!.markdown).toBe('Long Selfbound note from the owner');
  });

  test('only Linear → applied (old description fully saved); only Selfbound → kept; both → Selfbound kept with a conflict', async () => {
    const { t, owner } = setup();
    await runImport(t, 'r1');
    const kiu5 = (await find(t, 'KIU-5'))!;
    const kiu6 = (await find(t, 'KIU-6'))!;
    const before5 = (await bodyOf(t, kiu5._id))!.markdown;
    // Selfbound: priority on KIU-5, title and description on KIU-6.
    await owner.mutation(api.issues.update, { ids: [kiu5._id], patch: { priority: 2 } });
    await owner.mutation(api.issues.update, { ids: [kiu6._id], patch: { title: 'Title from Selfbound' } });
    await owner.mutation(api.issues.setDescription, { id: kiu6._id, markdown: 'Description from Selfbound', baseVersion: 1 });
    // Linear: title and description on KIU-5 (only there), title and description on KIU-6 (both).
    const raw = rawData();
    const i7 = raw.issues.find((i) => i.id === 'i-7')!;
    i7.title = 'New Linear title';
    i7.description = 'New Linear description';
    const i8 = raw.issues.find((i) => i.id === 'i-8')!;
    i8.title = 'Other Linear title';
    i8.description = 'Other Linear description';
    const summary = await runImport(t, 'r2', raw);

    const a5 = await getIssue(t, kiu5._id);
    expect(a5).toMatchObject({ title: 'New Linear title', priority: 2 });
    expect((await bodyOf(t, kiu5._id))!).toMatchObject({ markdown: 'New Linear description', version: 2 });
    const revisions5 = await owner.query(api.issues.revisions, { id: kiu5._id });
    expect(revisions5).toEqual([expect.objectContaining({ markdown: before5, version: 1, reason: 'import_overwrite' })]);

    const a6 = await getIssue(t, kiu6._id);
    expect(a6.title).toBe('Title from Selfbound');
    expect((await bodyOf(t, kiu6._id))!.markdown).toBe('Description from Selfbound');
    expect(await owner.query(api.issues.revisions, { id: kiu6._id })).toEqual([
      expect.objectContaining({ markdown: 'Other Linear description', reason: 'import_conflict' }),
    ]);
    expect(summary.conflicts).toEqual(['KIU-6: changed in Selfbound and in Linear (title, description); the Selfbound value stays.']);
    const conflicts = await t.run(async (ctx) => await ctx.db.query('importConflicts').collect());
    expect(conflicts.map((c) => c.issueId)).toEqual([kiu6._id]);

    // Third run with the same data: nothing left to do, no new conflict.
    const again = await runImport(t, 'r3', raw);
    expect(again.conflicts).toEqual([]);
    expect(again.counts.issue).toMatchObject({ updated: 0, created: 0 });
  });

  test('parent: changed only in Linear → applied; cleared in Selfbound and changed in Linear → conflict', async () => {
    const { t, owner } = setup();
    await runImport(t, 'r1');
    const kiu1 = (await find(t, 'KIU-1'))!;
    const kiu2 = (await find(t, 'KIU-2'))!;
    const kiu5 = (await find(t, 'KIU-5'))!;
    expect(kiu2.parentId).toBe(kiu1._id);
    const raw = rawData();
    raw.issues.find((i) => i.id === 'i-7')!.parent = { id: 'i-1' }; // KIU-5 under KIU-1
    raw.issues.find((i) => i.id === 'i-2')!.parent = { id: 'i-7' }; // KIU-2 under KIU-5
    await owner.mutation(api.issues.update, { ids: [kiu2._id], patch: { parentId: null } });
    const summary = await runImport(t, 'r2', raw);
    expect((await getIssue(t, kiu5._id)).parentId).toBe(kiu1._id);
    expect((await getIssue(t, kiu2._id)).parentId).toBeUndefined();
    expect(summary.conflicts).toContain('KIU-2: changed in Selfbound and in Linear (parentId); the Selfbound value stays.');
  });
});

describe('Permanently deleted issues stay deleted', () => {
  test('a purged issue does not come back on the next import', async () => {
    const { t, owner } = setup();
    await runImport(t, 'r1');
    const kiu5 = (await find(t, 'KIU-5'))!;
    await owner.mutation(api.issues.remove, { ids: [kiu5._id] });
    await t.run(async (ctx) => {
      await purgeTrash(ctx, Date.now() + 31 * DAY_MS);
    });
    expect(await find(t, 'KIU-5')).toBeNull();
    const link = await t.run(async (ctx) =>
      await ctx.db.query('linearLinks').withIndex('by_kind_linear', (q) => q.eq('kind', 'issue').eq('linearId', 'i-7')).unique(),
    );
    expect(link?.purgedAt).toBeDefined();
    const summary = await runImport(t, 'r2');
    expect(await find(t, 'KIU-5')).toBeNull();
    expect(summary.counts.issue).toMatchObject({ created: 0, skipped: 1 });
    expect(summary.deviations).toContain('KIU-5: permanently deleted in Selfbound, not recreated');
  });
});

describe('SVG allowlist and safe logo delivery', () => {
  const svg = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${inner}</svg>`;

  test('namespace prefixes, animations and hidden URL schemes are rejected', () => {
    const prefixed =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><s:script>alert(document.domain)</s:script></svg>';
    expect(checkSvgText(prefixed)).toContain('<s:script>');
    expect(checkLogo(new TextEncoder().encode(prefixed), 'image/svg+xml').ok).toBe(false);
    expect(
      checkSvgText('<svg xmlns="http://www.w3.org/2000/svg" xmlns:h="http://www.w3.org/1999/xhtml" viewBox="0 0 10 10"><h:iframe src="https://evil.example"/></svg>'),
    ).toContain('<h:iframe>');
    expect(checkSvgText(svg('<a><set attributeName="href" to="java&#9;script:alert(1)"/><rect width="10" height="10"/></a>'))).not.toBeNull();
    expect(checkSvgText(svg('<set attributeName="href" to="#x"/>'))).toContain('<set>');
    expect(checkSvgText(svg('<animate attributeName="href" values="javascript:alert(1)"/>'))).toContain('<animate>');
    expect(checkSvgText(svg('<use href="java&#x09;script:alert(1)"/>'))).toContain('javascript');
    expect(checkSvgText(svg('<use href="  JaVa\u0000ScRiPt:alert(1)"/>'))).toContain('javascript');
    expect(checkSvgText(svg('<rect s:onclick="x()" width="1"/>'))).not.toBeNull();
    expect(checkSvgText(svg('<style>@\\69mport url(x)</style>'))).toMatch(/escape/i);
    expect(checkSvgText(svg('<style><![CDATA[ rect { fill: url(https://x/y) } ]]></style>'))).toContain('url()');
    expect(checkSvgText(svg('<![CDATA[ x ]]>'))).not.toBeNull();
    expect(checkSvgText(svg('<rect width="1"'))).not.toBeNull(); // incomplete
  });

  test('typical logos from design tools pass', () => {
    const illustrator = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator -->
<svg version="1.1" id="Ebene_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px"
\t viewBox="0 0 64 64" style="enable-background:new 0 0 64 64;" xml:space="preserve">
<style type="text/css">
\t.st0{fill:#E30613;}
\t.st1{fill:url(#SVGID_1_);}
</style>
<linearGradient id="SVGID_1_" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="64" y2="64">
\t<stop  offset="0" style="stop-color:#FFFFFF"/>
\t<stop  offset="1" style="stop-color:#000000"/>
</linearGradient>
<g><path class="st0" d="M0,0h64v64H0V0z"/><circle class="st1" cx="32" cy="32" r="16"/></g>
<filter id="f"><feGaussianBlur stdDeviation="2"/></filter>
<use xlink:href="#SVGID_1_"/>
</svg>`;
    expect(checkSvgText(illustrator)).toBeNull();
  });

  test('meta.get returns /logo/<id>; the endpoint sets CSP, nosniff and the checked type', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const content = svg('<circle cx="5" cy="5" r="4" fill="#c33"/>');
    const storageId = await t.run(async (ctx) => await ctx.storage.store(new Blob([content], { type: 'image/svg+xml' })));
    await owner.action(api.teams.setLogo, { teamId: f.orb, storageId, variant: 'light' });
    const orb = (await owner.query(api.meta.get, {})).teams.find((x) => x._id === f.orb)!;
    expect(orb.logoUrl).toBe(`http://127.0.0.1:3211/logo/${storageId}`);
    const response = await t.fetch(`/logo/${storageId}`, { method: 'GET' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toBe(content);
    // Logos only: another file in storage and garbage → 404.
    const other = await t.run(async (ctx) => await ctx.storage.store(new Blob(['x'], { type: 'text/plain' })));
    expect((await t.fetch(`/logo/${other}`, { method: 'GET' })).status).toBe(404);
    expect((await t.fetch('/logo/broken', { method: 'GET' })).status).toBe(404);
    // An old logo that no longer passes the stricter check is not served.
    const old = await t.run(async (ctx) =>
      await ctx.storage.store(new Blob([svg('<s:script xmlns:s="http://www.w3.org/2000/svg">x</s:script>')], { type: 'image/svg+xml' })),
    );
    await t.run(async (ctx) => await ctx.db.patch('teams', f.nova, { logoId: old, logoType: 'image/svg+xml' }));
    expect((await t.fetch(`/logo/${old}`, { method: 'GET' })).status).toBe(404);
  });
});

describe('Archived labels only block new assignments', () => {
  test('UI: adding a label and undo work despite an archived label; assigning an archived label anew does not', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const issue = await createOne(owner, f.orb, { labelIds: [f.design] });
    await owner.mutation(api.labels.update, { labelId: f.design, archived: true });
    await owner.mutation(api.issues.update, { ids: [issue.id], patch: { labelIds: [f.design, f.docs] } });
    expect((await getIssue(t, issue.id)).labelIds).toEqual([f.design, f.docs]);
    await owner.mutation(api.issues.update, { ids: [issue.id], patch: { labelIds: [] } });
    // Undoing the removal: the archived label may come back.
    await owner.mutation(api.issues.revert, { items: [{ id: issue.id, patch: { labelIds: [f.design, f.docs] }, expect: { labelIds: [] } }] });
    expect((await getIssue(t, issue.id)).labelIds).toEqual([f.design, f.docs]);
    // Another issue does not get the archived label anew, not even through revert.
    const other = await createOne(owner, f.orb);
    await expectCode(owner.mutation(api.issues.update, { ids: [other.id], patch: { labelIds: [f.design] } }), 'invalid');
    await expectCode(
      owner.mutation(api.issues.revert, { items: [{ id: other.id, patch: { labelIds: [f.design] }, expect: { labelIds: [] } }] }),
      'invalid',
    );
  });

  test('MCP: update_issue with an already assigned archived label works, assigning it anew does not', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { key } = await owner.action(api.agents.create, { name: 'x' });
    const issue = await createOne(owner, f.orb, { labelIds: [f.design] });
    await owner.mutation(api.labels.update, { labelId: f.design, archived: true });
    const client = mcp(t, key);
    const ok = await client.call('update_issue', { identifier: issue.identifier, labels: ['Design', 'Docs'] });
    expect(ok.ok).toBe(true);
    expect(ok.value.changed).toEqual(['labels']);
    const other = await createOne(owner, f.orb);
    const denied = await client.call('update_issue', { identifier: other.identifier, labels: ['Design'] });
    expect(denied.error).toContain('Unknown label');
  });
});

describe('Closed sprints stay frozen', () => {
  test('reopened and planned again: old entry unchanged, capacity kept', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const issue = await createOne(owner, f.orb, { estimate: 5 });
    const { id: s1 } = await owner.mutation(api.sprints.create, {});
    await owner.mutation(api.sprints.add, { sprintId: s1, issueIds: [issue.id] });
    await owner.mutation(api.sprints.start, { sprintId: s1 });
    await owner.mutation(api.issues.update, { ids: [issue.id], patch: { status: 'done' } });
    await owner.mutation(api.sprints.close, { sprintId: s1, decisions: [] });
    const frozen = await owner.query(api.sprints.items, { sprintId: s1 });
    expect(frozen).toEqual([expect.objectContaining({ outcome: 'done', removedAt: null })]);
    expect((await owner.query(api.sprints.capacitySuggestion, {})).capacity).toBe(5);

    await owner.mutation(api.issues.update, { ids: [issue.id], patch: { status: 'todo', estimate: 8 } });
    const { id: s2 } = await owner.mutation(api.sprints.create, {});
    await owner.mutation(api.sprints.add, { sprintId: s2, issueIds: [issue.id] });
    expect(await owner.query(api.sprints.items, { sprintId: s1 })).toEqual(frozen);
    expect((await getIssue(t, issue.id)).sprintId).toBe(s2);
    expect((await owner.query(api.sprints.capacitySuggestion, {})).capacity).toBe(5);
    await expectSprintInvariant(t);
  });

  test('detaching from a closed sprint (sprintId null) leaves the entry unchanged; purge keeps it', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const issue = await createOne(owner, f.orb, { estimate: 3 });
    const { id: s1 } = await owner.mutation(api.sprints.create, {});
    await owner.mutation(api.sprints.add, { sprintId: s1, issueIds: [issue.id] });
    await owner.mutation(api.sprints.start, { sprintId: s1 });
    await owner.mutation(api.issues.update, { ids: [issue.id], patch: { status: 'done' } });
    await owner.mutation(api.sprints.close, { sprintId: s1, decisions: [] });
    const frozen = await owner.query(api.sprints.items, { sprintId: s1 });
    await owner.mutation(api.issues.update, { ids: [issue.id], patch: { status: 'todo', sprintId: null } });
    expect((await getIssue(t, issue.id)).sprintId).toBeUndefined();
    expect(await owner.query(api.sprints.items, { sprintId: s1 })).toEqual(frozen);
    await expectSprintInvariant(t);

    await owner.mutation(api.issues.remove, { ids: [issue.id] });
    await t.run(async (ctx) => {
      await purgeTrash(ctx, Date.now() + 31 * DAY_MS);
    });
    expect(await owner.query(api.sprints.items, { sprintId: s1 })).toEqual(frozen);
    expect((await owner.query(api.sprints.capacitySuggestion, {})).capacity).toBe(3);
    await expectSprintInvariant(t);
  });
});

describe('MCP read tools as queries with read limits', () => {
  async function manyDone(t: T, teamId: Id<'teams'>, count: number) {
    const ranks = generateNKeysBetween(null, null, count);
    // Done issues with an old due date: the filters "overdue" and "status: done"
    // must not read all of them.
    for (let start = 0; start < count; start += 500) {
      await t.run(async (ctx) => {
        for (let i = start; i < Math.min(count, start + 500); i++) {
          await ctx.db.insert('issues', {
            seq: 10_000 + i,
            bucket: Math.floor((10_000 + i) / 64),
            teamId,
            number: 10_000 + i,
            title: `Old ${i}`,
            status: 'done',
            priority: 0,
            labelIds: [],
            dueDate: '2020-01-01',
            rank: ranks[i],
            createdBy: { kind: OWNER_KIND },
            createdAt: 1,
            updatedAt: 1 + i,
            completedAt: 2,
          });
        }
      });
    }
  }

  test('read is a query; overdue reads no done issues, status done only limit + 1', { timeout: 120_000 }, async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { key, agentId } = await owner.action(api.agents.create, { name: 'x' });
    await manyDone(t, f.orb, 3100);
    const late = await createOne(owner, f.orb, { dueDate: '2021-01-01' });
    const client = mcp(t, key);
    const overdue = await client.call('list_issues', { filter: 'overdue' });
    expect(overdue.value).toMatchObject({ count: 1, issues: [{ identifier: late.identifier }] });
    expect(overdue.value.truncated).toBeUndefined();
    const done = await client.call('list_issues', { status: ['done'], limit: 5 });
    expect(done.value).toMatchObject({ count: 5, more: true });
    expect(done.value.truncated).toBeUndefined();
    expect(done.value.issues[0].title).toBe('Old 3099'); // most recently updated first
    expect(await rateCount(t, agentId)).toBe(2);
    // The read function is a query (cacheable) and needs a valid key.
    const keyHash = await t.run(async (ctx) => (await ctx.db.get('agents', agentId))!.keyHash!);
    const direct = await t.query(internal.mcp.read, { keyHash, tool: 'list_teams', args: {}, today: '2026-10-09' });
    expect(direct).toMatchObject({ teams: [{ key: 'ORB' }, { key: 'NOVA' }] });
    await expectCode(t.query(internal.mcp.read, { keyHash: '0'.repeat(64), tool: 'list_teams', args: {}, today: '2026-10-09' }), 'access_denied');
  });
});

describe('Retry with requestId before name resolution', () => {
  test('create_issues, set_status and add_comment return the stored result on retry', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const { key } = await owner.action(api.agents.create, { name: 'x' });
    const client = mcp(t, key);
    const create = { requestId: 'req-12345678', issues: [{ team: 'ORB', title: 'A', labels: ['Design'] }] };
    const first = await client.call('create_issues', create);
    expect(first.ok).toBe(true);
    await owner.mutation(api.labels.update, { labelId: f.design, archived: true });
    const second = await client.call('create_issues', create);
    expect(second).toEqual(first);
    const identifier = first.value.created[0].identifier as string;
    const status = { requestId: 'req-status-1', identifiers: [identifier], status: 'todo' };
    const comment = { requestId: 'req-comment-1', identifier, body: 'Hello' };
    const s1 = await client.call('set_status', status);
    const c1 = await client.call('add_comment', comment);
    const issue = (await owner.query(api.issues.resolve, { identifier }))!;
    await owner.mutation(api.issues.remove, { ids: [issue.id] });
    expect(await client.call('set_status', status)).toEqual(s1);
    expect(await client.call('add_comment', comment)).toEqual(c1);
    const comments = await t.run(async (ctx) => await ctx.db.query('comments').collect());
    expect(comments).toHaveLength(1);
  });
});

describe('Invalid calls count, invalid keys cost no query', () => {
  test('invalid arguments and unknown tools count toward the rate limit; wrong key format → 401', async () => {
    const { t, owner } = setup();
    await fixture(owner);
    const { key, agentId } = await owner.action(api.agents.create, { name: 'x' });
    const client = mcp(t, key);
    for (let i = 0; i < 3; i++) expect((await client.call('list_issues', { limit: 9999 })).ok).toBe(false);
    const unknown = await client.rpc('tools/call', { name: 'drop_database', arguments: {} });
    expect(unknown.body.error).toBeDefined();
    expect(await rateCount(t, agentId)).toBe(4);
    const wrong = await client.rpc('tools/list', {}, 'Bearer selfbound_too-short');
    expect(wrong.status).toBe(401);
  });
});

describe('Paged comments, search without full descriptions', () => {
  test('detail returns the newest 100 comments and hasMore; comments.page loads the rest', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const issue = await createOne(owner, f.orb);
    await t.run(async (ctx) => {
      for (let i = 0; i < 150; i++) {
        await ctx.db.insert('comments', {
          issueId: issue.id,
          body: `Comment ${i}`,
          author: { kind: OWNER_KIND },
          createdAt: 1_000 + Math.floor(i / 2), // two at a time with the same timestamp
          ...(i === 10 ? { deletedAt: 5 } : {}),
        });
      }
    });
    const detail = (await owner.query(api.issues.detail, { id: issue.id }))!;
    expect(detail.comments).toHaveLength(100);
    expect(detail.commentsHasMore).toBe(true);
    expect(detail.comments.at(-1)!.body).toBe('Comment 149');
    expect(detail.comments[0].body).toBe('Comment 50');
    const older = await owner.query(api.comments.page, { issueId: issue.id, before: detail.comments[0]._id });
    expect(older.hasMore).toBe(false);
    expect(older.comments).toHaveLength(49); // 0 … 49 without the removed no. 10
    expect(older.comments.map((c) => c.body)).not.toContain('Comment 10');
    expect(older.comments.at(-1)!.body).toBe('Comment 49');
    const seen = new Set([...older.comments, ...detail.comments].map((c) => c._id));
    expect(seen.size).toBe(149);
  });

  test('search reads only the search text (start of the description)', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const long = 'Firstword ' + 'x '.repeat(10_000) + 'Lastword';
    const issue = await createOne(owner, f.orb, { description: long });
    const row = await t.run(async (ctx) => await ctx.db.query('bodySearch').withIndex('by_issue', (q) => q.eq('issueId', issue.id)).unique());
    expect(row!.text.length).toBe(BODY_SEARCH_CHARS);
    expect((await owner.query(api.issues.search, { q: 'Firstword' })).map((r) => r.id)).toEqual([issue.id]);
    // New version: the search text follows.
    await owner.mutation(api.issues.setDescription, { id: issue.id, markdown: 'Brand new', baseVersion: 1 });
    expect((await owner.query(api.issues.search, { q: 'Firstword' })).length).toBe(0);
    expect((await owner.query(api.issues.search, { q: 'new' })).map((r) => r.match)).toEqual(['description']);
  });
});

describe('meta.get shows the most recently closed sprints, Selfbound first', () => {
  test('Selfbound sprints stay visible after importing old Linear cycles', async () => {
    const { t, owner } = setup();
    for (let i = 0; i < 2; i++) {
      const { id } = await owner.mutation(api.sprints.create, {});
      await owner.mutation(api.sprints.start, { sprintId: id });
      await owner.mutation(api.sprints.close, { sprintId: id, decisions: [] });
    }
    // Imported afterwards: many old Linear cycles (created later, closed earlier).
    await t.run(async (ctx) => {
      for (let i = 0; i < 8; i++) {
        await ctx.db.insert('sprints', {
          number: 100 + i,
          name: `KIU Cycle ${i}`,
          goal: '',
          startDate: '2025-01-01',
          endDate: '2025-01-14',
          state: 'closed',
          source: 'linear',
          startedAt: Date.UTC(2025, 0, 1) + i * DAY_MS,
          closedAt: Date.UTC(2025, 0, 14) + i * DAY_MS,
          updatedAt: Date.now(),
        });
      }
    });
    const closed = (await owner.query(api.meta.get, {})).sprints.filter((s) => s.state === 'closed');
    expect(closed).toHaveLength(6);
    expect(closed.filter((s) => s.source === 'selfbound')).toHaveLength(2);
    expect(closed.filter((s) => s.source === 'linear').map((s) => s.name)).toEqual([
      'KIU Cycle 7',
      'KIU Cycle 6',
      'KIU Cycle 5',
      'KIU Cycle 4',
    ]);
  });
});

describe('Local test sign-in only on a local deployment', () => {
  test('with a cloud URL requireOwner rejects the local issuer; /health reports devAuth', async () => {
    process.env.SELFBOUND_DEV_JWKS = 'data:application/json,{}';
    try {
      const local = setup();
      expect(await local.owner.query(api.health.whoami, {})).toEqual({ kind: OWNER_KIND });
      expect(await (await local.t.fetch('/health', { method: 'GET' })).json()).toMatchObject({ local: true, devAuth: true });
      const cloud = setup({ cloudUrl: 'https://happy-otter-123.convex.cloud' });
      await expectCode(cloud.owner.query(api.health.whoami, {}), 'access_denied');
      await expectCode(cloud.owner.mutation(api.teams.create, { key: 'ORB', name: 'Orbit' }), 'access_denied');
      expect(await (await cloud.t.fetch('/health', { method: 'GET' })).json()).toMatchObject({
        local: false,
        devAuth: false,
        devAuthConfigured: true,
      });
    } finally {
      delete process.env.SELFBOUND_DEV_JWKS;
    }
  });
});

describe('Nightly sprint audit in pages', () => {
  test('audits across several pages, skips Linear sprints and reports problems in opsStatus', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const ids: Id<'sprints'>[] = [];
    for (let i = 0; i < 23; i++) ids.push((await owner.mutation(api.sprints.create, {})).id);
    await t.run(async (ctx) => {
      await ctx.db.insert('sprints', {
        number: 999,
        name: 'Linear',
        goal: '',
        startDate: '2025-01-01',
        endDate: '2025-01-14',
        state: 'closed',
        source: 'linear',
        updatedAt: 1,
      });
    });
    const issue = await createOne(owner, f.orb);
    await owner.mutation(api.sprints.add, { sprintId: ids[22], issueIds: [issue.id] });
    await t.run(async (ctx) => await ctx.db.patch('issues', issue.id, { sprintId: undefined }));
    const result = (await t.action(internal.maintenance.auditSprints, {})) as Json;
    expect(result).toMatchObject({ ok: false, sprints: 23 });
    expect(result.problems).toEqual([expect.stringMatching(/^Sprint 23: .*issue\.sprintId = /)]);
    expect((await owner.query(api.ops.status, {})).sprintAudit?.value).toMatchObject({ ok: false, sprints: 23 });
  });
});

describe('GitHub closes issues only on the transition to merged', () => {
  test('another merged delivery does not close a reopened issue again', async () => {
    const secret = 'test-secret-synthetic';
    process.env.GITHUB_WEBHOOK_SECRET = secret;
    const { t, owner } = setup();
    const f = await fixture(owner);
    const issue = await createOne(owner, f.orb, { status: 'todo' });
    const deliver = async (deliveryId: string, updatedAt: string) => {
      const body = JSON.stringify({
        action: 'closed',
        number: 7,
        repository: { full_name: 'acme/app' },
        pull_request: {
          number: 7,
          title: `Fixes ${issue.identifier}`,
          body: '',
          state: 'closed',
          draft: false,
          merged: true,
          merged_at: '2026-10-08T12:00:00Z',
          updated_at: updatedAt,
          html_url: 'https://github.com/acme/app/pull/7',
          head: { ref: 'feature/x' },
          user: { login: 'octocat' },
        },
      });
      const response = await t.fetch('/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-GitHub-Delivery': deliveryId,
          'X-Hub-Signature-256': await signBody(secret, body),
        },
        body,
      });
      return (await response.json()) as Json;
    };
    expect((await deliver('d-1', '2026-10-08T12:00:00Z')).closed).toEqual([issue.identifier]);
    await owner.mutation(api.issues.update, { ids: [issue.id], patch: { status: 'todo' } });
    // Different delivery ID (e.g. "Redeliver" after the 30-day list expired), newer time.
    expect((await deliver('d-2', '2026-10-08T13:00:00Z')).closed).toEqual([]);
    expect((await getIssue(t, issue.id)).status).toBe('todo');
  });
});

describe('Import in resumable steps', () => {
  test('each step scheduled separately, progress in importRuns, stuck runs → failed', async () => {
    const { t } = setup();
    const summary = await runImport(t, 'r1');
    expect(summary.status).toBe('done');
    const run = await t.run(async (ctx) => (await ctx.db.query('importRuns').collect())[0]);
    expect(run).toMatchObject({ status: 'done', phase: 'done' });
    expect(run.heartbeatAt).toBeGreaterThanOrEqual(run.startedAt);
    // A stuck run (no progress for more than 15 minutes) is marked failed on the next start
    // and by the cron; after that a new run proceeds normally.
    const stale = await t.run(async (ctx) =>
      await ctx.db.insert('importRuns', {
        run: 'old',
        startedAt: Date.now() - STALE_RUN_MS - 60_000,
        heartbeatAt: Date.now() - STALE_RUN_MS - 60_000,
        status: 'running',
        counts: {},
        deviations: [],
        phase: 'issue',
      }),
    );
    expect(await t.mutation(internal.importer.failStale, {})).toEqual({ failed: 1 });
    expect(await t.run(async (ctx) => (await ctx.db.get('importRuns', stale))!)).toMatchObject({ status: 'failed' });
    // A running (fresh) run blocks a second start.
    await t.run(async (ctx) => {
      await ctx.db.insert('importRuns', { run: 'fresh', startedAt: Date.now(), heartbeatAt: Date.now(), status: 'running', counts: {}, deviations: [] });
      await ctx.db.insert('importStaging', { run: 'r9', kind: 'team', linearId: 'x', payload: {} });
    });
    await expect(t.mutation(internal.importer.start, { run: 'r9', notes: [] })).rejects.toThrow(/already running/);
  });
});
