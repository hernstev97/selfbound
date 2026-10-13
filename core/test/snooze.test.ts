import { describe, expect, test } from 'vitest';
import { App } from '../src/app/index.ts';
import { ACTIONS, KEYMAP, actionById } from '../src/app/actions.ts';
import { Auth } from '../src/auth.ts';
import { addDays, today } from '../src/format.ts';
import { emptyFilters } from '../src/query.ts';
import { parsePath, pagePath, readLocation, writeLocation } from '../src/route.ts';
import type { IssueId } from '../src/types.ts';
import { callName, doc, fakeClient, flush, meta } from './helpers.ts';

// Snooze: hidden from the lists, own view, picker with quick choices, undo, counts.

let n = 0;
async function setup(maxSeq = 63) {
  const client = fakeClient();
  const app = new App({ client: client as never, auth: new Auth({ devToken: 'x' }), debug: true, perf: false, cacheName: `snooze-${++n}` });
  app.start();
  await flush();
  client.push('meta:get', {}, meta);
  client.push('meta:counter', {}, { maxSeq });
  client.push('agents:list', {}, []);
  return { client, app };
}

const calls = (client: ReturnType<typeof fakeClient>, name: string) => client.mutation.mock.calls.filter((c) => callName(c) === name);
const tomorrow = () => addDays(today(), 1);
const visible = (app: App) => app.main.list.get().rows.flatMap((r) => (r.kind === 'issue' ? [r.id as string] : []));

describe('snoozed issues in the lists', () => {
  test('hidden everywhere except the Snoozed view, the trash and the filter; counted separately', async () => {
    const { client, app } = await setup();
    const until = addDays(today(), 3);
    client.push('issues:bucket', { bucket: 0 }, [
      doc(0, { status: 'todo' }),
      doc(2, { status: 'todo', snoozedUntil: until }),
      doc(4, { status: 'triage', snoozedUntil: until }),
      doc(6, { status: 'todo', reviewedAt: undefined, snoozedUntil: until }),
      doc(8, { status: 'todo', reviewedAt: undefined }),
    ]);
    await flush();

    app.nav.goView({ kind: 'all', team: null });
    expect(visible(app).sort()).toEqual(['i0', 'i8']);
    app.nav.goView({ kind: 'active', team: null });
    expect(visible(app).sort()).toEqual(['i0', 'i8']);
    // Inbox: only the unsnoozed entry; the sidebar counts it, not the snoozed ones.
    app.nav.goView({ kind: 'inbox', team: null });
    expect(visible(app)).toEqual(['i8']);
    expect(app.sidebar.get()).toMatchObject({ inbox: 1, triage: 0, snoozed: 3 });

    app.nav.goView({ kind: 'snoozed', team: null });
    expect(visible(app).sort()).toEqual(['i2', 'i4', 'i6']);
    expect(app.main.view.get().display.ordering).toBe('snoozed');

    // "Include snoozed" brings them back into a normal list.
    app.nav.goView({ kind: 'all', team: null });
    app.main.toggleSnoozed();
    expect(visible(app).sort()).toEqual(['i0', 'i2', 'i4', 'i6', 'i8']);
    expect(app.main.header.get().chips.map((c) => c.field)).toContain('snoozed');
  });

  test('snoozed sorts by day; the card counts of the team leave out snoozed issues', async () => {
    const { client, app } = await setup();
    client.push('issues:bucket', { bucket: 0 }, [
      doc(0, { teamId: 't1' as never, status: 'todo', snoozedUntil: addDays(today(), 9) }),
      doc(2, { teamId: 't1' as never, status: 'todo', snoozedUntil: addDays(today(), 2) }),
      doc(4, { teamId: 't1' as never, status: 'in_progress' }),
    ]);
    await flush();
    app.nav.goView({ kind: 'snoozed', team: null });
    expect(visible(app)).toEqual(['i2', 'i0']);
    app.updateTeamStats();
    expect(app.teamStats.get().ACME).toMatchObject({ todo: 0, started: 1 });
  });

  test('address /snoozed, team address and the URL parameter of the filter', () => {
    expect(parsePath('/snoozed')).toEqual({ name: 'view', view: { kind: 'snoozed', team: null } });
    expect(parsePath('/team/ACME/snoozed')).toEqual({ name: 'view', view: { kind: 'snoozed', team: 'ACME' } });
    expect(pagePath({ name: 'view', view: { kind: 'snoozed', team: 'ACME' } })).toBe('/team/ACME/snoozed');
    const url = writeLocation(new URL('http://x/'), { page: { name: 'view', view: { kind: 'all', team: null } }, filters: { ...emptyFilters(), snoozed: true }, quick: '', group: null, order: 'snoozed' });
    expect(url.search).toBe('?snoozed=1&order=snoozed');
    expect(readLocation(url).filters.snoozed).toBe(true);
  });
});

