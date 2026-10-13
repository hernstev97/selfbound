// Queries to Linear (`query` only) and collecting all pages.
//
// Field names checked against Linear's public schema
// (github.com/linear/linear, packages/sdk/src/schema.graphql, as of 2026-10-08):
// the documents below validate without errors against it (test
// `linear-import/schema.test.ts`, runs with LINEAR_SCHEMA=<path to the file>).
// Open questions are listed in docs/architecture/import.md.
//
// No fragments: the read-only guard allows exactly one query definition per
// document, so shared field lists are interpolated as text.
//
// Complexity: Linear limits the complexity per request (nested connections
// multiply with `first`). Hence small issue pages (20) with 25 nested entries
// each; anything beyond is fetched per issue.

import type { Connection, LinearClient } from './client.ts';

export const ISSUE_PAGE_SIZE = 20;
export const NESTED_PAGE_SIZE = 25;
export const PAGE_SIZE = 50;

const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';

const TEAM_FIELDS = 'id key name color description createdAt archivedAt retiredAt';
const STATE_FIELDS = 'id name type position archivedAt team { id key }';
const LABEL_FIELDS = 'id name color description isGroup archivedAt retiredAt parent { id } team { id }';
const PROJECT_FIELDS = `id name description createdAt startedAt completedAt canceledAt archivedAt
  status { id name type }
  teams(first: 10) { nodes { id key } ${PAGE_INFO} }`;
const CYCLE_FIELDS = 'id number name description startsAt endsAt completedAt archivedAt team { id key }';

const LABEL_REF = `nodes { id } ${PAGE_INFO}`;
const ATTACHMENT_FIELDS = `nodes { id url title subtitle sourceType metadata createdAt } ${PAGE_INFO}`;
const RELATION_FIELDS = `nodes { id type relatedIssue { id } } ${PAGE_INFO}`;
const COMMENT_FIELDS = `nodes {
    id body createdAt editedAt
    parent { id }
    user { id name displayName }
    botActor { id name }
  } ${PAGE_INFO}`;

const ISSUE_FIELDS = `id identifier number title description priority estimate dueDate
  createdAt updatedAt startedAt completedAt canceledAt archivedAt trashed
  previousIdentifiers url
  team { id key }
  state { id name type }
  project { id }
  parent { id }
  cycle { id }
  labels(first: ${NESTED_PAGE_SIZE}) { ${LABEL_REF} }
  attachments(first: ${NESTED_PAGE_SIZE}) { ${ATTACHMENT_FIELDS} }
  relations(first: ${NESTED_PAGE_SIZE}) { ${RELATION_FIELDS} }
  comments(first: ${NESTED_PAGE_SIZE}) { ${COMMENT_FIELDS} }`;

export const QUERIES = {
  teams: `query XlrTeams($first: Int!, $after: String) {
    teams(first: $first, after: $after, includeArchived: true) { nodes { ${TEAM_FIELDS} } ${PAGE_INFO} }
  }`,
  workflowStates: `query XlrWorkflowStates($first: Int!, $after: String) {
    workflowStates(first: $first, after: $after, includeArchived: true) { nodes { ${STATE_FIELDS} } ${PAGE_INFO} }
  }`,
  issueLabels: `query XlrIssueLabels($first: Int!, $after: String) {
    issueLabels(first: $first, after: $after, includeArchived: true) { nodes { ${LABEL_FIELDS} } ${PAGE_INFO} }
  }`,
  projects: `query XlrProjects($first: Int!, $after: String) {
    projects(first: $first, after: $after, includeArchived: true) { nodes { ${PROJECT_FIELDS} } ${PAGE_INFO} }
  }`,
  cycles: `query XlrCycles($first: Int!, $after: String) {
    cycles(first: $first, after: $after, includeArchived: true) { nodes { ${CYCLE_FIELDS} } ${PAGE_INFO} }
  }`,
  issues: `query XlrIssues($first: Int!, $after: String) {
    issues(first: $first, after: $after, includeArchived: true, orderBy: createdAt) { nodes { ${ISSUE_FIELDS} } ${PAGE_INFO} }
  }`,
  issueLabelsMore: `query XlrIssueLabelsMore($id: String!, $first: Int!, $after: String) {
    issue(id: $id) { labels(first: $first, after: $after) { ${LABEL_REF} } }
  }`,
  issueAttachmentsMore: `query XlrIssueAttachmentsMore($id: String!, $first: Int!, $after: String) {
    issue(id: $id) { attachments(first: $first, after: $after) { ${ATTACHMENT_FIELDS} } }
  }`,
  issueRelationsMore: `query XlrIssueRelationsMore($id: String!, $first: Int!, $after: String) {
    issue(id: $id) { relations(first: $first, after: $after) { ${RELATION_FIELDS} } }
  }`,
  issueCommentsMore: `query XlrIssueCommentsMore($id: String!, $first: Int!, $after: String) {
    issue(id: $id) { comments(first: $first, after: $after) { ${COMMENT_FIELDS} } }
  }`,
  projectTeamsMore: `query XlrProjectTeamsMore($id: String!, $first: Int!, $after: String) {
    project(id: $id) { teams(first: $first, after: $after) { nodes { id key } ${PAGE_INFO} } }
  }`,
} as const;

// ---------------------------------------------------------------------------
// Raw data as Linear returns it (only the queried fields)

type Ref = { id: string } | null;

export interface RawTeam {
  id: string;
  key: string;
  name: string;
  color?: string | null;
  description?: string | null;
  createdAt: string;
  archivedAt?: string | null;
  retiredAt?: string | null;
}

