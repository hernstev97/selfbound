// Sprints, priority budget, identifier column, settings helpers.
import { ConvexError } from 'convex/values';
import { describe, expect, test } from 'vitest';
import { errorMessage } from '../src/app/toasts.ts';
import { actionById } from '../src/app/actions.ts';
import { App } from '../src/app/index.ts';
import { mcpCommand, precheckLogo, siteUrl } from '../src/app/admin.ts';
import { Auth } from '../src/auth.ts';
import { computeList, computeVisible, emptyFilters, keyWidth } from '../src/query.ts';
import { budgetCheck, budgetLabel, closeSummary, limitHits, overBudget, defaultSprintRange, dropNeighbors, nextMonday, priorityBudget, remainingLabel, sprintStats, sprintTotals, type SprintItem } from '../src/sprintlogic.ts';
import type { Issue, IssueId, SprintItemKind, ViewState } from '../src/types.ts';
import { VIEWS, planSprint } from '../src/views.ts';
import { callName, doc, fakeClient, flush, meta } from './helpers.ts';

const issue = (seq: number, patch: Partial<Issue> = {}) => ({ ...doc(seq), key: `ACME-${seq + 1}`, ...patch }) as Issue;

describe('date range', () => {
  test('next Monday and 14 days (Monday itself does not count)', () => {
    expect(nextMonday('2026-10-09')).toBe('2026-10-12'); // Friday
    expect(nextMonday('2026-10-12')).toBe('2026-10-19'); // Monday
    expect(nextMonday('2026-10-11')).toBe('2026-10-12'); // Sunday
    expect(defaultSprintRange('2026-10-09')).toEqual({ startDate: '2026-10-12', endDate: '2026-10-25', follows: null });
    // Sprint 5 runs Oct 19 – Nov 1: sprint 6 starts on Nov 2, not overlapping on Oct 12.
    const five = { name: 'Sprint 5', endDate: '2026-11-01' };
    expect(defaultSprintRange('2026-10-09', [five, { name: 'Sprint 4', endDate: '2026-10-18' }])).toEqual({ startDate: '2026-11-02', endDate: '2026-11-15', follows: five });
    // End in the past: the next Monday again.
    expect(defaultSprintRange('2026-10-09', [{ endDate: '2026-10-01' }])).toEqual({ startDate: '2026-10-12', endDate: '2026-10-25', follows: null });
  });
  test('remaining days', () => {
    expect(remainingLabel({ startDate: '2026-10-05', endDate: '2026-10-18', state: 'active' }, '2026-10-09')).toBe('10 days left');
    expect(remainingLabel({ startDate: '2026-10-05', endDate: '2026-10-09', state: 'active' }, '2026-10-09')).toBe('last day');
    expect(remainingLabel({ startDate: '2026-10-19', endDate: '2026-11-01', state: 'planning' }, '2026-10-09')).toBe('starts in 10 days');
  });
});

describe('points', () => {
  test('active sprint: done/total, added later, without estimate', () => {
    const issues = [issue(0, { estimate: 3, status: 'done' }), issue(1, { estimate: 5, status: 'todo' }), issue(2, { status: 'in_progress', estimate: undefined })];
    const kinds = new Map<IssueId, SprintItemKind>([['i2' as IssueId, 'late']]);
    expect(sprintTotals(issues, kinds)).toMatchObject({ issues: 3, done: 1, open: 2, points: 8, donePoints: 3, planned: 2, late: 1, lateShare: 33, unestimated: 1 });
  });
  test('completed sprint from entries: removed ones without outcome do not count', () => {
    const issues = new Map([issue(0, { estimate: 2 }), issue(1, { estimate: 3 }), issue(2, { estimate: 8 }), issue(3, { estimate: 1 })].map((i) => [i._id, i]));
    const item = (id: string, patch: Partial<SprintItem>): SprintItem => ({ _id: `e${id}`, issueId: id as IssueId, kind: 'planned', carriedFrom: null, addedAt: 0, removedAt: null, outcome: null, ...patch });
    const items = [item('i0', { outcome: 'done' }), item('i1', { outcome: 'next', removedAt: 5, kind: 'late' }), item('i2', { removedAt: 3 }), item('i3', { outcome: 'backlog', removedAt: 5, carriedFrom: 's3' })];
    expect(sprintStats(items, (id) => issues.get(id))).toEqual({ issues: 3, points: 6, donePoints: 2, late: 1, lateShare: 33, carried: 1 });
  });
});

