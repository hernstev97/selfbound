import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { ensureTeamStates, teamStates } from './lib/workflow';
import { record } from './ops/history';
import { openCreatedEntry } from './ops/inboxChanges';
import { readOpsStatus, writeOpsStatus } from './ops/maintenance';
import { canonicalTimeZone } from './lib/dates';
import { storedTimeZone, writeTimeZone } from './ops/instance';
import { removeTestTeam as removeTestTeamOp } from './ops/testData';
import { CLOSED_STATUSES } from './shared/constants';
import { stateForStatus, statusOfState } from './shared/workflow';

// One-off data migrations. Run in production with `node tooling/cloud.mjs run migrations:<name>`,
// locally with `node tooling/convex.mjs run migrations:<name>`. Every migration may run any number
// of times.
//
// Workflow states per team: every team gets the eight default states, every issue the state of
// its team that matches its previous status key. The status type (`status`), `updatedAt` and the
// history stay unchanged: this is not a change to the issue, only a new form of the same value.

const PAGE = 500;
/** Read limit per page, well below Convex's 16 MiB (an issue is about 0.5 KB). */
const MAX_BYTES = 4 * 1024 * 1024;

/** Creates missing states and sets `stateId`. Reschedules itself until everything is done. */
export const workflowBackfill = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), numItems: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    let teams = 0;
    if (!args.cursor) {
      for (const team of await ctx.db.query('teams').take(500)) {
        if ((await teamStates(ctx, team._id)).length === 0) teams++;
        await ensureTeamStates(ctx, team._id, now);
      }
    }
    const page = await ctx.db.query('issues').paginate({ cursor: args.cursor ?? null, numItems: args.numItems ?? PAGE, maximumBytesRead: MAX_BYTES });
    let updated = 0;
    for (const issue of page.page) {
      if (issue.stateId !== undefined) continue;
      const state = stateForStatus(await ensureTeamStates(ctx, issue.teamId, now), issue.status);
      if (!state || statusOfState(state) !== issue.status) {
        throw new Error(`No matching state for issue ${issue._id} (${issue.status}).`);
      }
      await ctx.db.patch('issues', issue._id, { stateId: state._id });
      updated++;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.workflowBackfill, { cursor: page.continueCursor, numItems: args.numItems });
    }
    return { teams, updated, scanned: page.page.length, done: page.isDone };
  },
});

/** One page of the verification (query: read only). */
export const workflowVerifyPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query('issues').paginate({ cursor: args.cursor, numItems: PAGE, maximumBytesRead: MAX_BYTES });
    const counts: Record<string, Record<string, number>> = {};
    const problems: string[] = [];
    const teams = new Map<Id<'teams'>, string>();
    for (const issue of page.page) {
      if (!teams.has(issue.teamId)) teams.set(issue.teamId, (await ctx.db.get('teams', issue.teamId))?.key ?? '?');
      const key = teams.get(issue.teamId)!;
      const state = issue.stateId ? (await teamStates(ctx, issue.teamId)).find((s) => s._id === issue.stateId) : undefined;
      const label = `${key}-${issue.number}`;
      if (!issue.stateId) problems.push(`${label}: no state`);
      else if (!state) problems.push(`${label}: state does not belong to the team`);
      else if (statusOfState(state) !== issue.status) problems.push(`${label}: status type ${issue.status} ≠ ${statusOfState(state)}`);
      const name = state ? state.name : `(${issue.status})`;
      counts[key] ??= {};
      counts[key][name] = (counts[key][name] ?? 0) + 1;
    }
    return { counts, problems: problems.slice(0, 50), problemCount: problems.length, isDone: page.isDone, cursor: page.continueCursor };
  },
});

/**
 * Verifies the migration across all issues: each has a state of its own team, and the status type
 * matches. Returns the count per team and state (numbers only, no content).
 */
export const workflowVerify = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    ok: boolean;
    issues: number;
    problemCount: number;
    problems: string[];
    teamsWithoutStates: string[];
    counts: Record<string, Record<string, number>>;
  }> => {
    const counts: Record<string, Record<string, number>> = {};
    const problems: string[] = [];
    let problemCount = 0;
    let issues = 0;
    let cursor: string | null = null;
    for (;;) {
      const page: {
        counts: Record<string, Record<string, number>>;
        problems: string[];
        problemCount: number;
        isDone: boolean;
        cursor: string;
      } = await ctx.runQuery(internal.migrations.workflowVerifyPage, { cursor });
      for (const [team, byState] of Object.entries(page.counts)) {
        counts[team] ??= {};
        for (const [state, n] of Object.entries(byState)) {
          counts[team][state] = (counts[team][state] ?? 0) + n;
          issues += n;
        }
      }
      problems.push(...page.problems.slice(0, 50 - problems.length));
      problemCount += page.problemCount;
      if (page.isDone) break;
      cursor = page.cursor;
    }
    const teamsWithoutStates: string[] = await ctx.runQuery(internal.migrations.teamsWithoutStates, {});
    return { ok: problemCount === 0 && teamsWithoutStates.length === 0, issues, problemCount, problems, teamsWithoutStates, counts };
  },
});

export const teamsWithoutStates = internalQuery({
  args: {},
  handler: async (ctx) => {
    const out: string[] = [];
    for (const team of await ctx.db.query('teams').take(500)) {
      if ((await teamStates(ctx, team._id)).length === 0) out.push(team.key);
    }
    return out;
  },
});

