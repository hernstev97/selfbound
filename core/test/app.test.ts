import { describe, expect, test, vi } from 'vitest';
import { ConvexError } from 'convex/values';
import { App } from '../src/app/index.ts';
import { ACTIONS, KEYMAP, actionById } from '../src/app/actions.ts';
import { Auth } from '../src/auth.ts';
import { OWNER_KIND, type IssueId } from '../src/types.ts';
import { callName, doc, entry, fakeClient, flush, meta } from './helpers.ts';

let n = 0;
async function setup(maxSeq = 127) {
  const client = fakeClient();
  const app = new App({ client: client as never, auth: new Auth({ devToken: 'x' }), debug: true, perf: false, cacheName: `app-${++n}` });
  app.start();
  await flush();
  client.push('meta:get', {}, meta);
  client.push('meta:counter', {}, { maxSeq });
  client.push('agents:list', {}, [{ _id: 'a1', name: 'Claude Code' }]);
  return { client, app };
}

const calls = (client: ReturnType<typeof fakeClient>, name: string) => client.mutation.mock.calls.filter((c) => callName(c) === name);

describe('focus while loading', () => {
  test('automatic focus stays at the top, moved focus stays on the issue', async () => {
    const { client, app } = await setup(127);
    app.nav.goView({ kind: 'all', team: null }, { group: 'none', order: 'created' });
    // First only the later bucket arrives …
    client.push('issues:bucket', { bucket: 1 }, Array.from({ length: 64 }, (_, i) => doc(64 + i, { createdAt: 64 + i })));
    await flush();
    expect(app.list.focusId()).toBe(app.list.order()[0]);
    // … then the earlier one with newer issues that sort in at the top.
    client.push('issues:bucket', { bucket: 0 }, Array.from({ length: 64 }, (_, i) => doc(i, { createdAt: 1000 + i })));
    await flush();
    expect(app.list.order()[0]).toBe('i63');
    expect(app.list.focusId()).toBe('i63');
    // Now the user moves the focus: it stays on the issue, even when new ones arrive at the top.
    app.list.moveFocus(1);
    const moved = app.list.focusId();
    client.push('meta:counter', {}, { maxSeq: 128 });
    client.push('issues:bucket', { bucket: 2 }, [doc(128, { createdAt: 5000 })]);
    await flush();
    expect(app.list.order()[0]).toBe('i128');
    expect(app.list.focusId()).toBe(moved);
  });
});