describe('priority budget', () => {
  const all = [
    issue(0, { teamId: 't1' as never, priority: 2, status: 'todo' }),
    issue(1, { teamId: 't1' as never, priority: 2, status: 'backlog' }),
    issue(2, { teamId: 't1' as never, priority: 2, status: 'triage' }),
    issue(3, { teamId: 't1' as never, priority: 2, status: 'done' }),
    issue(4, { teamId: 't1' as never, priority: 3, status: 'todo' }),
    issue(5, { teamId: 't2' as never, priority: 1, status: 'todo' }),
    issue(6, { teamId: 't2' as never, priority: 3, status: 'todo' }),
  ];
  test('open urgent/high per team (done ones do not count)', () => {
    expect(priorityBudget(all).get('t1')).toEqual({ urgent: 0, high: 3 });
    expect(priorityBudget(all).get('t2')).toEqual({ urgent: 1, high: 0 });
  });
  test('configured limits: other numbers, no limit, hard ones marked', () => {
    const limits = { urgent: { max: 0, hard: true }, high: { max: null, hard: false } };
    expect(budgetCheck(all, ['i6' as IssueId], 1, limits)).toMatchObject([{ teamId: 't2', open: 2, budget: 0, hard: true }]);
    expect(budgetCheck(all, ['i4' as IssueId], 1, limits)).toMatchObject([{ teamId: 't1', open: 1, budget: 0, hard: true, previous: [] }]);
    expect(budgetCheck(all, ['i4' as IssueId, 'i6' as IssueId], 2, limits)).toEqual([]);
    expect(budgetLabel(priorityBudget(all).get('t1'), limits)).toBe('Urgent 0/0 · High 3');
    expect(overBudget(priorityBudget(all).get('t2'), limits)).toBe(true);
    expect(overBudget(priorityBudget(all).get('t1'), limits)).toBe(false);
    // Several teams at once: each counted on its own.
    const hits = limitHits(all, [{ id: 'new:0' as IssueId, teamId: 't1' }, { id: 'new:1' as IssueId, teamId: 't2' }], 2, { urgent: { max: 1, hard: false }, high: { max: 3, hard: true } });
    expect(hits).toMatchObject([{ teamId: 't1', open: 4, hard: true }]);
  });
  test('the 4th high or 2nd urgent triggers the notice, with the previous candidates', () => {
    const [hit] = budgetCheck(all, ['i4' as IssueId], 2);
    expect(hit).toMatchObject({ teamId: 't1', priority: 2, open: 4, budget: 3, changed: ['i4'] });
    expect(hit.previous.map((i) => i._id).sort()).toEqual(['i0', 'i1', 'i2']);
    expect(budgetCheck(all, ['i6' as IssueId], 1)).toHaveLength(1);
    // Within the budget, already set or done: no notice.
    expect(budgetCheck(all, ['i6' as IssueId], 2)).toEqual([]);
    expect(budgetCheck(all, ['i0' as IssueId], 2)).toEqual([]);
    expect(budgetCheck(all, ['i3' as IssueId], 2)).toEqual([]);
    expect(budgetCheck(all, ['i4' as IssueId], 3)).toEqual([]);
  });
});