describe('snoozing', () => {
  test('H opens the picker; Tomorrow snoozes the selection in one call, with a notice and undo', async () => {
    const { client, app } = await setup();
    client.push('issues:bucket', { bucket: 0 }, [doc(0, { status: 'todo' }), doc(2, { status: 'todo' }), doc(4, { status: 'todo' })]);
    await flush();
    app.nav.goView({ kind: 'all', team: null });
    app.list.selectAll();
    expect(KEYMAP.get('h')?.map((a) => a.id)).toEqual(['issue.snooze']);
    actionById('issue.snooze')!.run(app);
    const state = app.palette.state.get()!;
    expect(state).toMatchObject({ kind: 'snooze', targetLabel: '3 issues' });
    // The calendar is part of this picker, so no "Pick a date …" item.
    expect(state.items.map((i) => i.label)).toEqual(['Tomorrow', 'Next week', 'In two weeks', 'In a month']);
    expect(state.calendar).not.toBeNull();
    app.palette.choose(0);

    expect(calls(client, 'issues:update')).toHaveLength(1);
    const update = calls(client, 'issues:update')[0][1] as { ids: string[]; patch: unknown };
    expect([...update.ids].sort()).toEqual(['i0', 'i2', 'i4']);
    expect(update.patch).toEqual({ snoozedUntil: tomorrow() });
    // The server's answer arrives: the issues are gone from the list.
    client.push('issues:bucket', { bucket: 0 }, [0, 2, 4].map((i) => doc(i, { status: 'todo', snoozedUntil: tomorrow() })));
    await flush();
    expect(visible(app)).toEqual([]);
    expect(app.toasts.list.get().at(-1)).toMatchObject({ text: expect.stringMatching(/^3 issues snoozed until /), action: { label: 'Undo' } });

    app.edit.undo();
    await flush();
    const items = (calls(client, 'issues:revert')[0][1] as { items: { id: string }[] }).items;
    expect([...items].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      ['i0', 'i2', 'i4'].map((id) => ({ id, patch: { snoozedUntil: null }, expect: { snoozedUntil: tomorrow() } })),
    );
    client.push('issues:bucket', { bucket: 0 }, [0, 2, 4].map((i) => doc(i, { status: 'todo' })));
    await flush();
    expect(visible(app).sort()).toEqual(['i0', 'i2', 'i4']);
  });

  test('typed days: only after today; the calendar ignores today and the past', async () => {
    const { client, app } = await setup();
    client.push('issues:bucket', { bucket: 0 }, [doc(0, { status: 'todo' })]);
    await flush();
    app.nav.goView({ kind: 'all', team: null });
    app.palette.open('snooze', { target: { kind: 'issues', ids: ['i0' as IssueId] } });
    app.palette.setQuery('today');
    expect(app.palette.state.get()!.items.some((i) => i.id.startsWith('snooze:'))).toBe(false);
    app.palette.pickDay(today());
    expect(app.palette.state.get()).not.toBeNull();
    expect(calls(client, 'issues:update')).toHaveLength(0);

    app.palette.setQuery('+3');
    const first = app.palette.state.get()!.items[0];
    expect(first.id).toBe(`snooze:${addDays(today(), 3)}`);
    app.palette.choose(0);
    expect(calls(client, 'issues:update')[0][1]).toMatchObject({ ids: ['i0'], patch: { snoozedUntil: addDays(today(), 3) } });
  });

  test('Unsnooze is offered only for snoozed issues; closed issues cannot be snoozed', async () => {
    const { client, app } = await setup();
    client.push('issues:bucket', { bucket: 0 }, [doc(0, { status: 'todo' }), doc(2, { status: 'todo', snoozedUntil: tomorrow() }), doc(3, { status: 'done' })]);
    await flush();
    app.nav.goView({ kind: 'all', team: null });
    app.main.toggleSnoozed();
    const when = (id: string) => actionById(id)!.when!(app);

    app.list.select(['i0' as IssueId]);
    expect(when('issue.snooze')).toBe(true);
    expect(when('issue.unsnooze')).toBe(false);
    app.list.select(['i2' as IssueId]);
    expect(when('issue.unsnooze')).toBe(true);
    app.list.select(['i3' as IssueId]);
    expect(when('issue.snooze')).toBe(false);

    app.list.select(['i2' as IssueId]);
    actionById('issue.unsnooze')!.run(app);
    expect(calls(client, 'issues:update')[0][1]).toMatchObject({ ids: ['i2'], patch: { snoozedUntil: null } });
    expect(app.toasts.list.get().at(-1)).toMatchObject({ text: 'ACME-3 is no longer snoozed' });
  });

  test('done ends the snooze; undo and redo move both together', async () => {
    const { client, app } = await setup();
    const until = addDays(today(), 5);
    client.push('issues:bucket', { bucket: 0 }, [doc(0, { status: 'todo', snoozedUntil: until })]);
    await flush();
    app.edit.patch(['i0' as IssueId], { status: 'done' });
    expect(calls(client, 'issues:update')[0][1]).toMatchObject({ ids: ['i0'], patch: { stateId: 't1:done' } });
    app.edit.undo();
    await flush();
    expect(calls(client, 'issues:revert')[0][1]).toEqual({
      items: [{ id: 'i0', patch: { stateId: 't1:todo', snoozedUntil: until }, expect: { stateId: 't1:done', snoozedUntil: null } }],
    });
  });

  test('the context menu has a Snooze submenu with the quick choices and the date picker', async () => {
    const { client, app } = await setup();
    client.push('issues:bucket', { bucket: 0 }, [doc(0, { status: 'todo' })]);
    await flush();
    app.nav.goView({ kind: 'all', team: null });
    app.menu.open('i0' as IssueId, 10, 10);
    const items = app.menu.state.get()!.items;
    const at = items.findIndex((i) => i.id === 'issue.snooze');
    expect(items[at]).toMatchObject({ submenu: true, shortcut: 'H' });
    expect(items.some((i) => i.id === 'issue.unsnooze')).toBe(false);
    app.menu.hover(at);
    expect(app.menu.state.get()!.sub!.items.map((i) => i.label)).toEqual(['Tomorrow', 'Next week', 'In two weeks', 'In a month', 'Pick a date …']);
    app.menu.chooseSub(0);
    expect(calls(client, 'issues:update')[0][1]).toMatchObject({ ids: ['i0'], patch: { snoozedUntil: tomorrow() } });
  });

  test('the command menu finds "Snooze: Tomorrow" and "Go to: Snoozed"', async () => {
    const { client, app } = await setup();
    client.push('issues:bucket', { bucket: 0 }, [doc(0, { status: 'todo' })]);
    await flush();
    app.nav.goView({ kind: 'all', team: null });
    app.list.selectAll();
    app.palette.open('command');
    app.palette.setQuery('snooze tom');
    expect(app.palette.state.get()!.items[0].label).toBe('Snooze: Tomorrow');
    app.palette.setQuery('go to snoozed');
    expect(app.palette.state.get()!.items[0].label).toBe('Go to: Snoozed');
    expect(ACTIONS.find((a) => a.id === 'go.snoozed')?.keys).toEqual(['g h']);
  });
});
