import { describe, expect, test } from 'vitest';
import { api } from '../convex/_generated/api';
import { DAY_MS } from '../convex/lib/dates';
import { signBody } from '../convex/lib/github';
import { cleanupOld } from '../convex/ops/maintenance';
import { createOne, fixture, getIssue, historyOf, setup, stateId, type T } from './helpers';

// GitHub webhook over HTTP (t.fetch → convex/http.ts → internal.github.applyDelivery).

const SECRET = 'synthetic-test-secret';

function pr(action: string, extra: { branch?: string; title?: string; body?: string; merged?: boolean; updatedAt?: string; number?: number } = {}) {
  const merged = extra.merged ?? false;
  return {
    action,
    number: extra.number ?? 7,
    repository: { full_name: 'acme/xlr8' },
    pull_request: {
      number: extra.number ?? 7,
      title: extra.title ?? 'Search field',
      body: extra.body ?? '',
      state: action === 'closed' ? 'closed' : 'open',
      draft: false,
      merged,
      merged_at: merged ? '2026-10-08T12:00:00Z' : null,
      updated_at: extra.updatedAt ?? '2026-10-08T11:00:00Z',
      html_url: `https://github.com/acme/xlr8/pull/${extra.number ?? 7}`,
      head: { ref: extra.branch ?? 'feature/x' },
      user: { login: 'octocat' },
      _links: { self: { href: 'https://api.github.com/x' } },
    },
  };
}

