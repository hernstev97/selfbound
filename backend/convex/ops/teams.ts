import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import type { Actor } from '../lib/actor';
import { readCounter, teamCounter } from '../lib/counters';
import { fail, invalid, notFound } from '../lib/errors';
import type { LogoVariant } from '../lib/validators';
import { teamByPreviousKey } from '../lib/identifiers';
import { ensureTeamStates } from '../lib/workflow';
import { isOwnerKind, TEAM_KEY_RE, type ProjectState } from '../shared/constants';
import { sameChoice, type ModelChoice } from '../shared/models';
import { checkHue, checkModel, checkName, getTeam } from './validate';
import { normalizePeriod, ROADMAP_LIMITS } from '../shared/roadmap';

// Teams, projects, labels and label groups.
// Only the owner changes teams and logos. The import (actor 'import') may create and
// change teams, but not logos. Agents, GitHub and system may do neither.

export function assertCanManageTeams(actor: Actor) {
  if (!isOwnerKind(actor.kind) && actor.kind !== 'import') {
    fail('access_denied', 'Only the owner can change teams.');
  }
}

export function assertCanManageLogos(actor: Actor) {
  if (!isOwnerKind(actor.kind)) fail('access_denied', 'Only the owner can change team logos.');
}

function normalizeKey(key: string) {
  const upper = key.trim().toUpperCase();
  if (!TEAM_KEY_RE.test(upper)) {
    invalid('The key needs 2 to 6 characters: uppercase letters and digits, starting with a letter.');
  }
  return upper;
}

/** Free = no other team uses the key now or used it before (its old identifiers point there). */
async function assertKeyFree(ctx: MutationCtx, key: string, except?: Id<'teams'>) {
  const existing = await ctx.db
    .query('teams')
    .withIndex('by_key', (q) => q.eq('key', key))
    .first();
  if (existing && existing._id !== except) invalid(`The key ${key} is already taken.`);
  const former = await teamByPreviousKey(ctx, key);
  if (former && former._id !== except) {
    invalid(`The key ${key} was used by ${former.name} before: old identifiers like ${key}-1 still lead there.`, { teamId: former._id });
  }
}

/** Issues now or earlier (moved out, purged): identifiers with the team's key may be in use. */
async function hadIssues(ctx: MutationCtx, teamId: Id<'teams'>) {
  if ((await readCounter(ctx, teamCounter(teamId))) > 0) return true;
  const issue = await ctx.db
    .query('issues')
    .withIndex('by_team_number', (q) => q.eq('teamId', teamId))
    .first();
  return issue !== null;
}

/** The knowledge area can only be turned off while it has no pages outside the trash. */
async function assertWikiEmpty(ctx: MutationCtx, team: Doc<'teams'>) {
  const article = await ctx.db
    .query('articles')
    .withIndex('by_team_deleted', (q) => q.eq('teamId', team._id).eq('deletedAt', undefined))
    .first();
  if (article) invalid(`The knowledge area of ${team.key} still has pages. Delete the pages first.`);
}

const OPEN: Doc<'issues'>['status'][] = ['triage', 'backlog', 'todo', 'in_progress', 'in_review'];

/**
 * "Knowledge only" requires no open issues (outside the trash) and no active recurrence.
 * Closed issues stay and remain reachable through search and links. Counted via by_team_priority
 * (one query per priority and open status), without scanning the team.
 */
async function assertNoOpenWork(ctx: MutationCtx, team: Doc<'teams'>) {
  let open = 0;
  for (const priority of [0, 1, 2, 3, 4] as const) {
    for (const status of OPEN) {
      const rows = await ctx.db
        .query('issues')
        .withIndex('by_team_priority', (q) => q.eq('teamId', team._id).eq('priority', priority).eq('status', status))
        .take(1000);
      open += rows.filter((i) => i.deletedAt === undefined).length;
    }
  }
  if (open > 0) invalid(`${team.name} still has ${open} open issues. Close, move or delete them first, then choose "Knowledge only".`, { open });
  const recurrences = (await ctx.db.query('recurrences').take(1000)).filter((r) => r.teamId === team._id && r.active);
  if (recurrences.length) invalid(`${team.name} still has ${recurrences.length} active recurrences. Pause or delete them first.`, { recurrences: recurrences.length });
}

