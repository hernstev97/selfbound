// Raw Linear data → snapshot in the XLR8 format (backend/convex/shared/importTypes.ts).
//
// Pure and offline: everything here is testable with fixtures. Notes (`notes`)
// contain only counts and ids, never titles or texts.

import type {
  ImportComment,
  ImportIssue,
  ImportLabel,
  ImportLabelGroup,
  ImportLink,
  ImportProject,
  ImportProjectState,
  ImportPullRequest,
  ImportPullRequestState,
  ImportRelation,
  ImportSnapshot,
  ImportSprint,
  ImportStagingRow,
  ImportStatus,
  ImportTeam,
} from '../../backend/convex/shared/importTypes.ts';
import type { RawAttachment, RawLinearData } from './queries.ts';

const STATUSES: readonly ImportStatus[] = [
  'triage',
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'canceled',
  'duplicate',
];

/** Standard names per Linear state type. Other names are mapped by type and listed in the report. */
const STANDARD_NAMES: Record<string, string[]> = {
  triage: ['triage'],
  backlog: ['backlog'],
  unstarted: ['todo'],
  started: ['in progress', 'in review'],
  completed: ['done'],
  canceled: ['canceled', 'cancelled', 'duplicate'],
  duplicate: ['duplicate'],
};

export class UnknownStatusError extends Error {
  override name = 'UnknownStatusError';
  readonly unknown: { team: string; name: string; type: string; issues: number }[];
  constructor(unknown: UnknownStatusError['unknown']) {
    super(
      'Import aborted: these Linear statuses cannot be mapped to an XLR8 status:\n' +
        unknown.map((u) => `  - team ${u.team}: "${u.name}" (type ${u.type || 'empty'}), ${u.issues} issue(s)`).join('\n') +
        '\nAdd a mapping by hand, e.g. --map-status "Blocked=in_progress".',
    );
    this.unknown = unknown;
  }
}

/**
 * Maps a Linear status: first the manual mapping (by name, case-insensitive), then by
 * type: triage→triage, backlog→backlog, unstarted→todo, started→in_progress
 * (name "In Review"→in_review), completed→done, canceled→canceled (name
 * "Duplicate"→duplicate), duplicate→duplicate. Otherwise `undefined`.
 * Linear now returns "Duplicate" with its own type `duplicate` (checked 2026-10-10), older
 * workspaces with type `canceled`. Both become `duplicate`.
 */
export function mapStatus(name: string, type: string, overrides: Record<string, ImportStatus> = {}): ImportStatus | undefined {
  const lower = name.trim().toLowerCase();
  for (const [k, v] of Object.entries(overrides)) if (k.trim().toLowerCase() === lower) return v;
  switch (type) {
    case 'triage':
      return 'triage';
    case 'backlog':
      return 'backlog';
    case 'unstarted':
      return 'todo';
    case 'started':
      return lower === 'in review' ? 'in_review' : 'in_progress';
    case 'completed':
      return 'done';
    case 'canceled':
      return lower === 'duplicate' ? 'duplicate' : 'canceled';
    case 'duplicate':
      return 'duplicate';
    default:
      return undefined;
  }
}

/** Parses "Name=status" pairs (CLI `--map-status`). */
export function parseStatusOverrides(pairs: string[]): Record<string, ImportStatus> {
  const out: Record<string, ImportStatus> = {};
  for (const pair of pairs) {
    const i = pair.lastIndexOf('=');
    const name = pair.slice(0, i).trim();
    const status = pair.slice(i + 1).trim() as ImportStatus;
    if (i <= 0 || !name || !STATUSES.includes(status)) {
      throw new Error(`--map-status "${pair}" is invalid. Format: "Name=status" with status one of ${STATUSES.join(', ')}.`);
    }
    out[name] = status;
  }
  return out;
}

const PROJECT_STATES: Record<string, ImportProjectState> = {
  backlog: 'planned',
  planned: 'planned',
  started: 'active',
  paused: 'paused',
  completed: 'done',
  canceled: 'canceled',
};

