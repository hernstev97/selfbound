// Shared test helpers: fake Convex client, reference data, issue documents.
import { vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import { OWNER_KIND, type IssueDoc, type Meta } from '../src/types.ts';
import { DEFAULT_STATES } from '@xlr8/backend/shared/workflow';

/** The default statuses per team with ids like "t1:todo". */
function defaultStates(teamId: string) {
  const positions = new Map<string, number>();
  return DEFAULT_STATES.map((d) => {
    const position = positions.get(d.type) ?? 0;
    positions.set(d.type, position + 1);
    return { _id: `${teamId}:${d.legacyKey}`, _creationTime: 0, teamId, name: d.name, type: d.type, position, legacyKey: d.legacyKey, ...(d.isDuplicate ? { isDuplicate: true } : {}), createdAt: 0, updatedAt: 0 };
  });
}

globalThis.requestAnimationFrame ??= ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0)) as unknown as typeof requestAnimationFrame;

export const flush = () => new Promise((r) => setTimeout(r, 0));

export const meta: Meta = {
  workflowStates: [...defaultStates('t1'), ...defaultStates('t2'), ...defaultStates('t3')] as unknown as Meta['workflowStates'],
  teams: [
    { _id: 't1', _creationTime: 0, key: 'ACME', name: 'Acme', hue: 250, dormant: false, order: 0, updatedAt: 0, logoUrl: null, logoDarkUrl: null },
    { _id: 't2', _creationTime: 0, key: 'PX', name: 'Pixelwerk', hue: 330, dormant: false, order: 1, updatedAt: 0, logoUrl: 'https://x/logo.svg', logoDarkUrl: null },
    { _id: 't3', _creationTime: 0, key: 'MOSAIK', name: 'Mosaik', hue: 290, dormant: true, order: 2, updatedAt: 0, logoUrl: null, logoDarkUrl: null },
  ] as unknown as Meta['teams'],
  projects: [{ _id: 'p1', _creationTime: 0, teamId: 't1', name: 'Export', state: 'active', order: 0, updatedAt: 0 }] as unknown as Meta['projects'],
  labelGroups: [{ _id: 'g1', _creationTime: 0, name: 'Type', exclusive: true, hue: 25 }] as unknown as Meta['labelGroups'],
  labels: [
    { _id: 'l1', _creationTime: 0, name: 'Bug', hue: 25, groupId: 'g1' },
    { _id: 'l2', _creationTime: 0, name: 'Feature', hue: 265, groupId: 'g1' },
    { _id: 'l3', _creationTime: 0, name: 'Mobile', hue: 160 },
  ] as unknown as Meta['labels'],
  sprints: [
    { _id: 's4', _creationTime: 0, number: 4, name: 'Sprint 4', goal: '', startDate: '2026-10-05', endDate: '2026-10-18', state: 'active', source: 'xlr8', updatedAt: 0 },
    { _id: 's5', _creationTime: 0, number: 5, name: 'Sprint 5', goal: '', startDate: '2026-10-19', endDate: '2026-11-01', state: 'planning', source: 'xlr8', updatedAt: 0 },
  ] as unknown as Meta['sprints'],
  rejectWrites: false,
};

export function doc(seq: number, patch: Partial<IssueDoc> = {}): IssueDoc {
  return {
    _id: `i${seq}`,
    _creationTime: 0,
    seq,
    bucket: Math.floor(seq / 64),
    teamId: seq % 2 ? 't2' : 't1',
    number: seq + 1,
    title: `Issue number ${seq}`,
    status: (['todo', 'backlog', 'in_progress', 'done'] as const)[seq % 4],
    stateId: `${seq % 2 ? 't2' : 't1'}:${(['todo', 'backlog', 'in_progress', 'done'] as const)[seq % 4]}`,
    priority: (seq % 5) as IssueDoc['priority'],
    labelIds: seq % 3 === 0 ? ['l1'] : [],
    rank: `a${String(seq).padStart(5, '0')}`,
    createdBy: { kind: OWNER_KIND },
    reviewedAt: 1,
    createdAt: seq,
    updatedAt: seq,
    ...patch,
    // The status follows team and status type if the test sets only one of them.
    ...(patch.stateId === undefined && (patch.status !== undefined || patch.teamId !== undefined)
      ? { stateId: `${patch.teamId ?? (seq % 2 ? 't2' : 't1')}:${patch.status ?? (['todo', 'backlog', 'in_progress', 'done'] as const)[seq % 4]}` }
      : {}),
  } as IssueDoc;
}

type Callback = (value: unknown) => void;

/** Stand-in for ConvexClient: subscriptions by name + arguments, mutations as a mock. */
export function fakeClient() {
  const subs = new Map<string, Callback>();
  const errors = new Map<string, (e: Error) => void>();
  const key = (fn: unknown, args: unknown) => `${getFunctionName(fn as never)}:${JSON.stringify(args)}`;
  const client = {
    subs,
    push(name: string, args: unknown, value: unknown) {
      const cb = subs.get(`${name}:${JSON.stringify(args)}`);
      if (!cb) throw new Error(`No subscription for ${name} ${JSON.stringify(args)}; present: ${[...subs.keys()].join(', ')}`);
      cb(value);
    },
    /** Report an error result of a query (like the server's 1 s limit). */
    fail(name: string, args: unknown, error = new Error('Function execution timed out')) {
      const cb = errors.get(`${name}:${JSON.stringify(args)}`);
      if (!cb) throw new Error(`No error handler for ${name} ${JSON.stringify(args)}`);
      cb(error);
    },
    has(name: string, args: unknown) {
      return subs.has(`${name}:${JSON.stringify(args)}`);
    },
    onUpdate(fn: unknown, args: unknown, cb: Callback, onError?: (e: Error) => void) {
      const k = key(fn, args);
      subs.set(k, cb);
      if (onError) errors.set(k, onError);
      return () => {
        if (subs.get(k) === cb) {
          subs.delete(k);
          errors.delete(k);
        }
      };
    },
    subscribeToConnectionState() {
      return () => {};
    },
    connectionState() {
      return { isWebSocketConnected: true, connectionRetries: 0 };
    },
    setAuth() {},
    mutation: vi.fn(async (_fn: unknown, _args: unknown, _opts?: unknown): Promise<unknown> => ({ updatedAt: 1, changed: 1, warnings: [] })),
    query: vi.fn(async (_fn: unknown, _args: unknown): Promise<unknown> => null),
  };
  return client;
}

export type FakeClient = ReturnType<typeof fakeClient>;

/** Function name of a mutation call. */
export function callName(call: unknown[]) {
  return getFunctionName(call[0] as never);
}
