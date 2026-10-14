import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  assertReadOnly,
  LinearApiError,
  LinearClient,
  readApiKey,
  ReadOnlyViolation,
} from '../../../../tooling/linear-import/client.ts';
import { fetchLinearData, QUERIES } from '../../../../tooling/linear-import/queries.ts';
import { fakeLinear, jsonResponse } from './fixtures';

const KEY = 'lin_api_synthetic_0000';
const noSleep = () => {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
};

describe('read-only guard', () => {
  test('allows exactly one named query', () => {
    expect(assertReadOnly('query XlrTeams { teams { nodes { id } } }')).toBe('XlrTeams');
    for (const doc of Object.values(QUERIES)) expect(() => assertReadOnly(doc)).not.toThrow();
  });

  test.each([
    ['mutation', 'mutation Del { issueDelete(id: "x") { success } }', /mutation/],
    ['subscription', 'subscription S { issueUpdated { id } }', /subscription/],
    ['anonymous mutation', 'mutation { issueCreate(input: { title: "query" }) { success } }', /mutation/],
    ['mutation behind a comment', '# query Harmless\nmutation M { x }', /mutation/],
    ['query plus mutation', 'query A { viewer { id } } mutation B { x }', /Exactly one operation/],
    ['fragment', 'query A { viewer { ...F } } fragment F on User { id }', /Exactly one operation/],
    ['fragment only', 'fragment F on User { id }', /FragmentDefinition/],
    ['schema definition', 'type Query { x: Int }', /ObjectTypeDefinition/],
    ['anonymous query', '{ viewer { id } }', /needs a name/],
    ['syntax error', 'query { ', /cannot be parsed/],
  ])('rejects: %s', (_label, doc, message) => {
    expect(() => assertReadOnly(doc)).toThrow(ReadOnlyViolation);
    expect(() => assertReadOnly(doc)).toThrow(message);
  });

  test('the client never sends a mutation', async () => {
    const fake = fakeLinear();
    const client = new LinearClient({ apiKey: KEY, fetch: fake.fetch });
    await expect(client.query('mutation Del { issueDelete(id: "x") { success } }')).rejects.toThrow(ReadOnlyViolation);
    expect(fake.calls).toEqual([]);
    expect(client.log).toEqual([]);
  });
});

describe('options', () => {
  test('options passed explicitly as undefined keep their default (as from runFetch)', async () => {
    const fake = fakeLinear();
    const client = new LinearClient({ apiKey: KEY, fetch: fake.fetch, sleep: undefined, now: undefined });
    const raw = await fetchLinearData(client, () => {});
    expect(raw.issues.length).toBeGreaterThan(0);
    expect(client.log.every((entry) => typeof entry.ms === 'number')).toBe(true);
  });
});

describe('pagination', () => {
  test('all pages, variables first/after, key without "Bearer"', async () => {
    const fake = fakeLinear();
    const client = new LinearClient({ apiKey: KEY, fetch: fake.fetch });
    const states = await client.paginate(QUERIES.workflowStates, {}, (d: any) => d.workflowStates, 4);
    expect(states).toHaveLength(10);
    expect(fake.calls.map((c) => c.variables)).toEqual([
      { first: 4, after: null },
      { first: 4, after: '4' },
      { first: 4, after: '8' },
    ]);
    expect(fake.calls.every((c) => c.auth === KEY && c.kind === 'query')).toBe(true);
  });

  test('fetchLinearData completes nested connections (30 comments > 25)', async () => {
    const fake = fakeLinear();
    const client = new LinearClient({ apiKey: KEY, fetch: fake.fetch });
    const raw = await fetchLinearData(client);
    expect(raw.teams).toHaveLength(3);
    expect(raw.issues).toHaveLength(8);
    const kiu2 = raw.issues.find((i) => i.identifier === 'KIU-2')!;
    expect(kiu2.comments.nodes).toHaveLength(30);
    expect(new Set(kiu2.comments.nodes.map((c) => c.id)).size).toBe(30);
    expect(client.summary()).toEqual({
      XlrTeams: 1,
      XlrWorkflowStates: 1,
      XlrIssueLabels: 1,
      XlrProjects: 1,
      XlrCycles: 1,
      XlrIssues: 1,
      XlrIssueCommentsMore: 1,
    });
    expect(client.log.every((e) => e.kind === 'query')).toBe(true);
    expect(fake.calls.every((c) => c.kind === 'query')).toBe(true);
  });

  test('hasNextPage without a new cursor aborts', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ data: { teams: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } })) as typeof fetch;
    const client = new LinearClient({ apiKey: KEY, fetch: fetchImpl });
    await expect(client.paginate(QUERIES.teams, {}, (d: any) => d.teams)).rejects.toThrow(/endCursor/);
  });
});

