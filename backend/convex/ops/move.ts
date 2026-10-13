import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import type { Actor } from '../lib/actor';
import { takeCounter, teamCounter } from '../lib/counters';
import { invalid } from '../lib/errors';
import { idempotent } from '../lib/idempotency';
import { aliasKey } from '../lib/identifiers';
import { ensureTeamStates, teamStates } from '../lib/workflow';
import { identifierOf, LIMITS } from '../shared/constants';
import { matchingState, stateForStatus, statusOfState } from '../shared/workflow';
import { record } from './history';
import { statusTimestamps } from './issues';
import { assertIssuesAllowed, getIssue, getTeam } from './validate';

// Move issues to another team (triage "accept into team …", and from the UI).
//
// - New number in the target team (team counter, same transaction); the old identifier becomes
//   an alias (identifierAliases), so links, branch names and MCP calls keep resolving.
// - The project is dropped if it does not belong to the target team (a project belongs to
//   exactly one team); team labels of the old team are dropped, workspace labels stay.
// - seq and bucket stay (invariant: an issue never changes its bucket).
// - Statuses belong to a team: the issue gets the matching status in the target team (same
//   default status, else same name, else same status kind). The fixed order does not apply here.
// - History: one `teamId` row with old/new identifier, plus `projectId` and `labelIds` if changed.

export interface MoveTeamArgs {
  ids: Id<'issues'>[];
  teamId: Id<'teams'>;
  requestId?: string;
}

/** A moved issue, with what was dropped or newly set by the move (MCP reports this to agents). */
export interface MovedIssue {
  id: Id<'issues'>;
  identifier: string;
  previous: string;
  /** Name of the dropped project */
  droppedProject?: string;
  /** Names of the dropped team labels */
  droppedLabels: string[];
  /** Status before and after the move (name in the respective team) */
  statusFrom?: string;
  statusTo?: string;
}

export async function moveIssuesToTeam(ctx: MutationCtx, actor: Actor, args: MoveTeamArgs) {
  return await idempotent(ctx, actor, args.requestId, 'issues.moveTeam', { ...args }, async () => {
    const { moved } = await moveIssuesToTeamCore(ctx, actor, args);
    return { moved: moved.map(({ id, identifier, previous }) => ({ id, identifier, previous })) };
  });
}

/** Without idempotency (the caller handles it); `requestId` only goes into the history. */
export async function moveIssuesToTeamCore(ctx: MutationCtx, actor: Actor, args: MoveTeamArgs) {
  if (args.ids.length === 0 || args.ids.length > LIMITS.bulkUpdateMax) invalid(`Between 1 and ${LIMITS.bulkUpdateMax} issues per call.`);
  const target = await getTeam(ctx, args.teamId);
  assertIssuesAllowed(target, 'moved issues');
  const now = Date.now();
  const moved: MovedIssue[] = [];
  const unchanged: Id<'issues'>[] = [];
  for (const id of new Set(args.ids)) {
    const issue = await getIssue(ctx, id);
    if (issue.teamId === target._id) {
      unchanged.push(issue._id);
      continue;
    }
    const source = await ctx.db.get('teams', issue.teamId);
    const previous = identifierOf(source?.key ?? '?', issue.number);
    const number = await takeCounter(ctx, teamCounter(target._id), 1);
    const changes: Partial<Doc<'issues'>> = { teamId: target._id, number, updatedAt: now };
    let droppedProject: string | undefined;
    if (issue.projectId) {
      const project = await ctx.db.get('projects', issue.projectId);
      if (project?.teamId !== target._id) {
        changes.projectId = undefined;
        droppedProject = project?.name;
      }
    }
    const labels: Id<'labels'>[] = [];
    const droppedLabels: string[] = [];
    for (const labelId of issue.labelIds) {
      const label = await ctx.db.get('labels', labelId);
      if (label && (!label.teamId || label.teamId === target._id)) labels.push(labelId);
      else if (label) droppedLabels.push(label.name);
    }
    if (labels.length !== issue.labelIds.length) changes.labelIds = labels;
    const current = issue.stateId ? (await teamStates(ctx, issue.teamId)).find((s) => s._id === issue.stateId) : undefined;
    const targetStates = await ensureTeamStates(ctx, target._id, now);
    const state = current ? matchingState(targetStates, current) : stateForStatus(targetStates, issue.status);
    if (state) {
      changes.stateId = state._id;
      const status = statusOfState(state);
      if (status !== issue.status) Object.assign(changes, { status }, statusTimestamps(issue, status, now));
    }
    await ctx.db.patch('issues', issue._id, changes);
    await ctx.db.insert('identifierAliases', { key: aliasKey(source?.key ?? '?', issue.number), issueId: issue._id });
    const identifier = identifierOf(target.key, number);
    await record(ctx, actor, now, args.requestId, { issueId: issue._id, field: 'teamId', from: { teamId: issue.teamId, identifier: previous }, to: { teamId: target._id, identifier } });
    if ('projectId' in changes) await record(ctx, actor, now, args.requestId, { issueId: issue._id, field: 'projectId', from: issue.projectId });
    if (changes.stateId !== issue.stateId) await record(ctx, actor, now, args.requestId, { issueId: issue._id, field: 'stateId', from: issue.stateId, to: changes.stateId });
    if (changes.labelIds) await record(ctx, actor, now, args.requestId, { issueId: issue._id, field: 'labelIds', from: issue.labelIds, to: labels });
    moved.push({ id: issue._id, identifier, previous, droppedProject, droppedLabels, statusFrom: current?.name, statusTo: state?.name });
  }
  return { moved, unchanged };
}
