import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { assertWritable } from './lib/testSwitches';
import { sourceInputValidator } from './lib/validators';
import { advanceImport, failStaleImports, importSummary, startImport } from './ops/import';
import { importDocument } from './ops/wiki';

// Import from Linear: `importStaging` (filled in batches via `importer:stage`) → tables.
//
// Invocation (locally, after a typed confirmation in the tool):
//   node tooling/linear-import/index.ts push <folder-or-staging.jsonl>
// runs `convex run importer:process '{"run": "…"}'`.
//
// A run is a chain of small functions: `start` creates the run and schedules the first
// step; each step (`step` → `advance`) processes ONE batch (≤ 100 issues or ~1 MB), stores
// phase and cursor in `importRuns` and schedules the next one. That way no run hits the
// action time limit, and an aborted run leaves a clear state behind. At the end the staging
// rows are deleted and the run is `done`. Runs without progress for 15 minutes count as
// stuck and become `failed`. A second run with the same data creates no duplicates (linearLinks).

/** Maximum rows per `stage` call (the tool additionally stays below ~90 KB). */
export const STAGE_MAX_ROWS = 500;

/**
 * Appends rows to `importStaging`. Replaces `convex import --append`, which needs a deploy key
 * with backup permissions; `convex run` works with the regular production deploy key.
 */
export const stage = internalMutation({
  args: { rows: v.array(v.object({ run: v.string(), kind: v.string(), linearId: v.string(), payload: v.any() })) },
  handler: async (ctx, args) => {
    if (args.rows.length > STAGE_MAX_ROWS) throw new Error(`At most ${STAGE_MAX_ROWS} rows per call.`);
    for (const row of args.rows) await ctx.db.insert('importStaging', row);
    return { staged: args.rows.length };
  },
});

/** Creates the run and schedules the first step. */
export const start = internalMutation({
  args: { run: v.string(), notes: v.array(v.string()) },
  handler: async (ctx, args): Promise<Id<'importRuns'>> => {
    const runId = await startImport(ctx, args.run, args.notes);
    await ctx.scheduler.runAfter(0, internal.importer.step, { runId });
    return runId;
  },
});

/** One batch. Schedules the next step in the same transaction while work remains. */
export const advance = internalMutation({
  args: { runId: v.id('importRuns') },
  handler: async (ctx, args) => {
    const result = await advanceImport(ctx, args.runId);
    if (!result.finished) await ctx.scheduler.runAfter(0, internal.importer.step, { runId: args.runId });
    return result;
  },
});

/** Runs `advance` and records an error on the run (instead of leaving it stuck). */
export const step = internalAction({
  args: { runId: v.id('importRuns') },
  handler: async (ctx, args) => {
    try {
      await ctx.runMutation(internal.importer.advance, args);
    } catch (error) {
      await ctx.runMutation(internal.importer.fail, {
        runId: args.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});

export const fail = internalMutation({
  args: { runId: v.id('importRuns'), error: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get('importRuns', args.runId);
    if (run?.status !== 'running') return;
    await ctx.db.patch('importRuns', args.runId, { status: 'failed', finishedAt: Date.now(), error: args.error.slice(0, 2000) });
  },
});

/** Cron and `start`: mark runs without progress for 15 minutes as failed. */
export const failStale = internalMutation({
  args: {},
  handler: async (ctx) => await failStaleImports(ctx, Date.now()),
});

export const summary = internalQuery({
  args: { runId: v.id('importRuns') },
  handler: async (ctx, args) => await importSummary(ctx, args.runId),
});

const POLL_LIMIT_MS = 8 * 60_000;

/**
 * Starts a run and waits for it to finish (for `convex run`; actions may run at most
 * 10 minutes). If it takes longer, the intermediate state comes back with `status: 'running'`
 * and `push` keeps polling via `importer:summary`. Failed → throws.
 * `notes`: notes from the fetch step's summary.json.
 */
export const process = internalAction({
  args: { run: v.string(), notes: v.optional(v.array(v.string())) },
  handler: async (ctx, args): Promise<unknown> => {
    const runId: Id<'importRuns'> = await ctx.runMutation(internal.importer.start, { run: args.run, notes: args.notes ?? [] });
    const started = Date.now();
    for (let wait = 50; ; wait = Math.min(1000, wait * 2)) {
      const result = await ctx.runQuery(internal.importer.summary, { runId });
      if (!result) throw new Error('The import run has disappeared.');
      if (result.status === 'failed') throw new Error(`Import failed: ${result.error ?? 'unknown'}`);
      if (result.status === 'done' || Date.now() - started > POLL_LIMIT_MS) return result;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  },
});

/**
 * Imports a Linear document as a wiki page. Called by the tool
 * `node tooling/linear-import/index.ts document <file.md> [--prod]`, which parses the copy.
 * Repeatable without duplicates (linearLinks kind 'document'); `enableWiki` turns on the
 * team's wiki if it is off.
 */
export const importArticle = internalMutation({
  args: {
    linearId: v.string(),
    teamKey: v.string(),
    projectName: v.optional(v.string()),
    title: v.string(),
    markdown: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    sources: v.array(sourceInputValidator),
    enableWiki: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await assertWritable(ctx);
    return await importDocument(ctx, { ...args, enableWiki: args.enableWiki === true });
  },
});