// ---------------------------------------------------------------- Teams

export async function createTeam(
  ctx: MutationCtx,
  actor: Actor,
  args: { key: string; name: string; hue?: number; dormant?: boolean; wiki?: 'on' | 'only' },
) {
  assertCanManageTeams(actor);
  const key = normalizeKey(args.key);
  await assertKeyFree(ctx, key);
  const teams = await ctx.db.query('teams').take(500);
  const order = teams.reduce((max, t) => Math.max(max, t.order), -1) + 1;
  const teamId = await ctx.db.insert('teams', {
    key,
    name: checkName(args.name, 'The team'),
    hue: args.hue === undefined ? (order * 47) % 360 : checkHue(args.hue),
    dormant: args.dormant ?? false,
    order,
    ...(args.wiki ? { wiki: args.wiki } : {}),
    updatedAt: Date.now(),
  });
  await ensureTeamStates(ctx, teamId);
  return { teamId, key };
}

export async function updateTeam(
  ctx: MutationCtx,
  actor: Actor,
  args: {
    teamId: Id<'teams'>;
    key?: string;
    name?: string;
    hue?: number;
    dormant?: boolean;
    wiki?: 'on' | 'only' | null;
    defaultModel?: ModelChoice | null;
  },
) {
  assertCanManageTeams(actor);
  const team = await getTeam(ctx, args.teamId);
  const patch: Partial<Doc<'teams'>> = {};
  if (args.key !== undefined) {
    const key = normalizeKey(args.key);
    if (key !== team.key) {
      await assertKeyFree(ctx, key, team._id);
      // Issues, pages and links store the team ID, so only identifiers change. Once the team has had
      // issues, the old key stays with it, so "OLD-12" keeps resolving. Taking back an old key releases it.
      const previous = (team.previousKeys ?? []).filter((k) => k !== key);
      if (await hadIssues(ctx, team._id)) {
        if (!isOwnerKind(actor.kind)) fail('access_denied', 'Only the owner can rename the key of a team with issues.');
        previous.push(team.key);
      }
      patch.key = key;
      patch.previousKeys = previous.length ? previous : undefined;
    }
  }
  if (args.name !== undefined) patch.name = checkName(args.name, 'The team');
  if (args.hue !== undefined) patch.hue = checkHue(args.hue);
  if (args.dormant !== undefined) patch.dormant = args.dormant;
  if (args.wiki !== undefined && args.wiki !== (team.wiki ?? null)) {
    if (args.wiki === null) await assertWikiEmpty(ctx, team);
    if (args.wiki === 'only') await assertNoOpenWork(ctx, team);
    patch.wiki = args.wiki ?? undefined;
  }
  if (args.defaultModel !== undefined) {
    const model = args.defaultModel === null ? undefined : await checkModel(ctx, args.defaultModel, { keep: team.defaultModel });
    if (!sameChoice(model, team.defaultModel)) patch.defaultModel = model;
  }
  await ctx.db.patch('teams', team._id, { ...patch, updatedAt: Date.now() });
  return { teamId: team._id };
}

/** New order: position in the list. Teams not in the list go to the end. */
export async function reorderTeams(ctx: MutationCtx, actor: Actor, args: { teamIds: Id<'teams'>[] }) {
  assertCanManageTeams(actor);
  const teams = await ctx.db.query('teams').take(500);
  const position = new Map(args.teamIds.map((id, i) => [id, i]));
  const sorted = [...teams].sort(
    (a, b) => (position.get(a._id) ?? 1e6 + a.order) - (position.get(b._id) ?? 1e6 + b.order),
  );
  const now = Date.now();
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].order !== i) await ctx.db.patch('teams', sorted[i]._id, { order: i, updatedAt: now });
  }
  return { count: sorted.length };
}

