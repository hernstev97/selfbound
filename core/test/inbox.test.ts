// Inbox entries in the client: merged into the issues, counted, sorted, worded; German too.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test } from 'vitest';
import { actionById } from '../src/app/actions.ts';
import { App } from '../src/app/index.ts';
import { Auth } from '../src/auth.ts';
import { setDictionary } from '../src/i18n.ts';
import de from '../src/locales/de.ts';
import { Mirror } from '../src/idb.ts';
import { IssueStore } from '../src/store.ts';
import type { InboxEntry, IssueId } from '../src/types.ts';
import { callName, doc, entry, fakeClient, flush, meta } from './helpers.ts';

let n = 0;
async function setup(docs = [doc(0), doc(1), doc(2)], entries: InboxEntry[] = []) {
  const client = fakeClient();
  const app = new App({ client: client as never, auth: new Auth({ devToken: 'x' }), debug: true, perf: false, cacheName: `inbox-${++n}` });
  app.start();
  await flush();
  client.push('meta:get', {}, meta);
  client.push('meta:counter', {}, { maxSeq: docs.length - 1 });
  client.push('agents:list', {}, [{ _id: 'a1', name: 'Aleister' }]);
  client.push('issues:bucket', { bucket: 0 }, docs);
  client.push('inbox:list', {}, entries);
  await flush();
  return { client, app };
}

const change = (field: string, patch: Partial<InboxEntry['changes'][number]> = {}) => ({ field, actor: { kind: 'agent' as const, agentId: 'a1' }, at: 100, ...patch }) as InboxEntry['changes'][number];
const rowText = (app: App, id: string) => app.main.rows.get(id as IssueId).get()?.inboxText;

afterEach(() => setDictionary('en', null));

