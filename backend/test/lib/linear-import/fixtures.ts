// Made-up Linear data (small team examples) and a fake Linear server.
// Nothing in here comes from a real workspace.

import { graphql } from '../../../../tooling/linear-import/graphql.ts';
import { NESTED_PAGE_SIZE } from '../../../../tooling/linear-import/queries.ts';
import type {
  RawComment,
  RawCycle,
  RawIssue,
  RawLabel,
  RawLinearData,
  RawProject,
  RawTeam,
  RawWorkflowState,
} from '../../../../tooling/linear-import/queries.ts';

export const SECRET_TEXT = 'SECRET-CONTENT';

const t = (day: number, hour = 9) => new Date(Date.UTC(2026, 8, day, hour)).toISOString();
const conn = <T>(nodes: T[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });

export const TEAMS: RawTeam[] = [
  { id: 'team-kiu', key: 'KIU', name: 'Acme App', color: '#5e6ad2', description: null, createdAt: t(1), archivedAt: null, retiredAt: null },
  { id: 'team-xlr', key: 'XLR', name: 'XLR8', color: '#26b5ce', description: 'Tracker', createdAt: t(2), archivedAt: null, retiredAt: null },
  { id: 'team-old', key: 'OLD', name: 'Legacy project', color: null, description: null, createdAt: t(1), archivedAt: t(3), retiredAt: null },
];

const st = (id: string, team: RawTeam, name: string, type: string, position: number): RawWorkflowState => ({
  id,
  name,
  type,
  position,
  archivedAt: null,
  team: { id: team.id, key: team.key },
});
export const STATES: RawWorkflowState[] = [
  st('s-tri', TEAMS[0]!, 'Triage', 'triage', 0),
  st('s-back', TEAMS[0]!, 'Backlog', 'backlog', 1),
  st('s-todo', TEAMS[0]!, 'Todo', 'unstarted', 2),
  st('s-prog', TEAMS[0]!, 'In Progress', 'started', 3),
  st('s-rev', TEAMS[0]!, 'In Review', 'started', 4),
  st('s-done', TEAMS[0]!, 'Done', 'completed', 5),
  st('s-canc', TEAMS[0]!, 'Canceled', 'canceled', 6),
  st('s-dup', TEAMS[0]!, 'Duplicate', 'duplicate', 7), // how Linear returns "Duplicate" today
  st('s-xtodo', TEAMS[1]!, 'Todo', 'unstarted', 0),
  st('s-xtest', TEAMS[1]!, 'Testing', 'started', 1),
];
const state = (id: string) => {
  const s = STATES.find((x) => x.id === id)!;
  return { id: s.id, name: s.name, type: s.type };
};

export const LABELS: RawLabel[] = [
  { id: 'lg-type', name: 'Type', color: '#888888', description: null, isGroup: true, archivedAt: null, retiredAt: null, parent: null, team: null },
  { id: 'l-bug', name: 'Bug', color: '#eb5757', description: null, isGroup: false, archivedAt: null, retiredAt: null, parent: { id: 'lg-type' }, team: null },
  { id: 'l-feat', name: 'Feature', color: '#bb87fc', description: null, isGroup: false, archivedAt: null, retiredAt: null, parent: { id: 'lg-type' }, team: null },
  { id: 'l-agent', name: 'Agent', color: '#4cb782', description: null, isGroup: false, archivedAt: null, retiredAt: null, parent: null, team: null },
  { id: 'l-ui', name: 'UI', color: '#f2c94c', description: null, isGroup: false, archivedAt: t(4), retiredAt: null, parent: null, team: { id: 'team-kiu' } },
];

export const PROJECTS: RawProject[] = [
  {
    id: 'p-mvp',
    name: 'MVP',
    description: SECRET_TEXT,
    createdAt: t(2),
    startedAt: t(3),
    completedAt: null,
    canceledAt: null,
    archivedAt: null,
    status: { id: 'ps-1', name: 'In Progress', type: 'started' },
    teams: conn([{ id: 'team-xlr', key: 'XLR' }]),
  },
  {
    id: 'p-web',
    name: 'Website',
    description: null,
    createdAt: t(2),
    startedAt: null,
    completedAt: t(20),
    canceledAt: null,
    archivedAt: null,
    status: { id: 'ps-2', name: 'Completed', type: 'completed' },
    teams: conn([
      { id: 'team-xlr', key: 'XLR' },
      { id: 'team-kiu', key: 'KIU' },
    ]),
  },
];

