// Regression tests for QA findings (relations, undo, pickers, notices, actions).
import { describe, expect, test } from 'vitest';
import { App } from '../src/app/index.ts';
import { actionById } from '../src/app/actions.ts';
import { Auth } from '../src/auth.ts';
import { labelIdsFrom, labelParam, writeLocation } from '../src/route.ts';
import { revealIndex } from '../src/window.ts';
import { LEGACY_OWNER_KIND, OWNER_KIND, type IssueId } from '../src/types.ts';
import { callName, doc, entry, fakeClient, flush, inboxOf, meta } from './helpers.ts';

let n = 0;
async function setup(docs = [doc(0), doc(1), doc(2)]) {
  const client = fakeClient();
  const app = new App({ client: client as never, auth: new Auth({ devToken: 'x' }), debug: true, perf: false, cacheName: `qa-${++n}` });
  app.start();
  await flush();
  client.push('meta:get', {}, meta);
  client.push('meta:counter', {}, { maxSeq: docs.length - 1 });
  client.push('agents:list', {}, []);
  client.push('issues:bucket', { bucket: 0 }, docs);
  client.push('inbox:list', {}, inboxOf(docs));
  await flush();
  // relations.add returns an id, everything else the default answer.
  let rel = 0;
  client.mutation.mockImplementation(async (fn: unknown) => {
    const name = callName([fn]);
    if (name === 'relations:add') return { relationId: `r${++rel}` };
    if (name === 'labels:create') return { labelId: 'lNew' };
    return { updatedAt: 1, changed: 1, warnings: [] };
  });
  return { client, app };
}

const calls = (client: ReturnType<typeof fakeClient>, name: string) => client.mutation.mock.calls.filter((c) => callName(c) === name).map((c) => c[1] as Record<string, unknown>);
const ids = (...list: string[]) => list as IssueId[];

function chooseId(app: App, id: string) {
  const index = app.palette.state.get()!.items.findIndex((i) => i.id === id);
  expect(index).toBeGreaterThanOrEqual(0);
  app.palette.choose(index);
}

describe('relations', () => {
  test('"Blocks …" from the command menu creates blocks, not duplicate', async () => {
    const { client, app } = await setup();
    app.nav.goView({ kind: 'all', team: null }, { group: 'none' });
    app.list.focus('i0' as IssueId);
    app.palette.open('command');
    app.palette.setQuery('Blocks');
    chooseId(app, 'a:issue.blocks');
    expect(app.palette.state.get()?.kind).toBe('relation');
    chooseId(app, 'i:i1');
    await flush();
    expect(calls(client, 'relations:add')).toEqual([{ fromId: 'i0', toId: 'i1', type: 'blocks' }]);
    expect(calls(client, 'issues:update')).toHaveLength(0);
  });

  test('"Blocked by …" and "Related to …" from the context menu', async () => {
    const { client, app } = await setup();
    app.nav.goView({ kind: 'all', team: null }, { group: 'none' });
    for (const [action, other] of [['issue.blockedBy', 'i1'], ['issue.related', 'i2']] as const) {
      app.menu.open('i0' as IssueId, 10, 10);
      app.menu.choose(app.menu.state.get()!.items.findIndex((i) => i.id === action));
      chooseId(app, `i:${other}`);
    }
    await flush();
    expect(calls(client, 'relations:add')).toEqual([
      { fromId: 'i1', toId: 'i0', type: 'blocks' },
      { fromId: 'i0', toId: 'i2', type: 'related' },
    ]);
  });

  test('mark as duplicate: undo removes the relation and resets the status, redo again', async () => {
    const { client, app } = await setup();
    app.nav.goView({ kind: 'all', team: null }, { group: 'none' });
    app.list.focus('i0' as IssueId);
    app.palette.openRelation('duplicate');
    chooseId(app, 'i:i1');
    await flush();
    expect(calls(client, 'relations:add')).toEqual([{ fromId: 'i0', toId: 'i1', type: 'duplicate', markDuplicate: true }]);
    app.edit.undo();
    await flush();
    await flush();
    expect(calls(client, 'relations:remove')).toEqual([{ relationId: 'r1' }]);
    // Exactly the team's old status back, not just the status type.
    expect(calls(client, 'issues:revert').at(-1)).toEqual({ items: [{ id: 'i0', patch: { stateId: 't1:todo' }, expect: { stateId: 't1:duplicate' } }] });
    app.edit.redo();
    await flush();
    await flush();
    expect(calls(client, 'relations:add').at(-1)).toEqual({ fromId: 'i0', toId: 'i1', type: 'duplicate' });
    expect(calls(client, 'issues:revert').at(-1)).toEqual({ items: [{ id: 'i0', patch: { stateId: 't1:duplicate' }, expect: { stateId: 't1:todo' } }] });
  });

  test('removing a relation can be undone', async () => {
    const { client, app } = await setup();
    await app.edit.removeRelation({ from: 'i0' as IssueId, to: 'i2' as IssueId, type: 'related', relationId: 'rOld' });
    expect(calls(client, 'relations:remove')).toEqual([{ relationId: 'rOld' }]);
    app.edit.undo();
    await flush();
    expect(calls(client, 'relations:add')).toEqual([{ fromId: 'i0', toId: 'i2', type: 'related' }]);
  });

  test('the duplicate picker suggests similar titles without a query', async () => {
    const { app } = await setup([doc(0, { title: 'Export fails on umlauts' }), doc(1, { title: 'Umlauts broken in export' }), doc(2, { title: 'Something else entirely' })]);
    app.nav.goView({ kind: 'all', team: null }, { group: 'none' });
    app.list.focus('i0' as IssueId);
    app.palette.openRelation('duplicate');
    const items = app.palette.state.get()!.items;
    expect(items[0]).toMatchObject({ id: 'i:i1', section: 'Similar titles' });
    expect(items.map((i) => i.id)).not.toContain('i:i0');
  });
});

