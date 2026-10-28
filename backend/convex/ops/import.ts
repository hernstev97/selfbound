import type { Doc, Id, TableNames } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Actor } from '../lib/actor';
import { readCounter, SEQ, setCounter, takeCounter, teamCounter } from '../lib/counters';
import { hashText, sameValue, stable } from '../lib/equal';
import { aliasKey, teamByKey } from '../lib/identifiers';
import { lastRank, rankBetween } from '../lib/rank';
import { ensureTeamStates, stateFields, type State as WorkflowState } from '../lib/workflow';
import { bucketOf, identifierOf, LIMITS, type Priority, type Status } from '../shared/constants';
import { isLimited } from '../shared/priorityLimits';
import { stateByName, stateForStatus, statusOfState } from '../shared/workflow';
import type {
  ImportComment,
  ImportIssue,
  ImportLabel,
  ImportLabelGroup,
  ImportLink,
  ImportProject,
  ImportPullRequest,
  ImportRelation,
  ImportSprint,
  ImportStatus,
  ImportTeam,
} from '../shared/importTypes';
import { insertBody, writeBody } from './bodies';
import { syncFileRefs } from './files';
import { syncArticleLinks } from './links';
import { record } from './history';
import { hasRoom, holds } from './priorityLimits';
import { addRelation } from './relations';
import { setImportedSprintItem, upsertImportedSprint } from './sprints';
import { createTeam } from './teams';
import { checkParent } from './validate';

// Import from Linear: staging table `importStaging` → real tables.
//
// Principles (docs/architecture/import.md):
// - Repeatable without duplicates: every record has an entry in `linearLinks`
//   (kind + Linear ID → Selfbound ID + payload hash). Same hash → untouched.
// - Issues: three-way merge per field against the last imported Linear value
//   (`linearLinks.base`). Changed only in Linear → take it (old value in history, old
//   description in full in `bodyRevisions`); changed only in Selfbound → keep; changed in
//   both → keep Selfbound, add an `importConflicts` entry.
// - Issues permanently deleted in Selfbound (`linearLinks.purgedAt`) do not come back.
// - The import never touches Selfbound's own data: logos, team order, Selfbound sprints and sprint
//   assignment, rank, "reviewed", trash.
// - If a Linear identifier collides with an issue created in Selfbound, Linear keeps the
//   identifier; the Selfbound issue gets the next free number, the old identifier becomes an
//   alias, and `importConflicts` records it.
// - Deviations (`deviations`) contain only numbers and identifiers, never titles or texts.

export const IMPORT: Actor = { kind: 'import' };

/** Processing order. `parent` reads the issue rows a second time (phase 2). */
export const IMPORT_STEPS = [
  'team',
  'labelGroup',
  'label',
  'project',
  'sprint',
  'issue',
  'parent',
  'comment',
  'relation',
  'pullRequest',
  'link',
] as const;
export type ImportStep = (typeof IMPORT_STEPS)[number];

export const stagingKindOf = (step: ImportStep) => (step === 'parent' ? 'issue' : step);

/** Maximum rows per mutation (additionally capped at ~1 MB of data read). */
export const BATCH_SIZE: Record<ImportStep, number> = {
  team: 100,
  labelGroup: 200,
  label: 200,
  project: 200,
  sprint: 200,
  issue: 100,
  parent: 200,
  comment: 200,
  relation: 200,
  pullRequest: 200,
  link: 200,
};
export const BATCH_BYTES = 1_000_000;

export type Outcome = 'created' | 'updated' | 'unchanged' | 'skipped';
export interface StepCounts {
  seen: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
}
export const emptyCounts = (): StepCounts => ({ seen: 0, created: 0, updated: 0, unchanged: 0, skipped: 0 });

interface State {
  ctx: MutationCtx;
  runId: Id<'importRuns'>;
  now: number;
  /** Highest Linear number per team (Linear ID), from the scan phase. */
  maxNumbers: Record<string, number>;
  notes: string[];
  rank: { last: string | null };
}

// ---------------------------------------------------------------- linearLinks

export const payloadHash = (payload: unknown) => hashText(stable(payload));

export async function findLink(ctx: QueryCtx, kind: string, linearId: string) {
  return await ctx.db
    .query('linearLinks')
    .withIndex('by_kind_linear', (q) => q.eq('kind', kind).eq('linearId', linearId))
    .first();
}

async function saveLink(
  s: State,
  link: Doc<'linearLinks'> | null,
  kind: string,
  linearId: string,
  localId: string,
  hash: string,
  base?: IssueBase,
) {
  const extra = base ? { base } : {};
  if (link) await s.ctx.db.patch('linearLinks', link._id, { localId, hash, runId: s.runId, ...extra });
  else await s.ctx.db.insert('linearLinks', { kind, linearId, localId, hash, runId: s.runId, ...extra });
}

export async function getLocal<T extends TableNames>(ctx: QueryCtx, table: T, localId: string): Promise<Doc<T> | null> {
  const id = ctx.db.normalizeId(table, localId);
  return id ? await ctx.db.get(table, id) : null;
}

/** Selfbound document for a Linear ID via linearLinks. */
async function localOf<T extends TableNames>(ctx: QueryCtx, table: T, kind: string, linearId: string | undefined) {
  if (!linearId) return null;
  const link = await findLink(ctx, kind, linearId);
  return link ? await getLocal(ctx, table, link.localId) : null;
}

/** Is this Selfbound document already linked to a Linear record? */
async function isLinked(ctx: QueryCtx, localId: string) {
  return (
    (await ctx.db
      .query('linearLinks')
      .withIndex('by_local', (q) => q.eq('localId', localId))
      .first()) !== null
  );
}

function note(s: State, text: string) {
  if (!s.notes.includes(text)) s.notes.push(text);
}

function limitNote(s: State, identifier: string, priority: number, teamKey: string) {
  note(s, `${identifier}: priority ${priority === 1 ? 'urgent' : 'high'} not taken, the hard limit of team ${teamKey} is full`);
}