async function deliver(t: T, event: string, payload: unknown, deliveryId: string, secret = SECRET) {
  const body = JSON.stringify(payload);
  const response = await t.fetch('/github', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': event,
      'X-GitHub-Delivery': deliveryId,
      'X-Hub-Signature-256': await signBody(secret, body),
    },
    body,
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

function init() {
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  return setup();
}

describe('GitHub webhook', () => {
  test('missing or wrong signature → 401; ping → 200', async () => {
    const { t } = init();
    const body = JSON.stringify(pr('opened'));
    const missing = await t.fetch('/github', { method: 'POST', headers: { 'X-GitHub-Event': 'pull_request' }, body });
    expect(missing.status).toBe(401);
    expect((await deliver(t, 'pull_request', pr('opened'), 'd-1', 'wrong-secret')).status).toBe(401);
    expect(await deliver(t, 'ping', { zen: 'Keep it simple.', hook_id: 1 }, 'd-ping')).toMatchObject({ status: 200, body: { ok: true } });
    expect(await t.run(async (ctx) => await ctx.db.query('githubDeliveries').collect())).toHaveLength(0);
  });

  test('secret rotation: the previous secret is accepted while GITHUB_WEBHOOK_SECRET_PREVIOUS is set', async () => {
    const { t } = init();
    try {
      expect((await deliver(t, 'push', {}, 'd-old-1', 'old-secret')).status).toBe(401);
      process.env.GITHUB_WEBHOOK_SECRET_PREVIOUS = 'old-secret';
      expect((await deliver(t, 'push', {}, 'd-old-2', 'old-secret')).status).toBe(200);
      expect((await deliver(t, 'push', {}, 'd-new', SECRET)).status).toBe(200);
      expect((await deliver(t, 'push', {}, 'd-wrong', 'totally-wrong')).status).toBe(401);
    } finally {
      delete process.env.GITHUB_WEBHOOK_SECRET_PREVIOUS;
    }
  });

  test('linking; a redelivery has no effect; merge closes only "closes" links, never canceled issues', async () => {
    const { t, owner } = init();
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb, { status: 'in_progress' }); // ORB-1: branch → closes
    const b = await createOne(owner, f.orb, { status: 'todo' }); // ORB-2: "Fixes" → closes
    const c = await createOne(owner, f.nova, { status: 'todo' }); // NOVA-1: only mentioned
    const d = await createOne(owner, f.orb, { status: 'canceled' }); // ORB-3: canceled, "closes"
    const old = await createOne(owner, f.nova, { status: 'todo' }); // NOVA-2 with old identifier OLD-9
    await t.run(async (ctx) => {
      await ctx.db.insert('identifierAliases', { key: 'OLD-9', issueId: old.id });
    });
    const opened = pr('opened', {
      branch: 'octocat/orb-1-search-field',
      title: 'Search field (NOVA-1)',
      body: 'Fixes ORB-2, closes ORB-3 and resolves old-9.\n\n```\nfixes NOVA-1\n```',
    });
    const first = await deliver(t, 'pull_request', opened, 'd-open');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ duplicate: false, kind: 'pull_request', pr: 'acme/xlr8#7' });
    expect(first.body.linked.sort()).toEqual(['NOVA-1', 'OLD-9', 'ORB-1', 'ORB-2', 'ORB-3']);
    const links = await t.run(async (ctx) => await ctx.db.query('issuePullRequests').collect());
    expect(links).toHaveLength(5);
    expect(links.find((l) => l.issueId === c.id)).toMatchObject({ via: 'title', closes: false });
    expect(links.find((l) => l.issueId === a.id)).toMatchObject({ via: 'branch', closes: true });
    expect((await historyOf(t, a.id)).at(-1)).toMatchObject({ field: 'pull_request', actor: { kind: 'github' } });

    // The same delivery again (GitHub redelivers): no effect.
    const again = await deliver(t, 'pull_request', opened, 'd-open');
    expect(again.body).toMatchObject({ duplicate: true });
    expect(await t.run(async (ctx) => (await ctx.db.query('issuePullRequests').collect()).length)).toBe(5);
    expect(await t.run(async (ctx) => (await ctx.db.query('pullRequests').collect()).length)).toBe(1);

    // Edited without identifiers: links stay.
    await deliver(t, 'pull_request', pr('edited', { title: 'Different', updatedAt: '2026-10-08T11:30:00Z' }), 'd-edit');
    expect(await t.run(async (ctx) => (await ctx.db.query('issuePullRequests').collect()).length)).toBe(5);

    // Merge: ORB-1 (branch), ORB-2 (Fixes), NOVA-2 (old identifier) → done; NOVA-1 stays; ORB-3 stays canceled.
    const merged = await deliver(t, 'pull_request', pr('closed', { merged: true, updatedAt: '2026-10-08T12:00:00Z' }), 'd-merge');
    expect(merged.body.closed.sort()).toEqual(['NOVA-2', 'ORB-1', 'ORB-2']);
    expect((await getIssue(t, a.id)).status).toBe('done');
    expect((await getIssue(t, b.id)).status).toBe('done');
    expect((await getIssue(t, old.id)).status).toBe('done');
    expect((await getIssue(t, c.id)).status).toBe('todo');
    expect((await getIssue(t, d.id)).status).toBe('canceled');
    const statusRow = (await historyOf(t, b.id)).find((h) => h.field === 'stateId');
    const orbTeam = (await getIssue(t, b.id)).teamId;
    expect(statusRow).toMatchObject({
      from: await stateId(t, orbTeam, 'todo'),
      to: await stateId(t, orbTeam, 'done'),
      actor: { kind: 'github' },
    });
    const prDoc = await t.run(async (ctx) => (await ctx.db.query('pullRequests').collect())[0]);
    expect(prDoc).toMatchObject({ state: 'merged', title: 'Search field', branch: 'feature/x' });

    // A late, older delivery doesn't roll the state back.
    await deliver(t, 'pull_request', pr('reopened', { updatedAt: '2026-10-08T10:00:00Z' }), 'd-late');
    expect(await t.run(async (ctx) => (await ctx.db.query('pullRequests').collect())[0].state)).toBe('merged');
    // A second merge event (different delivery) changes nothing.
    const twice = await deliver(t, 'pull_request', pr('closed', { merged: true, updatedAt: '2026-10-08T12:00:01Z' }), 'd-merge-2');
    expect(twice.body.closed).toEqual([]);
  });

  test('"closes" is raised later, never lowered; unknown identifiers and other events change nothing', async () => {
    const { t, owner } = init();
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb);
    await deliver(t, 'pull_request', pr('opened', { body: 'See ORB-1 and ZZZ-5' }), 'd-1');
    expect(await t.run(async (ctx) => (await ctx.db.query('issuePullRequests').collect()).map((l) => l.closes))).toEqual([false]);
    await deliver(t, 'pull_request', pr('edited', { body: 'Fixes ORB-1', updatedAt: '2026-10-08T11:10:00Z' }), 'd-2');
    expect(await t.run(async (ctx) => (await ctx.db.query('issuePullRequests').collect()).map((l) => l.closes))).toEqual([true]);
    await deliver(t, 'pull_request', pr('edited', { body: 'See ORB-1', updatedAt: '2026-10-08T11:20:00Z' }), 'd-3');
    expect(await t.run(async (ctx) => (await ctx.db.query('issuePullRequests').collect()).map((l) => l.closes))).toEqual([true]);
    const ignored = await deliver(t, 'push', { ref: 'refs/heads/main' }, 'd-4');
    expect(ignored.body).toMatchObject({ kind: 'ignored' });
    const sync = await deliver(t, 'pull_request', pr('synchronize'), 'd-5');
    expect(sync.body).toMatchObject({ kind: 'ignored' });
    expect((await getIssue(t, a.id)).status).toBe('backlog');
  });

  test('after a team key rename, branches and texts with the old key still link and close', async () => {
    const { t, owner } = init();
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb, { status: 'in_progress' }); // ORB-1, later OBT-1
    const b = await createOne(owner, f.orb, { status: 'todo' }); // ORB-2, later OBT-2
    await owner.mutation(api.teams.update, { teamId: f.orb, key: 'OBT' });
    const opened = pr('opened', { branch: 'feat/orb-1-search-field', body: 'Fixes OBT-2, see also ORB-2.' });
    const first = await deliver(t, 'pull_request', opened, 'd-rename-open');
    // One link per issue, even if a PR names it under the old and the new key.
    expect(first.body.linked.sort()).toEqual(['OBT-2', 'ORB-1']);
    const links = await t.run(async (ctx) => await ctx.db.query('issuePullRequests').collect());
    expect(links).toHaveLength(2);
    expect(links.find((l) => l.issueId === a.id)).toMatchObject({ via: 'branch', closes: true });
    expect(links.find((l) => l.issueId === b.id)).toMatchObject({ closes: true });
    const merged = await deliver(t, 'pull_request', pr('closed', { branch: 'feat/orb-1-search-field', merged: true, updatedAt: '2026-10-08T12:00:00Z' }), 'd-rename-merge');
    expect(merged.body.closed.length).toBe(2);
    expect((await getIssue(t, a.id)).status).toBe('done');
    expect((await getIssue(t, b.id)).status).toBe('done');
  });

  test('the cron removes deliveries older than 30 days', async () => {
    const { t, owner } = init();
    await fixture(owner);
    await deliver(t, 'push', {}, 'd-old');
    const now = Date.now() + 31 * DAY_MS;
    const result = await t.run(async (ctx) => await cleanupOld(ctx, now));
    expect(result.deliveries).toBe(1);
    expect(await t.run(async (ctx) => await ctx.db.query('githubDeliveries').collect())).toHaveLength(0);
    // The ops page shows the latest delivery (none left here).
    expect((await owner.query(api.ops.status, {})).github).toBeNull();
  });
});