// ---------------------------------------------------------------- Logos

/** Sets a checked logo and deletes the previous file. The content is checked in teams.setLogo (action). */
export async function setTeamLogo(
  ctx: MutationCtx,
  actor: Actor,
  args: { teamId: Id<'teams'>; storageId: Id<'_storage'>; variant: LogoVariant; contentType: string },
) {
  assertCanManageLogos(actor);
  const team = await getTeam(ctx, args.teamId);
  const field = args.variant === 'dark' ? 'logoDarkId' : 'logoId';
  const previous = team[field];
  if (previous && previous !== args.storageId) await ctx.storage.delete(previous);
  await ctx.db.patch('teams', team._id, {
    [field]: args.storageId,
    ...(args.variant === 'light' ? { logoType: args.contentType } : {}),
    updatedAt: Date.now(),
  });
  return { teamId: team._id };
}

export async function removeTeamLogo(ctx: MutationCtx, actor: Actor, args: { teamId: Id<'teams'>; variant: LogoVariant }) {
  assertCanManageLogos(actor);
  const team = await getTeam(ctx, args.teamId);
  const field = args.variant === 'dark' ? 'logoDarkId' : 'logoId';
  const previous = team[field];
  if (!previous) return { teamId: team._id, removed: false };
  await ctx.storage.delete(previous);
  await ctx.db.patch('teams', team._id, {
    [field]: undefined,
    ...(args.variant === 'light' ? { logoType: undefined } : {}),
    updatedAt: Date.now(),
  });
  return { teamId: team._id, removed: true };
}

// ---------------------------------------------------------------- Projects

/** Roadmap fields of a project (SELF-113); null or an empty text clears a field. */
export interface ProjectFields {
  description?: string | null;
  readyWhen?: string | null;
  period?: string | null;
  hue?: number | null;
}

function checkProjectText(text: string, what: string): string | undefined {
  const s = text.replace(/[ \t]+\n/g, '\n').trim();
  if (s.length > ROADMAP_LIMITS.projectTextMax) invalid(`${what} is too long (at most ${ROADMAP_LIMITS.projectTextMax} characters).`);
  return s || undefined;
}

/** The roadmap fields as a patch: a value, or undefined to remove the field. */
function projectFields(args: ProjectFields): Partial<Pick<Doc<'projects'>, 'description' | 'readyWhen' | 'period' | 'hue'>> {
  const patch: Partial<Pick<Doc<'projects'>, 'description' | 'readyWhen' | 'period' | 'hue'>> = {};
  if (args.description !== undefined) patch.description = args.description === null ? undefined : checkProjectText(args.description, 'The goal');
  if (args.readyWhen !== undefined) patch.readyWhen = args.readyWhen === null ? undefined : checkProjectText(args.readyWhen, '"Ready when"');
  if (args.period !== undefined) {
    if (args.period === null || !args.period.trim()) patch.period = undefined;
    else patch.period = normalizePeriod(args.period) ?? invalid('The period must be a quarter like 2027-Q1 or a month like 2027-03.');
  }
  if (args.hue !== undefined) patch.hue = args.hue === null ? undefined : checkHue(args.hue);
  return patch;
}

export async function createProject(
  ctx: MutationCtx,
  _actor: Actor,
  args: { teamId: Id<'teams'>; name: string; state?: ProjectState; position?: number } & ProjectFields,
) {
  const team = await getTeam(ctx, args.teamId);
  const siblings = await ctx.db
    .query('projects')
    .withIndex('by_team', (q) => q.eq('teamId', team._id))
    .take(500);
  const fields = projectFields(args);
  const projectId = await ctx.db.insert('projects', {
    teamId: team._id,
    name: checkName(args.name, 'The project'),
    state: args.state ?? 'active',
    order: siblings.reduce((max, p) => Math.max(max, p.order), -1) + 1,
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    updatedAt: Date.now(),
  });
  if (args.position !== undefined) await moveProject(ctx, team._id, projectId, args.position);
  return { projectId };
}