export const clip = (text: string, max: number, fallback: string) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return (t.length > max ? t.slice(0, max) : t) || fallback;
};

/**
 * Linear color (hex) → OKLCH hue in degrees (0–360). Gray colors → 0.
 * Formulas: sRGB → linear → OKLab (Björn Ottosson).
 */
export function hueOf(hex: string | undefined): number | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const x = c / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s;
  if (Math.hypot(A, B) < 0.02) return 0;
  return Math.round((((Math.atan2(B, A) * 180) / Math.PI + 360) % 360) * 10) / 10;
}

// ---------------------------------------------------------------- Phase 1: master data

async function importTeam(s: State, p: ImportTeam): Promise<Outcome> {
  const { ctx } = s;
  const hash = payloadHash(p);
  const link = await findLink(ctx, 'team', p.linearId);
  let team = link ? await getLocal(ctx, 'teams', link.localId) : null;
  if (team && link?.hash === hash) return 'unchanged';
  let adopted = false;
  if (!team) {
    // The owner already created a team with this key (or renamed one away from it): adopt it
    // instead of creating a duplicate.
    team = await teamByKey(ctx, p.key.toUpperCase());
    adopted = team !== null;
  }
  if (!team) {
    const { teamId } = await createTeam(ctx, IMPORT, {
      key: p.key,
      name: clip(p.name, 100, p.key),
      hue: hueOf(p.color),
      dormant: p.dormant,
    });
    await saveLink(s, link, 'team', p.linearId, teamId, hash);
    return 'created';
  }
  // Linear fields: name, dormant, color. Key, order and logos belong to Selfbound.
  const patch: Partial<Doc<'teams'>> = {};
  const name = clip(p.name, 100, p.key);
  if (team.name !== name) patch.name = name;
  if (team.dormant !== p.dormant) patch.dormant = p.dormant;
  const hue = hueOf(p.color);
  if (hue !== undefined && hue !== team.hue) patch.hue = hue;
  if (team.key !== p.key.toUpperCase()) note(s, `Team ${team.key}: the key in Linear is now ${p.key}; Selfbound keeps ${team.key}.`);
  if (adopted) note(s, `Team ${team.key}: already existed in Selfbound, linked to Linear.`);
  if (Object.keys(patch).length) await ctx.db.patch('teams', team._id, { ...patch, updatedAt: s.now });
  await saveLink(s, link, 'team', p.linearId, team._id, hash);
  return Object.keys(patch).length || adopted ? 'updated' : 'unchanged';
}

async function importLabelGroup(s: State, p: ImportLabelGroup): Promise<Outcome> {
  const { ctx } = s;
  const hash = payloadHash(p);
  const link = await findLink(ctx, 'labelGroup', p.linearId);
  let group = link ? await getLocal(ctx, 'labelGroups', link.localId) : null;
  if (group && link?.hash === hash) return 'unchanged';
  const team = p.teamLinearId ? await localOf(ctx, 'teams', 'team', p.teamLinearId) : null;
  if (p.teamLinearId && !team) {
    note(s, 'Skipped label group of an unknown team');
    return 'skipped';
  }
  const name = clip(p.name, 100, 'Group');
  const fields = { name, exclusive: p.exclusive, hue: hueOf(p.color) ?? 0 };
  if (!group) {
    const candidates = (await ctx.db.query('labelGroups').take(500)).filter(
      (g) => g.name.toLowerCase() === name.toLowerCase() && g.teamId === (team?._id ?? undefined),
    );
    for (const candidate of candidates) if (!(await isLinked(ctx, candidate._id))) group = candidate;
  }
  if (!group) {
    const groupId = await ctx.db.insert('labelGroups', { ...fields, ...(team ? { teamId: team._id } : {}) });
    await saveLink(s, link, 'labelGroup', p.linearId, groupId, hash);
    return 'created';
  }
  const changed = group.name !== fields.name || group.exclusive !== fields.exclusive || group.hue !== fields.hue;
  if (changed) await ctx.db.patch('labelGroups', group._id, fields);
  await saveLink(s, link, 'labelGroup', p.linearId, group._id, hash);
  return changed || !link ? 'updated' : 'unchanged';
}

async function importLabel(s: State, p: ImportLabel): Promise<Outcome> {
  const { ctx } = s;
  const hash = payloadHash(p);
  const link = await findLink(ctx, 'label', p.linearId);
  let label = link ? await getLocal(ctx, 'labels', link.localId) : null;
  if (label && link?.hash === hash) return 'unchanged';
  const team = p.teamLinearId ? await localOf(ctx, 'teams', 'team', p.teamLinearId) : null;
  if (p.teamLinearId && !team) {
    note(s, 'Skipped label of an unknown team');
    return 'skipped';
  }
  const group = p.groupLinearId ? await localOf(ctx, 'labelGroups', 'labelGroup', p.groupLinearId) : null;
  const name = clip(p.name, 60, 'Label');
  const fields = { name, hue: hueOf(p.color) ?? 0, groupId: group?._id, archived: p.archived };
  if (!label) {
    const candidates = (await ctx.db.query('labels').take(2000)).filter(
      (l) => l.name.toLowerCase() === name.toLowerCase() && l.teamId === (team?._id ?? undefined) && l.groupId === fields.groupId,
    );
    for (const candidate of candidates) if (!(await isLinked(ctx, candidate._id))) label = candidate;
  }
  if (!label) {
    const labelId = await ctx.db.insert('labels', {
      name,
      hue: fields.hue,
      ...(group ? { groupId: group._id } : {}),
      ...(team ? { teamId: team._id } : {}),
      ...(p.archived ? { archived: true } : {}),
    });
    await saveLink(s, link, 'label', p.linearId, labelId, hash);
    return 'created';
  }
  const changed =
    label.name !== fields.name ||
    label.hue !== fields.hue ||
    label.groupId !== fields.groupId ||
    Boolean(label.archived) !== fields.archived;
  if (changed) await ctx.db.patch('labels', label._id, fields);
  await saveLink(s, link, 'label', p.linearId, label._id, hash);
  return changed || !link ? 'updated' : 'unchanged';
}