describe('changes, undo, conflict', () => {
  test('change status and undo with compare-and-set', async () => {
    const { client, app } = await setup(3);
    client.push('issues:bucket', { bucket: 0 }, [doc(0), doc(1), doc(2)]);
    await flush();
    // A status type becomes the team's status, undo brings back exactly the old status.
    app.edit.patch(['i0' as IssueId], { status: 'done' });
    expect(calls(client, 'issues:update')[0][1]).toMatchObject({ ids: ['i0'], patch: { stateId: 't1:done' } });
    app.edit.undo();
    await flush();
    expect(calls(client, 'issues:revert')[0][1]).toEqual({ items: [{ id: 'i0', patch: { stateId: 't1:todo' }, expect: { stateId: 't1:done' } }] });
    app.edit.redo();
    await flush();
    expect(calls(client, 'issues:revert')[1][1]).toEqual({ items: [{ id: 'i0', patch: { stateId: 't1:done' }, expect: { stateId: 't1:todo' } }] });
  });

  test('done clears the priority; undo and redo move both together', async () => {
    const { client, app } = await setup(3);
    client.push('issues:bucket', { bucket: 0 }, [doc(0, { priority: 2 }), doc(1, { priority: 3 }), doc(2, { priority: 0 })]);
    await flush();
    app.edit.patch(['i0', 'i2'] as IssueId[], { status: 'done' });
    // The server gets the cleared priority explicitly (it belongs to the undo step).
    expect(calls(client, 'issues:update').map((c) => c[1])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ids: ['i0'], patch: { stateId: 't1:done', priority: 0 } }),
        expect.objectContaining({ ids: ['i2'], patch: { stateId: 't1:done' } }),
      ]),
    );
    app.edit.undo();
    await flush();
    expect(calls(client, 'issues:revert')[0][1]).toEqual({
      items: [
        { id: 'i0', patch: { stateId: 't1:todo', priority: 2 }, expect: { stateId: 't1:done', priority: 0 } },
        { id: 'i2', patch: { stateId: 't1:in_progress' }, expect: { stateId: 't1:done' } },
      ],
    });
    app.edit.redo();
    await flush();
    expect(calls(client, 'issues:revert')[1][1]).toEqual({
      items: [
        { id: 'i0', patch: { stateId: 't1:done', priority: 0 }, expect: { stateId: 't1:todo', priority: 2 } },
        { id: 'i2', patch: { stateId: 't1:done' }, expect: { stateId: 't1:in_progress' } },
      ],
    });
  });

  test('a bulk change shows a notice with undo, a single change does not', async () => {
    const { client, app } = await setup(3);
    client.push('issues:bucket', { bucket: 0 }, [doc(0), doc(1), doc(2)]);
    await flush();
    app.edit.patch(['i0' as IssueId], { priority: 4 });
    expect(app.toasts.list.get()).toHaveLength(0);
    app.edit.patch(['i0', 'i1', 'i2'] as IssueId[], { priority: 3 });
    expect(app.toasts.list.get().at(-1)).toMatchObject({ text: '3 issues changed', action: { label: 'Undo' } });
  });

  test('an undo conflict names who changed it in the meantime', async () => {
    const { client, app } = await setup(3);
    client.push('issues:bucket', { bucket: 0 }, [doc(0), doc(1), doc(2)]);
    await flush();
    app.edit.patch(['i1' as IssueId], { priority: 3 });
    client.mutation.mockImplementationOnce(async () => {
      throw new ConvexError({ code: 'conflict', message: 'PX-2 was changed in the meantime (priority).', issueId: 'i1', identifier: 'PX-2', field: 'priority' });
    });
    client.query.mockImplementationOnce(async () => ({ history: [{ field: 'priority', actor: { kind: 'agent', agentId: 'a1' }, at: 5 }] }));
    app.edit.undo();
    await flush();
    await flush();
    const toast = app.toasts.list.get().at(-1)!;
    expect(toast.kind).toBe('error');
    expect(toast.text).toContain('PX-2 was changed by Claude Code in the meantime');
  });

  test('server rejects: notice with the reason and "Try again", no undo entry', async () => {
    const { client, app } = await setup(3);
    client.push('issues:bucket', { bucket: 0 }, [doc(0)]);
    await flush();
    client.mutation.mockImplementationOnce(async () => {
      throw new ConvexError({ code: 'rejected', message: 'Test switch: the server rejects changes.' });
    });
    app.edit.patch(['i0' as IssueId], { status: 'canceled' });
    await flush();
    const toast = app.toasts.list.get().at(-1)!;
    expect(toast).toMatchObject({ kind: 'error', detail: 'Test switch: the server rejects changes.', action: { label: 'Try again' } });
    expect(app.edit.undoDepth).toBe(0);
    toast.action!.run();
    expect(calls(client, 'issues:update')).toHaveLength(2);
  });

  test('create, then undo: moves the real issue to the trash', async () => {
    const { client, app } = await setup(0);
    client.push('issues:bucket', { bucket: 0 }, [doc(0)]);
    await flush();
    client.mutation.mockImplementationOnce(async () => ({ issues: [{ id: 'i1', identifier: 'PX-2' }], warnings: [] }));
    const [tmp] = app.edit.create([{ teamId: 't2' as never, title: 'New' }]);
    expect(app.store.get(tmp)?.pending).toBe(true);
    await flush();
    client.push('meta:counter', {}, { maxSeq: 1 });
    client.push('issues:bucket', { bucket: 0 }, [doc(0), doc(1, { title: 'New' })]);
    await flush();
    await flush();
    app.edit.undo();
    await flush();
    expect(calls(client, 'issues:remove')[0][1]).toEqual({ ids: ['i1'] });
  });

  test('delete and undo restores', async () => {
    const { client, app } = await setup(3);
    client.push('issues:bucket', { bucket: 0 }, [doc(0)]);
    await flush();
    app.edit.remove(['i0' as IssueId]);
    expect(app.toasts.list.get().at(-1)?.text).toContain('trash');
    app.edit.undo();
    await flush();
    expect(calls(client, 'issues:restore')[0][1]).toEqual({ ids: ['i0'] });
  });

  test('change team: new identifier in the notice, undo moves it back', async () => {
    const { client, app } = await setup(3);
    client.push('issues:bucket', { bucket: 0 }, [doc(0), doc(1)]);
    await flush();
    client.mutation.mockImplementationOnce(async () => ({ moved: [{ id: 'i0', identifier: 'PX-9', previous: 'ACME-1' }] }));
    app.edit.moveTeam(['i0' as IssueId], 't2');
    await flush();
    const [, args, opts] = calls(client, 'issues:moveTeam')[0] as unknown as [unknown, { ids: string[]; teamId: string }, { optimisticUpdate: (s: unknown) => void }];
    expect(args).toEqual({ ids: ['i0'], teamId: 't2' });
    let written: { teamId: string; number: number }[] = [];
    opts.optimisticUpdate({ getQuery: () => [doc(0)], setQuery: (_f: unknown, _a: unknown, v: typeof written) => (written = v) });
    expect(written[0]).toMatchObject({ teamId: 't2', number: 0 });
    await flush();
    expect(app.toasts.list.get().at(-1)?.text).toBe('ACME-1 is now PX-9');
    app.edit.undo();
    await flush();
    expect(calls(client, 'issues:moveTeam')[1][1]).toEqual({ ids: ['i0'], teamId: 't1' });
  });

  test('a label in an exclusive group replaces the old one', async () => {
    const { client, app } = await setup(3);
    client.push('issues:bucket', { bucket: 0 }, [doc(0, { labelIds: ['l1', 'l3'] as never })]);
    await flush();
    app.edit.toggleLabel(['i0' as IssueId], 'l2' as never);
    expect((calls(client, 'issues:update')[0][1] as { patch: { labelIds: string[] } }).patch.labelIds.sort()).toEqual(['l2', 'l3']);
  });
});