export const CYCLES: RawCycle[] = [
  {
    id: 'c-2',
    number: 2,
    name: null,
    description: null,
    startsAt: '2026-09-14T22:00:00.000Z',
    endsAt: '2026-09-28T22:00:00.000Z',
    completedAt: '2026-09-28T22:00:00.000Z',
    archivedAt: null,
    team: { id: 'team-kiu', key: 'KIU' },
  },
  {
    id: 'c-1',
    number: 1,
    name: 'Start',
    description: null,
    startsAt: '2026-08-31T22:00:00.000Z',
    endsAt: '2026-09-14T22:00:00.000Z',
    completedAt: '2026-09-14T22:00:00.000Z',
    archivedAt: null,
    team: { id: 'team-kiu', key: 'KIU' },
  },
];

const comment = (id: string, day: number, extra: Partial<RawComment> = {}): RawComment => ({
  id,
  body: `${SECRET_TEXT} comment ${id}`,
  createdAt: t(day, 10),
  editedAt: null,
  parent: null,
  user: { id: 'u-owner', name: 'Owner', displayName: 'owner' },
  botActor: null,
  ...extra,
});

function issue(id: string, identifier: string, day: number, stateId: string, extra: Partial<RawIssue> = {}): RawIssue {
  const [key, n] = identifier.split('-');
  const team = TEAMS.find((x) => x.key === key)!;
  return {
    id,
    identifier,
    number: Number(n),
    title: `${SECRET_TEXT} title ${identifier}`,
    description: `${SECRET_TEXT} description`,
    priority: 0,
    estimate: null,
    dueDate: null,
    createdAt: t(day),
    updatedAt: t(day + 1),
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    archivedAt: null,
    trashed: false,
    previousIdentifiers: [],
    url: `https://linear.app/acme/issue/${identifier.toLowerCase()}`,
    team: { id: team.id, key: team.key },
    state: state(stateId),
    project: null,
    parent: null,
    cycle: null,
    labels: conn([]),
    attachments: conn([]),
    relations: conn([]),
    comments: conn([]),
    ...extra,
  };
}

/** 30 comments: more than one nested page (25). */
const manyComments = Array.from({ length: 30 }, (_, i) => comment(`cm-${i + 1}`, 6 + (i % 3)));

export const ISSUES: RawIssue[] = [
  // deliberately not sorted by createdAt
  issue('i-2', 'KIU-2', 6, 's-rev', {
    priority: 2,
    estimate: 3,
    dueDate: '2026-10-20',
    labels: conn([{ id: 'l-bug' }, { id: 'l-ui' }]),
    project: { id: 'p-web' },
    parent: { id: 'i-1' },
    cycle: { id: 'c-2' },
    startedAt: t(7),
    previousIdentifiers: ['OLD-7', 'KIU-2'],
    comments: conn(manyComments),
    relations: conn([
      { id: 'r-1', type: 'blocks', relatedIssue: { id: 'i-3' } },
      { id: 'r-2', type: 'similar', relatedIssue: { id: 'i-1' } },
      { id: 'r-3', type: 'related', relatedIssue: { id: 'i-gone' } },
    ]),
    attachments: conn([
      {
        id: 'a-pr',
        url: 'https://github.com/acme/app/pull/42',
        title: 'Search field #42',
        subtitle: null,
        sourceType: 'github',
        metadata: { status: 'merged', branch: 'octocat/kiu-2-search-field', number: 42 },
        createdAt: t(8),
      },
      {
        id: 'a-pr-dup',
        url: 'https://github.com/acme/app/pull/42/files',
        title: 'Search field #42',
        subtitle: null,
        sourceType: 'github',
        metadata: {},
        createdAt: t(8),
      },
      {
        id: 'a-link',
        url: 'https://figma.com/file/abc',
        title: 'Draft',
        subtitle: null,
        sourceType: 'figma',
        metadata: {},
        createdAt: t(8),
      },
    ]),
  }),
  issue('i-1', 'KIU-1', 5, 's-done', {
    priority: 1,
    completedAt: t(9),
    cycle: { id: 'c-1' },
    comments: conn([
      comment('cb-1', 9, { user: null, botActor: { id: 'bot-gh', name: 'GitHub' } }),
      comment('cr-1', 9, { parent: { id: 'cb-1' } }),
    ]),
  }),
  issue('i-3', 'KIU-3', 7, 's-dup', { canceledAt: t(9), relations: conn([{ id: 'r-4', type: 'duplicate', relatedIssue: { id: 'i-1' } }]) }),
  issue('i-4', 'XLR-1', 8, 's-xtest', {
    project: { id: 'p-mvp' },
    labels: conn([{ id: 'l-agent' }, { id: 'l-unknown' }]),
    attachments: conn([
      {
        id: 'a-pr2',
        url: 'https://github.com/acme/xlr8/pull/7',
        title: 'Import',
        subtitle: null,
        sourceType: 'githubPr',
        metadata: { foo: 'bar' },
        createdAt: t(9),
      },
    ]),
  }),
  issue('i-5', 'XLR-2', 8, 's-xtodo', { trashed: true }),
  issue('i-6', 'KIU-4', 9, 's-tri', { archivedAt: t(12), parent: { id: 'i-5' } }),
  issue('i-7', 'KIU-5', 9, 's-back'),
  issue('i-8', 'KIU-6', 10, 's-canc'),
];