async function importProject(s: State, p: ImportProject): Promise<Outcome> {
  const { ctx } = s;
  const hash = payloadHash(p);
  const link = await findLink(ctx, 'project', p.linearId);
  let project = link ? await getLocal(ctx, 'projects', link.localId) : null;
  if (project && link?.hash === hash) return 'unchanged';
  const team = await localOf(ctx, 'teams', 'team', p.teamLinearId);
  if (!team) {
    note(s, 'Skipped project of an unknown team');
    return 'skipped';
  }
  const name = clip(p.name, 100, 'Project');
  const siblings = await ctx.db
    .query('projects')
    .withIndex('by_team', (q) => q.eq('teamId', team._id))
    .take(500);
  if (!project) {
    for (const candidate of siblings) {
      if (candidate.name.toLowerCase() === name.toLowerCase() && !(await isLinked(ctx, candidate._id))) project = candidate;
    }
  }
  if (!project) {
    const projectId = await ctx.db.insert('projects', {
      teamId: team._id,
      name,
      state: p.state,
      order: siblings.reduce((max, x) => Math.max(max, x.order), -1) + 1,
      updatedAt: s.now,
    });
    await saveLink(s, link, 'project', p.linearId, projectId, hash);
    return 'created';
  }
  if (project.teamId !== team._id) {
    note(s, `Project assigned to a different team in Linear (${team.key}); Selfbound keeps its team.`);
  }
  const changed = project.name !== name || project.state !== p.state;
  if (changed) await ctx.db.patch('projects', project._id, { name, state: p.state, updatedAt: s.now });
  await saveLink(s, link, 'project', p.linearId, project._id, hash);
  return changed || !link ? 'updated' : 'unchanged';
}

async function importSprint(s: State, p: ImportSprint): Promise<Outcome> {
  const { ctx } = s;
  const hash = payloadHash(p);
  const link = await findLink(ctx, 'cycle', p.linearId);
  const existing = link ? await getLocal(ctx, 'sprints', link.localId) : null;
  if (existing && link?.hash === hash) return 'unchanged';
  const { sprintId, changed } = await upsertImportedSprint(
    ctx,
    existing,
    {
      name: clip(p.name, 100, `${p.teamKey} Cycle ${p.linearNumber}`),
      goal: (p.description ?? '').slice(0, 2000),
      startDate: p.startDate,
      endDate: p.endDate,
      startedAt: p.startsAt,
      closedAt: p.completedAt ?? p.endsAt,
    },
    s.now,
  );
  await saveLink(s, link, 'cycle', p.linearId, sprintId, hash);
  return existing ? (changed ? 'updated' : 'unchanged') : 'created';
}

// ---------------------------------------------------------------- Phase 1: Issues

const outcomeOf = (status: ImportStatus) =>
  status === 'done' ? ('done' as const) : status === 'canceled' || status === 'duplicate' ? ('canceled' as const) : ('backlog' as const);

/**
 * Frees (team, number): if another issue holds the number (created in Selfbound), it gets the
 * next free number after all of the team's Linear numbers. The old identifier becomes an
 * alias; history and importConflicts record it.
 */
async function claimNumber(s: State, team: Doc<'teams'>, teamLinearId: string, number: number, self: Id<'issues'> | null) {
  const { ctx } = s;
  const occupant = await ctx.db
    .query('issues')
    .withIndex('by_team_number', (q) => q.eq('teamId', team._id).eq('number', number))
    .first();
  if (!occupant || occupant._id === self) return;
  const counter = teamCounter(team._id);
  await setCounter(ctx, counter, Math.max(await readCounter(ctx, counter), s.maxNumbers[teamLinearId] ?? 0, number));
  const next = await takeCounter(ctx, counter);
  const from = identifierOf(team.key, number);
  const to = identifierOf(team.key, next);
  await ctx.db.patch('issues', occupant._id, { number: next, updatedAt: s.now });
  await ctx.db.insert('identifierAliases', { key: aliasKey(team.key, number), issueId: occupant._id });
  await record(ctx, IMPORT, s.now, undefined, { issueId: occupant._id, field: 'identifier', from, to });
  const linked = await isLinked(ctx, occupant._id);
  const text = linked
    ? `${from}: number reassigned in Linear; the previous issue is now ${to} (old identifier stays as alias).`
    : `${from} was created in Selfbound. Linear keeps ${from}, the Selfbound issue is now ${to} (old identifier stays as alias).`;
  await ctx.db.insert('importConflicts', { runId: s.runId, issueId: occupant._id, note: text });
  note(s, text);
}

async function ensureAliases(s: State, issueId: Id<'issues'>, previous: string[]) {
  for (const raw of previous) {
    const key = raw.trim().toUpperCase();
    if (!key) continue;
    const rows = await s.ctx.db
      .query('identifierAliases')
      .withIndex('by_key', (q) => q.eq('key', key))
      .take(10);
    if (!rows.some((r) => r.issueId === issueId)) await s.ctx.db.insert('identifierAliases', { key, issueId });
  }
}

async function issueFields(s: State, p: ImportIssue, team: Doc<'teams'>) {
  const { ctx } = s;
  const labelIds: Id<'labels'>[] = [];
  for (const linearId of p.labelLinearIds) {
    const label = await localOf(ctx, 'labels', 'label', linearId);
    if (!label) continue;
    if (label.teamId && label.teamId !== team._id) {
      note(s, `${p.identifier}: label of another team not imported`);
      continue;
    }
    if (!labelIds.includes(label._id)) labelIds.push(label._id);
  }
  let projectId: Id<'projects'> | undefined;
  if (p.projectLinearId) {
    const project = await localOf(ctx, 'projects', 'project', p.projectLinearId);
    if (project && project.teamId !== team._id) note(s, `${p.identifier}: project belongs to another team, not imported`);
    else if (project) projectId = project._id;
  }
  return {
    title: clip(p.title, LIMITS.titleMax, '(untitled)'),
    status: p.status,
    priority: p.priority,
    labelIds,
    projectId,
    estimate: p.estimate,
    dueDate: p.dueDate,
    startedAt: p.startedAt,
    completedAt: p.completedAt,
    canceledAt: p.canceledAt,
  };
}

