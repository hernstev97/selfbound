import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Actor } from '../lib/actor';
import { addDays, berlinDay, berlinDayStart } from '../lib/dates';
import { fail } from '../lib/errors';
import { idempotent } from '../lib/idempotency';
import { resolveIssue } from '../lib/identifiers';
import type { ToolArgs, ToolName } from '../lib/mcp/tools';
import type { IssuePatch, NewIssue } from '../lib/validators';
import { teamStates, type State } from '../lib/workflow';
import { CLOSED_STATUSES, identifierOf, isOpen, OPEN_STATUSES, OWNER_KIND, STATUSES, type Priority, type Status } from '../shared/constants';
import {
  activeStates,
  allowedTargets,
  defaultState,
  STATE_TYPES,
  stateByName,
  statusOfState,
  TYPE_OF_STATUS,
  type StateType,
} from '../shared/workflow';
import { addCommentCore } from './comments';
import { applyDescription, applyPatch, budgetWarnings, createIssuesCore, updateIssuesCore, type BudgetWarning } from './issues';
import { issueArticles } from './links';
import { moveIssuesToTeamCore } from './move';
import {
  addSourcesCore,
  appendArticleBodyCore,
  articleDetail,
  createArticleCore,
  createTopic,
  getArticle,
  listArticles,
  moveArticle,
  searchArticles,
  setArticleBodyCore,
  updateArticleCore,
} from './wiki';

// The MCP tools for agents. Each tool maps the agents' arguments (team keys, label and
// project names, identifiers) onto the shared operations in ops/*.ts and builds a lean
// response from the result.
//
// Write tools run inside ONE internal mutation (convex/mcp.ts) together with the key check,
// rate limit and idempotency. Business errors throw `fail(...)` and reach the agent as a
// result with isError.

/** Read tools are the ones with `readOnlyHint` (lib/mcp/tools.ts); they run as a query. */
export { isReadTool } from '../lib/mcp/endpoint';

const PRIORITY_NAMES = ['none', 'urgent', 'high', 'medium', 'low'] as const;
/** Sort order: urgent first, no priority last. */
const PRIORITY_ORDER: readonly Priority[] = [1, 2, 3, 4, 0];
const ASSIGNED_STATUSES: readonly Status[] = ['backlog', 'todo', 'in_progress', 'in_review'];
/**
 * list_issues reads at most this many issues per call (hard read limit, about 475 bytes per
 * issue, so at most about 0.5 MB). Beyond that: `truncated: true`.
 */
export const SCAN_MAX = 1000;

const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

/** Display name of the instance owner in MCP output (history `by`, comment authors). */
export const ownerName = (env: Record<string, string | undefined> = process.env) => env.XLR8_OWNER_NAME?.trim() || 'Owner';

// ---------------------------------------------------------------- Lookup

/** Reference data, cached for the duration of one tool call. */
class Lookup {
  private teamList?: Doc<'teams'>[];
  private labelList?: Doc<'labels'>[];
  private groupList?: Doc<'labelGroups'>[];
  private projectList?: Doc<'projects'>[];
  private sprintCache = new Map<Id<'sprints'>, Doc<'sprints'> | null>();
  private agentCache = new Map<string, string>();
  private parentCache = new Map<Id<'issues'>, string | null>();

  private readonly ctx: QueryCtx;
  constructor(ctx: QueryCtx) {
    this.ctx = ctx;
  }

  async teams() {
    this.teamList ??= (await this.ctx.db.query('teams').take(500)).sort((a, b) => a.order - b.order);
    return this.teamList;
  }
  async team(teamId: Id<'teams'>) {
    return (await this.teams()).find((t) => t._id === teamId) ?? null;
  }
  async teamByKey(key: string) {
    const team = (await this.teams()).find((t) => t.key === key.toUpperCase());
    if (!team) fail('not_found', `Unknown team "${key}". Call list_teams for valid keys.`, { team: key });
    return team;
  }
  async labels() {
    this.labelList ??= await this.ctx.db.query('labels').take(2000);
    return this.labelList;
  }
  async groups() {
    this.groupList ??= await this.ctx.db.query('labelGroups').take(500);
    return this.groupList;
  }
  async projects() {
    this.projectList ??= await this.ctx.db.query('projects').take(2000);
    return this.projectList;
  }
  async sprint(sprintId: Id<'sprints'>) {
    if (!this.sprintCache.has(sprintId)) this.sprintCache.set(sprintId, await this.ctx.db.get('sprints', sprintId));
    return this.sprintCache.get(sprintId) ?? null;
  }

  async states(teamId: Id<'teams'>) {
    return await teamStates(this.ctx, teamId);
  }

  /** Status of an issue (null only for issues from before the workflow migration). */
  async stateOf(issue: Pick<Doc<'issues'>, 'teamId' | 'stateId'>): Promise<State | null> {
    if (!issue.stateId) return null;
    return (await this.states(issue.teamId)).find((s) => s._id === issue.stateId) ?? null;
  }

  /** Status name for agents, falling back to the status type key. */
  async statusName(issue: Pick<Doc<'issues'>, 'teamId' | 'stateId' | 'status'>) {
    return (await this.stateOf(issue))?.name ?? issue.status;
  }

  async stateName(stateId: Id<'workflowStates'>) {
    return (await this.ctx.db.get('workflowStates', stateId))?.name ?? null;
  }

  /**
   * An agent's status input for a team: a name (case-insensitive) → exactly that status; a
   * status type key → the team's matching status (stays in the current status if that already
   * has this type).
   */
  async statusPatch(team: Doc<'teams'>, input: string): Promise<Pick<IssuePatch, 'stateId' | 'status'>> {
    const states = await this.states(team._id);
    const named = stateByName(states, input);
    if (named && named.archivedAt === undefined) return { stateId: named._id };
    const key = input.trim().toLowerCase();
    if ((STATUSES as readonly string[]).includes(key)) return { status: key as Status };
    const names = activeStates(states).map((s) => `"${s.name}"`);
    return fail('invalid', `Unknown status "${input}" for team ${team.key}. Valid: ${names.join(', ')} (or a key like "in_progress", "done").`, {
      status: input,
      team: team.key,
      allowed: activeStates(states).map((s) => s.name),
    });
  }

  /** Does a status input (name or key) match the issue's current status? */
  async statusMatches(issue: Doc<'issues'>, input: string) {
    const key = input.trim().toLowerCase();
    const state = await this.stateOf(issue);
    return (state !== null && state.name.trim().toLowerCase() === key) || issue.status === key;
  }

  async identifier(issue: Pick<Doc<'issues'>, 'teamId' | 'number'>) {
    return identifierOf((await this.team(issue.teamId))?.key ?? '?', issue.number);
  }

  async parentIdentifier(parentId: Id<'issues'>) {
    if (!this.parentCache.has(parentId)) {
      const parent = await this.ctx.db.get('issues', parentId);
      this.parentCache.set(parentId, parent ? await this.identifier(parent) : null);
    }
    return this.parentCache.get(parentId) ?? null;
  }

  /**
   * Label names → ids for a team: workspace labels and labels of this team. Archived labels
   * only if already on the issue (`keep`), as in checkLabels.
   */
  async labelIds(team: Doc<'teams'>, names: string[], keep: ReadonlySet<Id<'labels'>> = new Set()): Promise<Id<'labels'>[]> {
    const labels = (await this.labels()).filter(
      (l) => (!l.archived || keep.has(l._id)) && (!l.teamId || l.teamId === team._id),
    );
    const out: Id<'labels'>[] = [];
    for (const name of names) {
      const matches = labels.filter((l) => l.name.toLowerCase() === name.trim().toLowerCase());
      // Same name as team and workspace label: the team label wins.
      const pick = matches.length > 1 ? matches.filter((l) => l.teamId === team._id) : matches;
      if (pick.length === 0) {
        fail('not_found', `Unknown label "${name}" for team ${team.key}. Call list_labels for valid names.`, { label: name });
      }
      if (pick.length > 1) {
        fail('invalid', `Label name "${name}" is ambiguous for team ${team.key} (it exists in several groups).`, { label: name });
      }
      out.push(pick[0]._id);
    }
    return out;
  }

