import 'fake-indexeddb/auto';
import { describe, expect, test, vi } from 'vitest';
import { IssueStore, applyPatch, sameIssue } from '../src/store.ts';
import { Mirror, MIRROR_SCHEMA } from '../src/idb.ts';
import { workflowsOf } from '../src/workflow.ts';
import type { Issue, IssueDoc, IssueId } from '../src/types.ts';
import { callName, doc, fakeClient, flush, meta } from './helpers.ts';

let n = 0;
function setup() {
  const client = fakeClient();
  const store = new IssueStore(client as never, { cacheName: `test-${++n}`, hooks: { saves: [] } });
  return { client, store };
}

async function started(maxSeq = 129) {
  const s = setup();
  await s.store.start();
  s.client.push('meta:get', {}, meta);
  s.client.push('meta:counter', {}, { maxSeq });
  return s;
}

const enriched = (d: IssueDoc) => ({ ...d, key: 'X-1' }) as Issue;

describe('sameIssue compares all fields generically', () => {
  // Change every schema field on its own: the change must be detected.
  const base = doc(5, { projectId: 'p1' as never, estimate: 3, dueDate: '2026-10-10', parentId: 'i1' as never, sprintId: 's4' as never, startedAt: 9, completedAt: 10, canceledAt: 11, deletedAt: 12, recurrenceId: 'r1' as never });
  const changes: Record<string, unknown> = {
    seq: 6,
    bucket: 9,
    teamId: 't9',
    number: 99,
    title: 'New',
    status: 'done',
    priority: 1,
    labelIds: ['l2'],
    projectId: 'p2',
    estimate: 8,
    dueDate: '2026-12-24',
    stateId: 't2:done',
    parentId: 'i2',
    sprintId: 's5',
    rank: 'zz',
    createdBy: { kind: 'agent', agentId: 'a1' },
    reviewedAt: 77,
    createdAt: 1234,
    updatedAt: 999,
    startedAt: 1,
    completedAt: 2,
    canceledAt: 3,
    deletedAt: 4,
    recurrenceId: 'r2',
    _creationTime: 5,
  };
  test('the same document counts as equal', () => {
    expect(sameIssue(enriched(base), { ...base, labelIds: [...base.labelIds], createdBy: { ...base.createdBy } })).toBe(true);
  });
  for (const [field, value] of Object.entries(changes)) {
    test(`change to ${field}`, () => {
      expect(sameIssue(enriched(base), { ...base, [field]: value } as IssueDoc)).toBe(false);
    });
  }
  test('a removed field (e.g. project cleared) is detected', () => {
    const { projectId: _, ...rest } = base;
    expect(sameIssue(enriched(base), rest as IssueDoc)).toBe(false);
  });
  test('a new, unknown field is detected', () => {
    expect(sameIssue(enriched(base), { ...base, kuenftig: 1 } as unknown as IssueDoc)).toBe(false);
  });
  test('all schema fields are covered', () => {
    expect(Object.keys(base).filter((k) => k !== '_id').sort()).toEqual(Object.keys(changes).sort());
  });
});

