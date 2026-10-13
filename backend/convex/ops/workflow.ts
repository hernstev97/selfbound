import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import type { Actor } from '../lib/actor';
import { fail, invalid, notFound } from '../lib/errors';
import { ensureTeamStates, forgetTeamStates, teamStates, type State } from '../lib/workflow';
import { CLOSED_STATUSES, OWNER_KIND } from '../shared/constants';
import {
  activeStates,
  MAX_EXCEPTIONS,
  MAX_STATES_PER_TEAM,
  STATE_DESCRIPTION_MAX,
  STATE_NAME_MAX,
  statusOfState,
  type StateType,
} from '../shared/workflow';
import { applyPatch, statusTimestamps } from './issues';
import { checkName, getTeam } from './validate';

// Configure a team's statuses: create, rename, color, reorder, archive, default,
// fixed order with exceptions. Owner only.
//
// Rules:
// - Names are unique per team (case-insensitive, among non-archived statuses).
// - A status's type is fixed; to change it, create a new status and move the issues.
// - Archive instead of delete. Blocked for the default status and for the last status of the
//   types unstarted, completed and canceled (recurrences, GitHub merges and canceling need them).
//   Issues in the status first move to `moveTo` (in pages, as the owner).

/** Issues moved per archive call; the call schedules itself again for the rest. */
export const MOVE_BATCH = 200;

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const NEEDED: readonly StateType[] = ['unstarted', 'completed', 'canceled'];

export function assertCanManageWorkflow(actor: Actor) {
  if (actor.kind !== OWNER_KIND) fail('access_denied', 'Only the owner can configure statuses.');
}

async function getState(ctx: MutationCtx, stateId: Id<'workflowStates'>): Promise<State> {
  return (await ctx.db.get('workflowStates', stateId)) ?? notFound('The status', { stateId });
}

function checkColor(color: string | null | undefined) {
  if (color === undefined || color === null) return undefined;
  if (!COLOR_RE.test(color)) invalid('The color must be given as #rrggbb.');
  return color.toLowerCase();
}

function checkDescription(text: string | null | undefined) {
  if (text === undefined || text === null) return undefined;
  const trimmed = text.trim();
  if (trimmed.length > STATE_DESCRIPTION_MAX) invalid(`The description is too long (at most ${STATE_DESCRIPTION_MAX} characters).`);
  return trimmed || undefined;
}

function assertNameFree(states: readonly State[], name: string, except?: Id<'workflowStates'>) {
  const taken = states.find((s) => s.archivedAt === undefined && s._id !== except && s.name.toLowerCase() === name.toLowerCase());
  if (taken) invalid(`Status "${taken.name}" already exists in this team.`);
}

export async function createState(
  ctx: MutationCtx,
  actor: Actor,
  args: { teamId: Id<'teams'>; name: string; type: StateType; color?: string; description?: string },
) {
  assertCanManageWorkflow(actor);
  const team = await getTeam(ctx, args.teamId);
  const now = Date.now();
  const states = await ensureTeamStates(ctx, team._id, now);
  const name = checkName(args.name, 'The status', STATE_NAME_MAX);
  assertNameFree(states, name);
  const active = activeStates(states);
  if (active.length >= MAX_STATES_PER_TEAM) invalid(`At most ${MAX_STATES_PER_TEAM} statuses per team.`);
  if (args.type === 'triage' && active.some((s) => s.type === 'triage')) invalid('A team has at most one triage status.');
  const position = states.filter((s) => s.type === args.type).reduce((max, s) => Math.max(max, s.position), -1) + 1;
  const stateId = await ctx.db.insert('workflowStates', {
    teamId: team._id,
    name,
    type: args.type,
    position,
    ...(checkColor(args.color) ? { color: checkColor(args.color) } : {}),
    ...(checkDescription(args.description) ? { description: checkDescription(args.description) } : {}),
    createdAt: now,
    updatedAt: now,
  });
  forgetTeamStates(ctx, team._id);
  return { stateId };
}