  async projectId(team: Doc<'teams'>, name: string): Promise<Id<'projects'>> {
    const matches = (await this.projects()).filter(
      (p) => p.teamId === team._id && p.name.toLowerCase() === name.trim().toLowerCase(),
    );
    if (matches.length === 0) {
      fail('not_found', `Unknown project "${name}" in team ${team.key}. Call list_projects for valid names.`, { project: name });
    }
    return matches[0]._id;
  }

  async labelNames(labelIds: Id<'labels'>[]) {
    const labels = await this.labels();
    return labelIds.map((id) => labels.find((l) => l._id === id)?.name ?? '?');
  }

  async projectName(projectId: Id<'projects'> | undefined) {
    if (!projectId) return null;
    return (await this.projects()).find((p) => p._id === projectId)?.name ?? null;
  }

  async actorName(actor: Actor, authorName?: string) {
    if (authorName) return authorName;
    switch (actor.kind) {
      case OWNER_KIND:
        return ownerName();
      case 'github':
        return 'GitHub';
      case 'import':
        return 'Import (Linear)';
      case 'system':
        return 'System';
      case 'agent': {
        const id = actor.agentId;
        if (!id) return 'Agent';
        if (!this.agentCache.has(id)) this.agentCache.set(id, (await this.ctx.db.get('agents', id))?.name ?? 'Agent');
        return `${this.agentCache.get(id)} (agent)`;
      }
    }
  }

  /** Lean view of an issue for lists: only fields that are set. */
  async brief(issue: Doc<'issues'>) {
    const team = await this.team(issue.teamId);
    const out: Record<string, unknown> = {
      identifier: identifierOf(team?.key ?? '?', issue.number),
      title: issue.title,
      status: await this.statusName(issue),
      statusType: (await this.stateOf(issue))?.type ?? TYPE_OF_STATUS[issue.status],
      priority: PRIORITY_NAMES[issue.priority],
      team: team?.key ?? '?',
    };
    if (issue.labelIds.length) out.labels = await this.labelNames(issue.labelIds);
    const project = await this.projectName(issue.projectId);
    if (project) out.project = project;
    if (issue.estimate !== undefined) out.estimate = issue.estimate;
    if (issue.dueDate) out.dueDate = issue.dueDate;
    if (issue.sprintId) {
      const sprint = await this.sprint(issue.sprintId);
      if (sprint) out.sprint = sprint.name;
    }
    if (issue.parentId) {
      const parent = await this.parentIdentifier(issue.parentId);
      if (parent) out.parent = parent;
    }
    if (issue.deletedAt !== undefined) out.deleted = true;
    return out;
  }
}

async function issueByIdentifier(ctx: QueryCtx, identifier: string) {
  const issue = await resolveIssue(ctx, identifier);
  if (!issue) fail('not_found', `Issue ${identifier} not found.`, { identifier });
  return issue;
}

function assertNotDeleted(issue: Doc<'issues'>, identifier: string) {
  if (issue.deletedAt !== undefined) {
    fail('invalid', `Issue ${identifier} is in the trash. The owner has to restore it before it can be changed.`, { identifier });
  }
}

/** Notice for agents: the priority was removed because the issue is done, canceled or a duplicate. */
function priorityClearedWarning(identifier: string, priority: Priority, statusType: unknown) {
  const word = PRIORITY_NAMES[priority];
  return {
    code: 'priority_cleared' as const,
    identifier,
    priority: word,
    message: `${identifier} is now ${statusType}: its priority (${word}) was removed because only open issues carry a priority. Reopening the issue does not restore it; set it again if needed.`,
  };
}

function englishWarnings(warnings: BudgetWarning[], lookup: Lookup) {
  return Promise.all(
    warnings.map(async (w) => {
      const key = (await lookup.team(w.teamId))?.key ?? '?';
      const word = PRIORITY_NAMES[w.priority];
      return {
        code: w.code,
        team: key,
        priority: word,
        open: w.open,
        budget: w.budget,
        message: `Priority budget exceeded: team ${key} now has ${w.open} open ${word} issues (budget ${w.budget}). The change was saved; consider lowering the priority of something else.`,
      };
    }),
  );
}

// ---------------------------------------------------------------- Reading

async function searchIssues(ctx: QueryCtx, args: ToolArgs['search_issues']) {
  const lookup = new Lookup(ctx);
  const team = args.team ? await lookup.teamByKey(args.team) : undefined;
  const limit = args.limit ?? 20;
  const text = args.q;
  const titles = await ctx.db
    .query('issues')
    .withSearchIndex('search_title', (q) => (team ? q.search('title', text).eq('teamId', team._id) : q.search('title', text)))
    .take(limit * 2);
  const seen = new Set<Id<'issues'>>();
  const out: Record<string, unknown>[] = [];
  const push = async (issue: Doc<'issues'> | null, match: 'title' | 'description') => {
    if (!issue || out.length >= limit || seen.has(issue._id) || issue.deletedAt !== undefined) return;
    if (team && issue.teamId !== team._id) return;
    if (args.includeClosed === false && !isOpen(issue.status)) return;
    seen.add(issue._id);
    out.push({ ...(await lookup.brief(issue)), match });
  };
  for (const issue of titles) await push(issue, 'title');
  if (out.length < limit) {
    // Descriptions only if titles are not enough, and via the search text (at most
    // BODY_SEARCH_CHARS characters per hit) instead of the whole description.
    const bodies = await ctx.db
      .query('bodySearch')
      .withSearchIndex('search_text', (q) => q.search('text', text))
      .take(Math.min(50, (limit - out.length) * 2));
    for (const body of bodies) await push(await ctx.db.get('issues', body.issueId), 'description');
  }
  return { count: out.length, issues: out };
}

type Source = () => Promise<Doc<'issues'>[]>;