const ms = (iso: string) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new Error(`Invalid timestamp from Linear: ${iso}`);
  return t;
};
const msOpt = (iso: string | null | undefined) => (iso ? ms(iso) : undefined);
const opt = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined || v === '' ? undefined : v);

const berlinDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
/** Calendar day in Europe/Berlin, "YYYY-MM-DD". */
export function dayInBerlin(t: number) {
  return berlinDay.format(new Date(t));
}

const PR_URL_RE = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

/** Recognizes a GitHub PR attachment (sourceType "github" or URL github.com/…/pull/N). */
export function pullRequestOf(a: RawAttachment): { repo: string; number: number } | undefined {
  const m = PR_URL_RE.exec(a.url.trim());
  if (!m) return undefined;
  return { repo: m[1]!, number: Number(m[2]) };
}

/**
 * State of a PR attachment from Linear's `metadata`. The format is undocumented;
 * it is read defensively (status/state, merged/draft, mergedAt/closedAt).
 */
export function pullRequestState(metadata: Record<string, unknown> | null | undefined): ImportPullRequestState | undefined {
  const m = metadata ?? {};
  const s = String(m.status ?? m.state ?? '').toLowerCase();
  if (s === 'merged' || m.merged === true || typeof m.mergedAt === 'string') return 'merged';
  if (s === 'draft' || m.draft === true) return 'draft';
  if (s === 'closed' || typeof m.closedAt === 'string') return 'closed';
  if (s === 'open' || s === 'opened' || s === 'inreview' || s === 'in_review' || s === 'approved') return 'open';
  return undefined;
}

