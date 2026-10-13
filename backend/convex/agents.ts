import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalMutation, internalQuery } from './_generated/server';
import { ownerAction, ownerQuery, ownerWriteMutation } from './lib/auth';
import { generateAgentKey } from './lib/keys';
import { assertWritable } from './lib/testSwitches';
import * as ops from './ops/agents';
import { actorValidator } from './schema';

// Agent keys: generated randomly in an action, returned in plain text exactly once, stored
// only as a SHA-256 hash. Each key can be revoked on its own.

/** New agent with a key. The key (`key`) appears ONLY in this response. */
export const create = ownerAction({
  args: { name: v.string() },
  handler: async (ctx, args): Promise<{ agentId: Id<'agents'>; key: string; keyPrefix: string }> => {
    ops.assertOwner(ctx.actor, 'create agent keys');
    const { key, keyHash, keyPrefix } = await generateAgentKey();
    const { agentId } = await ctx.runMutation(internal.agents.insert, {
      name: args.name,
      keyHash,
      keyPrefix,
      actor: ctx.actor,
    });
    return { agentId, key, keyPrefix };
  },
});

export const revoke = ownerWriteMutation({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => await ops.revokeAgent(ctx, ctx.actor, args),
});

/** All agents, without hashes. */
export const list = ownerQuery({
  args: {},
  handler: async (ctx) => {
    const agents = await ctx.db.query('agents').order('desc').take(200);
    return agents.map(ops.publicAgent);
  },
});

/** Internal: stores an agent with its hash (from `create`). */
export const insert = internalMutation({
  args: { name: v.string(), keyHash: v.string(), keyPrefix: v.string(), actor: actorValidator },
  handler: async (ctx, { actor, ...args }) => {
    await assertWritable(ctx);
    return await ops.insertAgent(ctx, actor, args);
  },
});

/** Internal, for MCP: hash of a key or access token → agent (revoked, expired or unknown → access_denied). */
export const authenticate = internalQuery({
  args: { keyHash: v.string(), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { agent, actor } = await ops.authenticateAgent(ctx, args.keyHash, args.now);
    return { agentId: agent._id, name: agent.name, actor };
  },
});

/** Internal, for MCP: counts one call (120/minute, 5000/day → rate_limited). */
export const consumeRate = internalMutation({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => await ops.consumeRate(ctx, args.agentId),
});