async function listIssues(ctx: QueryCtx, args: ToolArgs['list_issues'], today: string) {
  const lookup = new Lookup(ctx);
  const limit = args.limit ?? 50;
  const team = args.team ? await lookup.teamByKey(args.team) : undefined;
  const filter = args.status ? await statusFilter(lookup, team, args.status) : undefined;
  const statuses = filter?.kinds;

  let labelIds: Set<Id<'labels'>> | undefined;
  if (args.label) {
    const matches = (await lookup.labels()).filter((l) => l.name.toLowerCase() === args.label!.trim().toLowerCase());
    if (matches.length === 0) fail('not_found', `Unknown label "${args.label}". Call list_labels for valid names.`);
    labelIds = new Set(matches.map((l) => l._id));
  }
  let projectIds: Id<'projects'>[] | undefined;
  if (args.project) {
    const matches = (await lookup.projects()).filter(
      (p) => p.name.toLowerCase() === args.project!.trim().toLowerCase() && (!team || p.teamId === team._id),
    );
    if (matches.length === 0) fail('not_found', `Unknown project "${args.project}". Call list_projects for valid names.`);
    projectIds = matches.map((p) => p._id);
  }

  const teams = await lookup.teams();
  // Dormant and knowledge-only teams are not part of today's work.
  const dormant = new Set(teams.filter((t) => t.dormant || t.wiki === 'only').map((t) => t._id));
  let activeSprint: Doc<'sprints'> | null = null;
  if (args.filter === 'sprint') {
    activeSprint = await ctx.db
      .query('sprints')
      .withIndex('by_state', (q) => q.eq('state', 'active'))
      .first();
    if (!activeSprint) return { count: 0, issues: [], note: 'No sprint is active right now (see get_current_sprint).' };
  }
  const dayStart = berlinDayStart(today);
  const dayEnd = berlinDayStart(addDays(today, 1));
  const dueUntil = addDays(today, args.dueWithinDays ?? 7);

  const preset = (issue: Doc<'issues'>): boolean => {
    switch (args.filter) {
      case undefined:
        return true;
      case 'assigned':
        return ASSIGNED_STATUSES.includes(issue.status) && !dormant.has(issue.teamId);
      case 'due':
        return isOpen(issue.status) && issue.dueDate !== undefined && issue.dueDate <= dueUntil;
      case 'overdue':
        return isOpen(issue.status) && issue.dueDate !== undefined && issue.dueDate < today;
      case 'in_progress':
        return issue.status === 'in_progress' || issue.status === 'in_review';
      case 'done_today':
        return issue.status === 'done' && issue.completedAt !== undefined && issue.completedAt >= dayStart && issue.completedAt < dayEnd;
      case 'triage':
        return issue.status === 'triage';
      case 'sprint':
        return issue.sprintId === activeSprint!._id;
    }
  };
  const matches = (issue: Doc<'issues'>) =>
    issue.deletedAt === undefined &&
    (!team || issue.teamId === team._id) &&
    (!filter || filter.matches(issue)) &&
    (!labelIds || issue.labelIds.some((id) => labelIds!.has(id))) &&
    (!projectIds || (issue.projectId !== undefined && projectIds.includes(issue.projectId))) &&
    preset(issue);

  let scanned = 0;
  let truncated = false;
  const budget = () => Math.max(0, SCAN_MAX - scanned);
  const take = async (rows: Promise<Doc<'issues'>[]>) => {
    const got = await rows;
    scanned += got.length;
    if (scanned >= SCAN_MAX) truncated = true;
    return got;
  };
  /** Requested statuses within a selection (e.g. the open ones for "due"). */
  const within = (allowed: readonly Status[]) => allowed.filter((s) => !statuses || statuses.has(s));

  // Pick a source via an index, then re-check every condition. "triage" and "in progress"
  // go through by_team_priority (below) like the status filters, so the scan stops once there
  // are enough hits.
  let sources: Source[] | undefined;
  switch (args.filter) {
    case 'sprint':
      sources = [() => take(ctx.db.query('issues').withIndex('by_sprint', (q) => q.eq('sprintId', activeSprint!._id)).take(budget()))];
      break;
    case 'done_today':
      // Only status "done" and only completed today (by_status_completed), not every completed issue.
      sources = within(['done']).map(
        (status): Source =>
          () =>
            take(
              ctx.db
                .query('issues')
                .withIndex('by_status_completed', (q) => q.eq('status', status).gte('completedAt', dayStart).lt('completedAt', dayEnd))
                .take(budget()),
            ),
      );
      break;
    case 'overdue':
    case 'due': {
      const upper = args.filter === 'overdue' ? today : addDays(dueUntil, 1);
      // Open statuses only (by_status_due): completed issues with an old due date are never read.
      sources = within(OPEN_STATUSES).map(
        (status): Source =>
          () =>
            take(
              ctx.db
                .query('issues')
                .withIndex('by_status_due', (q) => q.eq('status', status).gte('dueDate', '0000-00-00').lt('dueDate', upper))
                .order('desc')
                .take(budget()),
            ),
      );
      break;
    }
    default:
      if (projectIds) {
        sources = projectIds.flatMap((projectId) =>
          statuses
            ? [...statuses].map(
                (status): Source =>
                  () =>
                    take(
                      ctx.db
                        .query('issues')
                        .withIndex('by_project', (q) => q.eq('projectId', projectId).eq('status', status))
                        .take(budget()),
                    ),
              )
            : [() => take(ctx.db.query('issues').withIndex('by_project', (q) => q.eq('projectId', projectId)).take(budget()))],
        );
      }
  }

  const order = (a: Doc<'issues'>, b: Doc<'issues'>) =>
    PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) ||
    (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') ||
    a.seq - b.seq;

  let result: Doc<'issues'>[] = [];
  if (sources) {
    const seen = new Set<Id<'issues'>>();
    for (const source of sources) {
      if (budget() === 0) break;
      for (const issue of await source()) {
        if (!seen.has(issue._id) && matches(issue)) {
          seen.add(issue._id);
          result.push(issue);
        }
      }
    }
    result.sort(order);
  } else {
    // Open statuses ("assigned", team and/or status): via by_team_priority, one priority at a
    // time. Once there are enough hits the scan stops after the current priority level.
    const presetStatuses: readonly Status[] =
      args.filter === 'assigned'
        ? ASSIGNED_STATUSES
        : args.filter === 'triage'
          ? ['triage']
          : args.filter === 'in_progress'
            ? ['in_progress', 'in_review']
            : OPEN_STATUSES;
    const wanted = statuses ? [...statuses].filter((s) => args.filter === undefined || presetStatuses.includes(s)) : [...presetStatuses];
    const walkStatuses = wanted.filter(isOpen);
    const walkTeams = team ? [team] : teams.filter((t) => args.filter !== 'assigned' || (!t.dormant && t.wiki !== 'only'));
    if (walkStatuses.length > 0) {
      for (const priority of PRIORITY_ORDER) {
        const level: Doc<'issues'>[] = [];
        for (const t of walkTeams) {
          for (const status of walkStatuses) {
            if (budget() === 0) break;
            const rows = await take(
              ctx.db
                .query('issues')
                .withIndex('by_team_priority', (q) => q.eq('teamId', t._id).eq('priority', priority).eq('status', status))
                .take(budget()),
            );
            for (const issue of rows) if (matches(issue)) level.push(issue);
          }
        }
        result.push(...level.sort(order));
        if (result.length > limit || budget() === 0) break;
      }
    }
    // Closed statuses (done, canceled, duplicate) only when explicitly requested, most
    // recently changed first (by_status), and only as many as still fit into the response.
    // This way "status: done" does not read every completed issue.
    const closedStatuses = wanted.filter((s) => !isOpen(s));
    if (closedStatuses.length > 0 && result.length <= limit) {
      const closed: Doc<'issues'>[] = [];
      for (const status of closedStatuses) {
        for await (const issue of ctx.db.query('issues').withIndex('by_status', (q) => q.eq('status', status)).order('desc')) {
          if (budget() === 0) {
            truncated = true;
            break;
          }
          scanned++;
          if (matches(issue)) closed.push(issue);
          if (closed.length > limit - result.length) break;
        }
      }
      result.push(...closed.sort((a, b) => b.updatedAt - a.updatedAt));
    }
  }
  const issues = await Promise.all(result.slice(0, limit).map((issue) => lookup.brief(issue)));
  return {
    count: issues.length,
    ...(result.length > limit ? { more: true } : {}),
    ...(truncated
      ? { truncated: true, note: `Stopped after reading ${SCAN_MAX} issues; narrow the filter (team, status, label) for complete results.` }
      : {}),
    issues,
  };
}

const RELATION_LABEL = {
  blocks: { out: 'blocks', in: 'blocked_by' },
  related: { out: 'related', in: 'related' },
  duplicate: { out: 'duplicate_of', in: 'duplicated_by' },
} as const;

async function historyValue(lookup: Lookup, field: string, value: unknown): Promise<unknown> {
  if (value === undefined || value === null) return null;
  switch (field) {
    case 'labelIds':
      return Array.isArray(value) ? await lookup.labelNames(value as Id<'labels'>[]) : value;
    case 'projectId':
      return await lookup.projectName(value as Id<'projects'>);
    case 'parentId':
      return await lookup.parentIdentifier(value as Id<'issues'>);
    case 'sprint':
      return (await lookup.sprint(value as Id<'sprints'>))?.name ?? null;
    case 'teamId':
      return typeof value === 'object' && value !== null && 'identifier' in value ? (value as { identifier: string }).identifier : value;
    case 'priority':
      return typeof value === 'number' ? PRIORITY_NAMES[value as Priority] : value;
    case 'stateId':
      return typeof value === 'string' ? ((await lookup.stateName(value as Id<'workflowStates'>)) ?? value) : value;
    case 'deleted':
    case 'restored':
    case 'reviewed':
    case 'unreviewed':
      return typeof value === 'number' ? iso(value) : value;
    default:
      return value;
  }
}

