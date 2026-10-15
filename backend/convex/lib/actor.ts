import type { Infer } from 'convex/values';
import type { actorValidator } from '../schema';
import { isOwnerKind } from '../shared/constants';

/** Who triggers a change. Always derived from the verified identity. */
export type Actor = Infer<typeof actorValidator>;

/** Same actor? The owner counts as one actor whether stored as 'owner' or as the legacy kind. */
export function sameActor(a: Actor, b: Actor): boolean {
  if (isOwnerKind(a.kind) || isOwnerKind(b.kind)) return isOwnerKind(a.kind) && isOwnerKind(b.kind);
  return a.kind === b.kind && a.agentId === b.agentId;
}
