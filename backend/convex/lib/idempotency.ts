import type { MutationCtx } from '../_generated/server';
import type { Actor } from './actor';
import { LEGACY_OWNER_KIND, OWNER_KIND, isOwnerKind } from '../shared/constants';
import { hashText, stable } from './equal';
import { invalid } from './errors';

// Idempotency via `requests`: the same request ID from one actor takes effect only once.
// Lookup, execution and storing run in the SAME transaction; if the operation fails, nothing is
// stored and a retry runs it again.

export const REQUEST_ID_MAX = 200;

/** Owner of a request ID: the actor kind (OWNER_KIND, 'system' …) or the agent ID. */
export function ownerKey(actor: Actor): string {
  if (actor.kind === 'agent' && actor.agentId) return actor.agentId;
  return isOwnerKind(actor.kind) ? OWNER_KIND : actor.kind;
}

/** Owner values a stored request may carry for this actor: the owner also under its legacy kind. */
function ownerKeys(actor: Actor): string[] {
  const key = ownerKey(actor);
  return key === OWNER_KIND ? [OWNER_KIND, LEGACY_OWNER_KIND] : [key];
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
  // legacy-xlr8: a retry made before the data migration (stored under the old kind) must still find its request.
  let existing = null;
  for (const candidate of ownerKeys(actor)) {
    existing = await ctx.db
      .query('requests')
      .withIndex('by_owner_request', (q) => q.eq('owner', candidate).eq('requestId', requestId))
      .unique();
    if (existing) break;
  }
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