async function getIssueTool(ctx: QueryCtx, args: ToolArgs['get_issue']) {
  const lookup = new Lookup(ctx);
  let issue: Doc<'issues'> | null = null;
  if (args.id) {
    const id = ctx.db.normalizeId('issues', args.id);
    issue = id ? await ctx.db.get('issues', id) : null;
    if (!issue) fail('not_found', `Issue with id ${args.id} not found.`, { id: args.id });
  } else {
    issue = await issueByIdentifier(ctx, args.identifier!);
  }
  const id = issue._id;
  const [body, comments, outgoing, incoming, children, links, history, aliases] = await Promise.all([
    ctx.db.query('issueBodies').withIndex('by_issue', (q) => q.eq('issueId', id)).unique(),
    ctx.db.query('comments').withIndex('by_issue', (q) => q.eq('issueId', id)).order('desc').take(101),
    ctx.db.query('relations').withIndex('by_from', (q) => q.eq('fromId', id)).take(200),
    ctx.db.query('relations').withIndex('by_to', (q) => q.eq('toId', id)).take(200),
    ctx.db.query('issues').withIndex('by_parent', (q) => q.eq('parentId', id)).take(200),
    ctx.db.query('issuePullRequests').withIndex('by_issue', (q) => q.eq('issueId', id)).take(100),
    ctx.db.query('history').withIndex('by_issue', (q) => q.eq('issueId', id)).order('desc').take(20),
    ctx.db.query('identifierAliases').withIndex('by_issue', (q) => q.eq('issueId', id)).take(20),
  ]);
  const visibleComments = comments.filter((c) => c.deletedAt === undefined);
  const relations = [];
  for (const [rows, direction] of [
    [outgoing, 'out'],
    [incoming, 'in'],
  ] as const) {
    for (const r of rows) {
      const other = await ctx.db.get('issues', direction === 'out' ? r.toId : r.fromId);
      if (!other) continue;
      relations.push({
        type: RELATION_LABEL[r.type][direction],
        identifier: await lookup.identifier(other),
        title: other.title,
        status: await lookup.statusName(other),
      });
    }
  }
  const pullRequests = [];
  for (const link of links) {
    const pr = await ctx.db.get('pullRequests', link.prId);
    if (pr) {
      pullRequests.push({
        repo: pr.repo,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        state: pr.state,
        branch: pr.branch,
        closesOnMerge: link.closes,
      });
    }
  }
  return {
    id,
    ...(await lookup.brief(issue)),
    createdAt: iso(issue.createdAt),
    updatedAt: iso(issue.updatedAt),
    ...(issue.startedAt ? { startedAt: iso(issue.startedAt) } : {}),
    ...(issue.completedAt ? { completedAt: iso(issue.completedAt) } : {}),
    ...(issue.canceledAt ? { canceledAt: iso(issue.canceledAt) } : {}),
    createdBy: await lookup.actorName(issue.createdBy),
    // Legacy field name (= reviewed by the owner), kept because agents rely on it.
    reviewedBySteven: issue.reviewedAt !== undefined || issue.readAt !== undefined,
    ...(await allowedStatuses(lookup, issue)),
    ...(aliases.length ? { previousIdentifiers: aliases.map((a) => a.key) } : {}),
    description: { markdown: body?.markdown ?? '', version: body?.version ?? 0 },
    comments: await Promise.all(
      visibleComments
        .slice(0, 100)
        .reverse()
        .map(async (c) => ({
          author: await lookup.actorName(c.author, c.authorName),
          createdAt: iso(c.createdAt),
          ...(c.editedAt ? { editedAt: iso(c.editedAt) } : {}),
          body: c.body,
        })),
    ),
    ...(comments.length > 100 ? { olderCommentsOmitted: true } : {}),
    relations,
    subIssues: await Promise.all(
      children
        .filter((c) => c.deletedAt === undefined)
        .map(async (c) => ({ identifier: await lookup.identifier(c), title: c.title, status: await lookup.statusName(c) })),
    ),
    pullRequests,
    ...(await knowledgeOf(ctx, lookup, id)),
    recentHistory: await Promise.all(
      history.map(async (h) => ({
        at: iso(h.at),
        field: h.field === 'stateId' ? 'status' : h.field,
        ...(h.from !== undefined ? { from: await historyValue(lookup, h.field, h.from) } : {}),
        ...(h.to !== undefined ? { to: await historyValue(lookup, h.field, h.to) } : {}),
        by: await lookup.actorName(h.actor),
      })),
    ),
  };
}

/** Knowledge pages for the issue: linked from description/comments, or pages that mention the issue. */
async function knowledgeOf(ctx: QueryCtx, lookup: Lookup, issueId: Id<'issues'>) {
  const pages = await issueArticles(ctx, issueId);
  if (pages.length === 0) return {};
  const knowledge = [];
  for (const p of pages) knowledge.push({ id: p.id, title: p.title, team: (await lookup.team(p.teamId))?.key ?? '?', via: p.via === 'linked' ? 'linked from the issue' : 'the page mentions this issue' });
  return { knowledge };
}

async function getCurrentSprint(ctx: QueryCtx) {
  const lookup = new Lookup(ctx);
  const active = await ctx.db
    .query('sprints')
    .withIndex('by_state', (q) => q.eq('state', 'active'))
    .first();
  const planning = active
    ? null
    : (await ctx.db.query('sprints').withIndex('by_state', (q) => q.eq('state', 'planning')).take(50)).sort(
        (a, b) => a.number - b.number,
      )[0];
  const sprint = active ?? planning;
  if (!sprint) return { sprint: null, note: 'No sprint is active and none is in planning.' };
  const entries = (await ctx.db.query('sprintItems').withIndex('by_sprint', (q) => q.eq('sprintId', sprint._id)).take(2000)).filter(
    (e) => e.removedAt === undefined,
  );
  const planned: Record<string, unknown>[] = [];
  const late: Record<string, unknown>[] = [];
  let total = 0;
  let done = 0;
  let open = 0;
  let closed = 0;
  for (const entry of entries) {
    const issue = await ctx.db.get('issues', entry.issueId);
    if (!issue || issue.deletedAt !== undefined || issue.sprintId !== sprint._id) continue;
    const points = issue.estimate ?? 0;
    if (issue.status !== 'canceled' && issue.status !== 'duplicate') total += points;
    if (issue.status === 'done') done += points;
    if (isOpen(issue.status)) open++;
    else closed++;
    const list = entry.kind === 'late' ? late : planned;
    if (list.length < 200) {
      list.push({ ...(await lookup.brief(issue)), ...(entry.carriedFrom ? { carriedOver: true } : {}) });
    }
  }
  return {
    sprint: {
      number: sprint.number,
      name: sprint.name,
      goal: sprint.goal,
      state: sprint.state,
      startDate: sprint.startDate,
      endDate: sprint.endDate,
      ...(sprint.capacity !== undefined ? { capacity: sprint.capacity } : {}),
    },
    ...(active ? {} : { note: 'No sprint is active; this is the next sprint in planning.' }),
    points: { done, total, ...(sprint.capacity !== undefined ? { capacity: sprint.capacity } : {}) },
    counts: { open, closed, planned: planned.length, addedLater: late.length },
    planned,
    addedLater: late,
  };
}

async function listTeams(ctx: QueryCtx, args: ToolArgs['list_teams']) {
  const teams = await new Lookup(ctx).teams();
  return {
    teams: teams
      .filter((t) => args.includeDormant !== false || !t.dormant)
      .map((t) => ({ key: t.key, name: t.name, dormant: t.dormant, wiki: t.wiki ?? null })),
  };
}