export async function updateState(
  ctx: MutationCtx,
  actor: Actor,
  args: { stateId: Id<'workflowStates'>; name?: string; color?: string | null; description?: string | null },
) {
  assertCanManageWorkflow(actor);
  const state = await getState(ctx, args.stateId);
  const patch: Partial<Doc<'workflowStates'>> = {};
  if (args.name !== undefined) {
    const name = checkName(args.name, 'The status', STATE_NAME_MAX);
    if (name !== state.name) {
      assertNameFree(await teamStates(ctx, state.teamId), name, state._id);
      patch.name = name;
    }
  }
  if (args.color !== undefined) patch.color = checkColor(args.color);
  if (args.description !== undefined) patch.description = checkDescription(args.description);
  if (Object.keys(patch).length) {
    await ctx.db.patch('workflowStates', state._id, { ...patch, updatedAt: Date.now() });
    forgetTeamStates(ctx, state.teamId);
  }
  return { stateId: state._id };
}

/** New order within one type (statuses of that type missing from the list go to the end). */
export async function reorderStates(ctx: MutationCtx, actor: Actor, args: { teamId: Id<'teams'>; stateIds: Id<'workflowStates'>[] }) {
  assertCanManageWorkflow(actor);
  const states = await teamStates(ctx, args.teamId);
  const listed = args.stateIds.map((id) => states.find((s) => s._id === id) ?? invalid('A status does not belong to the team.', { stateId: id }));
  const types = new Set(listed.map((s) => s.type));
  if (types.size > 1) invalid('Statuses can only be reordered within one type.');
  const [type] = types;
  if (!type) return { count: 0 };
  const rest = states.filter((s) => s.type === type && !args.stateIds.includes(s._id)).sort((a, b) => a.position - b.position);
  const now = Date.now();
  let count = 0;
  for (const [position, state] of [...listed, ...rest].entries()) {
    if (state.position === position) continue;
    await ctx.db.patch('workflowStates', state._id, { position, updatedAt: now });
    count++;
  }
  forgetTeamStates(ctx, args.teamId);
  return { count };
}

/**
 * Archive. If the status has issues (deleted or not), `moveTo` is required: they move to that
 * status (history per issue). Beyond MOVE_BATCH issues, the call schedules itself again.
 */
export async function archiveState(
  ctx: MutationCtx,
  actor: Actor,
  args: { stateId: Id<'workflowStates'>; moveTo?: Id<'workflowStates'> },
): Promise<{ stateId: Id<'workflowStates'>; moved: number; more: boolean }> {
  assertCanManageWorkflow(actor);
  const state = await getState(ctx, args.stateId);
  const team = await getTeam(ctx, state.teamId);
  const states = await teamStates(ctx, team._id);
  if (state.archivedAt === undefined) {
    const active = activeStates(states);
    if (team.workflow?.defaultStateId === state._id) {
      invalid(`"${state.name}" is the default status for new issues. Choose another default first.`);
    }
    if (NEEDED.includes(state.type) && active.filter((s) => s.type === state.type).length === 1) {
      invalid(`"${state.name}" is the last status of its type and is required.`);
    }
  }
  const target = args.moveTo ? await getState(ctx, args.moveTo) : null;
  if (target && (target.teamId !== team._id || target.archivedAt !== undefined || target._id === state._id)) {
    invalid('The target must be a different, non-archived status of the same team.');
  }
  const issues = await ctx.db
    .query('issues')
    .withIndex('by_state', (q) => q.eq('stateId', state._id))
    .take(MOVE_BATCH + 1);
  if (issues.length > 0 && !target) {
    invalid(`Status "${state.name}" still has issues. Choose a target status to move them to.`, { count: issues.length });
  }
  const now = Date.now();
  let moved = 0;
  for (const issue of issues.slice(0, MOVE_BATCH)) {
    if (issue.deletedAt !== undefined) {
      // Trash: move without history (applyPatch rejects deleted issues).
      const status = statusOfState(target!);
      await ctx.db.patch('issues', issue._id, {
        stateId: target!._id,
        ...(status !== issue.status ? { status, ...statusTimestamps(issue, status, now) } : {}),
        ...(CLOSED_STATUSES.includes(status) ? { priority: 0 } : {}),
      });
    } else {
      await applyPatch(ctx, actor, issue._id, { stateId: target!._id }, undefined, now, undefined, { force: true });
    }
    moved++;
  }
  // Exceptions that point to the archived status are dropped.
  if (team.workflow && team.workflow.exceptions.some((e) => e.from === state._id || e.to === state._id)) {
    await ctx.db.patch('teams', team._id, {
      workflow: { ...team.workflow, exceptions: team.workflow.exceptions.filter((e) => e.from !== state._id && e.to !== state._id) },
      updatedAt: now,
    });
  }
  if (state.archivedAt === undefined) await ctx.db.patch('workflowStates', state._id, { archivedAt: now, updatedAt: now });
  forgetTeamStates(ctx, team._id);
  return { stateId: state._id, moved, more: issues.length > MOVE_BATCH };
}

