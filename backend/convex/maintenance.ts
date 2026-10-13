import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { purgeTrash as purge } from './ops/issues';
import { cleanupOld, writeOpsStatus } from './ops/maintenance';
import { runDueRecurrences as runDue } from './ops/recurrences';
import { addAuditTotals, auditResult, auditSprintPage as auditPage, type AuditTotals } from './ops/sprints';
import { purgeArticleTrash } from './ops/wiki';

// Internal jobs for the crons (convex/crons.ts). Each one works in batches and reschedules
// itself while work remains.

/** Empty the trash: issues and knowledge base pages that have been in it for more than 30 days. */
export const purgeTrash = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const issues = await purge(ctx, now);
    const articles = await purgeArticleTrash(ctx, now);
    const result = { purged: issues.purged, articles: articles.purged, more: issues.more || articles.more };
    if (result.more) await ctx.scheduler.runAfter(0, internal.maintenance.purgeTrash, {});
    return result;
  },
});

export const cleanup = internalMutation({
  args: {},
  handler: async (ctx) => {
    const result = await cleanupOld(ctx);
    if (result.more) await ctx.scheduler.runAfter(0, internal.maintenance.cleanup, {});
    return result;
  },
});

export const auditSprintPage = internalQuery({
  args: { after: v.union(v.number(), v.null()) },
  handler: async (ctx, args) => await auditPage(ctx, args.after),
});

export const recordAudit = internalMutation({
  args: { value: v.any() },
  handler: async (ctx, args) => await writeOpsStatus(ctx, 'auditSprints', args.value),
});

/**
 * Nightly check of the sprint invariant; the result shows on the ops page.
 * Page by page (one query per page with its own read limits; imported Linear sprints are
 * skipped). If a page fails, the error is stored in opsStatus.auditSprints (`ok: false`, `error`).
 */
export const auditSprints = internalAction({
  args: {},
  handler: async (ctx): Promise<unknown> => {
    const startedAt = Date.now();
    const acc: AuditTotals = { problems: [], sprints: 0, items: 0, active: 0 };
    let after: number | null = null;
    try {
      for (;;) {
        const page: AuditTotals & { isDone: boolean; last: number | null } = await ctx.runQuery(
          internal.maintenance.auditSprintPage,
          { after },
        );
        addAuditTotals(acc, page);
        if (page.isDone) break;
        after = page.last;
      }
    } catch (error) {
      const failed = {
        ok: false,
        error: `Audit aborted: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
        problems: acc.problems.slice(0, 100),
        sprints: acc.sprints,
        items: acc.items,
        startedAt,
      };
      await ctx.runMutation(internal.maintenance.recordAudit, { value: failed });
      throw error;
    }
    const result = { ...auditResult(acc), startedAt };
    await ctx.runMutation(internal.maintenance.recordAudit, { value: result });
    return result;
  },
});

export const runDueRecurrences = internalMutation({
  args: {},
  handler: async (ctx) => {
    const result = await runDue(ctx);
    if (result.more) await ctx.scheduler.runAfter(0, internal.maintenance.runDueRecurrences, {});
    return result;
  },
});