describe('pickers', () => {
  test('labels: query empty after Enter, picker stays open', async () => {
    const { app } = await setup();
    app.nav.goView({ kind: 'all', team: null }, { group: 'none' });
    app.palette.open('labels');
    app.palette.setQuery('mob');
    app.palette.choose(0);
    const s = app.palette.state.get()!;
    expect(s.query).toBe('');
    expect(s.items[s.active].id).toBe('l:l3');
  });

  test('labels: without a hit, "Create label “…”" creates and sets it', async () => {
    const { client, app } = await setup();
    app.nav.goView({ kind: 'all', team: null }, { group: 'none' });
    app.list.focus('i1' as IssueId);
    app.palette.open('labels');
    app.palette.setQuery('Documentation');
    const items = app.palette.state.get()!.items;
    expect(items.at(-1)).toMatchObject({ id: 'l:new', label: 'Create label “Documentation”' });
    chooseId(app, 'l:new');
    await flush();
    expect(calls(client, 'labels:create')[0]).toMatchObject({ name: 'Documentation' });
    expect(calls(client, 'issues:update').at(-1)).toMatchObject({ ids: ['i1'], patch: { labelIds: ['lNew'] } });
    expect(app.palette.state.get()?.query).toBe('');
  });

  test('parent: with a query the first hit is active, Enter sets it', async () => {
    const { client, app } = await setup();
    app.nav.goView({ kind: 'all', team: null }, { group: 'none' });
    app.list.focus('i0' as IssueId);
    app.palette.open('parent');
    expect(app.palette.state.get()!.items[0].id).toBe('pa:none');
    app.palette.setQuery('PX-2');
    const s = app.palette.state.get()!;
    expect(s.items[s.active].id).toBe('i:i1');
    app.palette.choose();
    expect(calls(client, 'issues:update').at(-1)).toMatchObject({ ids: ['i0'], patch: { parentId: 'i1' } });
  });
});

