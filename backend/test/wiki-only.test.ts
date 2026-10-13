import { describe, expect, test } from 'vitest';
import { api } from '../convex/_generated/api';
import { createOne, expectCode, fixture, setup, stateId } from './helpers';

// Knowledge-only teams (wiki: 'only'): no new issues; switching requires no open work.

describe('Knowledge only', () => {
  test('create as knowledge-only team; no issues, no moving issues in, no recurrences', async () => {
    const { owner } = setup();
    const f = await fixture(owner);
    const { teamId: pol } = await owner.mutation(api.teams.create, { key: 'POL', name: 'Politics', wiki: 'only' });
    expect((await owner.query(api.meta.get, {})).teams.find((t) => t._id === pol)?.wiki).toBe('only');
    expect((await expectCode(owner.mutation(api.issues.create, { issues: [{ teamId: pol, title: 'No' }] }), 'invalid')).message).toContain('only holds knowledge pages');
    const issue = await createOne(owner, f.orb);
    await expectCode(owner.mutation(api.issues.moveTeam, { ids: [issue.id], teamId: pol }), 'invalid');
    await expectCode(owner.mutation(api.recurrences.create, { teamId: pol, title: 'x', cadence: 'weekly', weekday: 1 }), 'invalid');
    // Pages work.
    await owner.mutation(api.wiki.create, { teamId: pol, title: 'Electoral law' });
  });

  test('switch only without open issues and active recurrences; completed ones stay', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const open = await createOne(owner, f.nova);
    const done = await createOne(owner, f.nova);
    await owner.mutation(api.issues.update, { ids: [done.id], patch: { stateId: await stateId(t, f.nova, 'done') } });
    const data = await expectCode(owner.mutation(api.teams.update, { teamId: f.nova, wiki: 'only' }), 'invalid');
    expect(data).toMatchObject({ open: 1 });
    await owner.mutation(api.issues.update, { ids: [open.id], patch: { stateId: await stateId(t, f.nova, 'canceled') } });
    const { recurrenceId } = await owner.mutation(api.recurrences.create, { teamId: f.nova, title: 'Weekly', cadence: 'weekly', weekday: 1 });
    expect(await expectCode(owner.mutation(api.teams.update, { teamId: f.nova, wiki: 'only' }), 'invalid')).toMatchObject({ recurrences: 1 });
    await owner.mutation(api.recurrences.update, { recurrenceId, active: false });
    await owner.mutation(api.teams.update, { teamId: f.nova, wiki: 'only' });
    expect((await owner.query(api.meta.get, {})).teams.find((x) => x._id === f.nova)?.wiki).toBe('only');
    // Switching back to 'alongside issues' always works.
    await owner.mutation(api.teams.update, { teamId: f.nova, wiki: 'on' });
    await createOne(owner, f.nova);
  });

  test('MCP: "assigned" skips knowledge-only teams, create_issues and move_issues give a clear message', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    await createOne(owner, f.orb, { stateId: await stateId(t, f.orb, 'todo') });
    const { teamId: pol } = await owner.mutation(api.teams.create, { key: 'POL', name: 'Politics' });
    const old = await createOne(owner, pol, { stateId: await stateId(t, pol, 'done') });
    void old;
    await owner.mutation(api.teams.update, { teamId: pol, wiki: 'only' });
    const { key } = await owner.action(api.agents.create, { name: 'Claude Code' });
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await t.fetch('/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${key}`, 'MCP-Protocol-Version': '2025-11-25' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      return ((await response.json()) as { result: { isError?: boolean; content: { text: string }[]; structuredContent?: any } }).result;
    };
    const assigned = await call('list_issues', { filter: 'assigned' });
    expect(assigned.structuredContent.issues.every((i: { team: string }) => i.team !== 'POL')).toBe(true);
    const created = await call('create_issues', { requestId: 'only-0001', issues: [{ team: 'POL', title: 'No' }] });
    expect(created.isError).toBe(true);
    expect(created.content[0]!.text).toContain('knowledge only');
    const teams = await call('list_teams', {});
    expect(teams.structuredContent.teams.find((x: { key: string }) => x.key === 'POL')).toMatchObject({ wiki: 'only' });
  });
});
