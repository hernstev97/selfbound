// Made-up Linear snapshot (raw data as returned by the API) for import tests.
//
// Three teams (CODE, APIX, TOOL dormant), 60 issues with comments (including bots and
// replies), relations, parents, PR attachments, other attachments, cycles, previous
// identifiers and every status including Triage and Duplicate, plus one issue in the
// Linear trash. Deterministic, nothing in here comes from a real workspace.

import type {
  RawAttachment,
  RawComment,
  RawCycle,
  RawIssue,
  RawLabel,
  RawLinearData,
  RawProject,
  RawRelation,
  RawTeam,
  RawWorkflowState,
} from './queries.ts';

const conn = <T>(nodes: T[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
const BASE = Date.UTC(2026, 5, 1, 8); // 2026-06-01
const at = (hours: number) => new Date(BASE + hours * 3600_000).toISOString();

const TEAMS: RawTeam[] = [
  { id: 'syn-team-code', key: 'CODE', name: 'Code Workshop', color: '#5e6ad2', createdAt: at(0) },
  { id: 'syn-team-apix', key: 'APIX', name: 'API Lab', color: '#26b5ce', createdAt: at(1) },
  { id: 'syn-team-tool', key: 'TOOL', name: 'Toolbox', color: '#bec2c8', createdAt: at(2), archivedAt: at(500) },
];

const STATE_DEFS: [string, string][] = [
  ['Triage', 'triage'],
  ['Backlog', 'backlog'],
  ['Todo', 'unstarted'],
  ['In Progress', 'started'],
  ['In Review', 'started'],
  ['Done', 'completed'],
  ['Canceled', 'canceled'],
  ['Duplicate', 'canceled'],
];

const STATES: RawWorkflowState[] = TEAMS.flatMap((team, t) => [
  ...STATE_DEFS.map(([name, type], i) => ({
    id: `syn-state-${team.key}-${i}`,
    name,
    type,
    position: i,
    team: { id: team.id, key: team.key },
  })),
  // Custom status only in APIX: mapped by type (started → in_progress).
  ...(t === 1 ? [{ id: 'syn-state-APIX-testing', name: 'Testing', type: 'started', position: 9, team: { id: team.id, key: team.key } }] : []),
]);

const LABELS: RawLabel[] = [
  { id: 'syn-lg-art', name: 'Type', color: '#888888', isGroup: true, parent: null, team: null },
  { id: 'syn-l-bug', name: 'Bug', color: '#eb5757', isGroup: false, parent: { id: 'syn-lg-art' }, team: null },
  { id: 'syn-l-feature', name: 'Feature', color: '#bb87fc', isGroup: false, parent: { id: 'syn-lg-art' }, team: null },
  { id: 'syn-l-chore', name: 'Chore', color: '#4cb782', isGroup: false, parent: { id: 'syn-lg-art' }, team: null },
  { id: 'syn-l-agent', name: 'Agent', color: '#f2994a', isGroup: false, parent: null, team: null },
  { id: 'syn-l-backend', name: 'Backend', color: '#f2c94c', isGroup: false, parent: null, team: { id: 'syn-team-code' } },
  { id: 'syn-l-alt', name: 'Obsolete', color: '#95a2b3', isGroup: false, parent: null, team: null, archivedAt: at(300) },
];

const PROJECTS: RawProject[] = [
  {
    id: 'syn-p-parser',
    name: 'Parser',
    createdAt: at(3),
    startedAt: at(10),
    status: { id: 'syn-ps-1', name: 'In Progress', type: 'started' },
    teams: conn([{ id: 'syn-team-code', key: 'CODE' }]),
  },
  {
    id: 'syn-p-gateway',
    name: 'Gateway',
    createdAt: at(4),
    status: { id: 'syn-ps-2', name: 'Planned', type: 'planned' },
    teams: conn([
      { id: 'syn-team-apix', key: 'APIX' },
      { id: 'syn-team-code', key: 'CODE' },
    ]),
  },
  {
    id: 'syn-p-archiv',
    name: 'Archive',
    createdAt: at(5),
    completedAt: at(400),
    status: { id: 'syn-ps-3', name: 'Completed', type: 'completed' },
    teams: conn([{ id: 'syn-team-tool', key: 'TOOL' }]),
  },
];

/** Cycles: 14 days, starting Sundays 22:00 UTC (Monday 00:00 Berlin, summer time). */
const cycle = (team: RawTeam, number: number, startDay: number, name?: string): RawCycle => {
  const startsAt = new Date(Date.UTC(2026, 5, 1 + startDay, 22)).toISOString();
  const endsAt = new Date(Date.UTC(2026, 5, 15 + startDay, 22)).toISOString();
  return {
    id: `syn-cycle-${team.key}-${number}`,
    number,
    name: name ?? null,
    startsAt,
    endsAt,
    completedAt: endsAt,
    team: { id: team.id, key: team.key },
  };
};
const CYCLES: RawCycle[] = [
  cycle(TEAMS[0]!, 1, 6, 'Kickoff'),
  cycle(TEAMS[0]!, 2, 20),
  cycle(TEAMS[0]!, 3, 34),
  cycle(TEAMS[1]!, 1, 13),
  cycle(TEAMS[1]!, 2, 27),
];

// Status per issue (index within the team): about half open, a third done.
const STATUS_CYCLE = [5, 1, 2, 5, 3, 0, 5, 4, 2, 6, 5, 1, 7, 3, 5];

function comment(id: string, hours: number, kind: 'user' | 'bot' | 'reply', parent?: string): RawComment {
  return {
    id,
    body: kind === 'bot' ? `Automatic note ${id}: branch created.` : `Synthetic comment ${id} with **Markdown**.`,
    createdAt: at(hours),
    editedAt: kind === 'user' && hours % 3 === 0 ? at(hours + 1) : null,
    parent: parent ? { id: parent } : null,
    user: kind === 'bot' ? null : { id: 'syn-user', name: 'Owner', displayName: 'owner' },
    botActor: kind === 'bot' ? { id: 'syn-bot', name: 'GitHub' } : null,
  };
}

function prAttachment(id: string, repo: string, number: number, state: string, branch: string, hours: number): RawAttachment {
  return {
    id,
    url: `https://github.com/acme/${repo}/pull/${number}`,
    title: `PR #${number}`,
    sourceType: 'github',
    metadata: { status: state, branch, number },
    createdAt: at(hours),
  };
}

function buildIssues(): RawIssue[] {
  const issues: RawIssue[] = [];
  const counts = [30, 24, 6];
  let order = 0;
  TEAMS.forEach((team, t) => {
    for (let n = 1; n <= counts[t]!; n++) {
      const i = order++;
      const created = 20 + i * 7;
      const statusIndex = team.key === 'TOOL' ? (n % 3 === 0 ? 6 : 5) : STATUS_CYCLE[(n + t) % STATUS_CYCLE.length]!;
      const stateId =
        team.key === 'APIX' && n % 8 === 0 ? 'syn-state-APIX-testing' : `syn-state-${team.key}-${statusIndex}`;
      const state = STATES.find((s) => s.id === stateId)!;
      const done = state.type === 'completed';
      const canceled = state.type === 'canceled';
      const started = state.type === 'started' || done;
      const teamCycles = CYCLES.filter((c) => c.team.id === team.id);
      const labels = [
        ...(n % 3 === 0 ? ['syn-l-bug'] : n % 3 === 1 ? ['syn-l-feature'] : []),
        ...(n % 5 === 0 ? ['syn-l-agent'] : []),
        ...(team.key === 'CODE' && n % 4 === 0 ? ['syn-l-backend'] : []),
        ...(n === 11 ? ['syn-l-alt'] : []),
      ];
      const project =
        team.key === 'CODE' && n % 2 === 0 ? 'syn-p-parser' : team.key === 'APIX' && n % 3 !== 0 ? 'syn-p-gateway' : team.key === 'TOOL' ? 'syn-p-archiv' : null;
      const comments: RawComment[] = [];
      for (let c = 0; c < n % 5; c++) comments.push(comment(`syn-c-${team.key}-${n}-${c}`, created + 2 + c, c === 2 ? 'bot' : 'user'));
      if (n % 6 === 0 && comments.length) comments.push(comment(`syn-c-${team.key}-${n}-r`, created + 9, 'reply', comments[0]!.id));
      issues.push({
        id: `syn-issue-${team.key}-${n}`,
        identifier: `${team.key}-${n}`,
        number: n,
        title: `Synthetic issue ${team.key}-${n}`,
        description: n % 4 === 0 ? undefined : `## Goal\n\nMade-up description for ${team.key}-${n}.\n\n- Point one\n- Point two`,
        priority: [0, 1, 2, 3, 4, 3, 2, 4][n % 8]!,
        estimate: team.key === 'CODE' ? [1, 2, 3, 5, 8][n % 5] : undefined,
        dueDate: n % 7 === 0 ? `2026-10-${String(10 + (n % 15)).padStart(2, '0')}` : undefined,
        createdAt: at(created),
        updatedAt: at(created + 30),
        startedAt: started ? at(created + 5) : undefined,
        completedAt: done ? at(created + 20) : undefined,
        canceledAt: canceled ? at(created + 20) : undefined,
        archivedAt: team.key === 'TOOL' ? at(450) : undefined,
        trashed: false,
        previousIdentifiers: team.key === 'APIX' && n <= 3 ? [`COLD-${n}`] : team.key === 'TOOL' && n === 2 ? ['AALT-9'] : [],
        url: `https://linear.app/acme/issue/${team.key.toLowerCase()}-${n}`,
        team: { id: team.id, key: team.key },
        state: { id: state.id, name: state.name, type: state.type },
        project: project ? { id: project } : null,
        parent: n > 1 && n % 7 === 1 ? { id: `syn-issue-${team.key}-${n - 1}` } : null,
        cycle: teamCycles.length && n % 2 === 1 ? { id: teamCycles[n % teamCycles.length]!.id } : null,
        labels: conn(labels.map((id) => ({ id }))),
        attachments: conn([]),
        relations: conn([]),
        comments: conn(comments),
      });
    }
  });

  const find = (identifier: string) => issues.find((x) => x.identifier === identifier)!;
  const relation = (from: string, type: string, to: string, id: string) =>
    (find(from).relations.nodes as RawRelation[]).push({ id, type, relatedIssue: { id: find(to).id } });
  relation('CODE-2', 'blocks', 'CODE-3', 'syn-r-1');
  relation('CODE-5', 'related', 'APIX-4', 'syn-r-2');
  relation('APIX-10', 'blocks', 'APIX-11', 'syn-r-3');
  relation('CODE-12', 'similar', 'CODE-13', 'syn-r-4'); // Linear suggestion, not imported
  for (const issue of issues.filter((x) => x.state.name === 'Duplicate')) {
    const target = issues.find((x) => x.team.id === issue.team.id && x.number === issue.number - 1)!;
    relation(issue.identifier, 'duplicate', target.identifier, `syn-r-dup-${issue.identifier}`);
  }

  const attach = (identifier: string, a: RawAttachment) => (find(identifier).attachments.nodes as RawAttachment[]).push(a);
  attach('CODE-1', prAttachment('syn-a-1', 'workshop', 1, 'merged', 'octocat/code-1-start', 100));
  attach('CODE-4', prAttachment('syn-a-2', 'workshop', 2, 'open', 'octocat/code-4-parser', 120));
  attach('CODE-6', prAttachment('syn-a-3', 'workshop', 3, 'closed', 'octocat/code-6-x', 140));
  // One PR on two issues
  attach('APIX-2', prAttachment('syn-a-4', 'lab', 10, 'merged', 'octocat/apix-2-gateway', 160));
  attach('APIX-3', prAttachment('syn-a-5', 'lab', 10, 'merged', 'octocat/apix-2-gateway', 160));
  attach('APIX-7', prAttachment('syn-a-6', 'lab', 11, 'draft', 'octocat/apix-7', 180));
  attach('TOOL-1', prAttachment('syn-a-7', 'toolbox', 5, 'merged', 'octocat/tool-1', 200));
  attach('CODE-8', { id: 'syn-a-8', url: 'https://figma.com/file/example', title: 'Draft', sourceType: 'figma', metadata: {}, createdAt: at(210) });
  attach('CODE-8', { id: 'syn-a-9', url: 'https://example.com/note', title: 'Note', sourceType: null, metadata: null, createdAt: at(211) });

  // In the Linear trash: not imported.
  issues.push({
    ...find('CODE-30'),
    id: 'syn-issue-CODE-31',
    identifier: 'CODE-31',
    number: 31,
    trashed: true,
    relations: conn([]),
    attachments: conn([]),
    comments: conn([]),
  });
  return issues;
}

export function syntheticLinearData(): RawLinearData {
  return structuredClone({
    teams: TEAMS,
    workflowStates: STATES,
    labels: LABELS,
    projects: PROJECTS,
    cycles: CYCLES,
    issues: buildIssues(),
  });
}