/**
 * Team state for a Linear issue: same name (if the status type matches), otherwise the state
 * for the mapped status type. The status type thus always stays the one mapped from Linear,
 * so the three-way merge (`base.status`) stays correct.
 */
async function importState(s: State, team: Doc<'teams'>, p: ImportIssue): Promise<WorkflowState> {
  const states = await ensureTeamStates(s.ctx, team._id, s.now);
  const named = stateByName(states, p.linearStateName);
  if (named && named.archivedAt === undefined && statusOfState(named) === p.status) return named;
  const state = stateForStatus(states, p.status);
  if (!state) throw new Error(`Team ${team.key} has no state for "${p.status}".`);
  return state;
}

/** Fields with history (the timestamps follow the status and have no history entries of their own). */
const TRACKED = ['title', 'status', 'priority', 'labelIds', 'projectId', 'estimate', 'dueDate'] as const;
const TIMESTAMPS = ['startedAt', 'completedAt', 'canceledAt'] as const;

/**
 * Last imported Linear values of an issue in Selfbound form (`linearLinks.base`).
 * Basis of the three-way merge. The description only as a hash; phase 2 fills in the parent.
 */
export interface IssueBase {
  title: string;
  status: ImportStatus;
  priority: number;
  labelIds: Id<'labels'>[];
  projectId?: Id<'projects'>;
  estimate?: number;
  dueDate?: string;
  descriptionHash: string;
  parentId?: Id<'issues'>;
}

/**
 * Hash of an issue payload without `order` (depends on other issues), `updatedAt`
 * (changes in Linear even without content changes) and `url`.
 */
export function issueHash(p: ImportIssue) {
  const { order: _order, updatedAt: _updatedAt, url: _url, ...own } = p;
  return payloadHash(own);
}

export type Merge = 'keep' | 'take' | 'conflict';

/**
 * Three-way decision for one field: base = last imported, linear = now in Linear,
 * local = now in Selfbound. Without base (link from before the merge existed) every
 * difference counts as a conflict: Selfbound wins.
 */
export function merge(hasBase: boolean, base: unknown, linear: unknown, local: unknown, unordered = false): Merge {
  if (sameValue(local, linear, unordered)) return 'keep';
  if (!hasBase) return 'conflict';
  if (sameValue(base, linear, unordered)) return 'keep'; // changed only in Selfbound
  if (sameValue(base, local, unordered)) return 'take'; // changed only in Linear
  return 'conflict';
}

/**
 * Three-way merge of an imported description (`baseHash`: hash of the last imported text).
 * Changed only at the source: take it, the previous version goes in full into `bodyRevisions`.
 * Changed on both sides: keep Selfbound's, store the source's version for comparison.
 */
export async function mergeImportedBody(
  ctx: MutationCtx,
  runId: Id<'importRuns'>,
  now: number,
  issueId: Id<'issues'>,
  hasBase: boolean,
  baseHash: string | undefined,
  markdown: string,
): Promise<Merge> {
  const body = await ctx.db
    .query('issueBodies')
    .withIndex('by_issue', (q) => q.eq('issueId', issueId))
    .unique();
  const current = body?.markdown ?? '';
  const decision = merge(hasBase, baseHash, hashText(markdown), hashText(current));
  if (decision === 'take') {
    if (current !== '') {
      const revisionId = await ctx.db.insert('bodyRevisions', {
        issueId,
        markdown: current,
        version: body?.version ?? 0,
        reason: 'import_overwrite',
        at: now,
        actor: IMPORT,
        runId,
      });
      await syncFileRefs(ctx, revisionId, current, now);
    }
    const version = await writeBody(ctx, issueId, body, markdown, IMPORT, now);
    await ctx.db.patch('issues', issueId, { updatedAt: now });
    await record(ctx, IMPORT, now, undefined, {
      issueId,
      field: 'description',
      from: { version: body?.version ?? 0, ...(current !== '' ? { savedAsRevision: true } : {}) },
      to: { version, preview: markdown.slice(0, 120) },
    });
  } else if (decision === 'conflict' && markdown !== '') {
    // Keep the rejected version so the owner can compare.
    const revisionId = await ctx.db.insert('bodyRevisions', {
      issueId,
      markdown,
      version: body?.version ?? 0,
      reason: 'import_conflict',
      at: now,
      actor: IMPORT,
      runId,
    });
    await syncFileRefs(ctx, revisionId, markdown, now);
  }
  return decision;
}

async function addConflict(s: State, issueId: Id<'issues'>, identifier: string, fields: string[]) {
  const text = `${identifier}: changed in Selfbound and in Linear (${fields.join(', ')}); the Selfbound value stays.`;
  await s.ctx.db.insert('importConflicts', { runId: s.runId, issueId, note: text });
  note(s, text);
}