/** A project belongs to exactly one team; the team cannot be changed. */
export async function updateProject(
  ctx: MutationCtx,
  _actor: Actor,
  args: { projectId: Id<'projects'>; name?: string; state?: ProjectState; position?: number } & ProjectFields,
) {
  const project = (await ctx.db.get('projects', args.projectId)) ?? notFound('The project');
  const patch: Partial<Doc<'projects'>> = projectFields(args);
  if (args.name !== undefined) patch.name = checkName(args.name, 'The project');
  if (args.state !== undefined) patch.state = args.state;
  await ctx.db.patch('projects', project._id, { ...patch, updatedAt: Date.now() });
  if (args.position !== undefined) await moveProject(ctx, project.teamId, project._id, args.position);
  return { projectId: project._id };
}

/** Puts a project at a position (1 = first) within its team, the others keep their order. */
async function moveProject(ctx: MutationCtx, teamId: Id<'teams'>, projectId: Id<'projects'>, position: number) {
  const projects = (await ctx.db
    .query('projects')
    .withIndex('by_team', (q) => q.eq('teamId', teamId))
    .take(500)).sort((a, b) => a.order - b.order);
  const ids = projects.map((p) => p._id).filter((id) => id !== projectId);
  const at = Math.max(0, Math.min(ids.length, Math.round(position) - 1));
  ids.splice(at, 0, projectId);
  await reorderProjects(ctx, { kind: 'system' }, { teamId, projectIds: ids });
}

export async function reorderProjects(
  ctx: MutationCtx,
  _actor: Actor,
  args: { teamId: Id<'teams'>; projectIds: Id<'projects'>[] },
) {
  const projects = await ctx.db
    .query('projects')
    .withIndex('by_team', (q) => q.eq('teamId', args.teamId))
    .take(500);
  const position = new Map(args.projectIds.map((id, i) => [id, i]));
  const sorted = [...projects].sort(
    (a, b) => (position.get(a._id) ?? 1e6 + a.order) - (position.get(b._id) ?? 1e6 + b.order),
  );
  const now = Date.now();
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].order !== i) await ctx.db.patch('projects', sorted[i]._id, { order: i, updatedAt: now });
  }
  return { count: sorted.length };
}

// ---------------------------------------------------------------- Label groups and labels

export async function createLabelGroup(
  ctx: MutationCtx,
  _actor: Actor,
  args: { name: string; exclusive: boolean; hue?: number; teamId?: Id<'teams'> },
) {
  if (args.teamId) await getTeam(ctx, args.teamId);
  const groupId = await ctx.db.insert('labelGroups', {
    name: checkName(args.name, 'The label group'),
    exclusive: args.exclusive,
    hue: args.hue === undefined ? 0 : checkHue(args.hue),
    ...(args.teamId ? { teamId: args.teamId } : {}),
  });
  return { groupId };
}

export async function updateLabelGroup(
  ctx: MutationCtx,
  _actor: Actor,
  args: { groupId: Id<'labelGroups'>; name?: string; exclusive?: boolean; hue?: number },
) {
  const group = (await ctx.db.get('labelGroups', args.groupId)) ?? notFound('The label group');
  const patch: Partial<Doc<'labelGroups'>> = {};
  if (args.name !== undefined) patch.name = checkName(args.name, 'The label group');
  if (args.exclusive !== undefined) patch.exclusive = args.exclusive;
  if (args.hue !== undefined) patch.hue = checkHue(args.hue);
  await ctx.db.patch('labelGroups', group._id, patch);
  return { groupId: group._id };
}