function branchOf(metadata: Record<string, unknown> | null | undefined): string | undefined {
  const m = metadata ?? {};
  for (const v of [m.branch, m.branchName, m.headRefName, (m.head as Record<string, unknown> | undefined)?.ref]) {
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

export interface NormalizeOptions {
  run: string;
  fetchedAt: number;
  statusOverrides?: Record<string, ImportStatus>;
}

export function normalize(raw: RawLinearData, options: NormalizeOptions): ImportSnapshot {
  const notes: string[] = [];
  const teamKeyById = new Map(raw.teams.map((t) => [t.id, t.key]));

  // ---- Teams
  const teams: ImportTeam[] = raw.teams.map((t) => ({
    linearId: t.id,
    key: t.key.toUpperCase(),
    name: t.name,
    color: opt(t.color),
    description: opt(t.description),
    dormant: Boolean(t.archivedAt || t.retiredAt),
    createdAt: ms(t.createdAt),
  }));
  const dormant = teams.filter((t) => t.dormant).map((t) => t.key);
  if (dormant.length) notes.push(`Dormant teams (archived/retired in Linear): ${dormant.join(', ')}`);

  // ---- Filter issues (Linear's trash does not count) and sort by creation
  const trashed = raw.issues.filter((i) => i.trashed);
  if (trashed.length) notes.push(`In the Linear trash, not imported: ${trashed.length} issue(s)`);
  const rawIssues = raw.issues
    .filter((i) => !i.trashed && teamKeyById.has(i.team.id))
    .sort((a, b) => ms(a.createdAt) - ms(b.createdAt) || a.identifier.localeCompare(b.identifier));
  const foreign = raw.issues.filter((i) => !i.trashed && !teamKeyById.has(i.team.id));
  if (foreign.length) notes.push(`Issues without a known team, not imported: ${foreign.length}`);
  const issueIds = new Set(rawIssues.map((i) => i.id));

  // ---- Statuses
  const overrides = options.statusOverrides ?? {};
  const unknown = new Map<string, { team: string; name: string; type: string; issues: number }>();
  const nonStandard = new Map<string, string>();
  const statusOf = (team: string, state: { name: string; type: string }) => {
    const status = mapStatus(state.name, state.type, overrides);
    if (!status) {
      const key = `${team}|${state.name}|${state.type}`;
      const entry = unknown.get(key) ?? { team, name: state.name, type: state.type, issues: 0 };
      entry.issues++;
      unknown.set(key, entry);
      return 'triage' as const; // aborts below
    }
    const standard = STANDARD_NAMES[state.type]?.includes(state.name.trim().toLowerCase());
    if (!standard) nonStandard.set(`${state.name} (${state.type})`, status);
    return status;
  };

  // ---- Labels and groups
  const groupIds = new Set(raw.labels.filter((l) => l.isGroup).map((l) => l.id));
  const labelGroups: ImportLabelGroup[] = raw.labels
    .filter((l) => l.isGroup)
    .map((l) => ({ linearId: l.id, name: l.name, color: opt(l.color), teamLinearId: l.team?.id, exclusive: true }));
  let orphanParents = 0;
  const labels: ImportLabel[] = raw.labels
    .filter((l) => !l.isGroup)
    .map((l) => {
      const parent = l.parent?.id;
      if (parent && !groupIds.has(parent)) orphanParents++;
      return {
        linearId: l.id,
        name: l.name,
        color: opt(l.color),
        groupLinearId: parent && groupIds.has(parent) ? parent : undefined,
        teamLinearId: l.team?.id,
        archived: Boolean(l.archivedAt || l.retiredAt),
      };
    });
  if (orphanParents) notes.push(`Labels with an unknown group (imported without group): ${orphanParents}`);
  const labelIds = new Set(labels.map((l) => l.linearId));

  // ---- Projects: exactly one team (the one with most of the project's issues)
  const issuesPerProjectTeam = new Map<string, Map<string, number>>();
  for (const i of rawIssues) {
    if (!i.project) continue;
    const m = issuesPerProjectTeam.get(i.project.id) ?? new Map<string, number>();
    m.set(i.team.id, (m.get(i.team.id) ?? 0) + 1);
    issuesPerProjectTeam.set(i.project.id, m);
  }
  let multiTeam = 0;
  let withoutTeam = 0;
  const projects: ImportProject[] = [];
  for (const p of raw.projects) {
    const teamIds = p.teams.nodes.map((t) => t.id).filter((id) => teamKeyById.has(id));
    if (teamIds.length === 0) {
      withoutTeam++;
      continue;
    }
    if (teamIds.length > 1) multiTeam++;
    const counts = issuesPerProjectTeam.get(p.id);
    const teamLinearId = [...teamIds].sort((a, b) => (counts?.get(b) ?? 0) - (counts?.get(a) ?? 0))[0]!;
    const state = p.status ? PROJECT_STATES[p.status.type] : undefined;
    projects.push({
      linearId: p.id,
      name: p.name,
      description: opt(p.description),
      teamLinearId,
      teamLinearIds: teamIds,
      state: state ?? 'planned',
      linearStatusName: p.status?.name,
      createdAt: ms(p.createdAt),
      startedAt: msOpt(p.startedAt),
      completedAt: msOpt(p.completedAt),
      canceledAt: msOpt(p.canceledAt),
      archivedAt: msOpt(p.archivedAt),
    });
  }
  if (multiTeam) notes.push(`Projects with several teams (assigned to the team with the most issues): ${multiTeam}`);
  if (withoutTeam) notes.push(`Projects without a known team, not imported: ${withoutTeam}`);
  const projectTeam = new Map(projects.map((p) => [p.linearId, p.teamLinearId]));

  // ---- Cycles → Sprints
  const sprints: ImportSprint[] = raw.cycles
    .filter((c) => teamKeyById.has(c.team.id))
    .sort((a, b) => ms(a.startsAt) - ms(b.startsAt))
    .map((c) => {
      const startsAt = ms(c.startsAt);
      const endsAt = ms(c.endsAt);
      const teamKey = c.team.key.toUpperCase();
      return {
        linearId: c.id,
        source: 'linear' as const,
        teamLinearId: c.team.id,
        teamKey,
        linearNumber: c.number,
        name: opt(c.name) ?? `${teamKey} Cycle ${c.number}`,
        description: opt(c.description),
        startDate: dayInBerlin(startsAt),
        // endsAt is the moment the cycle ends; its last day lies before that.
        endDate: dayInBerlin(Math.max(startsAt, endsAt - 1)),
        startsAt,
        endsAt,
        completedAt: msOpt(c.completedAt),
      };
    });
  const cycleIds = new Set(sprints.map((s) => s.linearId));

  // ---- Issues
  let missingLabels = 0;
  let crossTeamProject = 0;
  const issues: ImportIssue[] = rawIssues.map((i, order) => {
    const teamKey = i.team.key.toUpperCase();
    const labelLinearIds = i.labels.nodes.map((l) => l.id).filter((id) => labelIds.has(id));
    missingLabels += i.labels.nodes.length - labelLinearIds.length;
    const projectLinearId = i.project && projectTeam.has(i.project.id) ? i.project.id : undefined;
    if (projectLinearId && projectTeam.get(projectLinearId) !== i.team.id) crossTeamProject++;
    return {
      linearId: i.id,
      identifier: i.identifier.toUpperCase(),
      teamLinearId: i.team.id,
      teamKey,
      number: i.number,
      title: i.title,
      description: opt(i.description),
      status: statusOf(teamKey, i.state),
      linearStateName: i.state.name,
      linearStateType: i.state.type,
      priority: Math.min(4, Math.max(0, Math.round(i.priority ?? 0))) as ImportIssue['priority'],
      estimate: opt(i.estimate),
      dueDate: opt(i.dueDate),
      labelLinearIds,
      projectLinearId,
      parentLinearId: i.parent && issueIds.has(i.parent.id) ? i.parent.id : undefined,
      cycleLinearId: i.cycle && cycleIds.has(i.cycle.id) ? i.cycle.id : undefined,
      createdAt: ms(i.createdAt),
      updatedAt: ms(i.updatedAt),
      startedAt: msOpt(i.startedAt),
      completedAt: msOpt(i.completedAt),
      canceledAt: msOpt(i.canceledAt),
      archivedAt: msOpt(i.archivedAt),
      previousIdentifiers: [...new Set(i.previousIdentifiers.map((p) => p.toUpperCase()))].filter(
        (p) => p !== i.identifier.toUpperCase(),
      ),
      url: opt(i.url),
      order,
    };
  });

  if (unknown.size) throw new UnknownStatusError([...unknown.values()]);
  for (const [state, status] of nonStandard) notes.push(`Status "${state}" mapped to ${status}`);
  if (missingLabels) notes.push(`Label assignments to unknown labels (skipped): ${missingLabels}`);
  if (crossTeamProject) notes.push(`Issues in a project assigned to another team: ${crossTeamProject}`);
  const missingParents = rawIssues.filter((i) => i.parent && !issueIds.has(i.parent.id));
  if (missingParents.length)
    notes.push(`Parent not in the import (parent removed): ${missingParents.map((i) => i.identifier).join(', ')}`);
  const archived = issues.filter((i) => i.archivedAt !== undefined).length;
  if (archived) notes.push(`Issues archived in Linear (imported normally): ${archived}`);

  // ---- Phase 2: comments, relations, attachments
  const comments: ImportComment[] = [];
  const relations: ImportRelation[] = [];
  const pullRequests: ImportPullRequest[] = [];
  const links: ImportLink[] = [];
  let similar = 0;
  let unknownRelation = 0;
  let danglingRelation = 0;
  let prUnknownState = 0;
  const seenRelations = new Set<string>();
  const seenPrs = new Set<string>();
  for (const i of rawIssues) {
    for (const c of i.comments.nodes) {
      const bot = !c.user && c.botActor;
      comments.push({
        linearId: c.id,
        issueLinearId: i.id,
        body: c.body,
        authorName: `${c.user ? c.user.name : (opt(c.botActor?.name) ?? 'Unknown')} (Linear)`,
        authorKind: bot ? 'bot' : 'user',
        parentLinearId: opt(c.parent?.id),
        createdAt: ms(c.createdAt),
        editedAt: msOpt(c.editedAt),
      });
    }
    for (const r of i.relations.nodes) {
      if (r.type === 'similar') {
        similar++;
        continue;
      }
      if (r.type !== 'blocks' && r.type !== 'related' && r.type !== 'duplicate') {
        unknownRelation++;
        continue;
      }
      if (!r.relatedIssue || !issueIds.has(r.relatedIssue.id)) {
        danglingRelation++;
        continue;
      }
      if (seenRelations.has(r.id)) continue;
      seenRelations.add(r.id);
      relations.push({ linearId: r.id, type: r.type, fromLinearId: i.id, toLinearId: r.relatedIssue.id });
    }
    for (const a of i.attachments.nodes) {
      const pr = pullRequestOf(a);
      if (pr) {
        const key = `${i.id}|${pr.repo.toLowerCase()}#${pr.number}`;
        if (seenPrs.has(key)) continue;
        seenPrs.add(key);
        const state = pullRequestState(a.metadata);
        if (!state) prUnknownState++;
        pullRequests.push({
          attachmentLinearId: a.id,
          issueLinearId: i.id,
          repo: pr.repo,
          number: pr.number,
          url: a.url,
          title: a.title,
          state: state ?? 'open',
          branch: branchOf(a.metadata),
          createdAt: ms(a.createdAt),
        });
      } else {
        links.push({
          linearId: a.id,
          issueLinearId: i.id,
          url: a.url,
          title: a.title,
          sourceType: opt(a.sourceType),
          createdAt: ms(a.createdAt),
        });
      }
    }
  }
  comments.sort((a, b) => a.createdAt - b.createdAt);
  if (similar) notes.push(`Linear "similar" suggestions not imported: ${similar}`);
  if (unknownRelation) notes.push(`Relations with an unknown type not imported: ${unknownRelation}`);
  if (danglingRelation) notes.push(`Relations to issues outside the import not imported: ${danglingRelation}`);
  if (prUnknownState) notes.push(`PR attachments without a recognizable state (imported as "open"): ${prUnknownState}`);
  if (links.length) notes.push(`Other attachments stay links (files are not copied): ${links.length}`);

  return {
    version: 1,
    source: 'linear',
    run: options.run,
    fetchedAt: options.fetchedAt,
    teams,
    labelGroups,
    labels,
    projects,
    sprints,
    issues,
    comments,
    relations,
    pullRequests,
    links,
    notes,
  };
}

/** Rows for `importStaging` (push uploads them through `importer:stage`): phase 1, then phase 2. */
export function stagingRows(snapshot: ImportSnapshot): ImportStagingRow[] {
  const run = snapshot.run;
  const rows: ImportStagingRow[] = [];
  const push = <K extends ImportStagingRow['kind']>(kind: K, linearId: string, payload: ImportStagingRow<K>['payload']) =>
    rows.push({ run, kind, linearId, payload } as ImportStagingRow);
  for (const x of snapshot.teams) push('team', x.linearId, x);
  for (const x of snapshot.labelGroups) push('labelGroup', x.linearId, x);
  for (const x of snapshot.labels) push('label', x.linearId, x);
  for (const x of snapshot.projects) push('project', x.linearId, x);
  for (const x of snapshot.sprints) push('sprint', x.linearId, x);
  for (const x of snapshot.issues) push('issue', x.linearId, x);
  for (const x of snapshot.comments) push('comment', x.linearId, x);
  for (const x of snapshot.relations) push('relation', x.linearId, x);
  for (const x of snapshot.pullRequests) push('pullRequest', x.attachmentLinearId, x);
  for (const x of snapshot.links) push('link', x.linearId, x);
  return rows;
}

/** Counts per kind, for the console and the report. */
export function snapshotCounts(snapshot: ImportSnapshot): Record<string, number> {
  return {
    teams: snapshot.teams.length,
    labelGroups: snapshot.labelGroups.length,
    labels: snapshot.labels.length,
    projects: snapshot.projects.length,
    sprints: snapshot.sprints.length,
    issues: snapshot.issues.length,
    comments: snapshot.comments.length,
    relations: snapshot.relations.length,
    pullRequests: snapshot.pullRequests.length,
    links: snapshot.links.length,
  };
}