/**
 * Removes a test team (for example before the first Linear import) with its projects, team
 * labels, states and recurrences, plus the given Selfbound sprints and workspace labels.
 * Without `apply: true` it only lists what it would remove (identifiers and counts). Aborts if
 * anything came from Linear.
 */
export const removeTestTeam = internalMutation({
  args: {
    teamKey: v.string(),
    sprintNumbers: v.optional(v.array(v.number())),
    labelNames: v.optional(v.array(v.string())),
    apply: v.optional(v.boolean()),
  },
  handler: async (ctx, args) =>
    await removeTestTeamOp(
      ctx,
      { teamKey: args.teamKey, sprintNumbers: args.sprintNumbers ?? [], labelNames: args.labelNames ?? [], apply: args.apply === true },
      Date.now(),
    ),
});

/**
 * Done, canceled and duplicate issues lose their priority (every status change applies this rule
 * now; this cleans up older data, mostly from the Linear import).
 * Without `apply: true` it only counts (per status type and priority, no content; returns `cursor`
 * while there are more pages: call again with `{ "cursor": … }`). With `apply: true`: priority set
 * to none, `updatedAt` bumped (a change to the issue, so clients see it), one `priority` history
 * row with actor "system", reschedules itself. Includes the trash. Safe to run repeatedly.
 */
export const priorityClearClosed = internalMutation({
  args: { apply: v.optional(v.boolean()), cursor: v.optional(v.union(v.string(), v.null())), numItems: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const page = await ctx.db.query('issues').paginate({ cursor: args.cursor ?? null, numItems: args.numItems ?? PAGE, maximumBytesRead: MAX_BYTES });
    const found: Record<string, number> = {};
    let changed = 0;
    for (const issue of page.page) {
      if (issue.priority === 0 || !CLOSED_STATUSES.includes(issue.status)) continue;
      const key = `${issue.status}/${issue.priority}`;
      found[key] = (found[key] ?? 0) + 1;
      if (args.apply !== true) continue;
      await ctx.db.patch('issues', issue._id, { priority: 0, updatedAt: now });
      await record(ctx, { kind: 'system' }, now, undefined, { issueId: issue._id, field: 'priority', from: issue.priority, to: 0 });
      changed++;
    }
    if (args.apply === true && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.priorityClearClosed, { apply: true, cursor: page.continueCursor, numItems: args.numItems });
    }
    return {
      applied: args.apply === true,
      scanned: page.page.length,
      found: Object.values(found).reduce((a, b) => a + b, 0),
      changed,
      byStatusAndPriority: found,
      done: page.isDone,
      ...(page.isDone ? {} : { cursor: page.continueCursor }),
    };
  },
});

/**
 * Inbox entries from the old markers on issues: every issue without `reviewedAt` (the old inbox,
 * the trash included, so a restored issue comes back as before) gets one entry of kind `created`
 * with the issue's creation time and its `readAt`. The issues are not touched; the markers stay as
 * they are.
 * Without `apply: true` it only counts (`missing` = issues that would get an entry; after the real
 * run it is 0). With `apply: true` it works page by page and reschedules itself. Safe to run again:
 * an issue that already has an entry (open or removed) is skipped, and once the last page is done
 * a note in `opsStatus` makes later runs do nothing, so entries the owner removed are never
 * brought back. `force: true` ignores the note.
 */
export const inboxBackfill = internalMutation({
  args: { apply: v.optional(v.boolean()), cursor: v.optional(v.union(v.string(), v.null())), numItems: v.optional(v.number()), force: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const apply = args.apply === true;
    if (apply && !args.cursor && args.force !== true) {
      const done = await readOpsStatus(ctx, 'inboxBackfill');
      if (done) return { applied: false, skipped: 'already done', doneAt: done.at, scanned: 0, missing: 0, existing: 0, done: true };
    }
    const page = await ctx.db.query('issues').paginate({ cursor: args.cursor ?? null, numItems: args.numItems ?? PAGE, maximumBytesRead: MAX_BYTES });
    let missing = 0;
    let existing = 0;
    for (const issue of page.page) {
      if (issue.reviewedAt !== undefined) continue;
      const entry = await ctx.db.query('inboxEntries').withIndex('by_issue', (q) => q.eq('issueId', issue._id)).first();
      if (entry) {
        existing++;
        continue;
      }
      missing++;
      if (apply) await openCreatedEntry(ctx, issue.createdBy, issue._id, issue.createdAt, issue.readAt);
    }
    if (apply && page.isDone) await writeOpsStatus(ctx, 'inboxBackfill', { done: true });
    if (apply && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.inboxBackfill, { apply: true, cursor: page.continueCursor, numItems: args.numItems, force: args.force });
    }
    return {
      applied: apply,
      scanned: page.page.length,
      missing,
      existing,
      done: page.isDone,
      ...(page.isDone ? {} : { cursor: page.continueCursor }),
    };
  },
});

/**
 * Sets the instance time zone, e.g. `{"timeZone":"Europe/Berlin"}`. For an existing instance, run
 * it before the first sign-in after the update: otherwise the app saves the browser's zone then.
 * Stored days are plain "YYYY-MM-DD" strings and stay as they are. Without arguments it only
 * reports the current zone.
 */
export const setInstanceTimeZone = internalMutation({
  args: { timeZone: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (args.timeZone === undefined) return { timeZone: await storedTimeZone(ctx), applied: false };
    if (!canonicalTimeZone(args.timeZone)) throw new Error(`Unknown time zone "${args.timeZone}".`);
    return { ...(await writeTimeZone(ctx, args.timeZone)), applied: true };
  },
});
