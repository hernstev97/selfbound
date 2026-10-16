import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { isDay } from '../lib/dates';
import { fail, invalid, notFound } from '../lib/errors';
import { LIMITS } from '../shared/constants';
import { choiceProblem, MODEL_LIMITS, normalizeChoice, sameModel, type ModelChoice } from '../shared/models';

// Field checks shared by create, update, recurrences and MCP.

export function checkTitle(title: string): string {
  const trimmed = title.replace(/\s+/g, ' ').trim();
  if (!trimmed) invalid('The title must not be empty.');
  if (trimmed.length > LIMITS.titleMax) invalid(`The title is too long (at most ${LIMITS.titleMax} characters).`);
  return trimmed;
}

export function checkDescription(markdown: string): string {
  if (markdown.length > LIMITS.descriptionMax) {
    invalid(`The description is too long (at most ${LIMITS.descriptionMax.toLocaleString('en-US')} characters).`);
  }
  return markdown;
}

export function checkComment(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) invalid('The comment must not be empty.');
  if (trimmed.length > LIMITS.commentMax) {
    invalid(`The comment is too long (at most ${LIMITS.commentMax.toLocaleString('en-US')} characters).`);
  }
  return trimmed;
}

export function checkEstimate(estimate: number): number {
  if (!Number.isFinite(estimate) || estimate < 0 || estimate > 1000) {
    invalid('The estimate must be a number between 0 and 1000.');
  }
  return estimate;
}

export function checkDay(day: string, what = 'The date'): string {
  if (!isDay(day)) invalid(`${what} must be a calendar day in the format YYYY-MM-DD.`);
  return day;
}

export function checkHue(hue: number): number {
  if (!Number.isFinite(hue) || hue < 0 || hue > 360) invalid('The hue must be between 0 and 360.');
  return hue;
}

export function checkName(name: string, what: string, max = 100): string {
  const trimmed = name.replace(/\s+/g, ' ').trim();
  if (!trimmed) invalid(`${what} needs a name.`);
  if (trimmed.length > max) invalid(`The name is too long (at most ${max} characters).`);
  return trimmed;
}

export async function getTeam(ctx: QueryCtx, teamId: Id<'teams'>): Promise<Doc<'teams'>> {
  return (await ctx.db.get('teams', teamId)) ?? notFound('The team');
}

/** Knowledge-only teams get no new issues: none created there, none moved in. */
export function assertIssuesAllowed(team: Doc<'teams'>, what = 'new issues') {
  if (team.wiki === 'only') invalid(`${team.name} (${team.key}) only holds knowledge pages and takes no ${what}.`, { teamId: team._id });
}

/**
 * Labels: must exist, be workspace labels or labels of the same team, at most one label
 * per single-choice group. Archived labels only if they are in `keep` (already on the issue,
 * or on it before the change being undone): archiving forbids new assignments but blocks
 * no other changes. Returns the list without duplicates.
 */
export async function checkLabels(
  ctx: QueryCtx,
  teamId: Id<'teams'>,
  labelIds: Id<'labels'>[],
  keep: ReadonlySet<Id<'labels'>> = new Set(),
): Promise<Id<'labels'>[]> {
  const unique = [...new Set(labelIds)];
  if (unique.length > 30) invalid('At most 30 labels per issue.');
  const perGroup = new Map<Id<'labelGroups'>, string[]>();
  for (const labelId of unique) {
    const label = await ctx.db.get('labels', labelId);
    if (!label) notFound('The label', { labelId });
    if (label.archived && !keep.has(labelId)) invalid(`Label "${label.name}" is archived.`, { labelId });
    if (label.teamId && label.teamId !== teamId) {
      invalid(`Label "${label.name}" belongs to another team.`, { labelId });
    }
    if (label.groupId) perGroup.set(label.groupId, [...(perGroup.get(label.groupId) ?? []), label.name]);
  }
  for (const [groupId, names] of perGroup) {
    if (names.length < 2) continue;
    const group = await ctx.db.get('labelGroups', groupId);
    if (group?.exclusive) {
      invalid(`Group "${group.name}" allows only one label (chosen: ${names.join(', ')}).`, { groupId });
    }
  }
  return unique;
}

