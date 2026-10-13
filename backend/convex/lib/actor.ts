import type { Infer } from 'convex/values';
import type { actorValidator } from '../schema';

/** Who triggers a change. Always derived from the verified identity. */
export type Actor = Infer<typeof actorValidator>;
