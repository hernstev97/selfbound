import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { isOwnerKind, type Status } from '../shared/constants';
import {
  activeStates,
  allowedTargets,
  DEFAULT_STATES,
  defaultStateName,
  MAX_STATES_PER_TEAM,
  stateForStatus,
  statusOfState,
  type WorkflowLike,
} from '../shared/workflow';
import type { Actor } from './actor';
import { fail, invalid } from './errors';
import { envVar } from './legacyEnv';

// Read, create and resolve a team's workflow states. Rules and order live in
// shared/workflow.ts (also used in the browser); this file only does the database access.

export type State = Doc<'workflowStates'>;

/** Cache per transaction: bulk changes read a team's states only once. */
const cache = new WeakMap<object, Map<Id<'teams'>, State[]>>();

function cacheOf(ctx: QueryCtx) {
  let map = cache.get(ctx.db);
  if (!map) cache.set(ctx.db, (map = new Map()));
  return map;
}

/** All states of a team (archived ones included), unordered. */
export async function teamStates(ctx: QueryCtx, teamId: Id<'teams'>): Promise<State[]> {
  const map = cacheOf(ctx);
  let states = map.get(teamId);
  if (!states) {
    states = await ctx.db
      .query('workflowStates')
      .withIndex('by_team', (q) => q.eq('teamId', teamId))
      .take(MAX_STATES_PER_TEAM * 4);
    map.set(teamId, states);
  }
  return states;
}

/** After changing a team's states: read them again. */
export function forgetTeamStates(ctx: QueryCtx, teamId: Id<'teams'>) {
  cacheOf(ctx).delete(teamId);
}

/**
 * Creates the default states if the team has none yet (new team, migration). Their names follow
 * the deployment language (SELFBOUND_LOCALE, English unless 'de').
 */
export async function ensureTeamStates(ctx: MutationCtx, teamId: Id<'teams'>, now = Date.now()): Promise<State[]> {
  const existing = await teamStates(ctx, teamId);
  if (existing.length > 0) return existing;
  const locale = envVar('LOCALE');
  const positions = new Map<string, number>();
  for (const def of DEFAULT_STATES) {
    const position = positions.get(def.type) ?? 0;
    positions.set(def.type, position + 1);
    await ctx.db.insert('workflowStates', {
      teamId,
      name: defaultStateName(def, locale),
      type: def.type,
      position,
      legacyKey: def.legacyKey,
      ...(def.isDuplicate ? { isDuplicate: true } : {}),
      createdAt: now,
      updatedAt: now,
    });
  }
  forgetTeamStates(ctx, teamId);
  return await teamStates(ctx, teamId);
}

/** A team's workflow settings (missing = no strict order). */
export function workflowOf(team: Pick<Doc<'teams'>, 'workflow'>): WorkflowLike | undefined {
  return team.workflow;
}

/**
 * Target state for create and update: either a state ID (must belong to the team and must not be
 * archived) or a status (legacy key, e.g. 'done' from a GitHub merge).
 */
export function resolveState(
  states: readonly State[],
  team: Pick<Doc<'teams'>, '_id' | 'key'>,
  input: { stateId?: Id<'workflowStates'>; status?: Status },
): State {
  if (input.stateId !== undefined) {
    const state = states.find((s) => s._id === input.stateId);
    if (!state) invalid(`The status does not belong to team ${team.key}.`, { stateId: input.stateId });
    if (state.archivedAt !== undefined) invalid(`Status "${state.name}" is archived.`, { stateId: state._id });
    if (input.status !== undefined && statusOfState(state) !== input.status) {
      invalid('The status and status key do not match.', { stateId: state._id, status: input.status });
    }
    return state;
  }
  if (input.status === undefined) invalid('No status given.');
  const state = stateForStatus(states, input.status);
  if (!state) invalid(`Team ${team.key} has no status matching "${input.status}".`, { status: input.status });
  return state;
}

/**
 * Strict order applies to the owner and agents. Automation (GitHub, import, system), undo,
 * moving teams and the move on archiving are exempt (handled by the callers).
 */
export function ruleApplies(actor: Actor) {
  return isOwnerKind(actor.kind) || actor.kind === 'agent';
}

/**
 * Throws `invalid_transition` if the transition `from → to` (from null = new issue) is not
 * allowed under strict order. The message names the allowed targets.
 */
export function assertTransition(
  actor: Actor,
  team: Pick<Doc<'teams'>, 'workflow' | 'key'>,
  states: readonly State[],
  from: State | null,
  to: State,
  identifier: string,
) {
  if (!ruleApplies(actor)) return;
  if (from && from._id === to._id) return;
  const allowed = allowedTargets(states, team.workflow, from?._id ?? null);
  if (allowed === null || allowed.has(to._id)) return;
  const names = activeStates(states)
    .filter((s) => allowed.has(s._id))
    .map((s) => s.name);
  const quoted = names.map((n) => `"${n}"`).join(', ');
  const message = from
    ? `${identifier}: status "${from.name}" → "${to.name}" is not allowed (team ${team.key} requires the workflow order). Allowed: ${quoted || 'none'}.`
    : `New issues in team ${team.key} cannot start in "${to.name}" (the team requires the workflow order). Allowed: ${quoted || 'none'}.`;
  fail('invalid_transition', message, { identifier, from: from?.name ?? null, to: to.name, allowed: names });
}

/** Fields a state sets on the issue (state ID and derived status). */
export function stateFields(state: State) {
  return { stateId: state._id, status: statusOfState(state) };
}
