import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { ownerQuery } from './lib/auth';
import { readCounter, SEQ } from './lib/counters';
import { rejectWritesActive } from './lib/testSwitches';
import { ownerProfile } from './ops/profile';
import { recentClosedSprints } from './ops/sprints';
import { compareStates } from './shared/workflow';

/** Number of closed sprints meta.get returns. */
const RECENT_CLOSED = 6;

/**
 * URL of a team logo: our own endpoint GET /logo/<storageId> (convex/http.ts) with a strict
 * Content-Security-Policy, not the raw storage URL.
 */
function logoUrl(storageId: Id<'_storage'>) {
  const site = (process.env.CONVEX_SITE_URL ?? '').replace(/\/+$/, '');
  return `${site}/logo/${storageId}`;
}

/**
 * Reference data for the UI, one subscription per client. Deliberately WITHOUT the counter: new
 * issues don't change this query (that's what `meta.counter` is for).
 */
export const get = ownerQuery({
  args: {},
  handler: async (ctx) => {
    const [teams, workflowStates, projects, labelGroups, labels, planning, active, closedSelfbound] = await Promise.all([
      ctx.db.query('teams').take(500),
      ctx.db.query('workflowStates').take(5000),
      ctx.db.query('projects').take(2000),
      ctx.db.query('labelGroups').take(500),
      ctx.db.query('labels').take(2000),
      ctx.db
        .query('sprints')
        .withIndex('by_state', (q) => q.eq('state', 'planning'))
        .take(100),
      ctx.db
        .query('sprints')
        .withIndex('by_state', (q) => q.eq('state', 'active'))
        .take(10),
      recentClosedSprints(ctx, 'selfbound', RECENT_CLOSED),
    ]);
    // The most recently closed sprints by close time, Selfbound sprints first. Imported Linear cycles
    // only fill up while there are fewer than RECENT_CLOSED Selfbound sprints.
    const closed = [...closedSelfbound, ...(await recentClosedSprints(ctx, 'linear', RECENT_CLOSED - closedSelfbound.length))];
    const teamsWithLogos = teams
      .sort((a, b) => a.order - b.order)
      .map((team) => ({
        ...team,
        logoUrl: team.logoId ? logoUrl(team.logoId) : null,
        logoDarkUrl: team.logoDarkId ? logoUrl(team.logoDarkId) : null,
      }));
    return {
      teams: teamsWithLogos,
      // States of all teams, archived ones included (history). Order: shared/workflow.ts compareStates.
      workflowStates: workflowStates.sort(compareStates),
      projects: projects.sort((a, b) => a.order - b.order),
      labelGroups,
      labels,
      sprints: [...active, ...planning, ...closed].sort((a, b) => b.number - a.number),
      rejectWrites: await rejectWritesActive(ctx),
      // The owner's profile (name and picture URL; null = not set)
      owner: await ownerProfile(ctx),
    };
  },
});

/** Highest assigned seq: it determines which buckets the client subscribes to. */
export const counter = ownerQuery({
  args: {},
  returns: v.object({ maxSeq: v.number() }),
  handler: async (ctx) => ({ maxSeq: await readCounter(ctx, SEQ) }),
});
