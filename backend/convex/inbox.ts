import { ownerQuery } from './lib/auth';
import * as ops from './ops/inbox';

// Inbox entries (the table is described in ops/inboxChanges.ts). Removing, reading and undo go
// through `issues.markReviewed`, `issues.markUnreviewed` and `issues.markRead` (issue IDs).

/** Open entries, newest first. One subscription per client; the entries are small. */
export const list = ownerQuery({
  args: {},
  handler: async (ctx) => await ops.listOpen(ctx),
});
