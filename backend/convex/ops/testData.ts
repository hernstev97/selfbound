import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { SPRINT, setCounter, teamCounter } from '../lib/counters';
import { identifierOf } from '../shared/constants';
import { purgeIssue } from './issues';
import { purgeArticle } from './wiki';

// Remove test data from production (e.g. before the first Linear import).
// Deletes a team with everything attached to it, plus selected Selfbound sprints and
// workspace labels. Without `apply` it only returns the list and changes nothing.
//
// Safeguards: aborts as soon as anything comes from the Linear import (`linearLinks`), a
// label is on an issue of another team, or a sprint contains issues of other teams.
// That way the call never hits real data.

/** More issues do not fit safely into one transaction; test teams are small. */
const MAX_ISSUES = 200;

export interface RemoveTestTeamArgs {
  teamKey: string;
  sprintNumbers: number[];
  labelNames: string[];
  apply: boolean;
}

export async function removeTestTeam(ctx: MutationCtx, args: RemoveTestTeamArgs, now: number) {
  const team = await ctx.db
    .query('teams')
    .withIndex('by_key', (q) => q.eq('key', args.teamKey))
    .unique();
  if (!team) return { apply: args.apply, team: args.teamKey, found: false as const };

  const issues = await ctx.db
    .query('issues')
    .withIndex('by_team_number', (q) => q.eq('teamId', team._id))
    .take(MAX_ISSUES + 1);
  if (issues.length > MAX_ISSUES) throw new Error(`Team ${team.key} has more than ${MAX_ISSUES} issues. This is not a test team.`);
  const issueIds = new Set<Id<'issues'>>(issues.map((i) => i._id));

  const projects = await ctx.db
    .query('projects')
    .withIndex('by_team', (q) => q.eq('teamId', team._id))
    .collect();
  const states = await ctx.db
    .query('workflowStates')
    .withIndex('by_team', (q) => q.eq('teamId', team._id))
    .collect();
  const allLabels = await ctx.db.query('labels').collect();
  const labels = allLabels.filter((l) => l.teamId === team._id);
  for (const name of args.labelNames) {
    const label = allLabels.find((l) => l.teamId === undefined && l.name === name);
    if (!label) throw new Error(`Workspace label "${name}" does not exist.`);
    labels.push(label);
  }
  const labelIds = new Set<Id<'labels'>>(labels.map((l) => l._id));
  const groups = (await ctx.db.query('labelGroups').collect()).filter((g) => g.teamId === team._id);
  const recurrences = (await ctx.db.query('recurrences').collect()).filter((r) => r.teamId === team._id);
  const articles = await ctx.db
    .query('articles')
    .withIndex('by_team_deleted', (q) => q.eq('teamId', team._id))
    .collect();
  const topics = await ctx.db
    .query('wikiTopics')
    .withIndex('by_team', (q) => q.eq('teamId', team._id))
    .collect();

  const teamKeys = new Map((await ctx.db.query('teams').collect()).map((x) => [x._id, x.key]));

  // Safeguard 1: nothing from Linear.
  for (const doc of [team, ...issues, ...projects, ...labels, ...groups, ...articles]) {
    const link = await ctx.db
      .query('linearLinks')
      .withIndex('by_local', (q) => q.eq('localId', doc._id))
      .first();
    if (link) throw new Error(`Aborted: a record of team ${team.key} comes from the Linear import (${link.kind}).`);
  }
  // Safeguard 2: labels only on issues and recurrences of this team, no sub-issue of another
  // team (purgeIssue would clear its parent, i.e. change an issue of another team).
  for (const issue of await ctx.db.query('issues').collect()) {
    if (issueIds.has(issue._id)) continue;
    const other = () => identifierOf(teamKeys.get(issue.teamId) ?? '?', issue.number);
    if (issue.labelIds.some((id) => labelIds.has(id))) throw new Error(`Aborted: a label is on ${other()}.`);
    if (issue.parentId && issueIds.has(issue.parentId)) throw new Error(`Aborted: ${other()} is a sub-issue of an issue of team ${team.key}.`);
  }
  for (const r of await ctx.db.query('recurrences').collect()) {
    if (r.teamId !== team._id && r.labelIds.some((id) => labelIds.has(id))) throw new Error('Aborted: a label is on a recurrence of another team.');
  }
  // Safeguard 3: only Selfbound sprints that contain issues of this team only.
  const sprints: Doc<'sprints'>[] = [];
  for (const number of args.sprintNumbers) {
    const sprint = await ctx.db
      .query('sprints')
      .withIndex('by_number', (q) => q.eq('number', number))
      .unique();
    if (!sprint) throw new Error(`Sprint ${number} does not exist.`);
    if (sprint.source !== 'xlr8') throw new Error(`Aborted: sprint ${number} comes from Linear.`);
    const items = await ctx.db
      .query('sprintItems')
      .withIndex('by_sprint', (q) => q.eq('sprintId', sprint._id))
      .collect();
    if (items.some((item) => !issueIds.has(item.issueId))) throw new Error(`Aborted: sprint ${number} contains issues of other teams.`);
    sprints.push(sprint);
  }

  const perIssue = async (table: 'comments' | 'history' | 'issueBodies' | 'relations') => {
    let n = 0;
    for (const id of issueIds) {
      if (table === 'relations') {
        n += (await ctx.db.query('relations').withIndex('by_from', (q) => q.eq('fromId', id)).collect()).length;
        n += (await ctx.db.query('relations').withIndex('by_to', (q) => q.eq('toId', id)).collect()).length;
      } else {
        n += (await ctx.db.query(table).withIndex('by_issue', (q) => q.eq('issueId', id)).collect()).length;
      }
    }
    return n;
  };
  const sprintItems = (
    await Promise.all(sprints.map((s) => ctx.db.query('sprintItems').withIndex('by_sprint', (q) => q.eq('sprintId', s._id)).collect()))
  ).flat();
  const list = {
    apply: args.apply,
    team: team.key,
    found: true as const,
    issues: issues.map((i) => identifierOf(team.key, i.number)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
    inTrash: issues.filter((i) => i.deletedAt !== undefined).length,
    comments: await perIssue('comments'),
    history: await perIssue('history'),
    bodies: await perIssue('issueBodies'),
    relations: await perIssue('relations'),
    states: states.length,
    projects: projects.length,
    labels: labels.length,
    labelGroups: groups.length,
    recurrences: recurrences.length,
    articles: articles.length,
    topics: topics.length,
    sprints: sprints.map((s) => s.number),
    sprintItems: sprintItems.length,
  };
  if (!args.apply) return list;

  for (const issue of issues) await purgeIssue(ctx, issue, now);
  // Knowledge pages with their revisions; a test team has few, so purgeArticle needs only one pass.
  for (const article of articles) {
    if (!(await purgeArticle(ctx, article, now, { revisions: 1000 }))) throw new Error('Too many revisions for one pass.');
  }
  for (const topic of topics) await ctx.db.delete('wikiTopics', topic._id);
  // Tombstones of a test team are not needed for any sync (including older ones from the trash).
  const tombstones = (await ctx.db.query('articleTombstones').collect()).filter((x) => x.teamId === team._id);
  for (const tombstone of tombstones) await ctx.db.delete('articleTombstones', tombstone._id);
  for (const r of recurrences) {
    const runs = await ctx.db
      .query('recurrenceRuns')
      .withIndex('by_recurrence_date', (q) => q.eq('recurrenceId', r._id))
      .collect();
    for (const run of runs) await ctx.db.delete('recurrenceRuns', run._id);
    await ctx.db.delete('recurrences', r._id);
  }
  for (const sprint of sprints) {
    // purgeIssue leaves entries of closed sprints; they go together with the sprint.
    for (const item of await ctx.db.query('sprintItems').withIndex('by_sprint', (q) => q.eq('sprintId', sprint._id)).collect()) {
      await ctx.db.delete('sprintItems', item._id);
    }
    await ctx.db.delete('sprints', sprint._id);
  }
  for (const project of projects) {
    if (project.iconId) await ctx.storage.delete(project.iconId);
    await ctx.db.delete('projects', project._id);
  }
  for (const label of labels) await ctx.db.delete('labels', label._id);
  for (const group of groups) await ctx.db.delete('labelGroups', group._id);
  for (const state of states) await ctx.db.delete('workflowStates', state._id);
  for (const id of [team.logoId, team.logoDarkId]) if (id) await ctx.storage.delete(id);
  const counter = await ctx.db
    .query('counters')
    .withIndex('by_name', (q) => q.eq('name', teamCounter(team._id)))
    .unique();
  if (counter) await ctx.db.delete('counters', counter._id);
  await ctx.db.delete('teams', team._id);
  if (sprints.length) {
    // Reset the sprint counter to the highest remaining number: deleted numbers become free again.
    const last = await ctx.db.query('sprints').withIndex('by_number').order('desc').first();
    await setCounter(ctx, SPRINT, last?.number ?? 0, true);
  }
  return list;
}