describe('notices with "Undo"', () => {
  test('after Ctrl Z the notice disappears; an old notice undoes only its own step', async () => {
    const { client, app } = await setup();
    app.edit.patch(ids('i0', 'i1'), { priority: 4 });
    expect(app.toasts.list.get().map((t) => t.text)).toEqual(['2 issues changed']);
    app.edit.undo();
    expect(app.toasts.list.get()).toHaveLength(0);

    app.edit.patch(ids('i0', 'i1'), { estimate: 3 });
    const first = app.toasts.list.get().at(-1)!;
    app.edit.patch(ids('i1', 'i2'), { dueDate: '2026-10-20' });
    await flush();
    first.action!.run();
    await flush();
    const revert = calls(client, 'issues:revert').at(-1) as { items: { patch: object }[] };
    expect(revert.items.map((i) => Object.keys(i.patch))).toEqual([['estimate'], ['estimate']]);
    // The used notice does nothing on a second click.
    const before = calls(client, 'issues:revert').length;
    first.action!.run();
    await flush();
    expect(calls(client, 'issues:revert')).toHaveLength(before);
  });

  test('deleting the selection: only the trash notice, no "no longer in this view"', async () => {
    const { client, app } = await setup();
    app.nav.goView({ kind: 'all', team: null }, { group: 'none' });
    app.list.selectAll();
    app.edit.remove(app.targets());
    const docs = [doc(0), doc(1), doc(2)].map((d) => ({ ...d, deletedAt: 5 }));
    client.push('issues:bucket', { bucket: 0 }, docs);
    await flush();
    expect(app.toasts.list.get().map((t) => t.text)).toEqual(['3 issues moved to the trash']);
  });
});

describe('actions', () => {
  test('Enter opens the focused issue even with a selection', async () => {
    const { app } = await setup();
    app.nav.goView({ kind: 'all', team: null }, { group: 'none' });
    app.list.toggleSelect('i2' as IssueId);
    app.list.focus('i0' as IssueId);
    actionById('issue.open')!.run(app);
    expect(app.nav.page.get()).toMatchObject({ name: 'issue', key: 'ACME-1' });
  });

  test('context menu in the trash: no actions for live issues', async () => {
    const { app } = await setup([doc(0, { deletedAt: 5 })]);
    app.nav.goView({ kind: 'trash', team: null });
    app.menu.open('i0' as IssueId, 10, 10);
    const items = app.menu.state.get()!.items.map((i) => i.id);
    expect(items).toContain('issue.restore');
    for (const id of ['issue.subissue', 'issue.copyBranch', 'issue.status', 'issue.delete', 'issue.blocks', 'issue.repeat']) expect(items).not.toContain(id);
  });

  test('Redo is not confused with "Repeat …"', () => {
    expect(actionById('history.redo')!.label).toBe('Redo');
    expect(actionById('issue.repeat')!.label).toBe('Repeat …');
  });
});