async function importIssue(s: State, p: ImportIssue): Promise<Outcome> {
  const { ctx, now } = s;
  const hash = issueHash(p);
  const link = await findLink(ctx, 'issue', p.linearId);
  if (link?.purgedAt !== undefined) {
    note(s, `${p.identifier}: permanently deleted in Selfbound, not recreated`);
    return 'skipped';
  }
  const existing = link ? await getLocal(ctx, 'issues', link.localId) : null;
  if (existing && link?.hash === hash) return 'unchanged';
  const team = await localOf(ctx, 'teams', 'team', p.teamLinearId);
  if (!team) {
    note(s, `${p.identifier}: team missing, issue skipped`);
    return 'skipped';
  }
  const fields = await issueFields(s, p, team);
  const sprint = p.cycleLinearId ? await localOf(ctx, 'sprints', 'cycle', p.cycleLinearId) : null;
  const identifier = identifierOf(team.key, p.number);
  const markdown = (p.description ?? '').slice(0, LIMITS.descriptionMax);
  const base: IssueBase = {
    title: fields.title,
    status: fields.status,
    priority: fields.priority,
    labelIds: fields.labelIds,
    ...(fields.projectId ? { projectId: fields.projectId } : {}),
    ...(fields.estimate !== undefined ? { estimate: fields.estimate } : {}),
    ...(fields.dueDate ? { dueDate: fields.dueDate } : {}),
    descriptionHash: hashText(markdown),
  };

  if (!existing) {
    // A full hard priority limit: the issue comes without that priority (base keeps Linear's, so
    // a later run does not try again unless Linear changes it).
    let priority = fields.priority;
    if (holds({ priority, status: fields.status, deletedAt: undefined }, priority) && !(await hasRoom(ctx, team._id, priority))) {
      limitNote(s, identifier, priority, team.key);
      priority = 0;
    }
    await claimNumber(s, team, p.teamLinearId, p.number, null);
    const seq = await takeCounter(ctx, SEQ);
    const rank = rankBetween(s.rank.last, null);
    s.rank.last = rank;
    const issueId = await ctx.db.insert('issues', {
      seq,
      bucket: bucketOf(seq),
      teamId: team._id,
      number: p.number,
      title: fields.title,
      ...stateFields(await importState(s, team, p)),
      priority,
      labelIds: fields.labelIds,
      ...(fields.projectId ? { projectId: fields.projectId } : {}),
      ...(fields.estimate !== undefined ? { estimate: fields.estimate } : {}),
      ...(fields.dueDate ? { dueDate: fields.dueDate } : {}),
      rank,
      createdBy: IMPORT,
      reviewedAt: now, // imported issues count as reviewed
      createdAt: p.createdAt,
      updatedAt: now,
      ...(fields.startedAt !== undefined ? { startedAt: fields.startedAt } : {}),
      ...(fields.completedAt !== undefined ? { completedAt: fields.completedAt } : {}),
      ...(fields.canceledAt !== undefined ? { canceledAt: fields.canceledAt } : {}),
    });
    await insertBody(ctx, issueId, markdown, IMPORT, now);
    await setCounter(ctx, teamCounter(team._id), p.number);
    await ensureAliases(s, issueId, p.previousIdentifiers);
    if (sprint) await setImportedSprintItem(ctx, issueId, sprint, outcomeOf(p.status), now);
    await record(ctx, IMPORT, now, undefined, {
      issueId,
      field: 'created',
      to: { identifier, title: fields.title, status: fields.status, source: 'linear' },
    });
    await saveLink(s, link, 'issue', p.linearId, issueId, hash, base);
    return 'created';
  }

  // ---- already imported: three-way merge per field against the last imported state
  const old = (link?.base ?? null) as IssueBase | null;
  const hasBase = old !== null;
  let changed = false;
  if (existing.teamId !== team._id || existing.number !== p.number) {
    // Moved (other team) or renumbered in Linear: take the Linear identifier.
    await claimNumber(s, team, p.teamLinearId, p.number, existing._id);
    const oldTeam = await ctx.db.get('teams', existing.teamId);
    const from = identifierOf(oldTeam?.key ?? '?', existing.number);
    await ctx.db.patch('issues', existing._id, { teamId: team._id, number: p.number, updatedAt: now });
    await setCounter(ctx, teamCounter(team._id), p.number);
    await ensureAliases(s, existing._id, [from]);
    await record(ctx, IMPORT, now, undefined, { issueId: existing._id, field: 'identifier', from, to: identifier });
    changed = true;
  }
  const patch: Record<string, unknown> = {};
  const conflicts: string[] = [];
  for (const field of TRACKED) {
    const decision = merge(hasBase, old?.[field], fields[field], existing[field], field === 'labelIds');
    if (decision === 'conflict') conflicts.push(field);
    if (decision !== 'take') continue;
    patch[field] = fields[field];
  }
  // A full hard priority limit: Linear's raise is not taken. The team move above is already
  // written, so an issue that keeps its priority counts in `team` already.
  const finalStatus = (patch.status ?? existing.status) as Status;
  const raises = (priority: Priority) => holds({ priority, status: finalStatus, deletedAt: existing.deletedAt }, priority) && !(existing.teamId === team._id && holds(existing, priority));
  const priority = (patch.priority ?? existing.priority) as Priority;
  if (raises(priority) && !(await hasRoom(ctx, team._id, priority, holds(existing, priority) ? 0 : 1))) {
    limitNote(s, identifier, priority, team.key);
    // Keep the local priority unless that one does not fit either (e.g. after a team move).
    const keep = existing.priority as Priority;
    const keepFits = !isLimited(keep) || !raises(keep) || (await hasRoom(ctx, team._id, keep, holds(existing, keep) ? 0 : 1));
    if (keepFits) delete patch.priority;
    else patch.priority = 0;
  }
  for (const field of TRACKED) {
    if (field in patch) await record(ctx, IMPORT, now, undefined, { issueId: existing._id, field, from: existing[field], to: patch[field] });
  }
  // The timestamps follow the status: only when the status is taken from Linear.
  if ('status' in patch) {
    for (const field of TIMESTAMPS) if (existing[field] !== fields[field]) patch[field] = fields[field];
    const state = await importState(s, team, p);
    if (state._id !== existing.stateId) patch.stateId = state._id;
  }
  if (Object.keys(patch).length) {
    await ctx.db.patch('issues', existing._id, { ...patch, updatedAt: now });
    changed = true;
  }

  const description = await mergeImportedBody(ctx, s.runId, now, existing._id, hasBase, old?.descriptionHash, markdown);
  if (description === 'take') changed = true;
  else if (description === 'conflict') conflicts.push('description');
  if (conflicts.length) await addConflict(s, existing._id, identifier, conflicts);
  await ensureAliases(s, existing._id, p.previousIdentifiers);
  if (sprint) await setImportedSprintItem(ctx, existing._id, sprint, outcomeOf(p.status), now);
  // Phase 2 merges the parent; until then its last imported value stays.
  await saveLink(s, link, 'issue', p.linearId, existing._id, hash, {
    ...base,
    ...(old?.parentId ? { parentId: old.parentId } : {}),
  });
  return changed ? 'updated' : 'unchanged';
}