export interface RawWorkflowState {
  id: string;
  name: string;
  type: string;
  position: number;
  archivedAt?: string | null;
  team: { id: string; key: string } | null;
}

export interface RawLabel {
  id: string;
  name: string;
  color?: string | null;
  description?: string | null;
  isGroup: boolean;
  archivedAt?: string | null;
  retiredAt?: string | null;
  parent: Ref;
  team: Ref;
}

export interface RawProject {
  id: string;
  name: string;
  description?: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  canceledAt?: string | null;
  archivedAt?: string | null;
  status: { id: string; name: string; type: string } | null;
  teams: Connection<{ id: string; key: string }>;
}

export interface RawCycle {
  id: string;
  number: number;
  name?: string | null;
  description?: string | null;
  startsAt: string;
  endsAt: string;
  completedAt?: string | null;
  archivedAt?: string | null;
  team: { id: string; key: string };
}

export interface RawAttachment {
  id: string;
  url: string;
  title: string;
  subtitle?: string | null;
  sourceType?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export interface RawRelation {
  id: string;
  type: string;
  relatedIssue: Ref;
}

export interface RawComment {
  id: string;
  body: string;
  createdAt: string;
  editedAt?: string | null;
  parent: Ref;
  user: { id: string; name: string; displayName?: string | null } | null;
  botActor: { id?: string | null; name?: string | null } | null;
}

export interface RawIssue {
  id: string;
  identifier: string;
  number: number;
  title: string;
  description?: string | null;
  priority: number;
  estimate?: number | null;
  dueDate?: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  canceledAt?: string | null;
  archivedAt?: string | null;
  trashed?: boolean | null;
  previousIdentifiers: string[];
  url?: string | null;
  team: { id: string; key: string };
  state: { id: string; name: string; type: string };
  project: Ref;
  parent: Ref;
  cycle: Ref;
  labels: Connection<{ id: string }>;
  attachments: Connection<RawAttachment>;
  relations: Connection<RawRelation>;
  comments: Connection<RawComment>;
}

export interface RawLinearData {
  teams: RawTeam[];
  workflowStates: RawWorkflowState[];
  labels: RawLabel[];
  projects: RawProject[];
  cycles: RawCycle[];
  issues: RawIssue[];
}

type Picker<K extends string, T> = (data: Record<K, Connection<T> | null>) => Connection<T> | null;
const pick =
  <K extends string, T>(key: K): Picker<K, T> =>
  (data) =>
    data[key];

/** Loads a nested connection completely when the first page was not enough. */
async function completeNested<T>(
  client: LinearClient,
  first: Connection<T>,
  document: string,
  owner: 'issue' | 'project',
  field: string,
  id: string,
): Promise<Connection<T>> {
  if (!first.pageInfo.hasNextPage) return first;
  const nodes = [...first.nodes];
  let after = first.pageInfo.endCursor ?? null;
  for (;;) {
    const data = await client.query<Record<string, Record<string, Connection<T>> | null>>(document, {
      id,
      first: PAGE_SIZE,
      after,
    });
    const connection = data[owner]?.[field];
    if (!connection) break;
    nodes.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor || connection.pageInfo.endCursor === after) break;
    after = connection.pageInfo.endCursor;
  }
  return { nodes, pageInfo: { hasNextPage: false, endCursor: null } };
}

export interface FetchProgress {
  (step: string, count: number): void;
}

/** Fetches all data the import needs. Reports only counts through `progress`. */
export async function fetchLinearData(client: LinearClient, progress: FetchProgress = () => {}): Promise<RawLinearData> {
  const teams = await client.paginate(QUERIES.teams, {}, pick<'teams', RawTeam>('teams'), PAGE_SIZE);
  progress('Teams', teams.length);
  const workflowStates = await client.paginate(
    QUERIES.workflowStates,
    {},
    pick<'workflowStates', RawWorkflowState>('workflowStates'),
    PAGE_SIZE,
  );
  progress('Statuses', workflowStates.length);
  const labels = await client.paginate(QUERIES.issueLabels, {}, pick<'issueLabels', RawLabel>('issueLabels'), PAGE_SIZE);
  progress('Labels', labels.length);
  const projects = await client.paginate(QUERIES.projects, {}, pick<'projects', RawProject>('projects'), PAGE_SIZE);
  for (const p of projects) p.teams = await completeNested(client, p.teams, QUERIES.projectTeamsMore, 'project', 'teams', p.id);
  progress('Projects', projects.length);
  const cycles = await client.paginate(QUERIES.cycles, {}, pick<'cycles', RawCycle>('cycles'), PAGE_SIZE);
  progress('Cycles', cycles.length);
  const issues = await client.paginate(QUERIES.issues, {}, pick<'issues', RawIssue>('issues'), ISSUE_PAGE_SIZE);
  for (const issue of issues) {
    issue.labels = await completeNested(client, issue.labels, QUERIES.issueLabelsMore, 'issue', 'labels', issue.id);
    issue.attachments = await completeNested(client, issue.attachments, QUERIES.issueAttachmentsMore, 'issue', 'attachments', issue.id);
    issue.relations = await completeNested(client, issue.relations, QUERIES.issueRelationsMore, 'issue', 'relations', issue.id);
    issue.comments = await completeNested(client, issue.comments, QUERIES.issueCommentsMore, 'issue', 'comments', issue.id);
  }
  progress('Issues', issues.length);
  return { teams, workflowStates, labels, projects, cycles, issues };
}