describe('completion and dragging', () => {
  test('decisions count only open issues; done ones automatically', () => {
    const issues = [issue(0, { status: 'done', estimate: 3 }), issue(1, { status: 'todo' }), issue(2, { status: 'in_review' }), issue(3, { status: 'canceled' })];
    const s = closeSummary(issues, new Map([['i1' as IssueId, 'next' as const]]));
    expect(s).toMatchObject({ open: 2, decided: 1, missing: 1, done: 1, donePoints: 3, canceled: 1, counts: { next: 1, backlog: 0, canceled: 0 } });
  });
  test('insert position without the dragged issues', () => {
    const order = ['a', 'b', 'c', 'd'] as IssueId[];
    expect(dropNeighbors(order, ['d' as IssueId], 0)).toEqual({ afterId: 'a' });
    expect(dropNeighbors(order, ['a' as IssueId], 2)).toEqual({ beforeId: 'b', afterId: 'c' });
    expect(dropNeighbors(order, ['b' as IssueId], 4)).toEqual({ beforeId: 'd' });
    expect(dropNeighbors(order, ['b' as IssueId], 2)).toEqual({ beforeId: 'a', afterId: 'c' });
  });
});

describe('sprint planning views', () => {
  const view = (kind: ViewState['route']['kind']): ViewState => ({ route: { kind, team: null }, filters: emptyFilters(), quick: '', quickOpen: false, display: VIEWS[kind].display({ kind, team: null }) });
  const ctx = { teamId: null, activeSprintId: 's4', projectId: null, keep: new Set<IssueId>(), planSprintId: 's5', activeTeams: new Set(['t1', 't2']) };
  const all = [
    issue(0, { status: 'backlog', rank: 'c' }),
    issue(1, { status: 'todo', rank: 'a' }),
    issue(2, { status: 'triage', rank: 'b' }),
    issue(3, { status: 'done', rank: 'd' }),
    issue(4, { status: 'todo', sprintId: 's5' as never, rank: 'e' }),
    issue(5, { status: 'todo', teamId: 't3' as never, rank: 'f' }),
    issue(6, { status: 'in_progress', sprintId: 's4' as never }),
    issue(7, { status: 'done', sprintId: 's4' as never }),
  ];
  test('backlog: open, accepted, without sprint, active teams only, by rank', () => {
    expect(computeVisible(all, view('plan'), meta, ctx).map((i) => i._id)).toEqual(['i1', 'i0']);
    expect(computeVisible(all, view('planned'), meta, ctx).map((i) => i._id)).toEqual(['i4']);
    expect(computeVisible(all, view('close'), meta, ctx).map((i) => i._id)).toEqual(['i6']);
  });
  test('sprint view groups by planned / added later', () => {
    const v = view('sprint');
    expect(v.display.grouping).toBe('scope');
    const visible = computeVisible(all, v, meta, ctx);
    const list = computeList(visible, v, meta, new Set(), true, { kinds: new Map([['i7' as IssueId, 'late']]) });
    expect(list.rows.map((r) => r.key)).toEqual(['g:scope:planned', 'i6', 'g:scope:late', 'i7']);
  });
  test('planning finds the sprint by number, else the next one in planning', () => {
    expect(planSprint({ kind: 'plan', team: null, sprint: null }, meta)?._id).toBe('s5');
    expect(planSprint({ kind: 'plan', team: null, sprint: '4' }, meta)?._id).toBe('s4');
    expect(planSprint({ kind: 'plan', team: null, sprint: '9' }, meta)).toBeNull();
  });
});

describe('identifier column', () => {
  test('one pattern per team key with the longest number (tabular digits)', () => {
    const issues = [issue(0, { key: 'NOVA-1396' }), issue(1, { key: 'NOVA-7' }), issue(2, { key: 'PX-20' }), issue(3, { key: 'PX-1' }), issue(4, { key: 'ACME-…' })];
    expect(keyWidth(issues)).toEqual({ keyChars: 9, keySamples: ['ACME-0', 'NOVA-0000', 'PX-00'] });
  });
});