async function listProjects(ctx: QueryCtx, args: ToolArgs['list_projects']) {
  const lookup = new Lookup(ctx);
  const team = args.team ? await lookup.teamByKey(args.team) : undefined;
  const projects = (await lookup.projects())
    .filter((p) => (!team || p.teamId === team._id) && (args.includeClosed || (p.state !== 'done' && p.state !== 'canceled')))
    .sort((a, b) => a.order - b.order);
  return {
    projects: await Promise.all(
      projects.map(async (p) => ({ name: p.name, team: (await lookup.team(p.teamId))?.key ?? '?', state: p.state })),
    ),
  };
}

async function listLabels(ctx: QueryCtx, args: ToolArgs['list_labels']) {
  const lookup = new Lookup(ctx);
  const team = args.team ? await lookup.teamByKey(args.team) : undefined;
  const groups = await lookup.groups();
  const labels = (await lookup.labels()).filter((l) => !l.archived && (!team || !l.teamId || l.teamId === team._id));
  return {
    labels: await Promise.all(
      labels.map(async (l) => {
        const group = l.groupId ? groups.find((g) => g._id === l.groupId) : undefined;
        return {
          name: l.name,
          ...(group ? { group: group.name, exclusive: group.exclusive } : {}),
          scope: l.teamId ? ((await lookup.team(l.teamId))?.key ?? '?') : 'workspace',
        };
      }),
    ),
  };
}

async function listStatuses(ctx: QueryCtx, args: ToolArgs['list_statuses']) {
  const lookup = new Lookup(ctx);
  const teams = args.team ? [await lookup.teamByKey(args.team)] : await lookup.teams();
  return {
    teams: await Promise.all(
      teams.map(async (t) => {
        const states = await lookup.states(t._id);
        const standard = defaultState(states, t.workflow);
        const active = activeStates(states);
        const name = (id: string) => active.find((s) => s._id === id)?.name;
        const exceptions = (t.workflow?.exceptions ?? []).flatMap((e) => (name(e.from) && name(e.to) ? [{ from: name(e.from)!, to: name(e.to)! }] : []));
        return {
          team: t.key,
          strictOrder: t.workflow?.strict ?? false,
          ...(t.workflow?.strict
            ? {
                rules:
                  'Issues move only to the next status in this order. Allowed at any time: canceled-type statuses. From triage: any backlog or unstarted status. Plus the listed exceptions. New issues start in a triage, backlog or unstarted status.',
                exceptions,
              }
            : {}),
          statuses: active.map((s) => ({
            name: s.name,
            type: s.type,
            key: statusOfState(s),
            ...(s._id === standard?._id ? { default: true } : {}),
          })),
        };
      }),
    ),
  };
}

/** With strict order: the statuses the issue may move to now (names). */
async function allowedStatuses(lookup: Lookup, issue: Doc<'issues'>) {
  const team = await lookup.team(issue.teamId);
  if (!team?.workflow?.strict || !issue.stateId) return {};
  const states = await lookup.states(issue.teamId);
  const allowed = allowedTargets(states, team.workflow, issue.stateId);
  if (!allowed) return {};
  return { allowedStatuses: activeStates(states).filter((s) => allowed.has(s._id)).map((s) => s.name) };
}

/** Status filter of list_issues: names, keys and types → status kinds (for the index) and a per-issue check. */
async function statusFilter(lookup: Lookup, team: Doc<'teams'> | undefined, inputs: string[]) {
  const kinds = new Set<Status>();
  const stateIds = new Set<Id<'workflowStates'>>();
  const keyKinds = new Set<Status>();
  const teams = team ? [team] : await lookup.teams();
  for (const input of inputs) {
    const key = input.trim().toLowerCase();
    if ((STATUSES as readonly string[]).includes(key)) {
      kinds.add(key as Status);
      keyKinds.add(key as Status);
      continue;
    }
    if ((STATE_TYPES as readonly string[]).includes(key)) {
      for (const status of STATUSES) {
        if (TYPE_OF_STATUS[status] === (key as StateType)) {
          kinds.add(status);
          keyKinds.add(status);
        }
      }
      continue;
    }
    let found = false;
    for (const t of teams) {
      for (const s of activeStates(await lookup.states(t._id))) {
        if (s.name.trim().toLowerCase() !== key) continue;
        found = true;
        stateIds.add(s._id);
        kinds.add(statusOfState(s));
      }
    }
    if (!found) {
      fail('not_found', `Unknown status "${input}"${team ? ` for team ${team.key}` : ''}. Call list_statuses for valid names.`, { status: input });
    }
  }
  return {
    kinds,
    matches: (issue: Doc<'issues'>) => keyKinds.has(issue.status) || (issue.stateId !== undefined && stateIds.has(issue.stateId)),
  };
}

// ---------------------------------------------------------------- Knowledge

async function wikiTeamByKey(lookup: Lookup, key: string) {
  const team = await lookup.teamByKey(key);
  if (!team.wiki) fail('invalid', `Team ${team.key} has no knowledge area. The owner can switch it on in the team settings.`, { team: team.key });
  return team;
}

function articleIdOf(ctx: QueryCtx, raw: string): Id<'articles'> {
  const id = ctx.db.normalizeId('articles', raw);
  if (!id) fail('not_found', `Knowledge page ${raw} not found.`, { id: raw });
  return id;
}

/** Titles of the parent pages, topmost first. */
async function pathTitles(ctx: QueryCtx, parentId: Id<'articles'> | undefined) {
  const out: string[] = [];
  while (parentId && out.length < 20) {
    const parent = await ctx.db.get('articles', parentId);
    if (!parent) break;
    out.unshift(parent.title);
    parentId = parent.parentId;
  }
  return out;
}

async function searchArticlesTool(ctx: QueryCtx, args: ToolArgs['search_articles']) {
  const lookup = new Lookup(ctx);
  const team = args.team ? await lookup.teamByKey(args.team) : undefined;
  const hits = await searchArticles(ctx, { q: args.q, teamId: team?._id, limit: args.limit ?? 20 });
  const articles = [];
  for (const hit of hits) {
    const article = await ctx.db.get('articles', hit.id);
    const path = await pathTitles(ctx, article?.parentId);
    articles.push({
      id: hit.id,
      title: hit.title,
      team: (await lookup.team(hit.teamId))?.key ?? '?',
      ...(path.length ? { path } : {}),
      match: hit.match,
      ...(hit.snippet ? { snippet: hit.snippet } : {}),
    });
  }
  return { count: articles.length, articles };
}

async function listArticlesTool(ctx: QueryCtx, args: ToolArgs['list_articles']) {
  const lookup = new Lookup(ctx);
  const team = await wikiTeamByKey(lookup, args.team);
  const { articles, topics, truncated } = await listArticles(ctx, team._id);
  const topicName = new Map(topics.map((t) => [t._id, t.name]));
  const projectId = args.project ? await lookup.projectId(team, args.project) : undefined;
  let topicId: Id<'wikiTopics'> | undefined;
  if (args.topic) {
    const lower = args.topic.trim().toLowerCase();
    topicId = topics.find((t) => t.name.toLowerCase() === lower)?._id;
    if (!topicId) fail('not_found', `Unknown topic "${args.topic}" in team ${team.key}. Topics: ${topics.map((t) => t.name).join(', ') || 'none'}.`, { topic: args.topic });
  }
  // Tree order: parents before children, siblings by rank.
  const byParent = new Map<string, Doc<'articles'>[]>();
  const ids = new Set(articles.map((a) => a._id as string));
  for (const a of articles) {
    const key = a.parentId && ids.has(a.parentId) ? a.parentId : '';
    byParent.set(key, [...(byParent.get(key) ?? []), a]);
  }
  const ordered: Doc<'articles'>[] = [];
  const walk = (parent: string, depth: number) => {
    for (const a of (byParent.get(parent) ?? []).sort((x, y) => (x.rank < y.rank ? -1 : 1))) {
      ordered.push(a);
      if (depth < 50) walk(a._id, depth + 1);
    }
  };
  walk('', 0);
  const rows = [];
  for (const a of ordered) {
    if (projectId && a.projectId !== projectId) continue;
    if (topicId && !a.topicIds.includes(topicId)) continue;
    const project = await lookup.projectName(a.projectId);
    rows.push({
      id: a._id,
      title: a.title,
      parent: a.parentId ?? null,
      ...(project ? { project } : {}),
      ...(a.topicIds.length ? { topics: a.topicIds.map((id) => topicName.get(id) ?? '?') } : {}),
      updatedAt: iso(a.updatedAt),
    });
  }
  return {
    team: team.key,
    count: rows.length,
    ...(truncated ? { truncated: true } : {}),
    topics: topics.map((t) => ({ name: t.name, ...(t.archived ? { archived: true } : {}) })),
    articles: rows,
  };
}

