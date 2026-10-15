import { describe, expect, test } from 'vitest';
import { App } from '../src/app/index.ts';
import { Auth } from '../src/auth.ts';
import type { IssueId } from '../src/types.ts';
import { callName, doc, fakeClient, flush, meta } from './helpers.ts';

// Board: columns from the team statuses, keyboard, moving cards, fixed order.

let n = 0;
async function setup(docs = Array.from({ length: 8 }, (_, i) => doc(i)), m = meta) {
  const client = fakeClient();
  const app = new App({ client: client as never, auth: new Auth({ devToken: 'x' }), debug: true, perf: false, cacheName: `board-${++n}` });
  app.start();
  await flush();
  client.push('meta:get', {}, m);
  client.push('meta:counter', {}, { maxSeq: 63 });
  client.push('issues:bucket', { bucket: 0 }, docs);
  await flush();
  return { client, app };
}
const calls = (client: ReturnType<typeof fakeClient>, name: string) => client.mutation.mock.calls.filter((c) => callName(c) === name);
const columns = (app: App) => app.main.board.get()!.columns.map((c) => `${c.label}:${c.ids.length}${c.collapsed ? '/closed' : ''}`);

describe('Board', () => {
  test('a column per team status; empty open columns stay, closed ones are collapsed; Ctrl B keeps the focus', async () => {
    const { app } = await setup();
    app.nav.goView({ kind: 'all', team: 'ACME' }, { order: 'created' });
    app.list.focus('i2' as IssueId);
    app.list.toggleLayout();
    // t1 (ACME): i0 todo, i2 in_progress, i4 todo, i6 in_progress
    expect(columns(app)).toEqual(['Backlog:0', 'Todo:2', 'In Progress:2', 'In Review:0', 'Done:0/closed', 'Canceled:0/closed', 'Duplicate:0/closed']);
    expect(app.list.focusId()).toBe('i2');
    app.list.toggleLayout();
    expect(app.main.board.get()).toBeNull();
    expect(app.list.focusId()).toBe('i2');
  });

  test('the board shows no triage issues and no triage column', async () => {
    const { app } = await setup([doc(0), doc(2, { status: 'triage' }), doc(4)]);
    app.nav.goView({ kind: 'all', team: 'ACME' }, { order: 'created' });
    expect(app.main.list.get().count).toBe(3);
    app.list.toggleLayout();
    expect(app.main.board.get()!.count).toBe(2);
    expect(columns(app).some((c) => c.startsWith('Triage'))).toBe(false);
    app.list.toggleLayout();
    expect(app.main.list.get().count).toBe(3);
  });

  test('across teams: statuses with the same name form one column; Active shows only unstarted and started', async () => {
    const { app } = await setup([doc(0), doc(1, { status: 'todo' }), doc(2), doc(3, { status: 'in_progress' }), doc(4, { status: 'backlog' })]);
    app.nav.goView({ kind: 'active', team: null }, { order: 'created' });
    app.list.toggleLayout();
    expect(columns(app)).toEqual(['Todo:2', 'In Progress:2', 'In Review:0']);
    expect(app.main.board.get()!.columns[0].ids.sort()).toEqual(['i0', 'i1']);
  });

  test('keyboard: J/K within the column, ←/→ between columns, Shift → moves the card (the team\'s stateId), undo', async () => {
    const { client, app } = await setup();
    app.nav.goView({ kind: 'all', team: 'ACME' }, { order: 'created' });
    app.list.toggleLayout();
    const todo = app.main.board.get()!.columns[1].ids;
    app.list.focus(todo[0]);
    app.list.moveFocus(1);
    expect(app.list.focusId()).toBe(todo[1]);
    app.list.moveFocus(1);
    expect(app.list.focusId()).toBe(todo[1]);
    app.list.moveColumn(1);
    expect(app.main.board.get()!.columns[2].ids).toContain(app.list.focusId());
    app.list.moveColumn(-1);
    app.list.moveCard(1);
    expect(calls(client, 'issues:update').at(-1)?.[1]).toMatchObject({ ids: [todo[1]], patch: { stateId: 't1:in_progress' } });
    app.edit.undo();
    await flush();
    expect(calls(client, 'issues:revert').at(-1)?.[1]).toEqual({ items: [{ id: todo[1], patch: { stateId: 't1:todo' }, expect: { stateId: 't1:in_progress' } }] });
  });

  test('fixed order: a column that is not allowed is refused (notice, no call); an allowed one works', async () => {
    const strict = { ...meta, teams: meta.teams.map((t) => (t._id === 't1' ? { ...t, workflow: { strict: true, exceptions: [] } } : t)) };
    const { client, app } = await setup(undefined, strict as typeof meta);
    app.nav.goView({ kind: 'all', team: 'ACME' }, { order: 'created' });
    app.list.toggleLayout();
    const board = app.main.board.get()!;
    const review = board.columns.find((c) => c.label === 'In Review')!;
    const progress = board.columns.find((c) => c.label === 'In Progress')!;
    // i0 is in Todo: In Review is two steps further.
    expect(app.list.dropProblem(['i0' as IssueId], review.key)).toMatch(/“Todo” → “In Review” is not allowed/);
    expect(app.list.dropOnColumn(['i0' as IssueId], review.key)).toBe(false);
    expect(calls(client, 'issues:update')).toHaveLength(0);
    expect(app.toasts.list.get().at(-1)?.text).toMatch(/not allowed/);
    expect(app.list.dropProblem(['i0' as IssueId], progress.key)).toBeNull();
    expect(app.list.dropOnColumn(['i0' as IssueId], progress.key)).toBe(true);
  });

  test('expand and collapse a column; a status change by an agent only moves the card', async () => {
    const docs = Array.from({ length: 8 }, (_, i) => doc(i));
    const { client, app } = await setup(docs);
    app.nav.goView({ kind: 'all', team: 'ACME' }, { order: 'created' });
    app.list.toggleLayout();
    const done = app.main.board.get()!.columns.find((c) => c.label === 'Done')!;
    app.list.toggleColumn(done.key);
    expect(app.main.board.get()!.columns.find((c) => c.label === 'Done')!.collapsed).toBe(false);
    const before = app.main.board.get()!;
    client.push('issues:bucket', { bucket: 0 }, docs.map((d) => (d.seq === 0 ? { ...d, status: 'done', stateId: 't1:done', updatedAt: 99 } : d)) as typeof docs);
    await flush();
    const after = app.main.board.get()!;
    expect(after.columns.find((c) => c.label === 'Done')!.ids).toEqual(['i0']);
    // An uninvolved column stays the same object (no re-render).
    expect(after.columns.find((c) => c.label === 'In Progress')).toBe(before.columns.find((c) => c.label === 'In Progress'));
  });
  test('columns by priority: five columns, a drop sets the priority, closed issues carry none', async () => {
    const docs = [doc(0, { priority: 1 }), doc(2, { priority: 3 }), doc(4, { priority: 0 }), doc(6, { status: 'done', priority: 0 })];
    const { client, app } = await setup(docs);
    app.nav.goView({ kind: 'all', team: 'ACME' }, { order: 'created' });
    app.list.toggleLayout();
    app.list.setDisplay({ boardColumns: 'priority' });
    expect(columns(app)).toEqual(['Urgent:1', 'High:0', 'Medium:1', 'Low:0', 'No priority:2']);
    const board = app.main.board.get()!;
    const key = (label: string) => board.columns.find((c) => c.label === label)!.key;
    // Dropping sets the priority, nothing else.
    expect(app.list.dropOnColumn(['i4' as IssueId], key('High'))).toBe(true);
    expect(calls(client, 'issues:update').at(-1)?.[1]).toMatchObject({ ids: ['i4'], patch: { priority: 2 } });
    // A closed issue cannot get a priority; "No priority" is fine.
    expect(app.list.dropProblem(['i6' as IssueId], key('High'))).toMatch(/closed/);
    expect(app.list.dropOnColumn(['i6' as IssueId], key('High'))).toBe(false);
    expect(app.list.dropProblem(['i6' as IssueId], key('No priority'))).toBeNull();
    // Back to the status columns; the choice is not kept in the default display.
    app.list.setDisplay({ boardColumns: undefined });
    expect(columns(app)[0]).toBe('Backlog:0');
    expect(app.main.view.get().display.boardColumns).toBeUndefined();
  });
});