describe('app: planning and completion', () => {
  async function setup() {
    const client = fakeClient();
    const app = new App({ client: client as never, auth: new Auth({ devToken: 'x' }), debug: true, perf: false, cacheName: `sprint-${Math.random()}` });
    app.start();
    await flush();
    client.push('meta:get', {}, meta);
    client.push('meta:counter', {}, { maxSeq: 5 });
    client.push('issues:bucket', { bucket: 0 }, [
      doc(0, { status: 'backlog' }),
      doc(1, { status: 'todo' }),
      doc(2, { status: 'todo', sprintId: 's5' as never }),
      doc(3, { status: 'todo', sprintId: 's4' as never }),
      doc(4, { status: 'in_progress', sprintId: 's4' as never }),
      doc(5, { status: 'done', sprintId: 's4' as never }),
    ]);
    await flush();
    await app.loadSprints();
    return { client, app };
  }
  const calls = (client: ReturnType<typeof fakeClient>, name: string) => client.mutation.mock.calls.filter((c) => callName(c) === name);

  test('→ plans the selection on the left, ← returns it on the right, Tab switches the column', async () => {
    const { client, app } = await setup();
    app.nav.goView({ kind: 'plan', team: null, sprint: null });
    await flush();
    expect(app.main.order()).toEqual(['i0', 'i1']);
    expect(app.side.order()).toEqual(['i2']);
    expect(app.list).toBe(app.main);
    app.list.focus('i1' as IssueId);
    app.sprints.shift('in');
    expect(calls(client, 'issues:update').at(-1)![1]).toMatchObject({ ids: ['i1'], patch: { sprintId: 's5' } });
    app.setPane('side');
    expect(app.list).toBe(app.side);
    app.side.focus('i2' as IssueId);
    app.sprints.shift('out');
    expect(calls(client, 'issues:update').at(-1)![1]).toMatchObject({ ids: ['i2'], patch: { sprintId: null } });
    // Elsewhere: the second list rests, the keyboard acts on the main list again.
    app.nav.goView({ kind: 'all', team: null });
    expect(app.side.idle).toBe(true);
    expect(app.list).toBe(app.main);
  });

  test('completion: 1/2/3 on focus or selection, completing sends all decisions', async () => {
    const { client, app } = await setup();
    app.nav.goView({ kind: 'close', team: null });
    await flush();
    expect(app.main.order()).toEqual(['i4', 'i3']);
    expect(app.sprints.closing.get()?.summary).toMatchObject({ open: 2, missing: 2, done: 1 });
    app.sprints.decide('next');
    expect(app.main.rows.get('i4' as IssueId).get()?.decision).toEqual({ outcome: 'next', label: 'Next sprint' });
    expect(app.main.focusId()).toBe('i3');
    app.sprints.decide('backlog');
    expect(app.sprints.closing.get()?.summary).toMatchObject({ missing: 0, counts: { next: 1, backlog: 1, canceled: 0 } });
    client.mutation.mockResolvedValueOnce({ sprintId: 's4', nextSprintId: 's5', counts: { done: 1, next: 1, backlog: 1, canceled: 0 } });
    await app.sprints.close('');
    const close = calls(client, 'sprints:close').at(-1)![1] as { decisions: unknown[]; nextSprintId: string };
    expect(close.nextSprintId).toBe('s5');
    expect(close.decisions).toEqual(expect.arrayContaining([{ issueId: 'i4', outcome: 'next' }, { issueId: 'i3', outcome: 'backlog' }]));
  });

  test('the active sprint can be edited: dates and name go through sprints.update, capacity is parsed', async () => {
    const { client, app } = await setup();
    app.nav.goView({ kind: 'sprint', team: null });
    await flush();
    app.sprints.update('s4' as never, { name: 'Renamed', endDate: '2026-10-23' });
    expect(calls(client, 'sprints:update').at(-1)![1]).toEqual({ sprintId: 's4', name: 'Renamed', endDate: '2026-10-23' });
    app.sprints.setCapacity('s4' as never, '12,5');
    expect(calls(client, 'sprints:update').at(-1)![1]).toEqual({ sprintId: 's4', capacity: 12.5 });
    client.push('meta:get', {}, { ...meta, sprints: meta.sprints.map((sp) => (sp._id === 's4' ? { ...sp, capacity: 10 } : sp)) });
    await flush();
    app.sprints.setCapacity('s4' as never, '');
    expect(calls(client, 'sprints:update').at(-1)![1]).toEqual({ sprintId: 's4', capacity: null });
    const before = calls(client, 'sprints:update').length;
    app.sprints.setCapacity('s4' as never, '-3');
    app.sprints.setCapacity('s4' as never, 'abc');
    expect(calls(client, 'sprints:update')).toHaveLength(before);
  });

  test('"Edit sprint" opens the edit form on the sprint page and closes it when leaving', async () => {
    const { app } = await setup();
    app.nav.goView({ kind: 'all', team: null });
    await flush();
    actionById('sprint.edit')!.run(app);
    await flush();
    expect(app.sprints.editing.get()).toBe(true);
    expect(app.nav.page.get()).toMatchObject({ name: 'view', view: { kind: 'sprint' } });
    app.nav.goView({ kind: 'all', team: null });
    await flush();
    expect(app.sprints.editing.get()).toBe(false);
  });

  test('priority budget: notice above the budget, "Downgrade" opens the candidates', async () => {
    const { client, app } = await setup();
    const highs = [0, 1, 2].map((n) => doc(10 + n, { teamId: 't1' as never, priority: 2, status: 'todo' }));
    client.push('meta:counter', {}, { maxSeq: 64 });
    client.push('issues:bucket', { bucket: 1 }, [...highs.map((h) => ({ ...h, bucket: 1, seq: 64 + h.seq })), { ...doc(70, { teamId: 't1' as never, priority: 4, status: 'todo' }), bucket: 1 }]);
    await flush();
    app.edit.patch(['i70' as IssueId], { priority: 2 });
    const toast = app.toasts.list.get().find((t) => t.text.includes('High open'));
    // i2 from the base data is also high in Acme.
    expect(toast?.text).toBe('Acme: now 5 × High open (limit 3)');
    expect(toast?.detail).toContain('So far:');
    toast!.action!.run();
    expect(app.palette.state.get()?.kind).toBe('downgrade');
    expect(app.palette.state.get()?.items.map((i) => i.id)).toEqual(expect.arrayContaining(['dg:i10', 'dg:i11', 'dg:i12']));
  });

  test('hard priority limit: nothing is sent, an error toast says what to lower', async () => {
    const { client, app } = await setup();
    client.push('meta:get', {}, { ...meta, priorityLimits: { urgent: { max: 1, hard: true }, high: { max: null, hard: false } } });
    await flush();
    // i1 is the one open urgent issue of Pixelwerk (t2); i3 is in Pixelwerk too.
    app.edit.patch(['i3' as IssueId], { priority: 1 });
    expect(calls(client, 'issues:update')).toHaveLength(0);
    expect(app.store.get('i3' as IssueId)?.priority).toBe(3);
    const toast = app.toasts.list.get().find((t) => t.kind === 'error');
    expect(toast?.text).toBe('Pixelwerk: at most 1 × Urgent open');
    expect(toast?.detail).toBe('Lower one of these first: PX-2 Issue number 1');
    toast!.action!.run();
    expect(app.palette.state.get()?.kind).toBe('downgrade');
    app.palette.close();
    // The priority menu names the full limit; the issue that already is urgent may stay so.
    app.list.focus('i3' as IssueId);
    app.palette.open('priority');
    expect(app.palette.state.get()?.items.find((i) => i.id === 'p:1')?.detail).toBe('Limit reached');
    app.palette.close();
    app.edit.patch(['i1' as IssueId], { title: 'Still urgent' });
    expect(calls(client, 'issues:update')).toHaveLength(1);
    // Acme (t1) has room for one urgent issue.
    app.edit.patch(['i0' as IssueId], { priority: 1 });
    expect(calls(client, 'issues:update')).toHaveLength(2);
    // Creating, moving and restoring into the full team are blocked as well.
    expect(app.edit.create([{ teamId: 't2' as never, title: 'New', priority: 1 }])).toEqual([]);
    expect(calls(client, 'issues:create')).toHaveLength(0);
    app.edit.moveTeam(['i0' as IssueId], 't2');
    expect(calls(client, 'issues:moveTeam')).toHaveLength(0);
    // No limit for high: no hint at all.
    const before = app.toasts.list.get().length;
    app.edit.patch(['i4' as IssueId], { priority: 2 });
    expect(app.toasts.list.get()).toHaveLength(before);
  });

  test('hard priority limit in the create dialog: it stays open with the reason', async () => {
    const { client, app } = await setup();
    client.push('meta:get', {}, { ...meta, priorityLimits: { urgent: { max: 1, hard: true }, high: { max: 3, hard: false } } });
    await flush();
    app.create.open();
    app.create.update({ title: 'Another fire', teamId: 't2', priority: 1, status: 'todo' });
    app.create.submit(false);
    expect(app.create.isOpen()).toBe(true);
    expect(app.create.state.get().error).toBe('Pixelwerk: at most 1 × Urgent open. Lower one of these first: PX-2 Issue number 1');
    expect(calls(client, 'issues:create')).toHaveLength(0);
    // Created as done it carries no priority (backend), so nothing is blocked.
    app.create.update({ status: 'done' });
    app.create.submit(false);
    expect(app.create.isOpen()).toBe(false);
    expect(calls(client, 'issues:create')).toHaveLength(1);
  });

  test('"Downgrade …" skips High when its hard limit is full too', async () => {
    const { client, app } = await setup();
    client.push('meta:get', {}, { ...meta, priorityLimits: { urgent: { max: 1, hard: true }, high: { max: 0, hard: true } } });
    await flush();
    app.palette.openDowngrade('t2', 1);
    expect(app.palette.state.get()?.items.find((i) => i.id === 'dg:i1')?.detail).toBe('PX-2 → Medium');
  });
});