describe('rate limits and errors', () => {
  test('HTTP 429 with Retry-After: waits and retries', async () => {
    const fake = fakeLinear({
      before: (_op, call) => (call <= 2 ? new Response('{}', { status: 429, headers: { 'retry-after': '3' } }) : undefined),
    });
    const { waits, sleep } = noSleep();
    const client = new LinearClient({ apiKey: KEY, fetch: fake.fetch, sleep });
    const data = await client.query<{ teams: { nodes: unknown[] } }>(QUERIES.teams, { first: 50 });
    expect(data.teams.nodes).toHaveLength(3);
    expect(waits).toEqual([3000, 3000]);
    expect(client.log.map((e) => [e.status, e.attempt])).toEqual([
      [429, 1],
      [429, 2],
      [200, 3],
    ]);
  });

  test('RATELIMITED in the body (HTTP 400) with a reset header', async () => {
    const now = 1_000_000;
    const fake = fakeLinear({
      before: (_op, call) =>
        call === 1
          ? jsonResponse({ errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] }, 400, {
              'x-ratelimit-requests-reset': String(now + 5000),
            })
          : undefined,
    });
    const { waits, sleep } = noSleep();
    const client = new LinearClient({ apiKey: KEY, fetch: fake.fetch, sleep, now: () => now });
    await client.query(QUERIES.teams, { first: 50 });
    expect(waits).toEqual([5250]);
  });

  test('exponential without headers, aborts after too many attempts', async () => {
    const fake = fakeLinear({ before: () => new Response('', { status: 429 }) });
    const { waits, sleep } = noSleep();
    const client = new LinearClient({ apiKey: KEY, fetch: fake.fetch, sleep, maxRateLimitRetries: 4 });
    await expect(client.query(QUERIES.teams, { first: 50 })).rejects.toThrow(/Rate limit/);
    expect(waits).toEqual([1000, 2000, 4000, 8000]);
  });

  test('5xx and network errors are retried', async () => {
    let n = 0;
    const base = fakeLinear();
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      n++;
      if (n === 1) throw new TypeError('fetch failed');
      if (n === 2) return new Response('bad gateway', { status: 502 });
      return base.fetch(url, init);
    }) as typeof fetch;
    const { waits, sleep } = noSleep();
    const client = new LinearClient({ apiKey: KEY, fetch: fetchImpl, sleep });
    await client.query(QUERIES.teams, { first: 50 });
    expect(waits).toEqual([1000, 2000]);
    expect(client.log.map((e) => e.status)).toEqual(['network-error', 502, 200]);
  });

  test('rejected key: aborts immediately', async () => {
    const fake = fakeLinear({
      before: () => jsonResponse({ errors: [{ message: 'auth', extensions: { code: 'AUTHENTICATION_ERROR' } }] }, 401),
    });
    const client = new LinearClient({ apiKey: KEY, fetch: fake.fetch, sleep: async () => {} });
    await expect(client.query(QUERIES.teams, { first: 50 })).rejects.toThrow(LinearApiError);
    expect(fake.calls).toHaveLength(1);
  });

  test('GraphQL errors are reported', async () => {
    const fake = fakeLinear({ before: () => jsonResponse({ errors: [{ message: 'Field "x" not found' }] }, 400) });
    const client = new LinearClient({ apiKey: KEY, fetch: fake.fetch });
    await expect(client.query(QUERIES.teams, { first: 50 })).rejects.toThrow(/Field "x" not found/);
  });
});

describe('key file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'selfbound-key-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('mode 600: ok, whitespace and line end are trimmed', () => {
    const file = join(dir, 'ok');
    writeFileSync(file, `${KEY}\n`, { mode: 0o600 });
    expect(readApiKey(file)).toBe(KEY);
  });

  test('readable by others: aborts with a chmod hint', () => {
    const file = join(dir, 'open');
    writeFileSync(file, KEY);
    chmodSync(file, 0o644);
    expect(() => readApiKey(file)).toThrow(/chmod 600/);
    chmodSync(file, 0o640);
    expect(() => readApiKey(file)).toThrow(/mode 640/);
  });

  test('missing, empty or symlink: aborts', () => {
    expect(() => readApiKey(join(dir, 'missing'))).toThrow(/No Linear API key/);
    const empty = join(dir, 'empty');
    writeFileSync(empty, '\n', { mode: 0o600 });
    expect(() => readApiKey(empty)).toThrow(/is empty/);
    const link = join(dir, 'link');
    symlinkSync(join(dir, 'ok'), link);
    expect(() => readApiKey(link)).toThrow(/symlinks/);
  });
});
