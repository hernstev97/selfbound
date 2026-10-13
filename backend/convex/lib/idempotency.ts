import type { MutationCtx } from '../_generated/server';
import type { Actor } from './actor';
import { hashText, stable } from './equal';
import { invalid } from './errors';

// Idempotency via `requests`: the same request ID from one actor takes effect only once.
// Lookup, execution and storing run in the SAME transaction; if the operation fails, nothing is
// stored and a retry runs it again.

export const REQUEST_ID_MAX = 200;

/** Owner of a request ID: the actor kind (OWNER_KIND, 'system' …) or the agent ID. */
export function ownerKey(actor: Actor): string {
  return actor.kind === 'agent' && actor.agentId ? actor.agentId : actor.kind;
}

export function argsHash(operation: string, args: unknown): string {
  return hashText(`${operation}\n${stable(args)}`);
}

/**
 * Runs `run` at most once per (actor, requestId).
 * - same arguments → the stored result
 * - different arguments or a different operation → `invalid`
 * Without a requestId, `run` simply runs.
 */
export async function idempotent<R>(
  ctx: MutationCtx,
  actor: Actor,
  requestId: string | undefined,
  operation: string,
  args: Record<string, unknown>,
  run: () => Promise<R>,
): Promise<R> {
  if (requestId === undefined) return await run();
  if (requestId.length === 0 || requestId.length > REQUEST_ID_MAX) {
    invalid(`requestId must be 1 to ${REQUEST_ID_MAX} characters long.`);
  }
  const owner = ownerKey(actor);
  const { requestId: _omit, ...rest } = args;
  const hash = argsHash(operation, rest);
  const existing = await ctx.db
    .query('requests')
    .withIndex('by_owner_request', (q) => q.eq('owner', owner).eq('requestId', requestId))
    .unique();
  if (existing) {
    if (existing.argsHash !== hash || existing.operation !== operation) {
      invalid('requestId was reused with different arguments.', { requestId });
    }
    return existing.result as R;
  }
  const result = await run();
  await ctx.db.insert('requests', {
    owner,
    requestId,
    argsHash: hash,
    operation,
    result: result ?? null,
    createdAt: Date.now(),
  });
  return result;
}