describe('IssueStore', () => {
  test('subscribes to buckets after meta.counter and keeps unchanged objects', async () => {
    const { client, store } = await started(129);
    expect([...client.subs.keys()].filter((k) => k.startsWith('issues:bucket'))).toHaveLength(3);
    const bucket0 = Array.from({ length: 64 }, (_, i) => doc(i));
    const changes: number[] = [];
    store.onChange((ids) => changes.push(ids.size));
    client.push('issues:bucket', { bucket: 0 }, bucket0);
    await flush();
    expect(changes).toEqual([64]);
    const before = store.get('i5' as IssueId);
    expect(before?.key).toBe('PX-6');
    // Convex sends the whole bucket again, only i6 changed.
    client.push('issues:bucket', { bucket: 0 }, bucket0.map((d) => (d.seq === 6 ? { ...d, status: 'done', updatedAt: 99 } : { ...d })));
    await flush();
    expect(changes).toEqual([64, 1]);
    expect(store.get('i5' as IssueId)).toBe(before);
    expect(store.get('i6' as IssueId)?.status).toBe('done');
    expect(store.byKey('acme-7')?._id).toBe('i6');
  });

  test('a new bucket after maxSeq grows, live only once all are there', async () => {
    const { client, store } = await started(10);
    client.push('issues:bucket', { bucket: 0 }, [doc(0), doc(1)]);
    await flush();
    expect(store.sync.get().phase).toBe('live');
    client.push('meta:counter', {}, { maxSeq: 70 });
    expect(client.has('issues:bucket', { bucket: 1 })).toBe(true);
  });

  test('resubscribes to a bucket after a server error, else sync would stall', async () => {
    const { client, store } = await started(129);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      for (const bucket of [2, 1]) client.push('issues:bucket', { bucket }, [doc(bucket * 64)]);
      client.fail('issues:bucket', { bucket: 0 });
      expect(client.has('issues:bucket', { bucket: 0 })).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.has('issues:bucket', { bucket: 0 })).toBe(true);
      // Failure on the second attempt too: resubscribe again.
      client.fail('issues:bucket', { bucket: 0 });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.has('issues:bucket', { bucket: 0 })).toBe(true);
      expect(store.sync.get().phase).toBe('syncing');
      client.push('issues:bucket', { bucket: 0 }, [doc(0)]);
      await vi.advanceTimersByTimeAsync(10);
      expect(store.sync.get().phase).toBe('live');
    } finally {
      vi.useRealTimers();
    }
  });

  test('stop also ends retries after a bucket error', async () => {
    const { client, store } = await started(10);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      client.fail('issues:bucket', { bucket: 0 });
      store.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.has('issues:bucket', { bucket: 0 })).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('removes issues that disappear from a bucket', async () => {
    const { client, store } = await started(3);
    client.push('issues:bucket', { bucket: 0 }, [doc(0), doc(1), doc(2)]);
    await flush();
    client.push('issues:bucket', { bucket: 0 }, [doc(0), doc(2)]);
    await flush();
    expect(store.get('i1' as IssueId)).toBeUndefined();
    expect(store.all()).toHaveLength(2);
  });

  test('an optimistic update patches only the issue\'s bucket', async () => {
    const { client, store } = await started();
    client.push('issues:bucket', { bucket: 1 }, [doc(64), doc(65)]);
    await flush();
    await store.update(['i65' as IssueId], { status: 'done', projectId: null });
    const [fn, args, options] = client.mutation.mock.calls[0] as unknown as [unknown, { ids: string[]; patch: object }, { optimisticUpdate: (s: unknown) => void }];
    expect(callName([fn])).toBe('issues:update');
    expect(args.ids).toEqual(['i65']);
    const written: unknown[] = [];
    options.optimisticUpdate({
      getQuery: (_fn: unknown, a: { bucket: number }) => (a.bucket === 1 ? [doc(64), doc(65, { projectId: 'p1' as never })] : undefined),
      setQuery: (_fn: unknown, a: unknown, value: IssueDoc[]) => written.push([a, value.map((d) => [d.status, d.projectId ?? null])]),
    });
    expect(written).toEqual([[{ bucket: 1 }, [['todo', null], ['done', null]]]]);
  });

  test('applyPatch: moving to done, canceled or duplicate clears the priority', () => {
    const workflows = workflowsOf(meta);
    const open = doc(0, { priority: 2 });
    for (const status of ['done', 'canceled', 'duplicate'] as const) {
      expect(applyPatch(open, { status }, 1, workflows)).toMatchObject({ status, priority: 0 });
    }
    // Even if the same patch brings a priority; open statuses keep it.
    expect(applyPatch(open, { stateId: 't1:done' as never, priority: 3 }, 1, workflows).priority).toBe(0);
    expect(applyPatch(open, { stateId: 't1:in_progress' as never }, 1, workflows).priority).toBe(2);
    // Out of done: the priority only comes back if the patch brings it (undo).
    const done = doc(0, { priority: 0, status: 'done', stateId: 't1:done' as never });
    expect(applyPatch(done, { stateId: 't1:todo' as never }, 1, workflows).priority).toBe(0);
    expect(applyPatch(done, { stateId: 't1:todo' as never, priority: 2 }, 1, workflows).priority).toBe(2);
  });

  test('applyPatch: null removes the field, updatedAt is set', () => {
    const next = applyPatch(doc(1, { estimate: 3 }), { estimate: null, title: 'T' }, 42);
    expect('estimate' in next).toBe(false);
    expect(next.title).toBe('T');
    expect(next.updatedAt).toBe(42);
  });

  test('create: provisional row right away, swapped exactly when the real issue is in the bucket', async () => {
    const { client, store } = await started(1);
    client.push('issues:bucket', { bucket: 0 }, [doc(0), doc(1)]);
    await flush();
    let resolveCreate!: (v: unknown) => void;
    client.mutation.mockImplementationOnce(() => new Promise((r) => (resolveCreate = r)));
    const { temps, done } = store.create([{ teamId: 't1' as never, title: 'New', priority: 2 }]);
    await flush();
    const tmp = temps[0];
    expect(store.get(tmp)?.pending).toBe(true);
    expect(store.get(tmp)?.key).toBe('ACME-…');
    expect(store.all().map((i) => i._id)).toContain(tmp);
    // A change to the provisional row applies locally right away.
    void store.update([tmp], { priority: 1 });
    await flush();
    expect(store.get(tmp)?.priority).toBe(1);
    // Server confirms, bucket not there yet: the row stays (no gap).
    resolveCreate({ issues: [{ id: 'i2', identifier: 'ACME-3' }], warnings: [] });
    await flush();
    expect(store.all().filter((i) => i.title === 'New')).toHaveLength(1);
    expect(store.get(tmp)?.pending).toBe(true);
    // The bucket arrives with the real issue: no duplicate, provisional row gone.
    client.push('meta:counter', {}, { maxSeq: 2 });
    client.push('issues:bucket', { bucket: 0 }, [doc(0), doc(1), doc(2, { title: 'New', teamId: 't1' as never })]);
    await flush();
    expect(store.all().filter((i) => i.title === 'New').map((i) => i._id)).toEqual(['i2']);
    expect(store.resolvedId(tmp)).toBe('i2');
    expect(store.get(tmp)?._id).toBe('i2');
    expect(await done).toEqual(['i2']);
    // The earlier change was sent with the real id after the confirmation.
    const updates = client.mutation.mock.calls.filter((c) => callName(c) === 'issues:update');
    expect((updates.at(-1)![1] as { ids: string[] }).ids).toEqual(['i2']);
  });

  test('create fails: the provisional row disappears', async () => {
    const { client, store } = await started(1);
    client.mutation.mockImplementationOnce(async () => {
      throw new Error('broken');
    });
    const { temps, done } = store.create([{ teamId: 't1' as never, title: 'Will fail' }]);
    await expect(done).rejects.toThrow('broken');
    await flush();
    expect(store.get(temps[0])).toBeUndefined();
  });

  test('comment and description: optimistic in the detail subscription', async () => {
    const { client, store } = await started(1);
    store.watchDetail('i1' as IssueId, () => {});
    await store.addComment('i1' as IssueId, 'Hello');
    const [, , opts] = client.mutation.mock.calls.at(-1) as unknown as [unknown, unknown, { optimisticUpdate: (s: unknown) => void }];
    let written: { comments: { body: string; pending?: boolean }[] } | null = null;
    opts.optimisticUpdate({ getQuery: () => ({ comments: [], body: { version: 1 } }), setQuery: (_f: unknown, _a: unknown, v: typeof written) => (written = v) });
    expect(written!.comments[0]).toMatchObject({ body: 'Hello', pending: true });

    await store.setDescription('i1' as IssueId, 'New', 3);
    const [, args, opts2] = client.mutation.mock.calls.at(-1) as unknown as [unknown, { baseVersion: number }, { optimisticUpdate: (s: unknown) => void }];
    expect(args.baseVersion).toBe(3);
    let body: { body: { version: number; markdown: string } } | null = null;
    opts2.optimisticUpdate({ getQuery: () => ({ body: { version: 3, markdown: 'Old' } }), setQuery: (_f: unknown, _a: unknown, v: typeof body) => (body = v) });
    expect(body!.body).toMatchObject({ version: 4, markdown: 'New' });
  });

  test('active sprint: planned/added later from sprints.items', async () => {
    const { client, store } = await started(1);
    expect(client.has('sprints:items', { sprintId: 's4' })).toBe(true);
    client.push('sprints:items', { sprintId: 's4' }, [
      { issueId: 'i1', kind: 'late', removedAt: null },
      { issueId: 'i0', kind: 'planned', removedAt: 5 },
    ]);
    expect(store.sprintKinds.get().get('i1' as IssueId)).toBe('late');
    expect(store.sprintKinds.get().has('i0' as IssueId)).toBe(false);
  });
});