async function getArticleTool(ctx: QueryCtx, args: ToolArgs['get_article']) {
  const lookup = new Lookup(ctx);
  const detail = await articleDetail(ctx, articleIdOf(ctx, args.id));
  if (!detail) fail('not_found', `Knowledge page ${args.id} not found.`, { id: args.id });
  const { article, body } = detail;
  const topics = article.topicIds.length
    ? (await ctx.db.query('wikiTopics').withIndex('by_team', (q) => q.eq('teamId', article.teamId)).take(500)).filter((t) => article.topicIds.includes(t._id))
    : [];
  const project = await lookup.projectName(article.projectId);
  const changedAt = Math.max(article.updatedAt, body.updatedAt);
  return {
    id: article._id,
    title: article.title,
    team: detail.team?.key ?? '?',
    ...(project ? { project } : {}),
    ...(topics.length ? { topics: topics.map((t) => t.name) } : {}),
    path: detail.path,
    children: detail.children.sort((a, b) => (a.rank < b.rank ? -1 : 1)).map((c) => ({ id: c.id, title: c.title })),
    markdown: body.markdown,
    version: body.version,
    sources: detail.sources.map((s) => ({
      ...(s.url ? { url: s.url } : {}),
      ...(s.title ? { title: s.title } : {}),
      ...(s.author ? { author: s.author } : {}),
      ...(s.publishedAt ? { publishedAt: s.publishedAt } : {}),
      accessedAt: s.accessedAt,
      ...(s.note ? { note: s.note } : {}),
    })),
    createdAt: iso(article.createdAt),
    createdBy: await lookup.actorName(article.createdBy),
    updatedAt: iso(changedAt),
    updatedBy: await lookup.actorName(body.updatedAt >= article.updatedAt ? body.updatedBy : article.updatedBy),
    ...(article.deletedAt !== undefined ? { deleted: true } : {}),
  };
}

/** Topics by name; unknown ones are created in the team. */
async function topicIdsByName(ctx: MutationCtx, actor: Actor, team: Doc<'teams'>, names: string[]) {
  const topics = await ctx.db.query('wikiTopics').withIndex('by_team', (q) => q.eq('teamId', team._id)).take(500);
  const ids: Id<'wikiTopics'>[] = [];
  const created: string[] = [];
  for (const name of names) {
    const found = topics.find((t) => t.name.toLowerCase() === name.trim().toLowerCase());
    if (found) {
      ids.push(found._id);
      continue;
    }
    const { topicId } = await createTopic(ctx, actor, { teamId: team._id, name });
    ids.push(topicId);
    created.push(name.trim());
  }
  return { ids, created };
}

async function createArticleTool(ctx: MutationCtx, actor: Actor, args: ToolArgs['create_article']) {
  return await idempotent(ctx, actor, args.requestId, 'mcp.create_article', { ...args }, async () => {
    const lookup = new Lookup(ctx);
    const team = await wikiTeamByKey(lookup, args.team);
    const parentId = args.parent ? articleIdOf(ctx, args.parent) : undefined;
    const projectId = args.project ? await lookup.projectId(team, args.project) : undefined;
    const topics = args.topics ? await topicIdsByName(ctx, actor, team, args.topics) : { ids: [], created: [] };
    const { articleId } = await createArticleCore(
      ctx,
      actor,
      { teamId: team._id, title: args.title, markdown: args.markdown, parentId, projectId, topicIds: topics.ids, sources: args.sources },
      Date.now(),
    );
    return { id: articleId, title: args.title, team: team.key, version: 1, ...(topics.created.length ? { createdTopics: topics.created } : {}) };
  });
}

async function updateArticleTool(ctx: MutationCtx, actor: Actor, args: ToolArgs['update_article']) {
  return await idempotent(ctx, actor, args.requestId, 'mcp.update_article', { ...args }, async () => {
    const lookup = new Lookup(ctx);
    const article = await getArticle(ctx, articleIdOf(ctx, args.id));
    const team = (await lookup.team(article.teamId))!;
    const now = Date.now();
    const changed: string[] = [];
    const topics = args.topics ? await topicIdsByName(ctx, actor, team, args.topics) : null;
    const projectId = args.project === undefined ? undefined : args.project === null ? null : await lookup.projectId(team, args.project);
    if (args.title !== undefined || projectId !== undefined || topics) {
      const result = await updateArticleCore(ctx, actor, { id: article._id, title: args.title, projectId, topicIds: topics?.ids }, now);
      if (result.changed) changed.push(...(['title', 'project', 'topics'] as const).filter((f) => args[f] !== undefined));
    }
    if (args.parent !== undefined) {
      const parentId = args.parent === null ? null : articleIdOf(ctx, args.parent);
      if ((parentId ?? undefined) !== article.parentId) {
        await moveArticle(ctx, actor, { id: article._id, parentId });
        changed.push('parent');
      }
    }
    let version: number | undefined;
    if (args.markdown !== undefined) {
      try {
        const result = await setArticleBodyCore(ctx, actor, { id: article._id, markdown: args.markdown, baseVersion: args.expectedVersion! }, now);
        version = result.version;
        if (result.changed) changed.push('markdown');
      } catch (error) {
        const data = (error as { data?: { code?: string; version?: number } }).data;
        if (data?.code !== 'conflict') throw error;
        fail('conflict', `The text changed since version ${args.expectedVersion} (now version ${data.version}). Nothing was written; read the page again with get_article.`, { id: article._id, version: data.version });
      }
    }
    if (args.append !== undefined) {
      version = (await appendArticleBodyCore(ctx, actor, { id: article._id, markdown: args.append }, now)).version;
      changed.push('append');
    }
    if (args.addSources) {
      await addSourcesCore(ctx, actor, { articleId: article._id, sources: args.addSources }, now);
      changed.push('sources');
    }
    return { id: article._id, changed, ...(version !== undefined ? { version } : {}), ...(topics?.created.length ? { createdTopics: topics.created } : {}) };
  });
}

/**
 * Runs a read tool (in a query, so Convex can cache the result). `today` (calendar day,
 * Europe/Berlin) is passed in rather than taken from Date.now(): this keeps the query
 * deterministic and the cache valid for exactly one day.
 */
export async function runReadTool(ctx: QueryCtx, tool: ToolName, args: unknown, today: string): Promise<unknown> {
  switch (tool) {
    case 'search_issues':
      return await searchIssues(ctx, args as ToolArgs['search_issues']);
    case 'list_issues':
      return await listIssues(ctx, args as ToolArgs['list_issues'], today);
    case 'get_issue':
      return await getIssueTool(ctx, args as ToolArgs['get_issue']);
    case 'get_current_sprint':
      return await getCurrentSprint(ctx);
    case 'list_teams':
      return await listTeams(ctx, args as ToolArgs['list_teams']);
    case 'list_projects':
      return await listProjects(ctx, args as ToolArgs['list_projects']);
    case 'list_labels':
      return await listLabels(ctx, args as ToolArgs['list_labels']);
    case 'search_articles':
      return await searchArticlesTool(ctx, args as ToolArgs['search_articles']);
    case 'list_articles':
      return await listArticlesTool(ctx, args as ToolArgs['list_articles']);
    case 'get_article':
      return await getArticleTool(ctx, args as ToolArgs['get_article']);
    case 'list_statuses':
      return await listStatuses(ctx, args as ToolArgs['list_statuses']);
    default:
      return fail('invalid', `${tool} is not a read tool.`);
  }
}

