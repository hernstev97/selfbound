import { describe, expect, test } from 'vitest';
import { api, internal } from '../convex/_generated/api';
import { base64url } from '../convex/lib/keys';
import { consumeRate, dayWindow, RATE_PER_DAY, RATE_PER_MINUTE } from '../convex/ops/agents';
import { expectCode, setup } from './helpers';

async function sha256(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('agent keys', () => {
  test('key returned only once, only hash and prefix stored; list without hash', async () => {
    const { t, owner } = setup();
    const created = await owner.action(api.agents.create, { name: 'Assistant' });
    expect(created.key).toMatch(/^xlr8_[A-Za-z0-9_-]{43}$/);
    expect(created.keyPrefix).toBe(created.key.slice(0, 10));
    const stored = await t.run(async (ctx) => await ctx.db.get('agents', created.agentId));
    expect(stored?.keyHash).toBe(await sha256(created.key));
    // The plain-text key is nowhere in the database.
    const everything = await t.run(async (ctx) => JSON.stringify(await ctx.db.query('agents').collect()));
    expect(everything).not.toContain(created.key);
    const list = await owner.query(api.agents.list, {});
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Assistant', keyPrefix: created.keyPrefix, revokedAt: null });
    expect(JSON.stringify(list)).not.toContain(stored!.keyHash);
    const second = await owner.action(api.agents.create, { name: 'Codex' });
    expect(second.key).not.toBe(created.key);
  });

  test('authenticate: known → actor agent; revoked or unknown → access_denied', async () => {
    const { t, owner } = setup();
    const { agentId, key } = await owner.action(api.agents.create, { name: 'Claude Code' });
    const hash = await sha256(key);
    expect(await t.query(internal.agents.authenticate, { keyHash: hash })).toEqual({
      agentId,
      name: 'Claude Code',
      actor: { kind: 'agent', agentId },
    });
    await expectCode(t.query(internal.agents.authenticate, { keyHash: await sha256('xlr8_wrong') }), 'access_denied');
    await owner.mutation(api.agents.revoke, { agentId });
    await expectCode(t.query(internal.agents.authenticate, { keyHash: hash }), 'access_denied');
    await expectCode(t.mutation(internal.agents.consumeRate, { agentId }), 'access_denied');
    expect((await owner.query(api.agents.list, {}))[0].revokedAt).not.toBeNull();
  });

  test('rate limit: 120 per minute, 5000 per day; lastUsedAt at most once a minute', async () => {
    const { t, owner } = setup();
    const { agentId } = await owner.action(api.agents.create, { name: 'Codex' });
    // A fixed day far from today, so the day counter below does not collide with Date.now().
    const now = Date.UTC(2025, 0, 15, 10, 0, 5);
    await t.run(async (ctx) => {
      for (let i = 0; i < RATE_PER_MINUTE; i++) await consumeRate(ctx, agentId, now + i);
    });
    const data = await expectCode(t.run(async (ctx) => await consumeRate(ctx, agentId, now + 500)), 'rate_limited');
    expect(data.retryAfterMs).toBeGreaterThan(0);
    // Rejected calls do not count; the next minute works again.
    expect(await t.run(async (ctx) => await consumeRate(ctx, agentId, now + 60_000))).toEqual({ minute: 1, day: RATE_PER_MINUTE + 1 });
    const agent = await t.run(async (ctx) => await ctx.db.get('agents', agentId));
    expect(agent?.lastUsedAt).toBe(now + 60_000);
    await t.run(async (ctx) => await consumeRate(ctx, agentId, now + 61_000));
    expect((await t.run(async (ctx) => await ctx.db.get('agents', agentId)))?.lastUsedAt).toBe(now + 60_000);
    // Daily limit.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('rateWindows')
        .withIndex('by_agent_window', (q) => q.eq('agentId', agentId).eq('window', dayWindow(now)))
        .unique();
      await ctx.db.patch('rateWindows', row!._id, { count: RATE_PER_DAY });
    });
    await expectCode(t.run(async (ctx) => await consumeRate(ctx, agentId, now + 120_000)), 'rate_limited');
    // The ops page shows today's calls (Berlin calendar day of Date.now()).
    await t.run(async (ctx) => await consumeRate(ctx, agentId));
    const status = await owner.query(api.ops.status, {});
    expect(status.agents[0]).toMatchObject({ name: 'Codex', callsToday: 1 });
  });

  test('base64url without padding', () => {
    expect(base64url(new Uint8Array([]))).toBe('');
    expect(base64url(new Uint8Array([0xfb]))).toBe('-w');
    expect(base64url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
    expect(base64url(new Uint8Array([1, 2, 3]))).toBe('AQID');
  });
});