export function rawData(): RawLinearData {
  return structuredClone({
    teams: TEAMS,
    workflowStates: STATES,
    labels: LABELS,
    projects: PROJECTS,
    cycles: CYCLES,
    issues: ISSUES,
  });
}

// ---------------------------------------------------------------------------
// Fake Linear: answers the import queries page by page from the fixtures.

export interface FakeLinearOptions {
  /** Responses before the actual answer, e.g. a rate limit. */
  before?: (operation: string, call: number) => Response | undefined;
  data?: RawLinearData;
}

export interface FakeLinear {
  fetch: typeof fetch;
  calls: { operation: string; kind: string; auth: string | null; variables: Record<string, unknown> }[];
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function page<T>(items: T[], first: number, after: unknown) {
  const start = after ? Number(after) : 0;
  const nodes = items.slice(start, start + first);
  const end = start + nodes.length;
  return { nodes, pageInfo: { hasNextPage: end < items.length, endCursor: end < items.length ? String(end) : null } };
}

const truncate = <T>(c: { nodes: T[] }) => page(c.nodes, NESTED_PAGE_SIZE, null);

export function fakeLinear(options: FakeLinearOptions = {}): FakeLinear {
  const data = options.data ?? rawData();
  const calls: FakeLinear['calls'] = [];
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const doc = graphql.parse(body.query);
    const def = doc.definitions[0] as { operation: string; name?: { value: string } };
    const operation = def.name?.value ?? '?';
    const headers = new Headers(init?.headers);
    calls.push({ operation, kind: def.operation, auth: headers.get('authorization'), variables: body.variables });
    const early = options.before?.(operation, calls.length);
    if (early) return early;
    const { first, after, id } = body.variables as { first: number; after?: string | null; id?: string };
    const issueById = (x: string) => data.issues.find((i) => i.id === x)!;
    switch (operation) {
      case 'XlrTeams':
        return json({ data: { teams: page(data.teams, first, after) } });
      case 'XlrWorkflowStates':
        return json({ data: { workflowStates: page(data.workflowStates, first, after) } });
      case 'XlrIssueLabels':
        return json({ data: { issueLabels: page(data.labels, first, after) } });
      case 'XlrProjects':
        return json({ data: { projects: page(data.projects, first, after) } });
      case 'XlrCycles':
        return json({ data: { cycles: page(data.cycles, first, after) } });
      case 'XlrIssues': {
        const p = page(data.issues, first, after);
        const nodes = p.nodes.map((i) => ({
          ...i,
          labels: truncate(i.labels),
          attachments: truncate(i.attachments),
          relations: truncate(i.relations),
          comments: truncate(i.comments),
        }));
        return json({ data: { issues: { ...p, nodes } } });
      }
      case 'XlrIssueCommentsMore':
        return json({ data: { issue: { comments: page(issueById(id!).comments.nodes, first, after) } } });
      case 'XlrIssueLabelsMore':
        return json({ data: { issue: { labels: page(issueById(id!).labels.nodes, first, after) } } });
      case 'XlrIssueAttachmentsMore':
        return json({ data: { issue: { attachments: page(issueById(id!).attachments.nodes, first, after) } } });
      case 'XlrIssueRelationsMore':
        return json({ data: { issue: { relations: page(issueById(id!).relations.nodes, first, after) } } });
      default:
        return json({ errors: [{ message: `unknown operation ${operation}` }] }, 400);
    }
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

export { json as jsonResponse };