describe('description and activity', () => {
  const detail = (version: number, markdown: string, history: object[] = []) => ({ id: 'i0', identifier: 'ACME-1', body: { markdown, version, updatedAt: 1, updatedBy: { kind: OWNER_KIND } }, comments: [], relations: [], pullRequests: [], history, sprints: [] });

  test('status line: unsaved from the first keystroke, no longer after saving', async () => {
    const { client, app } = await setup([doc(0)]);
    app.nav.go({ name: 'issue', key: 'ACME-1' });
    client.push('issues:detail', { id: 'i0' }, detail(1, 'Old'));
    app.detail.startEdit();
    expect(app.detail.desc.get().dirty).toBe(false);
    app.detail.input('Old and new');
    expect(app.detail.desc.get().dirty).toBe(true);
    client.mutation.mockImplementationOnce(async () => ({ version: 2, changed: true }));
    await app.detail.saveDescription();
    expect(app.detail.desc.get()).toMatchObject({ dirty: false, saving: false });
    app.detail.input('Old and new!');
    app.detail.input('Old and new');
    expect(app.detail.desc.get().dirty).toBe(false);
  });

  test('activity of the legacy owner kind is shown as the owner, and its events are not revertable', async () => {
    const { client, app } = await setup([doc(0)]);
    app.nav.go({ name: 'issue', key: 'ACME-1' });
    // legacy-xlr8: history and comments written before the rename carry "steven"
    const legacy = { kind: LEGACY_OWNER_KIND };
    client.push('issues:detail', { id: 'i0' }, {
      ...detail(1, 'x', [{ _id: 'h1', issueId: 'i0', field: 'priority', from: 1, to: 2, actor: legacy, at: 1 }]),
      comments: [{ _id: 'c1', issueId: 'i0', body: 'hi', author: legacy, createdAt: 2 }],
    });
    const activity = app.detail.state.get()!.activity!;
    expect(activity.map((a) => a.actor)).toEqual(['owner', 'owner']);
    expect(activity.find((a) => a.kind === 'event')!.revert).toBeUndefined();
    expect(activity.find((a) => a.kind === 'comment')).toMatchObject({ mine: true });
  });

  test('consecutive description changes by the same actor: one line', async () => {
    const { client, app } = await setup([doc(0)]);
    app.nav.go({ name: 'issue', key: 'ACME-1' });
    const min = 60_000;
    const h = (id: string, field: string, at: number, actor: object = { kind: OWNER_KIND }) => ({ _id: id, issueId: 'i0', field, actor, at });
    client.push(
      'issues:detail',
      { id: 'i0' },
      detail(4, 'x', [
        h('h1', 'created', 0),
        h('h2', 'description', 1 * min),
        h('h3', 'description', 2 * min),
        h('h4', 'description', 9 * min),
        h('h5', 'description', 30 * min),
        h('h6', 'description', 31 * min, { kind: 'agent', agentId: 'a1' }),
        h('h7', 'status', 32 * min),
        h('h8', 'description', 33 * min),
      ]),
    );
    const activity = app.detail.state.get()!.activity!;
    expect(activity.map((a) => [a.id, a.at / min])).toEqual([
      ['h1', 0],
      ['h4', 9],
      ['h5', 30],
      ['h6', 31],
      ['h7', 32],
      ['h8', 33],
    ]);
  });
});

describe('inbox and comments', () => {
  test('remove from inbox: only the mark, notice with undo, undo brings the entry back', async () => {
    const { client, app } = await setup([doc(0, { reviewedAt: undefined }), doc(1, { reviewedAt: undefined }), doc(2)]);
    app.nav.goView({ kind: 'inbox', team: null });
    expect(app.list.order()).toEqual(ids('i1', 'i0'));
    app.list.focus('i1' as IssueId);
    actionById('inbox.remove')!.run(app);
    await flush();
    expect(calls(client, 'issues:markReviewed')).toEqual([{ ids: ['i1'] }]);
    // No field of the issue changes (status, title …): no change through issues.update.
    expect(calls(client, 'issues:update')).toHaveLength(0);
    expect(app.toasts.list.get().at(-1)).toMatchObject({ text: 'PX-2 removed from inbox', action: { label: 'Undo' } });
    client.push('inbox:list', {}, inboxOf([doc(0, { reviewedAt: undefined })]));
    await flush();
    expect(app.list.order()).toEqual(ids('i0'));
    expect(app.list.focusId()).toBe('i0');
    app.edit.undo();
    await flush();
    expect(calls(client, 'issues:markUnreviewed')).toEqual([{ ids: ['i1'] }]);
  });

  test('U toggles read and unread, Alt U marks all, "Done for today" clears the inbox', async () => {
    const { client, app } = await setup([doc(0, { reviewedAt: undefined }), doc(1, { reviewedAt: undefined, readAt: 3 }), doc(2, { reviewedAt: undefined }), doc(3)]);
    app.nav.goView({ kind: 'inbox', team: null });
    expect(app.sidebar.get().inbox).toBe(2);
    app.list.focus('i0' as IssueId);
    expect(actionById('inbox.unread')!.when!(app)).toBe(false);
    actionById('inbox.read')!.run(app);
    app.list.focus('i1' as IssueId);
    expect(actionById('inbox.read')!.when!(app)).toBe(false);
    actionById('inbox.unread')!.run(app);
    actionById('inbox.readAll')!.run(app);
    await flush();
    expect(calls(client, 'issues:markRead')).toEqual([
      { ids: ['i0'], read: true },
      { ids: ['i1'], read: false },
      { ids: ['i2', 'i0'], read: true },
    ]);
    actionById('inbox.clearAll')!.run(app);
    await flush();
    expect((calls(client, 'issues:markReviewed')[0].ids as string[]).sort()).toEqual(['i0', 'i1', 'i2']);
    expect(app.toasts.list.get().at(-1)).toMatchObject({ text: 'Inbox cleared (3 entries)', action: { label: 'Undo' } });
    // Remove read ones: only the read ones.
    actionById('inbox.clearRead')!.run(app);
    await flush();
    expect(calls(client, 'issues:markReviewed')[1].ids).toEqual(['i1']);
  });

  test('inbox actions exist only in the inbox (and in the context menu of an entry)', async () => {
    const { app } = await setup([doc(0, { reviewedAt: undefined }), doc(1)]);
    app.nav.goView({ kind: 'all', team: null }, { group: 'none' });
    app.list.focus('i0' as IssueId);
    expect(actionById('inbox.remove')!.when!(app)).toBe(false);
    app.menu.open('i0' as IssueId, 10, 10);
    expect(actionById('inbox.remove')!.when!(app)).toBe(true);
    app.menu.close();
    app.menu.open('i1' as IssueId, 10, 10);
    expect(actionById('inbox.remove')!.when!(app)).toBe(false);
  });

  test('the comment draft is kept per issue and deleted after sending', async () => {
    const memory = new Map<string, string>();
    const original = globalThis.localStorage;
    globalThis.localStorage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) } as unknown as Storage;
    const { app } = await setup([doc(0)]);
    app.detail.setCommentDraft('i0', 'Half a thought');
    expect(memory.get('selfbound:comment:i0')).toBe('Half a thought');
    expect(app.detail.commentDraft('i0')).toBe('Half a thought');
    expect(app.detail.commentDraft('i1')).toBe('');
    app.nav.go({ name: 'issue', key: 'ACME-1' });
    expect(await app.detail.addComment('Half a thought, finished')).toBe(true);
    expect(app.detail.commentDraft('i0')).toBe('');
    globalThis.localStorage = original;
  });
});

