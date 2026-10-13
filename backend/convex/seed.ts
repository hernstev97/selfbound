import { v } from 'convex/values';
import type { Id, TableNames } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { ownerMutation, ownerQuery } from './lib/auth';
import { setCounter, SEQ, SPRINT, teamCounter } from './lib/counters';
import { fail } from './lib/errors';
import { ensureTeamStates, stateFields } from './lib/workflow';
import { BODY_SEARCH_CHARS } from './ops/bodies';
import { readOpsStatus, writeOpsStatus } from './ops/maintenance';
import schema, {
  actorValidator,
  prDetailDataValidator,
  prItemFields,
  prStateValidator,
  priorityValidator,
  projectStateValidator,
  relationTypeValidator,
  sprintItemKindValidator,
  sprintOutcomeValidator,
  sprintStateValidator,
  statusValidator,
} from './schema';
import { bucketOf } from './shared/constants';
import { stateForStatus } from './shared/workflow';

// Load synthetic test data (called by backend/scripts/seed.ts).
// Guarded twice: only for the owner (ownerMutation) AND only if the deployment
// has XLR8_ALLOW_SEED=1 set (local only).

function assertSeedAllowed() {
  if (process.env.XLR8_ALLOW_SEED !== '1') {
    fail('access_denied', 'Test data is not allowed on this backend (XLR8_ALLOW_SEED is not set).');
  }
}

export const MAX_ISSUES_PER_CALL = 200;
const RESET_BATCH = 2000;
const TABLES = Object.keys(schema.tables) as TableNames[];

/** State of the last loaded dataset (null = none or incomplete). */
export const status = ownerQuery({
  args: {},
  handler: async (ctx) => {
    assertSeedAllowed();
    return (await readOpsStatus(ctx, 'seed'))?.value ?? null;
  },
});

/** Deletes ALL data in batches. Call until done = true. */
export const reset = ownerMutation({
  args: {},
  handler: async (ctx) => {
    assertSeedAllowed();
    // Convex limits per call: 4096 reads, 16 MiB read. Descriptions are up to 3 KB,
    // so at most 2000 documents per call (about 6 MiB).
    let budget = RESET_BATCH;
    let deleted = 0;
    for (const table of TABLES) {
      if (table === 'settings') continue;
      const rows = await ctx.db.query(table).take(budget);
      for (const row of rows) {
        if (table === 'teams') {
          const team = row as unknown as { logoId?: Id<'_storage'>; logoDarkId?: Id<'_storage'> };
          if (team.logoId) await ctx.storage.delete(team.logoId);
          if (team.logoDarkId) await ctx.storage.delete(team.logoDarkId);
        }
        await ctx.db.delete(row._id);
      }
      deleted += rows.length;
      budget -= rows.length;
      if (budget <= 0) return { done: false, deleted };
    }
    return { done: true, deleted };
  },
});

const sprintPayload = v.object({
  number: v.number(),
  name: v.string(),
  goal: v.string(),
  startDate: v.string(),
  endDate: v.string(),
  state: sprintStateValidator,
  capacity: v.optional(v.number()),
  startedAt: v.optional(v.number()),
  closedAt: v.optional(v.number()),
});