describe('description with version check', () => {
  test('an agent changes it while the user types: notice, keeping your own saves on top of the new version', async () => {
    const { client, app } = await setup(3);
    client.push('issues:bucket', { bucket: 0 }, [doc(0)]);
    await flush();
    app.nav.go({ name: 'issue', key: 'ACME-1' });
    expect(app.detail.pageId()).toBe('i0');
    const detail = (version: number, markdown: string, by: object) => ({ id: 'i0', identifier: 'ACME-1', body: { markdown, version, updatedAt: 1, updatedBy: by }, comments: [], relations: [], pullRequests: [], history: [], sprints: [] });
    client.push('issues:detail', { id: 'i0' }, detail(1, 'Old', { kind: OWNER_KIND }));
    app.detail.startEdit();
    app.detail.input('My new text');
    client.push('issues:detail', { id: 'i0' }, detail(2, 'Text from the agent', { kind: 'agent', agentId: 'a1' }));
    const conflict = app.detail.desc.get().conflict;
    expect(conflict).toMatchObject({ by: 'Claude Code', version: 2, markdown: 'Text from the agent' });
    expect(app.detail.desc.get().text).toBe('My new text');
    // Without a decision nothing is saved (no silent overwrite).
    await app.detail.saveDescription();
    expect(calls(client, 'issues:setDescription')).toHaveLength(0);
    client.mutation.mockImplementationOnce(async () => ({ version: 3, changed: true }));
    app.detail.keepMine();
    await flush();
    expect(calls(client, 'issues:setDescription')[0][1]).toEqual({ id: 'i0', markdown: 'My new text', baseVersion: 2 });
  });

  test('your own save causes no conflict', async () => {
    const { client, app } = await setup(3);
    client.push('issues:bucket', { bucket: 0 }, [doc(0)]);
    await flush();
    app.nav.go({ name: 'issue', key: 'ACME-1' });
    const detail = (version: number, markdown: string) => ({ id: 'i0', identifier: 'ACME-1', body: { markdown, version, updatedAt: 1, updatedBy: { kind: OWNER_KIND } }, comments: [], relations: [], pullRequests: [], history: [], sprints: [] });
    client.push('issues:detail', { id: 'i0' }, detail(1, 'Old'));
    app.detail.startEdit();
    app.detail.input('New');
    let resolve!: (v: unknown) => void;
    client.mutation.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const saving = app.detail.saveDescription();
    // The optimistic update arrives with version 2 before the server answers.
    client.push('issues:detail', { id: 'i0' }, detail(2, 'New'));
    resolve({ version: 2, changed: true });
    await saving;
    expect(app.detail.desc.get().conflict).toBeNull();
    expect(app.detail.desc.get().base).toBe(2);
  });
});

describe('description: Done while a save runs', () => {
  test('waits for the running save, saves the newest text and closes the editor', async () => {
    const { client, app } = await setup(3);
    client.push('issues:bucket', { bucket: 0 }, [doc(0)]);
    await flush();
    app.nav.go({ name: 'issue', key: 'ACME-1' });
    const detail = (version: number, markdown: string) => ({ id: 'i0', identifier: 'ACME-1', body: { markdown, version, updatedAt: 1, updatedBy: { kind: OWNER_KIND } }, comments: [], relations: [], pullRequests: [], history: [], sprints: [] });
    client.push('issues:detail', { id: 'i0' }, detail(1, 'Old'));
    app.detail.startEdit();
    app.detail.input('First version');
    let resolve!: (v: unknown) => void;
    client.mutation.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const first = app.detail.saveDescription();
    // Something is added while saving (e.g. the finished image), then "Done".
    app.detail.input('First version with image');
    client.mutation.mockImplementationOnce(async () => ({ version: 3, changed: true }));
    const done = app.detail.finishEdit();
    resolve({ version: 2, changed: true });
    await first;
    await done;
    expect(calls(client, 'issues:setDescription').map((c) => (c[1] as { markdown: string }).markdown)).toEqual(['First version', 'First version with image']);
    expect(app.detail.desc.get().editing).toBe(false);
  });
});