describe('split inbox', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function split(docs = [doc(0, { reviewedAt: undefined }), doc(1, { reviewedAt: undefined }), doc(2, { reviewedAt: undefined })]) {
    const ctx = await setup(docs);
    ctx.app.wide.set(true);
    ctx.app.nav.goView({ kind: 'inbox', team: null });
    return ctx;
  }

  test('a click shows the issue on the right, the page stays the inbox; J/K follows', async () => {
    const { app } = await split();
    expect(app.shell.get().split).toBe(true);
    expect(app.detail.state.get()).toBeNull();
    app.list.clickRow('i1' as IssueId);
    expect(app.nav.page.get()).toMatchObject({ name: 'view', view: { kind: 'inbox' } });
    expect(app.detail.splitShown()).toBe(true);
    expect(app.detail.state.get()?.id).toBe('i1');
    actionById('nav.down')!.run(app);
    expect(app.list.focusId()).toBe('i0');
    expect(app.detail.state.get()?.id).toBe('i0');
    // The mouse does not switch the entry (the right side keeps what was chosen).
    app.list.hoverRow('i2' as IssueId);
    expect(app.detail.state.get()?.id).toBe('i0');
    // Esc closes the right side, the focus stays.
    app.detail.closeSplit();
    expect(app.detail.state.get()).toBeNull();
    expect(app.list.focusId()).toBe('i0');
  });

  test('read only after a short look: paging past with J does not read', async () => {
    const { client, app } = await split();
    app.list.clickRow('i2' as IssueId);
    actionById('nav.down')!.run(app);
    actionById('nav.down')!.run(app);
    await wait(320);
    expect(calls(client, 'issues:markRead')).toEqual([{ ids: ['i0'], read: true }]);
  });

  test('narrow window: a click opens the own page as before', async () => {
    const { app } = await setup([doc(0, { reviewedAt: undefined })]);
    app.nav.goView({ kind: 'inbox', team: null });
    expect(app.shell.get().split).toBe(false);
    app.list.clickRow('i0' as IssueId);
    expect(app.nav.page.get()).toEqual({ name: 'issue', key: 'ACME-1' });
  });

  test('remove an entry: the next one shows on the right; removing the last closes the right side', async () => {
    const { client, app } = await split([doc(0, { reviewedAt: undefined }), doc(1, { reviewedAt: undefined })]);
    app.list.clickRow('i1' as IssueId);
    actionById('inbox.remove')!.run(app);
    client.push('inbox:list', {}, inboxOf([doc(0, { reviewedAt: undefined })]));
    await flush();
    expect(app.detail.state.get()?.id).toBe('i0');
    actionById('inbox.remove')!.run(app);
    client.push('inbox:list', {}, []);
    await flush();
    expect(app.detail.splitShown()).toBe(false);
    // A new entry does not open by itself (and is not read).
    client.push('inbox:list', {}, [entry('i2')]);
    await wait(320);
    expect(app.detail.state.get()).toBeNull();
    expect(calls(client, 'issues:markRead').flatMap((c) => c.ids as string[])).not.toContain('i2');
  });

  test('Enter opens the own page, back restores the split', async () => {
    const { app } = await split();
    app.list.clickRow('i1' as IssueId);
    actionById('issue.open')!.run(app);
    expect(app.nav.page.get()).toEqual({ name: 'issue', key: 'PX-2' });
    app.nav.goView({ kind: 'inbox', team: null });
    expect(app.detail.splitShown()).toBe(true);
    expect(app.detail.state.get()?.id).toBe('i1');
    app.nav.goView({ kind: 'all', team: null });
    expect(app.detail.split.get()).toBe(false);
  });
});

