import { ConvexError, v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import { fail } from './lib/errors';
import { checkToolArguments, isToolName } from './lib/mcp/tools';
import { authenticateAgent, consumeRate } from './ops/agents';
import { isReadTool, plain, runReadTool, runWriteTool } from './ops/mcp';

// Internal functions for the MCP endpoint (convex/http.ts).
// `keyHash` is the hash of an agent key or of an OAuth access token (connector).
//
// Write tools: ONE mutation per call (`call`): re-check key and revocation, count the call
// (rate limit), idempotency, run the operation with actor {kind: 'agent'} and store the
// result, all in the same transaction.
//
// Read tools: first a small mutation (`countCall`, rate limit only), then a query (`read`).
// Convex can cache queries: a repeated call with the same arguments reads nothing again as
// long as the data it read has not changed. Concurrent writes no longer make the read
// function retry.

function checked(tool: string, args: unknown) {
  if (!isToolName(tool)) fail('invalid', `Unknown tool: ${tool}.`);
  // The action has already checked; check again because internal functions assume nothing.
  const result = checkToolArguments(tool, args);
  if (!result.ok) fail('invalid', `Invalid arguments for ${tool}: ${result.errors.join('; ')}`);
  return { tool, args: result.value };
}

/** Write tool: counting and writing in one transaction. An error discards both. */
export const call = internalMutation({
  args: { keyHash: v.string(), tool: v.string(), args: v.any() },
  handler: async (ctx, { keyHash, tool, args }): Promise<{ ok: true; value: unknown }> => {
    const { agent, actor } = await authenticateAgent(ctx, keyHash, Date.now());
    await consumeRate(ctx, agent._id);
    const input = checked(tool, args);
    if (isReadTool(input.tool)) fail('invalid', `${tool} is a read tool.`);
    return { ok: true, value: plain(await runWriteTool(ctx, actor, input.tool, input.args)) };
  },
});

/** Read tool, step 1: count the call (revoked → access_denied, too many → rate_limited). */
export const countCall = internalMutation({
  args: { keyHash: v.string() },
  handler: async (ctx, { keyHash }) => {
    const { agent } = await authenticateAgent(ctx, keyHash, Date.now());
    return await consumeRate(ctx, agent._id);
  },
});

/**
 * Read tool, step 2: as a query (cacheable). Checks the key again so that a key revoked in
 * the meantime reads nothing. The action passes `today` (calendar day, Europe/Berlin) so the
 * query does not depend on the clock.
 */
export const read = internalQuery({
  args: { keyHash: v.string(), tool: v.string(), args: v.any(), today: v.string() },
  handler: async (ctx, { keyHash, tool, args, today }) => {
    // No clock (cacheable): countCall has just checked the access token's expiry.
    await authenticateAgent(ctx, keyHash);
    const input = checked(tool, args);
    if (!isReadTool(input.tool)) fail('invalid', `${tool} is not a read tool.`);
    return plain(await runReadTool(ctx, input.tool, input.args, today));
  },
});

/**
 * Counts a failed call after the fact: discarded write calls (whose transaction, counter
 * included, was rolled back) and calls that already failed the check in the action (unknown
 * tool, invalid arguments). This way an agent cannot bypass the rate limit with bad calls.
 * Revoked or over the limit: nothing to do.
 */
export const countFailedCall = internalMutation({
  args: { keyHash: v.string() },
  handler: async (ctx, { keyHash }) => {
    try {
      const { agent } = await authenticateAgent(ctx, keyHash, Date.now());
      await consumeRate(ctx, agent._id);
      return { counted: true };
    } catch (error) {
      if (error instanceof ConvexError) return { counted: false };
      throw error;
    }
  },
});
