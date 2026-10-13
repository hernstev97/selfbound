import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import type { Actor } from '../lib/actor';
import { invalid, notFound } from '../lib/errors';
import { idempotent } from '../lib/idempotency';
import type { RelationType } from '../shared/constants';
import { record } from './history';
import { applyPatch } from './issues';
import { getIssue } from './validate';

// Relations: blocks (from blocks to), related, duplicate (from is a duplicate of to).
// No self-reference, no duplicates (same type between the same issues, in either
// direction). History on both issues.

export async function addRelation(
  ctx: MutationCtx,
  actor: Actor,
  args: { fromId: Id<'issues'>; toId: Id<'issues'>; type: RelationType; markDuplicate?: boolean; requestId?: string },
) {
  return await idempotent(ctx, actor, args.requestId, 'relations.add', { ...args }, async () => {
    if (args.fromId === args.toId) invalid('An issue cannot have a relation to itself.');
    const from = await getIssue(ctx, args.fromId);
    const to = await getIssue(ctx, args.toId);
    const forward = await ctx.db
      .query('relations')
      .withIndex('by_from', (q) => q.eq('fromId', from._id))
      .collect();
    const backward = await ctx.db
      .query('relations')
      .withIndex('by_from', (q) => q.eq('fromId', to._id))
      .collect();
    const exists =
      forward.some((r) => r.toId === to._id && r.type === args.type) ||
      backward.some((r) => r.toId === from._id && r.type === args.type);
    if (exists) invalid('This relation already exists.');
    const now = Date.now();
    const relationId = await ctx.db.insert('relations', {
      fromId: from._id,
      toId: to._id,
      type: args.type,
      createdAt: now,
      createdBy: actor,
    });
    await ctx.db.patch('issues', from._id, { updatedAt: now });
    await ctx.db.patch('issues', to._id, { updatedAt: now });
    await record(ctx, actor, now, args.requestId, {
      issueId: from._id,
      field: 'relation',
      to: { relationId, type: args.type, direction: 'out', otherId: to._id },
    });
    await record(ctx, actor, now, args.requestId, {
      issueId: to._id,
      field: 'relation',
      to: { relationId, type: args.type, direction: 'in', otherId: from._id },
    });
    if (args.type === 'duplicate' && args.markDuplicate) {
      await applyPatch(ctx, actor, from._id, { status: 'duplicate' }, undefined, now, args.requestId);
    }
    return { relationId };
  });
}

export async function removeRelation(
  ctx: MutationCtx,
  actor: Actor,
  args: { relationId: Id<'relations'>; requestId?: string },
) {
  return await idempotent(ctx, actor, args.requestId, 'relations.remove', { ...args }, async () => {
    const relation = (await ctx.db.get('relations', args.relationId)) ?? notFound('The relation');
    const now = Date.now();
    await ctx.db.delete('relations', relation._id);
    for (const [issueId, direction, otherId] of [
      [relation.fromId, 'out', relation.toId],
      [relation.toId, 'in', relation.fromId],
    ] as const) {
      if (!(await ctx.db.get('issues', issueId))) continue;
      await ctx.db.patch('issues', issueId, { updatedAt: now });
      await record(ctx, actor, now, args.requestId, {
        issueId,
        field: 'relation_removed',
        from: { relationId: relation._id, type: relation.type, direction, otherId },
      });
    }
    return { relationId: relation._id };
  });
}