describe('list, URL and focus', () => {
  test('undoing a bulk change that dropped all issues from the filter selects them again', async () => {
    const docs = [doc(0, { priority: 0 }), doc(1, { priority: 0 }), doc(2, { priority: 3 })];
    const { client, app } = await setup(docs);
    app.nav.goView({ kind: 'all', team: null }, { group: 'none', filters: { ...app.list.view.get().filters, priority: [0] } });
    app.list.selectAll();
    expect(app.list.selection().sort()).toEqual(['i0', 'i1']);
    app.edit.patch(app.targets(), { priority: 4 });
    // The server reports the change: both drop out of the filter, the selection empties.
    client.push('issues:bucket', { bucket: 0 }, [doc(0, { priority: 4 }), doc(1, { priority: 4 }), docs[2]]);
    await flush();
    expect(app.list.selection()).toEqual([]);
    // Only ONE notice (no extra "no longer in this view").
    expect(app.toasts.list.get().map((t) => t.text)).toEqual(['2 issues changed']);
    app.edit.undo();
    await flush();
    client.push('issues:bucket', { bucket: 0 }, docs);
    await flush();
    expect(app.list.selection().sort()).toEqual(['i0', 'i1']);
  });

  test('jumping to a row leaves room at the bottom for open notices', () => {
    const el = { scrollTop: 0, clientHeight: 440 };
    revealIndex(el, 9, 44); // row 9 ends at 440: fits exactly
    expect(el.scrollTop).toBe(0);
    revealIndex(el, 9, 44, 0, 80);
    expect(el.scrollTop).toBe(80);
  });

  test('the filter chip shows the team name; labels in the URL by name, old ids still work', async () => {
    const { app } = await setup();
    app.nav.goView({ kind: 'all', team: null }, { filters: { ...app.list.view.get().filters, team: ['PX'], label: ['l3'] } });
    expect(app.list.header.get().chips.map((c) => c.label)).toEqual(['Team: Pixelwerk', 'Label: Mobile']);
    expect(labelParam('l3', meta.labels as never)).toBe('Mobile');
    expect(labelIdsFrom(['mobile', 'l1', 'Unknown'], meta.labels as never)).toEqual(['l3', 'l1', 'Unknown']);
    // Duplicate name (e.g. in two teams): stays with the id.
    expect(labelParam('l3', [...meta.labels, { _id: 'l9', name: 'mobile' }] as never)).toBe('l3');
    const url = writeLocation(new URL('http://x/all'), { page: { name: 'view', view: { kind: 'all', team: null } }, filters: { ...app.list.view.get().filters, label: ['l3'] }, quick: '', group: null, order: null }, meta.labels as never);
    expect(url.searchParams.get('label')).toBe('Mobile');
  });

  test('opening an issue outside the list and going back: the focus stays in the list', async () => {
    const { app } = await setup([doc(0), doc(1), doc(2, { deletedAt: 5 })]);
    app.nav.goView({ kind: 'all', team: null }, { group: 'none' });
    const order = [...app.list.order()];
    expect(order).not.toContain('i2');
    app.list.focus(order[1]);
    app.openIssue('i2' as IssueId);
    expect(app.nav.page.get()).toMatchObject({ name: 'issue' });
    app.closeIssue();
    expect(app.nav.page.get().name).toBe('view');
    expect(app.list.focusId()).toBe(order[1]);
  });
});