describe('entries in the store', () => {
  test('an agent\'s change to an existing issue shows up in the inbox; the issue itself is as before', async () => {
    const { client, app } = await setup();
    app.nav.goView({ kind: 'inbox', team: null });
    expect(app.list.order()).toEqual([]);
    expect(app.sidebar.get().inbox).toBe(0);
    const before = app.store.get('i1' as IssueId);
    client.push('inbox:list', {}, [entry('i1', { kind: 'changed', updatedAt: 100, changes: [change('stateId', { value: 't2:done' })] })]);
    await flush();
    expect(app.list.order()).toEqual(['i1']);
    expect(app.sidebar.get().inbox).toBe(1);
    expect(rowText(app, 'i1')).toBe('Aleister set the status to Done');
    // Same issue data, only the merged entry differs.
    expect({ ...app.store.get('i1' as IssueId), inbox: undefined }).toEqual({ ...before, inbox: undefined });
  });

  test('several changes are one row: the latest leads, "n more changes"; reading and removing follow the entry', async () => {
    const changes = [change('comment', { at: 90, value: 'Done.' }), change('priority', { at: 95, value: 2 }), change('stateId', { at: 100, value: 't2:done' })];
    const { client, app } = await setup([doc(0), doc(1)], [entry('i1', { kind: 'changed', updatedAt: 100, changes })]);
    app.nav.goView({ kind: 'inbox', team: null });
    expect(app.list.order()).toEqual(['i1']);
    expect(rowText(app, 'i1')).toBe('Aleister set the status to Done · 2 more changes');
    expect(app.sidebar.get().inbox).toBe(1);
    // Read, then a new change: unread again and still one row.
    client.push('inbox:list', {}, [entry('i1', { kind: 'changed', updatedAt: 100, readAt: 150, changes })]);
    await flush();
    expect(app.sidebar.get().inbox).toBe(0);
    client.push('inbox:list', {}, [entry('i1', { kind: 'changed', updatedAt: 200, changes: [...changes, change('dueDate', { at: 200, value: '2026-12-24' })] })]);
    await flush();
    expect(app.list.order()).toEqual(['i1']);
    expect(app.sidebar.get().inbox).toBe(1);
    expect(rowText(app, 'i1')).toBe('Aleister set the due date to Thu, Dec 24 · 3 more changes');
    client.push('inbox:list', {}, []);
    await flush();
    expect(app.list.order()).toEqual([]);
    expect(app.store.entryGoneAt('i1' as IssueId)).toBeDefined();
  });

  test('entries that arrive before their issue are merged when the issue comes', async () => {
    const { client, app } = await setup([doc(0)], [entry('i70')]);
    client.push('meta:counter', {}, { maxSeq: 127 });
    await flush();
    client.push('issues:bucket', { bucket: 1 }, [doc(70)]);
    await flush();
    expect(app.store.get('i70' as IssueId)?.inbox?.issueId).toBe('i70');
    expect(app.sidebar.get().inbox).toBe(1);
  });

  const WORDING = [
    entry('i0', { kind: 'changed', changes: [change('comment', { value: 'x' })] }),
    entry('i1', { kind: 'changed', changes: [change('description')] }),
    entry('i2', { kind: 'changed', changes: [change('labelIds', { from: ['l1'], value: ['l1', 'l3'] })] }),
    entry('i3'),
  ];
  const wording = async () => {
    const { app } = await setup([doc(0), doc(1), doc(2), doc(3)], WORDING);
    return [0, 1, 2, 3].map((i) => rowText(app, `i${i}`));
  };

  test('wording: comment, description, labels, created', async () => {
    expect(await wording()).toEqual(['Aleister added a comment', 'Aleister changed the description', 'Aleister changed labels: added Mobile', 'Aleister created the issue']);
  });

  test('wording in German', async () => {
    setDictionary('de', de);
    expect(await wording()).toEqual(['Aleister hat einen Kommentar hinzugefügt', 'Aleister hat die Beschreibung geändert', 'Aleister hat Labels geändert: Mobile hinzugefügt', 'Aleister hat das Issue angelegt']);
  });

  test('remove and undo go through the issue IDs; the removed entry comes back at once', async () => {
    const { client, app } = await setup([doc(0), doc(1)], [entry('i0', { updatedAt: 5 }), entry('i1', { updatedAt: 6 })]);
    app.nav.goView({ kind: 'inbox', team: null });
    app.list.focus('i1' as IssueId);
    actionById('inbox.remove')!.run(app);
    await flush();
    const calls = (name: string) => client.mutation.mock.calls.filter((c) => callName(c) === name);
    expect(calls('issues:markReviewed').map((c) => c[1])).toEqual([{ ids: ['i1'] }]);
    // The optimistic update only touches the entries query, not the buckets.
    const options = calls('issues:markReviewed')[0][2] as { optimisticUpdate: (store: unknown) => void };
    let written: unknown;
    options.optimisticUpdate({ getQuery: () => [entry('i0'), entry('i1')], setQuery: (_f: unknown, _a: unknown, value: unknown) => (written = value) });
    expect((written as InboxEntry[]).map((e) => e.issueId)).toEqual(['i0']);
    client.push('inbox:list', {}, [entry('i0', { updatedAt: 5 })]);
    await flush();
    expect(app.list.order()).toEqual(['i0']);
    app.edit.undo();
    await flush();
    expect(calls('issues:markUnreviewed').map((c) => c[1])).toEqual([{ ids: ['i1'] }]);
    const undo = calls('issues:markUnreviewed')[0][2] as { optimisticUpdate: (store: unknown) => void };
    undo.optimisticUpdate({ getQuery: () => [entry('i0', { updatedAt: 5 })], setQuery: (_f: unknown, _a: unknown, value: unknown) => (written = value) });
    expect((written as InboxEntry[]).map((e) => e.issueId)).toEqual(['i1', 'i0']);
  });

  test('the mirror keeps the entries for the warm start', async () => {
    const mirror = new Mirror('inbox-mirror', 0);
    mirror.setMaxSeq(0);
    mirror.setBucket(0, [doc(0)]);
    mirror.setInbox([entry('i0')]);
    await mirror.flush();
    const snapshot = await new Mirror('inbox-mirror').read();
    expect(snapshot?.inbox).toHaveLength(1);
    const store = new IssueStore(fakeClient() as never, { cacheName: 'inbox-mirror' });
    await store.start();
    expect(store.get('i0' as IssueId)?.inbox?.issueId).toBe('i0');
    expect(store.counts().inbox).toBe(1);
  });
});