/** Base data: teams, label groups, labels, projects, agents (hash only), sprints, recurrences. */
export const insertBase = ownerMutation({
  args: {
    teams: v.array(v.object({ key: v.string(), name: v.string(), hue: v.number(), dormant: v.boolean(), order: v.number() })),
    labelGroups: v.array(v.object({ name: v.string(), exclusive: v.boolean(), hue: v.number() })),
    labels: v.array(v.object({ name: v.string(), hue: v.number(), group: v.optional(v.string()), teamKey: v.optional(v.string()) })),
    projects: v.array(v.object({ teamKey: v.string(), name: v.string(), state: projectStateValidator, order: v.number() })),
    agents: v.array(v.object({ name: v.string(), keyHash: v.string(), keyPrefix: v.string() })),
    sprints: v.array(sprintPayload),
    recurrences: v.array(
      v.object({
        teamKey: v.string(),
        title: v.string(),
        description: v.string(),
        priority: priorityValidator,
        labels: v.array(v.string()),
        cadence: v.union(v.literal('weekly'), v.literal('monthly')),
        weekday: v.optional(v.number()),
        monthDay: v.optional(v.number()),
        nextDate: v.string(),
      }),
    ),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    assertSeedAllowed();
    if (await ctx.db.query('teams').first()) fail('invalid', 'There is already data. Call seed.reset first.');
    const teams: { key: string; id: Id<'teams'> }[] = [];
    for (const team of args.teams) teams.push({ key: team.key, id: await ctx.db.insert('teams', { ...team, updatedAt: args.now }) });
    for (const team of teams) await ensureTeamStates(ctx, team.id, args.now);
    const teamId = (key: string) => teams.find((t) => t.key === key)!.id;
    const groups: { name: string; id: Id<'labelGroups'> }[] = [];
    for (const group of args.labelGroups) groups.push({ name: group.name, id: await ctx.db.insert('labelGroups', group) });
    const labels: { name: string; id: Id<'labels'> }[] = [];
    for (const { group, teamKey, ...label } of args.labels) {
      const groupId = group ? groups.find((g) => g.name === group)!.id : undefined;
      labels.push({
        name: label.name,
        id: await ctx.db.insert('labels', { ...label, ...(groupId ? { groupId } : {}), ...(teamKey ? { teamId: teamId(teamKey) } : {}) }),
      });
    }
    const projects: { name: string; id: Id<'projects'> }[] = [];
    for (const { teamKey, ...project } of args.projects) {
      projects.push({
        name: project.name,
        id: await ctx.db.insert('projects', { ...project, teamId: teamId(teamKey), updatedAt: args.now }),
      });
    }
    const agents: { name: string; id: Id<'agents'> }[] = [];
    for (const agent of args.agents) {
      agents.push({ name: agent.name, id: await ctx.db.insert('agents', { ...agent, createdAt: args.now - 60 * 86_400_000 }) });
    }
    const sprints: { number: number; id: Id<'sprints'> }[] = [];
    for (const sprint of args.sprints) {
      sprints.push({
        number: sprint.number,
        id: await ctx.db.insert('sprints', { ...sprint, source: 'xlr8', updatedAt: sprint.closedAt ?? sprint.startedAt ?? args.now }),
      });
    }
    for (const { teamKey, labels: names, ...r } of args.recurrences) {
      await ctx.db.insert('recurrences', {
        ...r,
        teamId: teamId(teamKey),
        labelIds: names.map((n) => labels.find((l) => l.name === n)!.id),
        active: true,
        createdAt: args.now,
      });
    }
    return { teams, labels, projects, agents, sprints };
  },
});

const seedActor = actorValidator;

/** Up to 200 issues with description, comments, history and sprint entries. */
export const insertIssues = ownerMutation({
  args: {
    issues: v.array(
      v.object({
        seq: v.number(),
        teamId: v.id('teams'),
        number: v.number(),
        title: v.string(),
        status: statusValidator,
        priority: priorityValidator,
        labelIds: v.array(v.id('labels')),
        projectId: v.optional(v.id('projects')),
        estimate: v.optional(v.number()),
        dueDate: v.optional(v.string()),
        sprintId: v.optional(v.id('sprints')),
        rank: v.string(),
        createdBy: seedActor,
        reviewedAt: v.optional(v.number()),
        readAt: v.optional(v.number()),
        createdAt: v.number(),
        updatedAt: v.number(),
        startedAt: v.optional(v.number()),
        completedAt: v.optional(v.number()),
        canceledAt: v.optional(v.number()),
        deletedAt: v.optional(v.number()),
        description: v.string(),
        comments: v.array(v.object({ author: seedActor, body: v.string(), createdAt: v.number() })),
        sprintItems: v.array(
          v.object({
            sprintId: v.id('sprints'),
            kind: sprintItemKindValidator,
            carriedFrom: v.optional(v.id('sprints')),
            addedAt: v.number(),
            addedBy: seedActor,
            removedAt: v.optional(v.number()),
            outcome: v.optional(sprintOutcomeValidator),
          }),
        ),
        history: v.array(
          v.object({ field: v.string(), from: v.optional(v.any()), to: v.optional(v.any()), actor: seedActor, at: v.number() }),
        ),
      }),
    ),
  },
  handler: async (ctx, args) => {
    assertSeedAllowed();
    if (args.issues.length > MAX_ISSUES_PER_CALL) fail('invalid', `At most ${MAX_ISSUES_PER_CALL} issues per call.`);
    for (const { description, comments, sprintItems, history, ...issue } of args.issues) {
      const state = stateForStatus(await ensureTeamStates(ctx, issue.teamId, issue.createdAt), issue.status);
      if (!state) fail('invalid', `No state for "${issue.status}".`);
      const issueId = await ctx.db.insert('issues', { ...issue, ...stateFields(state), bucket: bucketOf(issue.seq) });
      await ctx.db.insert('issueBodies', {
        issueId,
        markdown: description,
        version: 1,
        updatedAt: issue.createdAt,
        updatedBy: issue.createdBy,
      });
      await ctx.db.insert('bodySearch', { issueId, text: description.slice(0, BODY_SEARCH_CHARS) });
      for (const comment of comments) await ctx.db.insert('comments', { issueId, ...comment });
      for (const item of sprintItems) await ctx.db.insert('sprintItems', { issueId, ...item });
      for (const row of history) await ctx.db.insert('history', { issueId, ...row });
    }
    return { inserted: args.issues.length };
  },
});