describe('move to team', () => {
  const withTeamLabel = { ...meta, labels: [...meta.labels, { _id: 'l9', _creationTime: 0, name: 'Release', hue: 45, teamId: 't1' }] } as never;

  test('shortcut Ctrl Shift M, also in the command menu and in the context menu of selections', () => {
    const action = actionById('issue.team')!;
    expect(action.keys).toEqual(['mod+shift+m']);
    expect(action.label).toBe('Move to team …');
    expect(action.context).toBeDefined();
    expect(action.top).toBe(true);
  });

  test('without loss (no project, no team labels): move right away, with a notice', async () => {
    const { client, app } = await setup();
    client.push('meta:get', {}, withTeamLabel);
    await flush();
    app.nav.goView({ kind: 'all', team: null }, { group: 'none' });
    app.palette.open('team', { target: { kind: 'issues', ids: ids('i1') } });
    chooseId(app, 't:t1');
    await flush();
    expect(app.palette.state.get()).toBeNull();
    expect(calls(client, 'issues:moveTeam')).toEqual([{ ids: ['i1'], teamId: 't1' }]);
  });

  test('with loss: first a confirmation with project and team labels, back leads to the team picker, Enter moves', async () => {
    const { client, app } = await setup([doc(0, { projectId: 'p1' as never, labelIds: ['l9', 'l1'] as never }), doc(1), doc(2)]);
    client.push('meta:get', {}, withTeamLabel);
    await flush();
    app.nav.goView({ kind: 'all', team: null }, { group: 'none' });
    app.palette.open('team', { target: { kind: 'issues', ids: ids('i0') } });
    chooseId(app, 't:t2');
    const s = app.palette.state.get()!;
    expect(calls(client, 'issues:moveTeam')).toHaveLength(0);
    expect(s.items.map((i) => i.id)).toEqual(['mvc:ok', 'mvc:no']);
    expect(s.items[0].label).toBe('Move to Pixelwerk');
    expect(s.hint).toContain('Project “Export” is removed');
    expect(s.hint).toContain('Labels of the old team are removed: Release');
    expect(s.hint).not.toContain('Bug');
    expect(s.hint).toContain('ACME-1 stays valid as a link');

    app.palette.back();
    expect(app.palette.state.get()!.items.some((i) => i.id === 't:t2')).toBe(true);
    chooseId(app, 't:t2');
    app.palette.choose(0);
    await flush();
    expect(app.palette.state.get()).toBeNull();
    expect(calls(client, 'issues:moveTeam')).toEqual([{ ids: ['i0'], teamId: 't2' }]);
  });

  test('several issues: one confirmation for all, cancel moves nothing', async () => {
    const { client, app } = await setup([doc(0, { projectId: 'p1' as never }), doc(2, { projectId: 'p1' as never }), doc(4)]);
    app.nav.goView({ kind: 'all', team: null }, { group: 'none' });
    app.palette.open('team', { target: { kind: 'issues', ids: ids('i0', 'i2', 'i4') } });
    expect(app.palette.state.get()!.targetLabel).toBe('3 issues');
    chooseId(app, 't:t2');
    const s = app.palette.state.get()!;
    expect(s.items[0].label).toBe('Move 3 issues to Pixelwerk');
    expect(s.hint).toContain('2 issues lose their project: “Export”');
    expect(s.hint).toContain('New IDs in PX');
    chooseId(app, 'mvc:no');
    await flush();
    expect(calls(client, 'issues:moveTeam')).toHaveLength(0);
  });
});