async function checkLabelScope(ctx: MutationCtx, teamId: Id<'teams'> | undefined, groupId: Id<'labelGroups'> | undefined) {
  if (teamId) await getTeam(ctx, teamId);
  if (!groupId) return;
  const group = (await ctx.db.get('labelGroups', groupId)) ?? notFound('The label group');
  if (group.teamId && group.teamId !== teamId) invalid('The label group belongs to another team.');
}

export async function createLabel(
  ctx: MutationCtx,
  _actor: Actor,
  args: { name: string; hue: number; groupId?: Id<'labelGroups'>; teamId?: Id<'teams'>; position?: number },
) {
  await checkLabelScope(ctx, args.teamId, args.groupId);
  const labelId = await ctx.db.insert('labels', {
    name: checkName(args.name, 'The label', 60),
    hue: checkHue(args.hue),
    ...(args.groupId ? { groupId: args.groupId } : {}),
    ...(args.teamId ? { teamId: args.teamId } : {}),
  });
  if (args.position !== undefined) await moveLabel(ctx, labelId, args.position);
  return { labelId };
}

/** Labels that share a list: the same group, or ungrouped in the same scope (team or workspace). */
async function siblingLabels(ctx: MutationCtx, label: Doc<'labels'>) {
  const all = await ctx.db.query('labels').take(2000);
  return all.filter((l) => (label.groupId ? l.groupId === label.groupId : !l.groupId && l.teamId === label.teamId));
}

/** Labels in their order: ordered ones first, then the rest by name (shared/labels in the UI too). */
function byOrder(a: Doc<'labels'>, b: Doc<'labels'>) {
  return (a.order ?? Infinity) - (b.order ?? Infinity) || a.name.localeCompare(b.name);
}

/** Puts a label at a position (1 = first) among its siblings; every sibling then has an order. */
async function moveLabel(ctx: MutationCtx, labelId: Id<'labels'>, position: number) {
  const label = (await ctx.db.get('labels', labelId)) ?? notFound('The label');
  const ids = (await siblingLabels(ctx, label)).sort(byOrder).map((l) => l._id).filter((id) => id !== labelId);
  ids.splice(Math.max(0, Math.min(ids.length, Math.round(position) - 1)), 0, labelId);
  await reorderLabels(ctx, { kind: 'system' }, { labelIds: ids });
}

/** Order of labels: the given ones get 0, 1, 2 … in this order (usually the labels of one group). */
export async function reorderLabels(ctx: MutationCtx, _actor: Actor, args: { labelIds: Id<'labels'>[] }) {
  if (args.labelIds.length > 500) invalid('Too many labels at once.');
  let i = 0;
  for (const id of args.labelIds) {
    const label = (await ctx.db.get('labels', id)) ?? notFound('The label', { labelId: id });
    if (label.order !== i) await ctx.db.patch('labels', label._id, { order: i });
    i++;
  }
  return { count: args.labelIds.length };
}

export async function updateLabel(
  ctx: MutationCtx,
  _actor: Actor,
  args: { labelId: Id<'labels'>; name?: string; hue?: number; groupId?: Id<'labelGroups'> | null; archived?: boolean; position?: number },
) {
  const label = (await ctx.db.get('labels', args.labelId)) ?? notFound('The label');
  const patch: Partial<Doc<'labels'>> = {};
  if (args.name !== undefined) patch.name = checkName(args.name, 'The label', 60);
  if (args.hue !== undefined) patch.hue = checkHue(args.hue);
  if (args.groupId !== undefined) {
    await checkLabelScope(ctx, label.teamId, args.groupId ?? undefined);
    patch.groupId = args.groupId ?? undefined;
  }
  if (args.archived !== undefined) patch.archived = args.archived;
  // A label that changes its group starts at the end of the new one.
  if (args.groupId !== undefined && (args.groupId ?? undefined) !== label.groupId) patch.order = undefined;
  await ctx.db.patch('labels', label._id, patch);
  if (args.position !== undefined) await moveLabel(ctx, label._id, args.position);
  return { labelId: label._id };
}