export async function checkProject(ctx: QueryCtx, teamId: Id<'teams'>, projectId: Id<'projects'>) {
  const project = await ctx.db.get('projects', projectId);
  if (!project) notFound('The project', { projectId });
  if (project.teamId !== teamId) invalid(`Project "${project.name}" belongs to another team.`, { projectId });
  return project;
}

/** The parent exists, is not in the trash and creates no cycle. */
export async function checkParent(ctx: QueryCtx, issueId: Id<'issues'> | null, parentId: Id<'issues'>) {
  if (issueId && parentId === issueId) invalid('An issue cannot be its own parent.');
  const parent = await ctx.db.get('issues', parentId);
  if (!parent) notFound('The parent issue', { parentId });
  if (parent.deletedAt !== undefined) invalid('The parent issue is in the trash.', { parentId });
  if (issueId) {
    // Walk up the chain: reaching the issue itself would create a cycle.
    let cursor: Doc<'issues'> | null = parent;
    for (let depth = 0; cursor?.parentId; depth++) {
      if (cursor.parentId === issueId) invalid('This would create a cycle of sub-issues.');
      if (depth > 100) fail('invalid', 'The chain of parent issues is too long.');
      cursor = await ctx.db.get('issues', cursor.parentId);
    }
  }
  return parent;
}

export async function getIssue(ctx: QueryCtx, id: Id<'issues'>, opts: { allowDeleted?: boolean } = {}) {
  const issue = await ctx.db.get('issues', id);
  if (!issue) notFound('The issue', { issueId: id });
  if (issue.deletedAt !== undefined && !opts.allowDeleted) {
    invalid('The issue is in the trash. Restore it first.', { issueId: id });
  }
  return issue;
}

/** The catalog row of a model, or null. */
export async function modelRow(ctx: QueryCtx, provider: string, modelId: string): Promise<Doc<'models'> | null> {
  if (!provider || !modelId || provider.length > MODEL_LIMITS.provider || modelId.length > MODEL_LIMITS.modelId) return null;
  return await ctx.db
    .query('models')
    .withIndex('by_provider_model', (q) => q.eq('provider', provider).eq('modelId', modelId))
    .unique();
}

/**
 * A desired model (XLR8-93): enabled in the settings and still in the catalog, effort and speed among
 * the model's values. The model the issue (or team) already has (`keep`) stays allowed after it was
 * disabled or left the catalog, like an archived label; so does, on undo, the model the last change
 * replaced (`undo`). Effort and speed are always checked against the last known catalog values.
 * Returns the stored form (`normalizeChoice`).
 */
export async function checkModel(
  ctx: QueryCtx,
  choice: ModelChoice,
  opts: { keep?: ModelChoice | null; undo?: ModelChoice | null } = {},
): Promise<ModelChoice> {
  const model = normalizeChoice(choice);
  const row = await modelRow(ctx, model.provider, model.modelId);
  const hint = ' Call list_models for the enabled models and their values.';
  if (row && !sameModel(model, opts.keep) && !sameModel(model, opts.undo)) {
    if (row.removedAt !== undefined) invalid(`${row.name} is no longer in the models.dev catalog.`, { model: model.modelId });
    if (!row.enabled) invalid(`${row.name} is not enabled. Enable it under Settings › Models.`, { model: model.modelId });
  }
  const problem = choiceProblem(model, row ? { name: row.name, efforts: row.efforts ?? [], modes: row.modes ?? [] } : undefined);
  if (problem) invalid(problem + (row ? '' : hint), { model: model.modelId });
  return model;
}