export async function restoreState(ctx: MutationCtx, actor: Actor, args: { stateId: Id<'workflowStates'> }) {
  assertCanManageWorkflow(actor);
  const state = await getState(ctx, args.stateId);
  if (state.archivedAt === undefined) return { stateId: state._id };
  const states = await teamStates(ctx, state.teamId);
  assertNameFree(states, state.name, state._id);
  if (state.type === 'triage' && activeStates(states).some((s) => s.type === 'triage')) invalid('A team has at most one triage status.');
  if (activeStates(states).length >= MAX_STATES_PER_TEAM) invalid(`At most ${MAX_STATES_PER_TEAM} statuses per team.`);
  await ctx.db.patch('workflowStates', state._id, { archivedAt: undefined, updatedAt: Date.now() });
  forgetTeamStates(ctx, state.teamId);
  return { stateId: state._id };
}

/** Workflow settings: default status, fixed order, exceptions. */
export async function setWorkflow(
  ctx: MutationCtx,
  actor: Actor,
  args: {
    teamId: Id<'teams'>;
    strict?: boolean;
    exceptions?: { from: Id<'workflowStates'>; to: Id<'workflowStates'> }[];
    defaultStateId?: Id<'workflowStates'> | null;
  },
) {
  assertCanManageWorkflow(actor);
  const team = await getTeam(ctx, args.teamId);
  const states = await ensureTeamStates(ctx, team._id);
  const live = (id: Id<'workflowStates'>) => {
    const s = states.find((x) => x._id === id);
    if (!s || s.archivedAt !== undefined) invalid('A status does not belong to the team or is archived.', { stateId: id });
    return s;
  };
  const current = team.workflow ?? { strict: false, exceptions: [] };
  const next = { ...current };
  if (args.strict !== undefined) next.strict = args.strict;
  if (args.exceptions !== undefined) {
    if (args.exceptions.length > MAX_EXCEPTIONS) invalid(`At most ${MAX_EXCEPTIONS} exceptions.`);
    const seen = new Set<string>();
    next.exceptions = [];
    for (const e of args.exceptions) {
      live(e.from);
      live(e.to);
      if (e.from === e.to) invalid('An exception needs two different statuses.');
      const key = `${e.from}>${e.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      next.exceptions.push(e);
    }
  }
  if (args.defaultStateId !== undefined) {
    if (args.defaultStateId === null) delete next.defaultStateId;
    else {
      const s = live(args.defaultStateId);
      if (s.type === 'triage' || s.type === 'completed' || s.type === 'canceled') invalid('The default for new issues can only be a backlog, unstarted or started status.');
      next.defaultStateId = s._id;
    }
  }
  await ctx.db.patch('teams', team._id, { workflow: next, updatedAt: Date.now() });
  return { teamId: team._id };
}