// ---------------------------------------------------------------- Phase 2

async function importParent(s: State, p: ImportIssue): Promise<Outcome> {
  const { ctx, now } = s;
  const link = await findLink(ctx, 'issue', p.linearId);
  if (!link || link.purgedAt !== undefined) return 'skipped';
  const issue = await getLocal(ctx, 'issues', link.localId);
  if (!issue) return 'skipped';
  // Only issues that arrived in THIS run or changed in Linear
  // (the parent is part of the hash).
  if (link.runId !== s.runId) return 'unchanged';
  const parent = p.parentLinearId ? await localOf(ctx, 'issues', 'issue', p.parentLinearId) : null;
  if (p.parentLinearId && !parent) {
    note(s, `${p.identifier}: parent not found`);
    return 'skipped';
  }
  const target = parent?._id;
  const old = (link.base ?? null) as IssueBase | null;
  const saveBase = async () => {
    if (!old || old.parentId === target) return;
    const { parentId: _previous, ...rest } = old;
    await ctx.db.patch('linearLinks', link._id, { base: { ...rest, ...(target ? { parentId: target } : {}) } });
  };
  // Three-way like the fields (a new issue has no parent yet: take it).
  const decision = merge(old !== null, old?.parentId, target, issue.parentId);
  if (decision === 'keep') {
    await saveBase();
    return 'unchanged';
  }
  if (decision === 'conflict') {
    await saveBase();
    await addConflict(s, issue._id, p.identifier, ['parentId']);
    return 'unchanged';
  }
  if (target) {
    // Cycle or parent in trash: do not set it (checkParent writes nothing).
    try {
      await checkParent(ctx, issue._id, target);
    } catch {
      note(s, `${p.identifier}: parent not imported (cycle or trash)`);
      return 'skipped';
    }
  }
  await saveBase();
  await ctx.db.patch('issues', issue._id, { parentId: target, updatedAt: now });
  await record(ctx, IMPORT, now, undefined, { issueId: issue._id, field: 'parentId', from: issue.parentId, to: target });
  return 'updated';
}

async function importComment(s: State, p: ImportComment): Promise<Outcome> {
  const { ctx, now } = s;
  const hash = payloadHash(p);
  const link = await findLink(ctx, 'comment', p.linearId);
  const existing = link ? await getLocal(ctx, 'comments', link.localId) : null;
  if (existing && link?.hash === hash) return 'unchanged';
  const issue = await localOf(ctx, 'issues', 'issue', p.issueLinearId);
  if (!issue) {
    note(s, 'Skipped comment on a missing issue');
    return 'skipped';
  }
  const body = p.body.slice(0, LIMITS.commentMax) || '(empty)';
  if (!existing) {
    const commentId = await ctx.db.insert('comments', {
      issueId: issue._id,
      body,
      author: IMPORT,
      authorName: p.authorName,
      createdAt: p.createdAt,
      ...(p.editedAt ? { editedAt: p.editedAt } : {}),
    });
    await syncFileRefs(ctx, commentId, body, now);
    await syncArticleLinks(ctx, { kind: 'comment', id: commentId, issueId: issue._id }, body);
    await ctx.db.patch('issues', issue._id, { updatedAt: now });
    await record(ctx, IMPORT, now, undefined, { issueId: issue._id, field: 'comment', to: { commentId, preview: body.slice(0, 120) } });
    await saveLink(s, link, 'comment', p.linearId, commentId, hash);
    return 'created';
  }
  // Comments deleted in Selfbound stay deleted.
  let changed = false;
  if (existing.deletedAt === undefined && existing.body !== body) {
    await ctx.db.patch('comments', existing._id, { body, editedAt: p.editedAt ?? now });
    await syncFileRefs(ctx, existing._id, body, now);
    await syncArticleLinks(ctx, { kind: 'comment', id: existing._id, issueId: issue._id }, body);
    await ctx.db.patch('issues', issue._id, { updatedAt: now });
    await record(ctx, IMPORT, now, undefined, {
      issueId: issue._id,
      field: 'comment_edited',
      to: { commentId: existing._id, preview: body.slice(0, 120) },
    });
    changed = true;
  }
  await saveLink(s, link, 'comment', p.linearId, existing._id, hash);
  return changed ? 'updated' : 'unchanged';
}

async function importRelation(s: State, p: ImportRelation): Promise<Outcome> {
  const { ctx } = s;
  const hash = payloadHash(p);
  const link = await findLink(ctx, 'relation', p.linearId);
  // Relations do not change. Ones removed in Selfbound stay removed.
  if (link) return 'unchanged';
  const from = await localOf(ctx, 'issues', 'issue', p.fromLinearId);
  const to = await localOf(ctx, 'issues', 'issue', p.toLinearId);
  if (!from || !to || from._id === to._id) {
    note(s, 'Skipped relation with a missing issue');
    return 'skipped';
  }
  if (from.deletedAt !== undefined || to.deletedAt !== undefined) {
    note(s, 'Skipped relation to an issue in the Selfbound trash');
    return 'skipped';
  }
  const forward = await ctx.db
    .query('relations')
    .withIndex('by_from', (q) => q.eq('fromId', from._id))
    .take(500);
  const backward = await ctx.db
    .query('relations')
    .withIndex('by_from', (q) => q.eq('fromId', to._id))
    .take(500);
  const same =
    forward.find((r) => r.toId === to._id && r.type === p.type) ?? backward.find((r) => r.toId === from._id && r.type === p.type);
  if (same) {
    await saveLink(s, null, 'relation', p.linearId, same._id, hash);
    return 'unchanged';
  }
  const { relationId } = await addRelation(ctx, IMPORT, { fromId: from._id, toId: to._id, type: p.type });
  await saveLink(s, null, 'relation', p.linearId, relationId, hash);
  return 'created';
}