// ---------------------------------------------------------------- Writing

// Write tools with a requestId are wrapped ENTIRELY in `idempotent`, keyed on the agent's raw
// arguments (names, identifiers). A retry thus returns the stored result even if a name no
// longer resolves (e.g. the label was archived). The inner operations get the requestId only
// for the history.

async function createIssuesTool(ctx: MutationCtx, actor: Actor, args: ToolArgs['create_issues']) {
  return await idempotent(ctx, actor, args.requestId, 'mcp.create_issues', { ...args }, async () =>
    createIssuesToolCore(ctx, actor, args),
  );
}

async function createIssuesToolCore(ctx: MutationCtx, actor: Actor, args: ToolArgs['create_issues']) {
  const lookup = new Lookup(ctx);
  const issues: NewIssue[] = [];
  const dormant = new Set<string>();
  for (const item of args.issues) {
    const team = await lookup.teamByKey(item.team);
    if (team.wiki === 'only') fail('invalid', `Team ${team.key} holds knowledge only (no issues). Use create_article there, or pick another team (list_teams).`, { team: team.key });
    if (team.dormant) dormant.add(team.key);
    let parentId: Id<'issues'> | undefined;
    if (item.parent) {
      const parent = await issueByIdentifier(ctx, item.parent);
      parentId = parent._id;
    }
    // Without a status, agent issues land in triage so the owner reviews them.
    const triage = defaultState(await lookup.states(team._id), team.workflow, { triage: true });
    const state = item.status !== undefined ? await lookup.statusPatch(team, item.status) : triage ? { stateId: triage._id } : {};
    issues.push({
      teamId: team._id,
      title: item.title,
      ...state,
      ...(item.description !== undefined ? { description: item.description } : {}),
      ...(item.priority !== undefined ? { priority: item.priority } : {}),
      ...(item.labels ? { labelIds: await lookup.labelIds(team, item.labels) } : {}),
      ...(item.project ? { projectId: await lookup.projectId(team, item.project) } : {}),
      ...(item.estimate !== undefined ? { estimate: item.estimate } : {}),
      ...(item.dueDate ? { dueDate: item.dueDate } : {}),
      ...(parentId ? { parentId } : {}),
    });
  }
  const result = await createIssuesCore(ctx, actor, { issues, requestId: args.requestId });
  const created = [];
  const cleared = [];
  for (const { id, identifier, clearedPriority } of result.issues) {
    const issue = await ctx.db.get('issues', id);
    if (!issue) continue;
    const brief = await lookup.brief(issue);
    created.push(brief);
    if (clearedPriority !== undefined) cleared.push(priorityClearedWarning(identifier, clearedPriority, brief.statusType));
  }
  // Dormant teams: the issues are created anyway, but the agent is told (the owner rarely looks there).
  const dormantWarnings = [...dormant].map((key) => ({
    code: 'dormant_team' as const,
    team: key,
    message: `Team ${key} is dormant: the issues were created, but the owner rarely looks there. Check list_teams for an active team if this was not intended.`,
  }));
  return { created, warnings: [...(await englishWarnings(result.warnings, lookup)), ...cleared, ...dormantWarnings] };
}

const sameText = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

async function updateIssueTool(ctx: MutationCtx, actor: Actor, args: ToolArgs['update_issue']) {
  return await idempotent(ctx, actor, args.requestId, 'mcp.update_issue', { ...args }, async () => {
    const lookup = new Lookup(ctx);
    const issue = await issueByIdentifier(ctx, args.identifier);
    const identifier = await lookup.identifier(issue);
    assertNotDeleted(issue, identifier);
    const team = (await lookup.team(issue.teamId))!;
    const now = Date.now();

    // Check expected values: a field that has changed in the meantime is not written.
    const conflicts: { field: string; expected: unknown; actual: unknown }[] = [];
    const expected = args.expected ?? {};
    const currentLabels = await lookup.labelNames(issue.labelIds);
    const currentProject = await lookup.projectName(issue.projectId);
    const currentParent = issue.parentId ? await lookup.parentIdentifier(issue.parentId) : null;
    const check = (field: string, ok: boolean, exp: unknown, actual: unknown) => {
      if (!ok) conflicts.push({ field, expected: exp, actual });
    };
    if (expected.title !== undefined) check('title', expected.title.trim() === issue.title, expected.title, issue.title);
    if (expected.status !== undefined) {
      check('status', await lookup.statusMatches(issue, expected.status), expected.status, await lookup.statusName(issue));
    }
    if (expected.priority !== undefined) {
      check('priority', expected.priority === issue.priority, PRIORITY_NAMES[expected.priority], PRIORITY_NAMES[issue.priority]);
    }
    if (expected.labels !== undefined) {
      const want = [...new Set(expected.labels.map((l) => l.trim().toLowerCase()))].sort();
      const have = [...new Set(currentLabels.map((l) => l.toLowerCase()))].sort();
      check('labels', want.join('\n') === have.join('\n'), expected.labels, currentLabels);
    }
    if (expected.project !== undefined) {
      check('project', expected.project === null ? currentProject === null : sameText(expected.project, currentProject), expected.project, currentProject);
    }
    if (expected.estimate !== undefined) {
      check('estimate', (expected.estimate ?? null) === (issue.estimate ?? null), expected.estimate, issue.estimate ?? null);
    }
    if (expected.dueDate !== undefined) {
      check('dueDate', (expected.dueDate ?? null) === (issue.dueDate ?? null), expected.dueDate, issue.dueDate ?? null);
    }
    if (expected.parent !== undefined) {
      let ok = expected.parent === null ? issue.parentId === undefined : false;
      if (expected.parent !== null) {
        const parent = await resolveIssue(ctx, expected.parent);
        ok = parent !== null && parent._id === issue.parentId;
      }
      check('parent', ok, expected.parent, currentParent);
    }
    const blocked = new Set(conflicts.map((c) => c.field));

    const patch: IssuePatch = {};
    if (args.title !== undefined && !blocked.has('title')) patch.title = args.title;
    if (args.status !== undefined && !blocked.has('status')) Object.assign(patch, await lookup.statusPatch(team, args.status));
    if (args.priority !== undefined && !blocked.has('priority')) patch.priority = args.priority;
    if (args.labels !== undefined && !blocked.has('labels')) {
      patch.labelIds = await lookup.labelIds(team, args.labels, new Set(issue.labelIds));
    }
    if (args.project !== undefined && !blocked.has('project')) {
      patch.projectId = args.project === null ? null : await lookup.projectId(team, args.project);
    }
    if (args.estimate !== undefined && !blocked.has('estimate')) patch.estimate = args.estimate;
    if (args.dueDate !== undefined && !blocked.has('dueDate')) patch.dueDate = args.dueDate;
    if (args.parent !== undefined && !blocked.has('parent')) {
      patch.parentId = args.parent === null ? null : (await issueByIdentifier(ctx, args.parent))._id;
    }

    const before = issue;
    if (Object.keys(patch).length > 0) await applyPatch(ctx, actor, issue._id, patch, undefined, now, args.requestId);
    const after = (await ctx.db.get('issues', issue._id))!;
    const changed: string[] = [];
    const FIELD_NAMES = {
      title: 'title',
      stateId: 'status',
      priority: 'priority',
      labelIds: 'labels',
      projectId: 'project',
      estimate: 'estimate',
      dueDate: 'dueDate',
      parentId: 'parent',
    } as const;
    for (const [field, name] of Object.entries(FIELD_NAMES) as [keyof typeof FIELD_NAMES, string][]) {
      if (JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null)) changed.push(name);
    }

    let descriptionVersion: number | undefined;
    if (args.description !== undefined) {
      const body = await ctx.db.query('issueBodies').withIndex('by_issue', (q) => q.eq('issueId', issue._id)).unique();
      const current = body?.version ?? 0;
      if (current !== args.expectedDescriptionVersion) {
        conflicts.push({ field: 'description', expected: args.expectedDescriptionVersion, actual: current });
        descriptionVersion = current;
      } else {
        const result = await applyDescription(
          ctx,
          actor,
          { id: issue._id, markdown: args.description, baseVersion: current },
          now,
          args.requestId,
        );
        descriptionVersion = result.version;
        if (result.changed) changed.push('description');
      }
    }
    const warnings: unknown[] =
      changed.includes('priority') && (after.priority === 1 || after.priority === 2)
        ? await englishWarnings(await budgetWarnings(ctx, [{ teamId: after.teamId, priority: after.priority }]), lookup)
        : [];
    // Newly done/canceled/duplicate: if the agent set a priority or the issue had one, the result reports that it was dropped.
    const requested = patch.priority ?? before.priority;
    if (changed.includes('status') && after.priority === 0 && requested !== 0 && CLOSED_STATUSES.includes(after.status)) {
      warnings.push(priorityClearedWarning(identifier, requested, (await lookup.brief(after)).statusType));
    }
    return {
      identifier,
      changed,
      conflicts,
      ...(conflicts.length
        ? {
            message: `Not written because the value changed in the meantime: ${conflicts
              .map((c) => `${c.field} (expected ${JSON.stringify(c.expected)}, now ${JSON.stringify(c.actual)})`)
              .join(', ')}. Read the issue again (get_issue) and decide.`,
          }
        : {}),
      ...(descriptionVersion !== undefined ? { descriptionVersion } : {}),
      warnings,
      issue: await lookup.brief(after),
    };
  });
}