async function bySeq(ctx: MutationCtx, seq: number) {
  const issue = await ctx.db
    .query('issues')
    .withIndex('by_seq', (q) => q.eq('seq', seq))
    .unique();
  if (!issue) fail('not_found', `Issue with seq ${seq} is missing.`);
  return issue;
}

/** Links by seq: parent, relations, old identifiers. */
export const insertLinks = ownerMutation({
  args: {
    parents: v.array(v.object({ seq: v.number(), parentSeq: v.number() })),
    relations: v.array(
      v.object({ fromSeq: v.number(), toSeq: v.number(), type: relationTypeValidator, createdAt: v.number(), createdBy: seedActor }),
    ),
    aliases: v.array(v.object({ key: v.string(), seq: v.number() })),
  },
  handler: async (ctx, args) => {
    assertSeedAllowed();
    for (const { seq, parentSeq } of args.parents) {
      const issue = await bySeq(ctx, seq);
      await ctx.db.patch('issues', issue._id, { parentId: (await bySeq(ctx, parentSeq))._id });
    }
    for (const { fromSeq, toSeq, ...relation } of args.relations) {
      await ctx.db.insert('relations', { ...relation, fromId: (await bySeq(ctx, fromSeq))._id, toId: (await bySeq(ctx, toSeq))._id });
    }
    for (const alias of args.aliases) {
      await ctx.db.insert('identifierAliases', { key: alias.key, issueId: (await bySeq(ctx, alias.seq))._id });
    }
    return { parents: args.parents.length, relations: args.relations.length, aliases: args.aliases.length };
  },
});

/** Sample PRs (data/pullRequests.ts) with their stored GitHub state, without GitHub. */
export const insertPullRequests = ownerMutation({
  args: {
    prs: v.array(
      v.object({
        issueSeqs: v.array(v.number()),
        closes: v.boolean(),
        pr: v.object({
          repo: v.string(),
          number: v.number(),
          title: v.string(),
          url: v.string(),
          state: prStateValidator,
          branch: v.string(),
          author: v.string(),
          updatedAt: v.number(),
          mergedAt: v.optional(v.number()),
          headSha: v.string(),
        }),
        detail: prDetailDataValidator,
        items: v.array(v.object(prItemFields)),
      }),
    ),
    fetchedAt: v.number(),
  },
  handler: async (ctx, args) => {
    assertSeedAllowed();
    for (const { issueSeqs, closes, pr, detail, items } of args.prs) {
      const prId = await ctx.db.insert('pullRequests', pr);
      for (const seq of issueSeqs) {
        await ctx.db.insert('issuePullRequests', { issueId: (await bySeq(ctx, seq))._id, prId, via: 'branch', closes });
      }
      const reviews = new Map<string, 'approved' | 'changes_requested'>();
      for (const item of items) {
        if (item.reviewState === 'approved' || item.reviewState === 'changes_requested') reviews.set(item.author.login, item.reviewState);
      }
      const decisions = [...reviews.values()];
      const review = decisions.includes('changes_requested') ? 'changes_requested' : decisions.includes('approved') ? 'approved' : undefined;
      await ctx.db.insert('pullRequestDetails', {
        prId,
        media: [],
        fetchedAt: args.fetchedAt,
        data: detail,
        summary: { comments: items.filter((i) => i.kind !== 'review').length, ...(review ? { review } : {}) },
      });
      for (const item of items) await ctx.db.insert('pullRequestItems', { prId, ...item });
    }
    return { prs: args.prs.length };
  },
});

/** Sets the counters and marks the dataset complete. Only then does the client see new buckets. */
export const finish = ownerMutation({
  args: {
    set: v.string(),
    count: v.number(),
    teamNumbers: v.array(v.object({ teamId: v.id('teams'), number: v.number() })),
    sprintNumber: v.number(),
  },
  handler: async (ctx, args) => {
    assertSeedAllowed();
    await setCounter(ctx, SEQ, args.count - 1, true);
    await setCounter(ctx, SPRINT, args.sprintNumber, true);
    for (const { teamId, number } of args.teamNumbers) await setCounter(ctx, teamCounter(teamId), number, true);
    await writeOpsStatus(ctx, 'seed', { set: args.set, count: args.count, finishedAt: Date.now() });
    return { ok: true };
  },
});