async function importPullRequest(s: State, p: ImportPullRequest): Promise<Outcome> {
  const { ctx, now } = s;
  const hash = payloadHash(p);
  const link = await findLink(ctx, 'pullRequest', p.attachmentLinearId);
  if (link && link.hash === hash) return 'unchanged';
  const issue = await localOf(ctx, 'issues', 'issue', p.issueLinearId);
  if (!issue) {
    note(s, 'Skipped PR attachment on a missing issue');
    return 'skipped';
  }
  let pr = await ctx.db
    .query('pullRequests')
    .withIndex('by_repo_number', (q) => q.eq('repo', p.repo).eq('number', p.number))
    .unique();
  let created = false;
  if (!pr) {
    // An existing PR (e.g. from the webhook) is more current and stays as it is.
    const prId = await ctx.db.insert('pullRequests', {
      repo: p.repo,
      number: p.number,
      title: clip(p.title, 500, `#${p.number}`),
      url: p.url,
      state: p.state,
      branch: p.branch ?? '',
      updatedAt: p.createdAt,
    });
    pr = (await ctx.db.get('pullRequests', prId))!;
    created = true;
  }
  const rows = await ctx.db
    .query('issuePullRequests')
    .withIndex('by_issue', (q) => q.eq('issueId', issue._id))
    .take(200);
  let row = rows.find((r) => r.prId === pr._id);
  if (!row) {
    const id = await ctx.db.insert('issuePullRequests', { issueId: issue._id, prId: pr._id, via: 'import', closes: false });
    row = (await ctx.db.get('issuePullRequests', id))!;
    await ctx.db.patch('issues', issue._id, { updatedAt: now });
    await record(ctx, IMPORT, now, undefined, {
      issueId: issue._id,
      field: 'pull_request',
      to: { pr: `${p.repo}#${p.number}`, url: p.url, via: 'import', closes: false },
    });
    created = true;
  }
  await saveLink(s, link, 'pullRequest', p.attachmentLinearId, row._id, hash);
  return created ? 'created' : 'unchanged';
}

const ATTACHMENTS_HEADING = '**Attachments from Linear**';

/** Other attachments: one "Attachments from Linear" comment per issue, one line per attachment. */
async function importLink(s: State, p: ImportLink): Promise<Outcome> {
  const { ctx, now } = s;
  const hash = payloadHash(p);
  const link = await findLink(ctx, 'link', p.linearId);
  if (link) return 'unchanged';
  const issue = await localOf(ctx, 'issues', 'issue', p.issueLinearId);
  if (!issue) {
    note(s, 'Skipped attachment on a missing issue');
    return 'skipped';
  }
  const title = (p.title || p.url).replace(/[[\]]/g, '').trim() || p.url;
  const line = `- [${title}](${p.url})`;
  const commentLink = await findLink(ctx, 'linkComment', p.issueLinearId);
  const comment = commentLink ? await getLocal(ctx, 'comments', commentLink.localId) : null;
  let commentId: Id<'comments'>;
  if (comment) {
    commentId = comment._id;
    if (comment.deletedAt === undefined && !comment.body.includes(p.url)) {
      await ctx.db.patch('comments', comment._id, { body: `${comment.body}\n${line}`.slice(0, LIMITS.commentMax) });
      await ctx.db.patch('issues', issue._id, { updatedAt: now });
    }
  } else {
    commentId = await ctx.db.insert('comments', {
      issueId: issue._id,
      body: `${ATTACHMENTS_HEADING}\n\n${line}`,
      author: IMPORT,
      authorName: 'Linear (attachments)',
      createdAt: p.createdAt,
    });
    await ctx.db.patch('issues', issue._id, { updatedAt: now });
    await record(ctx, IMPORT, now, undefined, { issueId: issue._id, field: 'comment', to: { commentId, preview: ATTACHMENTS_HEADING } });
    await saveLink(s, commentLink, 'linkComment', p.issueLinearId, commentId, '');
  }
  await saveLink(s, null, 'link', p.linearId, commentId, hash);
  return 'created';
}

// ---------------------------------------------------------------- Batches

const HANDLERS: Record<ImportStep, (s: State, payload: never) => Promise<Outcome>> = {
  team: importTeam,
  labelGroup: importLabelGroup,
  label: importLabel,
  project: importProject,
  sprint: importSprint,
  issue: importIssue,
  parent: importParent,
  comment: importComment,
  relation: importRelation,
  pullRequest: importPullRequest,
  link: importLink,
};

/** A run without a finished batch for this long counts as stuck. */
export const STALE_RUN_MS = 15 * 60_000;

/** Phases of a run: scan, the import steps, cleanup. */
type Phase = 'scan' | ImportStep | 'cleanup';

function abort(message: string): never {
  throw new Error(message);
}

/** Marks stuck runs (`running`, no progress for STALE_RUN_MS) as `failed`. */
export async function failStaleImports(ctx: MutationCtx, now: number) {
  const running = await ctx.db
    .query('importRuns')
    .withIndex('by_status', (q) => q.eq('status', 'running'))
    .take(50);
  let failed = 0;
  for (const run of running) {
    const last = run.heartbeatAt ?? run.startedAt;
    if (now - last < STALE_RUN_MS) continue;
    await ctx.db.patch('importRuns', run._id, {
      status: 'failed',
      finishedAt: now,
      error: `Aborted: no progress for ${Math.round((now - last) / 60_000)} minutes (step ${run.phase ?? '?'}). Restart the run; data already imported will not be duplicated.`,
    });
    failed++;
  }
  return { failed };
}