async function setStatusTool(ctx: MutationCtx, actor: Actor, args: ToolArgs['set_status']) {
  return await idempotent(ctx, actor, args.requestId, 'mcp.set_status', { ...args }, async () =>
    setStatusToolCore(ctx, actor, args),
  );
}

async function setStatusToolCore(ctx: MutationCtx, actor: Actor, args: ToolArgs['set_status']) {
  const lookup = new Lookup(ctx);
  const issues: Doc<'issues'>[] = [];
  const missing: string[] = [];
  for (const identifier of args.identifiers) {
    const issue = await resolveIssue(ctx, identifier);
    if (!issue) missing.push(identifier);
    else issues.push(issue);
  }
  if (missing.length) fail('not_found', `Issues not found: ${missing.join(', ')}. Nothing was changed.`, { missing });
  for (const issue of issues) assertNotDeleted(issue, await lookup.identifier(issue));
  const ids = [...new Set(issues.map((i) => i._id))];
  // Statuses belong to a team: resolve per team, then update once per distinct target.
  const groups = new Map<string, { patch: IssuePatch; ids: Id<'issues'>[] }>();
  for (const issue of issues) {
    const team = (await lookup.team(issue.teamId))!;
    const patch = await lookup.statusPatch(team, args.status);
    const key = JSON.stringify(patch);
    const group = groups.get(key) ?? { patch, ids: [] as Id<'issues'>[] };
    if (!group.ids.includes(issue._id)) group.ids.push(issue._id);
    groups.set(key, group);
  }
  let changed = 0;
  for (const group of groups.values()) {
    changed += (await updateIssuesCore(ctx, actor, { ids: group.ids, patch: group.patch, requestId: args.requestId })).changed;
  }
  const result = { changed };
  const after = [];
  const warnings = [];
  for (const id of ids) {
    const issue = await ctx.db.get('issues', id);
    if (!issue) continue;
    const brief = await lookup.brief(issue);
    after.push(brief);
    // `issues` is from before the change: if it had a priority and now has none, the rule removed it.
    const was = issues.find((i) => i._id === id)?.priority ?? 0;
    if (was !== 0 && issue.priority === 0 && CLOSED_STATUSES.includes(issue.status)) {
      warnings.push(priorityClearedWarning(String(brief.identifier), was, brief.statusType));
    }
  }
  return { status: args.status, changed: result.changed, ...(warnings.length ? { warnings } : {}), issues: after };
}

async function moveIssuesTool(ctx: MutationCtx, actor: Actor, args: ToolArgs['move_issues']) {
  return await idempotent(ctx, actor, args.requestId, 'mcp.move_issues', { ...args }, async () => {
    const lookup = new Lookup(ctx);
    const target = await lookup.teamByKey(args.team);
    if (target.wiki === 'only') fail('invalid', `Team ${target.key} holds knowledge only (no issues). Nothing was moved.`, { team: target.key });
    const found: Doc<'issues'>[] = [];
    const missing: string[] = [];
    for (const identifier of args.identifiers) {
      const issue = await resolveIssue(ctx, identifier);
      if (!issue) missing.push(identifier);
      else found.push(issue);
    }
    if (missing.length) fail('not_found', `Issues not found: ${missing.join(', ')}. Nothing was moved.`, { missing });
    for (const issue of found) assertNotDeleted(issue, await lookup.identifier(issue));
    const ids = [...new Set(found.map((i) => i._id))];
    const result = await moveIssuesToTeamCore(ctx, actor, { ids, teamId: target._id, requestId: args.requestId });
    const moved = result.moved.map((m) => ({
      previousIdentifier: m.previous,
      identifier: m.identifier,
      ...(m.statusTo !== undefined ? { status: m.statusTo, previousStatus: m.statusFrom ?? null } : {}),
      removed: {
        project: m.droppedProject ?? null,
        labels: m.droppedLabels,
      },
    }));
    const unchanged = [];
    for (const id of result.unchanged) {
      const issue = await ctx.db.get('issues', id);
      if (issue) unchanged.push(await lookup.identifier(issue));
    }
    const warnings = target.dormant
      ? [
          {
            code: 'dormant_team' as const,
            team: target.key,
            message: `Team ${target.key} is dormant: the issues were moved, but the owner rarely looks there. Check list_teams for an active team if this was not intended.`,
          },
        ]
      : [];
    return {
      team: target.key,
      moved,
      unchanged,
      note: 'Old identifiers keep resolving as aliases. The project was removed unless it belongs to the target team; labels of the old team were removed (workspace labels stay); the status is the matching status of the target team.',
      warnings,
    };
  });
}

async function addCommentTool(ctx: MutationCtx, actor: Actor, args: ToolArgs['add_comment']) {
  return await idempotent(ctx, actor, args.requestId, 'mcp.add_comment', { ...args }, async () => {
    const issue = await issueByIdentifier(ctx, args.identifier);
    const lookup = new Lookup(ctx);
    const identifier = await lookup.identifier(issue);
    assertNotDeleted(issue, identifier);
    const { commentId } = await addCommentCore(ctx, actor, { issueId: issue._id, body: args.body, requestId: args.requestId });
    return { identifier, commentId };
  });
}

export async function runWriteTool(ctx: MutationCtx, actor: Actor, tool: ToolName, args: unknown): Promise<unknown> {
  if (actor.kind !== 'agent') fail('access_denied', 'MCP tools run only as an agent.');
  switch (tool) {
    case 'create_issues':
      return await createIssuesTool(ctx, actor, args as ToolArgs['create_issues']);
    case 'update_issue':
      return await updateIssueTool(ctx, actor, args as ToolArgs['update_issue']);
    case 'set_status':
      return await setStatusTool(ctx, actor, args as ToolArgs['set_status']);
    case 'move_issues':
      return await moveIssuesTool(ctx, actor, args as ToolArgs['move_issues']);
    case 'add_comment':
      return await addCommentTool(ctx, actor, args as ToolArgs['add_comment']);
    case 'create_article':
      return await createArticleTool(ctx, actor, args as ToolArgs['create_article']);
    case 'update_article':
      return await updateArticleTool(ctx, actor, args as ToolArgs['update_article']);
    default:
      return fail('invalid', `${tool} is not a write tool.`);
  }
}

/** Removes `undefined` (Convex values do not support it) via a JSON round trip. */
export function plain<T>(value: T): T {
  return value === undefined ? (null as T) : (JSON.parse(JSON.stringify(value)) as T);
}

