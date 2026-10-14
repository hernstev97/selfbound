import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { REPO_ROOT, runFetch, runId } from '../../../../tooling/linear-import/index.ts';
import { CONFIRM_WORD, runPush, stageBatches } from '../../../../tooling/linear-import/push.ts';
import { fakeLinear, SECRET_TEXT } from './fixtures';

const base = mkdtempSync(join(tmpdir(), 'selfbound-import-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const keyFile = join(base, 'linear-api-key');
writeFileSync(keyFile, 'lin_api_synthetic_0000\n', { mode: 0o600 });
const NOW = Date.UTC(2026, 9, 8, 21, 30, 0, 123);

describe('CLI fetch', () => {
  test('writes snapshot, staging.jsonl and log outside the repository, private', async () => {
    const lines: string[] = [];
    const fake = fakeLinear();
    const outRoot = join(base, 'out');
    const result = await runFetch({ outRoot, keyFile, fetch: fake.fetch, now: () => NOW, print: (l) => lines.push(l) });
    expect(result.run).toBe('2026-10-08T21-30-00Z');
    expect(result.dir).toBe(join(outRoot, result.run));
    const dir = result.dir!;
    expect(readdirSync(dir).sort()).toEqual(['operations.jsonl', 'snapshot.json', 'staging.jsonl', 'summary.json']);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);

    const snapshot = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'));
    expect(snapshot).toMatchObject({ version: 1, source: 'linear', run: result.run });
    const staging = readFileSync(join(dir, 'staging.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(staging[0]).toMatchObject({ run: result.run, kind: 'team', linearId: 'team-kiu' });
    expect(staging).toHaveLength(Object.values(result.counts).reduce((a, b) => a + b, 0));
    const ops = readFileSync(join(dir, 'operations.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(ops.every((o) => o.kind === 'query' && o.operation.startsWith('Xlr'))).toBe(true);
    expect(ops).toHaveLength(fake.calls.length);

    // Console: only counts, ids, status names; no titles, texts or keys
    const output = lines.join('\n');
    expect(output).not.toContain(SECRET_TEXT);
    expect(output).not.toContain('lin_api_');
    expect(output).toContain('issues        7');
    expect(output).toMatch(/all of type query/);
    expect(output).toContain('tooling/linear-import/index.ts push');
  });

  test('--dry-run writes nothing', async () => {
    const outRoot = join(base, 'dry');
    const lines: string[] = [];
    const result = await runFetch({ dryRun: true, outRoot, keyFile, fetch: fakeLinear().fetch, now: () => NOW, print: (l) => lines.push(l) });
    expect(result.dir).toBeUndefined();
    expect(result.counts.issues).toBe(7);
    expect(existsSync(outRoot)).toBe(false);
    expect(lines.join('\n')).not.toContain(SECRET_TEXT);
  });

  test('an output directory inside the repository is refused before Linear is called', async () => {
    const fake = fakeLinear();
    await expect(
      runFetch({ outRoot: join(REPO_ROOT, 'tmp-import'), keyFile, fetch: fake.fetch, print: () => {} }),
    ).rejects.toThrow(/inside the repository/);
    expect(fake.calls).toEqual([]);
  });

  test('runId', () => {
    expect(runId(NOW)).toBe('2026-10-08T21-30-00Z');
  });
});

describe('CLI push --prod', () => {
  const dir = join(base, 'push-prod');
  const instance = { convexDeployment: 'happy-otter-123', appUrl: 'https://selfbound.example.com' };
  const staging = () => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const row = (kind: string, linearId: string) => JSON.stringify({ run: 'r1', kind, linearId, payload: {} });
    writeFileSync(join(dir, 'staging.jsonl'), [row('team', 't-1'), row('issue', 'i-1'), row('issue', 'i-2')].join('\n') + '\n');
    return dir;
  };

  test('shows production as the target and uploads nothing without the confirmation word', async () => {
    const lines: string[] = [];
    const questions: string[] = [];
    await expect(
      runPush({
        path: staging(),
        prod: true,
        instance,
        print: (l) => lines.push(l),
        ask: async (q) => {
          questions.push(q);
          return 'yes';
        },
      }),
    ).rejects.toThrow(/nothing uploaded/);
    expect(lines[0]).toBe('Target: PRODUCTION happy-otter-123 (https://happy-otter-123.convex.cloud, app https://selfbound.example.com)');
    expect(lines.join('\n')).toContain('Run:    r1, 3 rows: team 1, issue 2');
    expect(questions).toEqual([`Type "${CONFIRM_WORD}" to start in PRODUCTION: `]);
    expect(lines.some((l) => l.startsWith('Uploading'))).toBe(false);
  });

  test('--yes and --backend-dir do not apply to production', async () => {
    const ask = async () => CONFIRM_WORD;
    await expect(runPush({ path: staging(), prod: true, instance, yes: true, ask, print: () => {} })).rejects.toThrow(/--yes does not apply/);
    await expect(runPush({ path: staging(), prod: true, instance, backendDir: base, ask, print: () => {} })).rejects.toThrow(/mutually exclusive/);
  });

  test('without instance settings production is refused before asking', async () => {
    const questions: string[] = [];
    const ask = async (q: string) => (questions.push(q), CONFIRM_WORD);
    await expect(runPush({ path: staging(), prod: true, instance: {}, ask, print: () => {} })).rejects.toThrow(/production target unknown/);
    await expect(runPush({ path: staging(), prod: true, instance: { convexDeployment: 'happy-otter-123' }, ask, print: () => {} })).rejects.toThrow(
      /production target unknown/,
    );
    expect(questions).toEqual([]);
  });

  test('push and tooling/cloud.mjs read the production deployment from the same instance settings', () => {
    const push = readFileSync(join(REPO_ROOT, 'tooling', 'linear-import', 'push.ts'), 'utf8');
    const cloud = readFileSync(join(REPO_ROOT, 'tooling', 'cloud.mjs'), 'utf8');
    expect(push).toMatch(/from '\.\.\/instance\.mjs'/);
    expect(cloud).toMatch(/from '\.\/instance\.mjs'/);
    expect(cloud).not.toMatch(/PROD_DEPLOYMENT = '/);
  });
});

describe('stageBatches', () => {
  const row = (n: number, size = 10) => JSON.stringify({ run: 'r1', kind: 'issue', linearId: `i-${n}`, payload: { t: 'x'.repeat(size) } });

  test('batches stay below the byte limit and maxRows rows, order is kept', () => {
    const lines = Array.from({ length: 30 }, (_, i) => row(i, 300));
    const batches = stageBatches(lines, 2000, 4);
    expect(batches.flat()).toEqual(lines);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(4);
      expect(Buffer.byteLength(`{"rows":[${batch.join(',')}]}`)).toBeLessThan(2000);
    }
    expect(stageBatches(Array.from({ length: 1001 }, (_, i) => row(i)), 1_000_000).map((b) => b.length)).toEqual([500, 500, 1]);
  });

  test('a row that is too large aborts with kind and Linear ID, without content', () => {
    expect(() => stageBatches([row(1), row(2, 5000)], 2000)).toThrow(/Row issue i-2 has \d+ bytes, too large/);
  });
});