/** Creates a run (phase "scan"). Throws if another run is in progress. */
export async function startImport(ctx: MutationCtx, run: string, notes: string[]) {
  const now = Date.now();
  await failStaleImports(ctx, now);
  const busy = await ctx.db
    .query('importRuns')
    .withIndex('by_status', (q) => q.eq('status', 'running'))
    .first();
  if (busy) abort(`An import is already running (${busy.run}). Wait for it to finish first.`);
  const any = await ctx.db
    .query('importStaging')
    .withIndex('by_run_kind', (q) => q.eq('run', run))
    .first();
  if (!any) abort(`No data in importStaging for run ${run}. Upload staging.jsonl first.`);
  return await ctx.db.insert('importRuns', {
    run,
    startedAt: now,
    status: 'running',
    counts: {},
    deviations: notes.slice(0, 500),
    phase: 'scan',
    cursor: null,
    maxNumbers: [],
    heartbeatAt: now,
  });
}

/** Scan phase: highest Linear number per team (for collisions with Selfbound issues), one page. */
async function scanNumbers(ctx: QueryCtx, run: string, cursor: string | null) {
  const page = await ctx.db
    .query('importStaging')
    .withIndex('by_run_kind', (q) => q.eq('run', run).eq('kind', 'issue'))
    .paginate({ cursor, numItems: 500, maximumBytesRead: 4_000_000 });
  const max: Record<string, number> = {};
  for (const row of page.page) {
    const p = row.payload as ImportIssue;
    max[p.teamLinearId] = Math.max(max[p.teamLinearId] ?? 0, p.number);
  }
  return { max, isDone: page.isDone, continueCursor: page.continueCursor };
}

/** One batch of a step: reads at most `numItems` rows or ~1 MB and processes them. */
async function processBatch(
  ctx: MutationCtx,
  runDoc: Doc<'importRuns'>,
  step: ImportStep,
  cursor: string | null,
  maxNumbers: Record<string, number>,
) {
  const page = await ctx.db
    .query('importStaging')
    .withIndex('by_run_kind', (q) => q.eq('run', runDoc.run).eq('kind', stagingKindOf(step)))
    .paginate({ cursor, numItems: BATCH_SIZE[step], maximumBytesRead: BATCH_BYTES });
  const s: State = {
    ctx,
    runId: runDoc._id,
    now: Date.now(),
    maxNumbers,
    notes: [],
    rank: { last: step === 'issue' ? await lastRank(ctx) : null },
  };
  const counts: StepCounts = { ...emptyCounts(), ...((runDoc.counts as Record<string, StepCounts>)[step] ?? {}) };
  const handler = HANDLERS[step] as (s: State, payload: unknown) => Promise<Outcome>;
  for (const row of page.page) {
    const outcome = await handler(s, row.payload);
    counts.seen++;
    counts[outcome]++;
  }
  const deviations = [...runDoc.deviations];
  for (const text of s.notes) if (!deviations.includes(text) && deviations.length < 1000) deviations.push(text);
  return {
    isDone: page.isDone,
    continueCursor: page.continueCursor,
    counts: { ...(runDoc.counts as Record<string, StepCounts>), [step]: counts },
    deviations,
  };
}

/**
 * One step of a run (one mutation): one scan page, one batch of an import step, or one
 * cleanup batch. Stores phase, cursor and heartbeat.
 * `finished`: the run is over (or already was).
 */
export async function advanceImport(ctx: MutationCtx, runId: Id<'importRuns'>): Promise<{ finished: boolean; phase: string }> {
  const run = await ctx.db.get('importRuns', runId);
  if (!run || run.status !== 'running') return { finished: true, phase: run?.phase ?? 'unknown' };
  const now = Date.now();
  const phase = (run.phase ?? 'scan') as Phase;
  const cursor = run.cursor ?? null;
  const maxNumbers: Record<string, number> = Object.fromEntries(
    (run.maxNumbers ?? []).map(([team, n]) => [String(team), Number(n)]),
  );
  const nextStep = (step: Phase): Phase => {
    if (step === 'scan') return IMPORT_STEPS[0];
    const i = IMPORT_STEPS.indexOf(step as ImportStep);
    return i >= 0 && i < IMPORT_STEPS.length - 1 ? IMPORT_STEPS[i + 1] : 'cleanup';
  };

  if (phase === 'scan') {
    const page = await scanNumbers(ctx, run.run, cursor);
    for (const [team, n] of Object.entries(page.max)) maxNumbers[team] = Math.max(maxNumbers[team] ?? 0, n);
    await ctx.db.patch('importRuns', runId, {
      phase: page.isDone ? nextStep('scan') : 'scan',
      cursor: page.isDone ? null : page.continueCursor,
      maxNumbers: Object.entries(maxNumbers),
      heartbeatAt: now,
    });
    return { finished: false, phase };
  }

  if (phase === 'cleanup') {
    // Only after success: delete the run's staging rows (on failure they stay for a retry).
    const rows = await ctx.db
      .query('importStaging')
      .withIndex('by_run_kind', (q) => q.eq('run', run.run))
      .take(500);
    for (const row of rows) await ctx.db.delete('importStaging', row._id);
    if (rows.length === 500) {
      await ctx.db.patch('importRuns', runId, { heartbeatAt: now });
      return { finished: false, phase };
    }
    await ctx.db.patch('importRuns', runId, { status: 'done', finishedAt: now, phase: 'done', cursor: null, heartbeatAt: now });
    return { finished: true, phase };
  }

  const batch = await processBatch(ctx, run, phase, cursor, maxNumbers);
  await ctx.db.patch('importRuns', runId, {
    counts: batch.counts,
    deviations: batch.deviations,
    phase: batch.isDone ? nextStep(phase) : phase,
    cursor: batch.isDone ? null : batch.continueCursor,
    heartbeatAt: now,
  });
  return { finished: false, phase };
}

export async function importSummary(ctx: QueryCtx, runId: Id<'importRuns'>) {
  const run = await ctx.db.get('importRuns', runId);
  if (!run) return null;
  const conflicts = await ctx.db
    .query('importConflicts')
    .withIndex('by_run', (q) => q.eq('runId', runId))
    .take(200);
  return {
    runId,
    run: run.run,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    counts: run.counts as Record<string, StepCounts>,
    deviations: run.deviations,
    conflicts: conflicts.map((c) => c.note),
    error: run.error ?? null,
    phase: run.phase ?? null,
  };
}