describe('description by keyboard', () => {
  const key = (k: string) => ({ key: k, code: `Key${k.toUpperCase()}`, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, repeat: false, timeStamp: 0, target: null, preventDefault: vi.fn(), stopPropagation: vi.fn() }) as unknown as KeyboardEvent;

  test('E edits on the issue page, not in the list and not in the trash', async () => {
    const { client, app } = await setup(3);
    client.push('issues:bucket', { bucket: 0 }, [doc(0), doc(1, { deletedAt: 5 })]);
    await flush();
    app.nav.goView({ kind: 'all', team: null }, { group: 'none' });
    app.keys.onKeyDown(key('e'));
    expect(app.detail.desc.get().editing).toBe(false);

    app.nav.go({ name: 'issue', key: 'ACME-1' });
    // Text not loaded yet: nothing to edit.
    expect(actionById('issue.editDescription')!.when!(app)).toBe(false);
    client.push('issues:detail', { id: 'i0' }, { id: 'i0', identifier: 'ACME-1', body: { markdown: 'Old', version: 1, updatedAt: 1, updatedBy: { kind: OWNER_KIND } }, comments: [], relations: [], pullRequests: [], history: [], sprints: [] });
    const e = key('e');
    app.keys.onKeyDown(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(app.detail.desc.get()).toMatchObject({ editing: true, text: 'Old' });
    // Already editing: not again in the command menu.
    expect(actionById('issue.editDescription')!.when!(app)).toBe(false);
    await app.detail.finishEdit();

    app.nav.go({ name: 'issue', key: 'PX-2' });
    client.push('issues:detail', { id: 'i1' }, { id: 'i1', identifier: 'PX-2', body: { markdown: 'Gone', version: 1, updatedAt: 1, updatedBy: { kind: OWNER_KIND } }, comments: [], relations: [], pullRequests: [], history: [], sprints: [] });
    app.keys.onKeyDown(key('e'));
    expect(app.detail.desc.get().editing).toBe(false);
  });

  test('E in the inbox stays "Remove", also with the issue on the right in the split view', async () => {
    const { client, app } = await setup(3);
    client.push('issues:bucket', { bucket: 0 }, [doc(0, { reviewedAt: undefined })]);
    client.push('inbox:list', {}, [entry('i0')]);
    await flush();
    app.wide.set(true);
    app.nav.goView({ kind: 'inbox', team: null });
    app.detail.openSplit();
    expect(app.detail.split.get()).toBe(true);
    expect(KEYMAP.get('e')!.find((a) => !a.when || a.when(app))?.id).toBe('inbox.remove');
  });
});

describe('one action list for all ways', () => {
  test('every action with a shortcut is in the help', async () => {
    const { app } = await setup(0);
    app.palette.open('help');
    const ids = app.palette.state.get()!.items.map((i) => i.id);
    for (const action of ACTIONS.filter((a) => a.keys && !a.hidden)) expect(ids).toContain(`a:${action.id}`);
  });

  test('the command menu finds second-level values and acts on the selection', async () => {
    const { client, app } = await setup(3);
    client.push('issues:bucket', { bucket: 0 }, [doc(0), doc(1), doc(2)]);
    await flush();
    app.nav.goView({ kind: 'all', team: null });
    app.list.selectAll();
    app.palette.open('command');
    expect(app.palette.state.get()?.targetLabel).toBe('3 issues');
    app.palette.setQuery('prog');
    const first = app.palette.state.get()!.items[0];
    expect(first.label).toBe('Status: In Progress');
    app.palette.choose(0);
    // Two teams: per team the status with the same name. i2 is already "In Progress": only the other two change.
    const sent = calls(client, 'issues:update').map((c) => c[1] as { ids: string[]; patch: { stateId: string } });
    expect(sent.map((u) => [u.ids.join(), u.patch.stateId]).sort()).toEqual([
      ['i0', 't1:in_progress'],
      ['i1', 't2:in_progress'],
    ]);
  });

  test('context menu: priority submenu from the same picker', async () => {
    const { client, app } = await setup(3);
    client.push('issues:bucket', { bucket: 0 }, [doc(0)]);
    await flush();
    app.nav.goView({ kind: 'all', team: null });
    app.menu.open('i0' as IssueId, 10, 10);
    const items = app.menu.state.get()!.items;
    const prio = items.findIndex((i) => i.id === 'issue.priority');
    expect(items[prio]).toMatchObject({ submenu: true, shortcut: 'P' });
    app.menu.hover(prio);
    const sub = app.menu.state.get()!.sub!;
    expect(sub.items.map((i) => i.label)).toEqual(['No priority', 'Urgent', 'High', 'Medium', 'Low']);
    app.menu.chooseSub(1);
    expect(calls(client, 'issues:update')[0][1]).toMatchObject({ ids: ['i0'], patch: { priority: 1 } });
    expect(app.menu.state.get()).toBeNull();
  });

  test('picker: Esc changes nothing, labels stay open (multiple choice)', async () => {
    const { client, app } = await setup(3);
    client.push('issues:bucket', { bucket: 0 }, [doc(0)]);
    await flush();
    app.nav.goView({ kind: 'all', team: null });
    app.palette.open('labels');
    app.palette.setQuery('mob');
    app.palette.choose(0);
    expect(app.palette.state.get()).not.toBeNull();
    expect(calls(client, 'issues:update')).toHaveLength(1);
    app.palette.back();
    expect(app.palette.state.get()).toBeNull();
  });
});

describe('create dialog', () => {
  test('context prefilled, create another keeps the properties', async () => {
    const { client, app } = await setup(3);
    client.push('issues:bucket', { bucket: 0 }, [doc(0)]);
    await flush();
    app.nav.goView({ kind: 'backlog', team: 'PX' });
    app.create.open();
    const d = app.create.state.get().draft;
    expect(d.teamId).toBe('t2');
    expect(d.status).toBe('backlog');
    app.create.setField({ priority: 2 });
    app.create.update({ title: 'First' });
    client.mutation.mockImplementation(async () => ({ issues: [{ id: 'iX', identifier: 'PX-9' }], warnings: [] }));
    app.create.submit(true);
    expect(app.create.isOpen()).toBe(true);
    expect(app.create.state.get().draft).toMatchObject({ title: '', priority: 2, teamId: 't2' });
    app.create.update({ title: 'Second' });
    app.create.submit(true);
    const created = calls(client, 'issues:create').map((c) => (c[1] as { issues: { title: string; priority: number }[] }).issues[0]);
    expect(created).toEqual([expect.objectContaining({ title: 'First', priority: 2 }), expect.objectContaining({ title: 'Second', priority: 2 })]);
  });

  test('the draft survives navigating away; Esc with content becomes a saved draft', async () => {
    const { app } = await setup(0);
    app.nav.goView({ kind: 'all', team: null });
    app.create.open();
    app.create.update({ title: 'Half done' });
    app.nav.goView({ kind: 'inbox', team: null });
    expect(app.create.isOpen()).toBe(false);
    app.create.open();
    expect(app.create.state.get().draft.title).toBe('Half done');
    app.create.close();
    expect(app.create.drafts.get()[0].title).toBe('Half done');
  });

  test('discard with content: a notice with undo brings back the dialog with its content; empty means no notice', async () => {
    const { app } = await setup(0);
    app.nav.goView({ kind: 'all', team: null });
    app.create.open();
    app.create.discard();
    expect(app.create.isOpen()).toBe(false);
    expect(app.toasts.list.get()).toHaveLength(0);

    app.create.open();
    app.create.update({ title: 'Almost gone', description: 'With text' });
    app.create.setField({ priority: 1 });
    app.create.discard();
    expect(app.create.isOpen()).toBe(false);
    expect(app.create.draftCount()).toBe(0);
    const toast = app.toasts.list.get().find((t) => t.text === 'Draft discarded');
    expect(toast?.action?.label).toBe('Undo');
    // Meanwhile a new draft in the dialog: it moves to the list, the discarded one comes back.
    app.create.open();
    app.create.update({ title: 'New thought' });
    toast!.action!.run();
    expect(app.create.isOpen()).toBe(true);
    expect(app.create.state.get().draft).toMatchObject({ title: 'Almost gone', description: 'With text', priority: 1 });
    expect(app.create.drafts.get().map((d) => d.title)).toEqual(['New thought']);
  });

  test('/new?title=…&priority=high', async () => {
    const { app } = await setup(0);
    app.create.openFromParams({ title: 'Test', priority: 'high', team: 'ACME', label: 'bug' });
    expect(app.create.state.get().draft).toMatchObject({ title: 'Test', priority: 2, teamId: 't1', labelIds: ['l1'] });
  });

  test.each([
    ['in progress', 'urgent', 'in_progress', 1],
    ['in arbeit', 'dringend', 'in_progress', 1],
    ['erledigt', 'keine priorität', 'done', 0],
    ['Done', 'No priority', 'done', 0],
    ['in_review', '3', 'in_review', 3],
  ])('/new?status=%s&priority=%s works in any UI language', async (status, priority, wanted, prio) => {
    const { app } = await setup(0);
    app.create.openFromParams({ title: 'Test', status, priority, team: 'ACME' });
    expect(app.create.state.get().draft).toMatchObject({ status: wanted, priority: prio });
  });
});

describe('action targets', () => {
  test('selection before focus, the detail page acts on the open issue', async () => {
    const { client, app } = await setup(3);
    client.push('issues:bucket', { bucket: 0 }, [doc(0), doc(1), doc(2)]);
    await flush();
    app.nav.goView({ kind: 'all', team: null }, { group: 'none' });
    const focus = app.list.focusId()!;
    expect(app.targets()).toEqual([focus]);
    app.list.toggleSelect('i2' as IssueId);
    expect(app.targets()).toEqual(['i2']);
    app.nav.go({ name: 'issue', key: 'ACME-1' });
    expect(app.targets()).toEqual(['i0']);
  });

  vi.useRealTimers();
});

describe('a change to an issue recomputes only its row', () => {
  test('changing priority when ordered by creation: the list stays the same object, the row is new', async () => {
    const { client, app } = await setup(63);
    app.nav.goView({ kind: 'all', team: null }, { group: 'none', order: 'created' });
    const docs = Array.from({ length: 64 }, (_, i) => doc(i, { status: 'todo' }));
    client.push('issues:bucket', { bucket: 0 }, docs);
    await flush();
    const list = app.main.list.get();
    const row = app.main.rows.get('i10' as IssueId);
    const seen: (number | undefined)[] = [];
    const stop = row.subscribe(() => seen.push(row.get()?.priority));
    // An agent changes the priority: same order, same group → only the row.
    client.push('issues:bucket', { bucket: 0 }, docs.map((d) => (d.seq === 10 ? { ...d, priority: 1 } : d)));
    await flush();
    expect(app.main.list.get()).toBe(list);
    expect(seen).toEqual([1]);
    // If the order changes (new creation date), it is recomputed.
    client.push('issues:bucket', { bucket: 0 }, docs.map((d) => (d.seq === 10 ? { ...d, priority: 1, createdAt: 9999 } : d)));
    await flush();
    expect(app.main.list.get()).not.toBe(list);
    expect(app.main.order()[0]).toBe('i10');
    // If an issue drops out of the view (deleted), it disappears.
    client.push('issues:bucket', { bucket: 0 }, docs.map((d) => (d.seq === 10 ? { ...d, deletedAt: 5 } : d)));
    await flush();
    expect(app.main.order()).not.toContain('i10');
    stop();
  });

  test('grouping by status: a status change moves the issue to the other group', async () => {
    const { client, app } = await setup(63);
    app.nav.goView({ kind: 'all', team: null }, { group: 'status', order: 'created' });
    const docs = Array.from({ length: 64 }, (_, i) => doc(i));
    client.push('issues:bucket', { bucket: 0 }, docs);
    await flush();
    const groupOf = (id: string) => {
      let group = '';
      for (const r of app.main.list.get().rows) {
        if (r.kind === 'group') group = r.group.value;
        else if (r.id === id) return group;
      }
      return null;
    };
    // Groups per status, across teams by type and name.
    expect(groupOf('i1')).toBe('backlog:backlog');
    client.push('issues:bucket', { bucket: 0 }, docs.map((d) => (d.seq === 1 ? { ...d, status: 'in_progress', stateId: 't2:in_progress' } : d)) as typeof docs);
    await flush();
    expect(groupOf('i1')).toBe('started:in progress');
  });

  test('rows without subscribers are dropped instead of recomputed', async () => {
    const { client, app } = await setup(63);
    app.nav.goView({ kind: 'all', team: null }, { group: 'none', order: 'created' });
    client.push('issues:bucket', { bucket: 0 }, Array.from({ length: 64 }, (_, i) => doc(i)));
    await flush();
    for (let i = 0; i < 64; i++) app.main.rows.get(`i${i}` as IssueId);
    const kept = app.main.rows.get('i5' as IssueId);
    const stop = kept.subscribe(() => {});
    app.main.rows.refreshAll();
    expect(app.main.rows.size).toBe(1);
    stop();
  });
});

describe('fixed order in the picker', () => {
  test('S shows only allowed targets (intersection), the hint names the blocked ones; without a rule everything', async () => {
    const { client, app } = await setup(3);
    const strictMeta = {
      ...meta,
      teams: meta.teams.map((t) => (t._id === 't1' ? { ...t, workflow: { strict: true, exceptions: [{ from: 't1:in_progress', to: 't1:todo' }] } } : t)),
    };
    client.push('meta:get', {}, strictMeta);
    client.push('issues:bucket', { bucket: 0 }, [doc(0), doc(1), doc(2)]);
    await flush();
    // i0: t1 Todo → the next is In Progress, plus Canceled and Duplicate.
    app.palette.open('status', { target: { kind: 'issues', ids: ['i0' as IssueId] } });
    expect(app.palette.state.get()!.items.map((i) => i.label)).toEqual(['Todo', 'In Progress', 'Canceled', 'Duplicate']);
    expect(app.palette.state.get()!.hint).toBe('Fixed order: Triage, Backlog, In Review, Done not allowed right now');
    expect(app.palette.state.get()!.items[1].shortcut).toBe('2');
    app.palette.close();
    // i0 (Todo) and i2 (In Progress, exception back to Todo): allowed together.
    app.palette.open('status', { target: { kind: 'issues', ids: ['i0', 'i2'] as IssueId[] } });
    expect(app.palette.state.get()!.items.map((i) => i.label)).toEqual(['Todo', 'In Progress', 'Canceled', 'Duplicate']);
    app.palette.close();
    // Team without a rule: all eight.
    app.palette.open('status', { target: { kind: 'issues', ids: ['i1' as IssueId] } });
    expect(app.palette.state.get()!.items).toHaveLength(8);
    expect(app.palette.state.get()!.hint).toBeNull();
  });
});

describe('motion signal for the UI', () => {
  test('collapsing and expanding a group reports row and count, the list is already done', async () => {
    const { client, app } = await setup(63);
    app.nav.goView({ kind: 'all', team: null }, { group: 'status', order: 'created' });
    client.push('issues:bucket', { bucket: 0 }, Array.from({ length: 64 }, (_, i) => doc(i)));
    await flush();
    const rows = app.main.list.get().rows;
    const head = rows.find((r) => r.kind === 'group')!;
    const seen: unknown[] = [];
    const stop = app.main.motion.subscribe(() => seen.push({ ...app.main.motion.get(), length: app.main.list.get().rows.length }));
    app.main.toggleGroup(head.key);
    const count = head.kind === 'group' ? head.count : 0;
    expect(seen).toEqual([{ kind: 'toggle', key: head.key, index: rows.indexOf(head), rows: count, open: false, length: rows.length - count }]);
    app.main.toggleGroup(head.key);
    expect(seen[1]).toEqual({ kind: 'toggle', key: head.key, index: rows.indexOf(head), rows: count, open: true, length: rows.length });
    stop();
  });

  test('a status change into another group reports "moved", the same place does not', async () => {
    const { client, app } = await setup(63);
    app.nav.goView({ kind: 'all', team: null }, { group: 'status', order: 'created' });
    const docs = Array.from({ length: 64 }, (_, i) => doc(i));
    client.push('issues:bucket', { bucket: 0 }, docs);
    await flush();
    const seen: unknown[] = [];
    const stop = app.main.motion.subscribe(() => seen.push(app.main.motion.get()));
    // Change priority: same place (ordered by creation), no signal.
    client.push('issues:bucket', { bucket: 0 }, docs.map((d) => (d.seq === 1 ? { ...d, priority: 1 } : d)) as typeof docs);
    await flush();
    expect(seen).toEqual([]);
    // Change status: another group.
    client.push('issues:bucket', { bucket: 0 }, docs.map((d) => (d.seq === 1 ? { ...d, priority: 1, status: 'in_progress', stateId: 't2:in_progress' } : d)) as typeof docs);
    await flush();
    expect(seen).toEqual([{ kind: 'moved', ids: ['i1'] }]);
    stop();
  });

  test('triage is the first status group in the team and across teams; a status change moves to the new group', async () => {
    const { client, app } = await setup(63);
    const docs = Array.from({ length: 64 }, (_, i) => doc(i, i === 4 || i === 5 ? { status: 'triage' } : {}));
    client.push('issues:bucket', { bucket: 0 }, docs);
    await flush();
    const groups = () => app.main.list.get().rows.flatMap((r) => (r.kind === 'group' ? [`${r.group.label}:${r.count}`] : []));
    // i4 belongs to ACME (t1), i5 to PX (t2)
    app.nav.goView({ kind: 'all', team: 'ACME' }, { group: 'status', order: 'created' });
    expect(groups()[0]).toBe('Triage:1');
    app.nav.goView({ kind: 'all', team: null }, { group: 'status', order: 'created' });
    expect(groups()[0]).toBe('Triage:2');
    app.main.toggleGroup(app.main.list.get().rows[0].key);
    expect(app.main.list.get().rows[0]).toMatchObject({ kind: 'group', collapsed: true });
    app.main.toggleGroup(app.main.list.get().rows[0].key);
    const seen: unknown[] = [];
    const stop = app.main.motion.subscribe(() => seen.push(app.main.motion.get()));
    client.push('issues:bucket', { bucket: 0 }, docs.map((d) => (d.seq === 4 ? { ...d, status: 'todo', stateId: 't1:todo' } : d)) as typeof docs);
    await flush();
    expect(groups()[0]).toBe('Triage:1');
    expect(seen).toEqual([{ kind: 'moved', ids: ['i4'] }]);
    stop();
    // Active and backlog show no triage group.
    app.nav.goView({ kind: 'active', team: null }, { group: 'status' });
    expect(groups().some((g) => g.startsWith('Triage'))).toBe(false);
  });

  test('new issues land without a signal (the real one replaces the provisional one on confirmation)', async () => {
    const { client, app } = await setup(63);
    app.nav.goView({ kind: 'all', team: null }, { group: 'none', order: 'created' });
    const docs = Array.from({ length: 10 }, (_, i) => doc(i));
    client.push('issues:bucket', { bucket: 0 }, docs);
    await flush();
    const seen: unknown[] = [];
    const stop = app.main.motion.subscribe(() => seen.push(app.main.motion.get()));
    client.push('issues:bucket', { bucket: 0 }, [...docs, doc(10, { createdAt: 9999 })]);
    await flush();
    expect(app.main.order()[0]).toBe('i10');
    expect(seen).toEqual([]);
    stop();
  });
});

describe('sidebar with team cards', () => {
  test('counts by status type: unstarted, started; sprint only with the team\'s issues in it', async () => {
    const { client, app } = await setup(63);
    client.push('issues:bucket', { bucket: 0 }, [
      doc(0, { teamId: 't1' as never, status: 'todo' }),
      doc(2, { teamId: 't1' as never, status: 'in_progress' }),
      // Another status of type "started" (In Review) counts like In Progress.
      doc(4, { teamId: 't1' as never, status: 'in_review' }),
      doc(6, { teamId: 't1' as never, status: 'backlog' }),
      doc(8, { teamId: 't1' as never, status: 'todo', deletedAt: 5 }),
      // Sprint 4 (active): team PX has three issues in it, one done, one canceled (does not count).
      doc(1, { teamId: 't2' as never, status: 'done', sprintId: 's4' as never }),
      doc(3, { teamId: 't2' as never, status: 'todo', sprintId: 's4' as never }),
      doc(5, { teamId: 't2' as never, status: 'in_progress', sprintId: 's4' as never }),
      doc(7, { teamId: 't2' as never, status: 'canceled', sprintId: 's4' as never }),
    ]);
    await flush();
    const sb = app.sidebar.get();
    expect(sb.current?.key).toBe('ACME');
    expect(sb.teams.map((t) => t.key)).toEqual(['PX']);
    expect(sb.dormant.map((t) => t.key)).toEqual(['MOSAIK']);
    // The counts arrive batched a bit later (not a response to input).
    await vi.waitFor(() => expect(app.teamStats.get().ACME).toEqual({ todo: 1, started: 2, sprintIssues: 0, sprintDone: 0 }));
    expect(app.teamStats.get().PX).toEqual({ todo: 1, started: 1, sprintIssues: 3, sprintDone: 1 });
    // Done counts right away.
    client.push('issues:bucket', { bucket: 0 }, [doc(1, { teamId: 't2' as never, status: 'done', sprintId: 's4' as never }), doc(3, { teamId: 't2' as never, status: 'done', sprintId: 's4' as never })]);
    app.updateTeamStats();
    expect(app.teamStats.get().PX).toMatchObject({ sprintIssues: 2, sprintDone: 2 });
  });

  test('a team page makes the team current, issue pages and global pages do not; fixed order', async () => {
    const { client, app } = await setup(63);
    client.push('issues:bucket', { bucket: 0 }, Array.from({ length: 4 }, (_, i) => doc(i)));
    await flush();
    app.nav.goView({ kind: 'backlog', team: 'PX' });
    expect(app.sidebar.get().current?.key).toBe('PX');
    expect(app.sidebar.get().teams.map((t) => t.key)).toEqual(['ACME']);
    app.nav.goView({ kind: 'all', team: null });
    app.nav.go({ name: 'issue', key: 'ACME-1' });
    expect(app.sidebar.get().current?.key).toBe('PX');
    // Dormant team as the current one: at the top, no longer under "Inactive".
    app.nav.go({ name: 'projects', team: 'MOSAIK' });
    expect(app.sidebar.get().current?.key).toBe('MOSAIK');
    expect(app.sidebar.get().teams.map((t) => t.key)).toEqual(['ACME', 'PX']);
    expect(app.sidebar.get().dormant).toEqual([]);
  });

  test('teams in the sidebar: small by default, choosing "large" applies right away', async () => {
    const { app } = await setup(63);
    expect(app.prefs.state.get().sidebarTeams).toBe('small');
    expect(app.sidebar.get().teamSize).toBe('small');
    app.prefs.set({ sidebarTeams: 'large' });
    expect(app.sidebar.get().teamSize).toBe('large');
    app.prefs.set({ sidebarTeams: 'small' });
  });

  test('switching keeps the team page: backlog stays backlog, projects stay projects, else issues', async () => {
    const { app } = await setup(63);
    app.nav.goView({ kind: 'backlog', team: 'ACME' });
    app.switchTeam('PX');
    expect(app.nav.page.get()).toMatchObject({ name: 'view', view: { kind: 'backlog', team: 'PX' } });
    app.nav.go({ name: 'projects', team: 'PX' });
    app.switchTeam('ACME');
    expect(app.nav.page.get()).toEqual({ name: 'projects', team: 'ACME' });
    app.nav.goView({ kind: 'inbox', team: null });
    app.switchTeam('PX');
    expect(app.nav.page.get()).toMatchObject({ name: 'view', view: { kind: 'active', team: 'PX' } });
    expect(app.sidebar.get().current?.key).toBe('PX');
  });

  test('O T opens "Switch team", Enter switches', async () => {
    const { app } = await setup(63);
    app.palette.open('switchTeam');
    const items = app.palette.state.get()!.items;
    expect(items.map((i) => i.label)).toEqual(['Acme', 'Pixelwerk', 'Mosaik']);
    expect(items.find((i) => i.checked)?.label).toBe('Acme');
    expect(ACTIONS.find((a) => a.id === 'team.switch')?.keys).toEqual(['o t']);
    app.palette.choose(1);
    expect(app.sidebar.get().current?.key).toBe('PX');
  });
});

describe('sounds: core reports what happened', () => {
  function heard(app: App) {
    const cues: string[] = [];
    app.cues.subscribe((e) => cues.push(e.step === undefined ? e.cue : `${e.cue}:${e.step}`));
    return cues;
  }

  test('status to done → success, other statuses stay silent', async () => {
    const { client, app } = await setup(3);
    client.push('issues:bucket', { bucket: 0 }, [doc(0), doc(1), doc(2)]);
    await flush();
    const cues = heard(app);
    app.edit.patch(['i0' as IssueId], { priority: 2 });
    app.edit.patch(['i1' as IssueId], { status: 'in_progress' });
    expect(cues).toEqual([]);
    app.edit.patch(['i0' as IssueId], { status: 'done' });
    expect(cues).toEqual(['success']);
  });

  test('error notice → error, info notice silent, budget → warning', async () => {
    const { app } = await setup(3);
    const cues = heard(app);
    app.toasts.show('Link copied');
    expect(cues).toEqual([]);
    app.toasts.error('Not saved', new Error('x'));
    app.toasts.show('Not allowed', undefined, 'error');
    expect(cues).toEqual(['error', 'error']);
  });

  test('command menu: choice → command, submenu → chirp; context menu → select with step', async () => {
    const { client, app } = await setup(3);
    client.push('issues:bucket', { bucket: 0 }, [doc(0), doc(1), doc(2)]);
    await flush();
    const cues = heard(app);
    app.palette.open('command');
    const items = app.palette.state.get()!.items;
    const plain = items.findIndex((i) => !i.submenu && !i.checkbox && !i.danger);
    app.palette.choose(plain);
    expect(cues).toEqual(['command']);
  });

  test('J/K → tap', async () => {
    const { client, app } = await setup(3);
    client.push('issues:bucket', { bucket: 0 }, [doc(0), doc(1), doc(2)]);
    await flush();
    app.nav.goView({ kind: 'all', team: null }, { group: 'none', order: 'created' });
    await flush();
    const cues = heard(app);
    ACTIONS.find((a) => a.id === 'nav.down')!.run(app);
    ACTIONS.find((a) => a.id === 'nav.up')!.run(app);
    expect(cues).toEqual(['tap', 'tap']);
  });

  test('without listeners a cue costs nothing and does not throw', async () => {
    const { app } = await setup(3);
    expect(() => app.cues.emit('success')).not.toThrow();
  });
});

describe('pull request next to the issue', () => {
  test('stays open on the issue page and closes when switching to another page', async () => {
    const { client, app } = await setup(63);
    client.push('issues:bucket', { bucket: 0 }, Array.from({ length: 4 }, (_, i) => doc(i)));
    await flush();
    app.openIssue('i1' as IssueId);
    app.prSplit.set({ repo: 'o/r', number: 7 });
    app.onPage(app.nav.page.get());
    expect(app.prSplit.get()).toEqual({ repo: 'o/r', number: 7 });
    expect(app.targets()).toEqual(['i1']);
    app.nav.go({ name: 'pr', repo: 'o/r', number: 7 });
    expect(app.prSplit.get()).toBeNull();
    expect(app.targets()).toEqual([]);
  });
});