describe('priority limit errors from the server', () => {
  test('are told in the UI language with what to lower', () => {
    const full = new ConvexError({ code: 'priority_limit', message: 'Team PX already has …', team: 'PX', priority: 1, limit: 1, issues: ['PX-2'] });
    expect(errorMessage(full)).toBe('PX is at its limit of 1 × Urgent. Lower one of these first: PX-2');
    const zero = new ConvexError({ code: 'priority_limit', message: '…', team: 'PX', priority: 2, limit: 0, issues: [] });
    expect(errorMessage(zero)).toBe('PX allows at most 0 × High. Change the limit under Settings → Priorities.');
  });
});

describe('settings', () => {
  test('site URL for MCP from the Convex URL', () => {
    expect(siteUrl('http://127.0.0.1:13500')).toBe('http://127.0.0.1:13501');
    expect(siteUrl('https://happy-otter-123.convex.cloud')).toBe('https://happy-otter-123.convex.site');
    expect(siteUrl('http://127.0.0.1:13500', 'https://x.example/')).toBe('https://x.example');
    expect(mcpCommand('http://127.0.0.1:13501', 'selfbound_abc')).toBe('claude mcp add --transport http selfbound http://127.0.0.1:13501/mcp --header "Authorization: Bearer selfbound_abc"');
  });
  test('logo precheck in the browser', () => {
    expect(precheckLogo({ name: 'a.svg', type: 'image/svg+xml', size: 100 })).toBeNull();
    expect(precheckLogo({ name: 'a.png', type: '', size: 100 })).toBeNull();
    expect(precheckLogo({ name: 'a.jpg', type: 'image/jpeg', size: 100 })).toBe('Only SVG and PNG are allowed.');
    expect(precheckLogo({ name: 'a.png', type: 'image/png', size: 300 * 1024 })).toContain('too large');
  });
});