describe('detail subscriptions', () => {
  test('a new detail subscription survives the cleanup after many preloads', () => {
    const { client, store } = setup();
    for (let i = 0; i < 20; i++) store.prefetchDetail(`p${i}` as IssueId);
    const seen: string[] = [];
    store.watchDetail('new' as IssueId, () => seen.push('new'));
    expect(client.has('issues:detail', { id: 'new' })).toBe(true);
    client.push('issues:detail', { id: 'new' }, { id: 'new', body: { markdown: 'x' }, comments: [] });
    expect(seen).toEqual(['new']);
    expect(store.detail('new' as IssueId)?.body.markdown).toBe('x');
    expect(store.detailCount).toBeLessThanOrEqual(17);
  });

  test('subscriptions with listeners are never dropped', () => {
    const { client, store } = setup();
    store.watchDetail('offen' as IssueId, () => {});
    for (let i = 0; i < 40; i++) store.prefetchDetail(`p${i}` as IssueId);
    expect(client.has('issues:detail', { id: 'offen' })).toBe(true);
  });
});

describe('IndexedDB mirror', () => {
  test('warm start from one entry, server buckets win', async () => {
    const mirror = new Mirror('spiegel-1', 0);
    mirror.setMeta(meta);
    mirror.setMaxSeq(65);
    mirror.setBucket(0, [doc(0), doc(1)]);
    mirror.setBucket(1, [doc(64)]);
    await mirror.flush();
    const { client, store } = (() => {
      const client = fakeClient();
      return { client, store: new IssueStore(client as never, { cacheName: 'spiegel-1' }) };
    })();
    await store.start();
    expect(store.sync.get().phase).toBe('cache');
    expect(store.all()).toHaveLength(3);
    expect(store.get('i64' as IssueId)?.key).toBe('ACME-65');
    void client;
  });

  test('different schema version: the mirror is dropped', async () => {
    const mirror = new Mirror('spiegel-2', 0);
    mirror.setMaxSeq(0);
    mirror.setBucket(0, [doc(0)]);
    await mirror.flush();
    expect(await new Mirror('spiegel-2').read()).not.toBeNull();
    // Write a schema "from yesterday"
    await new Promise<void>((resolve) => {
      const req = indexedDB.open('spiegel-2');
      req.onsuccess = () => {
        const tx = req.result.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ schema: MIRROR_SCHEMA - 1, meta: null, maxSeq: 0 }, 'head');
        tx.oncomplete = () => resolve();
      };
    });
    expect(await new Mirror('spiegel-2').read()).toBeNull();
  });

  test('writes only changed buckets', async () => {
    const mirror = new Mirror('spiegel-3', 0);
    mirror.setMaxSeq(65);
    mirror.setBucket(0, [doc(0)]);
    mirror.setBucket(1, [doc(64)]);
    await mirror.flush();
    mirror.setBucket(1, [doc(64, { title: 'new' })]);
    await mirror.flush();
    const snap = await new Mirror('spiegel-3').read();
    expect(Object.keys(snap!.buckets)).toEqual(['0', '1']);
    expect((snap!.buckets[1][0] as { title: string }).title).toBe('new');
  });
});
