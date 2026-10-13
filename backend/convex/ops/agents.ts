import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Actor } from '../lib/actor';
import { berlinDay } from '../lib/dates';
import { fail, notFound } from '../lib/errors';
import { OWNER_KIND } from '../shared/constants';
import { revokeConnector } from './oauth';
import { checkName } from './validate';

// Agents: one key per agent, stored only as a SHA-256 hash. Connectors (claude.ai, ChatGPT)
// authenticate with OAuth access tokens instead (ops/oauth.ts).
// Rate limit per agent: 120 calls per minute, 5000 per day (calendar day, Europe/Berlin).

export const RATE_PER_MINUTE = 120;
export const RATE_PER_DAY = 5000;
const LAST_USED_EVERY_MS = 60_000;

/** Only the owner may do `what` (e.g. "create agent keys"). */
export function assertOwner(actor: Actor, what: string) {
  if (actor.kind !== OWNER_KIND) fail('access_denied', `Only the owner may ${what}.`);
}

export async function insertAgent(
  ctx: MutationCtx,
  actor: Actor,
  args: { name: string; keyHash: string; keyPrefix: string },
) {
  assertOwner(actor, 'create agent keys');
  if (!/^[0-9a-f]{64}$/.test(args.keyHash)) fail('invalid', 'Invalid key hash.');
  const agentId = await ctx.db.insert('agents', {
    name: checkName(args.name, 'The agent', 60),
    keyHash: args.keyHash,
    keyPrefix: args.keyPrefix,
    createdAt: Date.now(),
  });
  return { agentId };
}

export async function revokeAgent(ctx: MutationCtx, actor: Actor, args: { agentId: Id<'agents'> }) {
  assertOwner(actor, 'revoke agent keys');
  const agent = (await ctx.db.get('agents', args.agentId)) ?? notFound('The agent');
  if (agent.connector) await revokeConnector(ctx, agent._id, 'owner', Date.now());
  else if (agent.revokedAt === undefined) await ctx.db.patch('agents', agent._id, { revokedAt: Date.now(), revokedReason: 'owner' });
  return { agentId: agent._id };
}

/** Public view of an agent: never the hash. */
export function publicAgent(agent: Doc<'agents'>) {
  return {
    _id: agent._id,
    name: agent.name,
    keyPrefix: agent.keyPrefix ?? null,
    connector: agent.connector ? { app: agent.connector.app } : null,
    createdAt: agent.createdAt,
    revokedAt: agent.revokedAt ?? null,
    revokedReason: agent.revokedReason ?? null,
    lastUsedAt: agent.lastUsedAt ?? null,
  };
}

/**
 * For MCP: hash of a key or access token → agent and actor. Unknown, expired or revoked →
 * access_denied. Token expiry is only checked when `now` is passed (mutations, the sign-in
 * in the action): this keeps the read query free of the clock and cacheable; `countCall`
 * (a mutation, with the check) always runs before it.
 */
export async function authenticateAgent(ctx: QueryCtx, hash: string, now?: number) {
  let agent = await ctx.db
    .query('agents')
    .withIndex('by_hash', (q) => q.eq('keyHash', hash))
    .unique();
  if (!agent) {
    const token = await ctx.db
      .query('oauthTokens')
      .withIndex('by_hash', (q) => q.eq('hash', hash))
      .unique();
    if (!token) fail('access_denied', 'Unknown agent key.');
    if (token.kind !== 'access' || (now !== undefined && token.expiresAt <= now)) {
      fail('access_denied', 'Access expired or invalid.');
    }
    agent = await ctx.db.get('agents', token.agentId);
    if (!agent) fail('access_denied', 'Unknown agent.');
  }
  if (agent.revokedAt !== undefined) fail('access_denied', 'This agent key has been revoked.');
  const actor: Actor = { kind: 'agent', agentId: agent._id };
  return { agent, actor };
}

export const minuteWindow = (now: number) => `m:${Math.floor(now / 60_000)}`;
export const dayWindow = (now: number) => `d:${berlinDay(now)}`;

async function windowRow(ctx: QueryCtx, agentId: Id<'agents'>, window: string) {
  return await ctx.db
    .query('rateWindows')
    .withIndex('by_agent_window', (q) => q.eq('agentId', agentId).eq('window', window))
    .unique();
}

/** An agent's calls today (for the ops page). */
export async function callsToday(ctx: QueryCtx, agentId: Id<'agents'>, now: number) {
  return (await windowRow(ctx, agentId, dayWindow(now)))?.count ?? 0;
}

/**
 * Counts a call. Over the limit → rate_limited (the call is then not counted because the
 * transaction is discarded). lastUsedAt is updated at most once per minute.
 */
export async function consumeRate(ctx: MutationCtx, agentId: Id<'agents'>, now = Date.now()) {
  const agent = (await ctx.db.get('agents', agentId)) ?? notFound('The agent');
  if (agent.revokedAt !== undefined) fail('access_denied', 'This agent key has been revoked.');
  const minute = await windowRow(ctx, agentId, minuteWindow(now));
  const day = await windowRow(ctx, agentId, dayWindow(now));
  if ((minute?.count ?? 0) >= RATE_PER_MINUTE) {
    fail('rate_limited', `Too many calls: at most ${RATE_PER_MINUTE} per minute.`, { retryAfterMs: 60_000 - (now % 60_000) });
  }
  if ((day?.count ?? 0) >= RATE_PER_DAY) {
    fail('rate_limited', `Too many calls: at most ${RATE_PER_DAY} per day.`);
  }
  if (minute) await ctx.db.patch('rateWindows', minute._id, { count: minute.count + 1 });
  else await ctx.db.insert('rateWindows', { agentId, window: minuteWindow(now), count: 1 });
  if (day) await ctx.db.patch('rateWindows', day._id, { count: day.count + 1 });
  else await ctx.db.insert('rateWindows', { agentId, window: dayWindow(now), count: 1 });
  if (agent.lastUsedAt === undefined || now - agent.lastUsedAt >= LAST_USED_EVERY_MS) {
    await ctx.db.patch('agents', agentId, { lastUsedAt: now });
  }
  return { minute: (minute?.count ?? 0) + 1, day: (day?.count ?? 0) + 1 };
}
