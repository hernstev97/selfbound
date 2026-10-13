import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { writeOpsStatus } from './ops/maintenance';

// Reports from outside for the ops page (ops.status).

/**
 * Records a successful backup. Called by the backup workflow after export, restore test and
 * encryption:
 *   convex run opsStatus:recordBackup '{"at":…,"bytes":…,"sha256":"…","tables":…,"documents":…,"files":…,"run":"…"}'
 * Only the summary is stored (no contents). ops.status shows it under `backup`.
 */
export const recordBackup = internalMutation({
  args: {
    at: v.number(),
    bytes: v.optional(v.number()),
    sha256: v.optional(v.string()),
    tables: v.optional(v.number()),
    documents: v.optional(v.number()),
    files: v.optional(v.number()),
    run: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await writeOpsStatus(ctx, 'backup', { ok: true, ...args }, args.at);
    return { recorded: true, at: args.at };
  },
});
