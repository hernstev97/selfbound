// Synthetic test data. Everything is made up: teams, titles, texts, agent names.
// Same seed → same dataset, so performance runs stay comparable.
//
// Runs in Node (seed script, Node type stripping) and in Vitest. Hence only imports
// with a file extension, from files without imports of their own.

import { generateNKeysBetween } from 'fractional-indexing';
import { berlinDay, nextMonthDay, nextWeekday } from '../convex/lib/dates.ts';
import { OWNER_KIND } from '../convex/shared/constants.ts';

export type GenStatus = 'triage' | 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'canceled' | 'duplicate';
export type GenPriority = 0 | 1 | 2 | 3 | 4;
/** Actor in the dataset; agent = index into `agents`. */
export type GenActor = { kind: typeof OWNER_KIND } | { kind: 'agent'; agent: number } | { kind: 'system' };

export interface GenTeam {
  key: string;
  name: string;
  hue: number;
  dormant: boolean;
  order: number;
  /** Only some teams use estimates. */
  estimates: boolean;
}
export interface GenLabelGroup {
  name: string;
  exclusive: boolean;
  hue: number;
}
export interface GenLabel {
  name: string;
  hue: number;
  group?: string;
  teamKey?: string;
}
export interface GenProject {
  teamKey: string;
  name: string;
  state: 'planned' | 'active' | 'paused' | 'done' | 'canceled';
  order: number;
}
export interface GenAgent {
  name: string;
  /** Key usable only locally; seeding stores only its hash. */
  key: string;
}
export interface GenSprint {
  number: number;
  name: string;
  goal: string;
  startDate: string;
  endDate: string;
  state: 'planning' | 'active' | 'closed';
  capacity?: number;
  startedAt?: number;
  closedAt?: number;
}
export interface GenSprintItem {
  sprint: number;
  kind: 'planned' | 'late';
  carriedFrom?: number;
  addedAt: number;
  addedBy: GenActor;
  removedAt?: number;
  outcome?: 'done' | 'next' | 'backlog' | 'canceled';
}
export interface GenComment {
  author: GenActor;
  body: string;
  createdAt: number;
}
export interface GenHistory {
  field: string;
  from?: string | number;
  to?: string | number | Record<string, string | number>;
  actor: GenActor;
  at: number;
}
export interface GenIssue {
  seq: number;
  teamKey: string;
  number: number;
  title: string;
  status: GenStatus;
  priority: GenPriority;
  labels: string[];
  project?: string;
  estimate?: number;
  dueDate?: string;
  parentSeq?: number;
  /** Sprint number of the open entry (invariant: issue.sprintId ⇔ open entry). */
  sprint?: number;
  rank: string;
  createdBy: GenActor;
  reviewedAt?: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  canceledAt?: number;
  deletedAt?: number;
  description: string;
  comments: GenComment[];
  sprintItems: GenSprintItem[];
  history: GenHistory[];
}
export interface GenRelation {
  fromSeq: number;
  toSeq: number;
  type: 'blocks' | 'related' | 'duplicate';
  createdAt: number;
  createdBy: GenActor;
}
export interface GenRecurrence {
  teamKey: string;
  title: string;
  description: string;
  priority: GenPriority;
  labels: string[];
  cadence: 'weekly' | 'monthly';
  weekday?: number;
  monthDay?: number;
  nextDate: string;
}
export interface GenDataset {
  set: DatasetName;
  count: number;
  teams: GenTeam[];
  labelGroups: GenLabelGroup[];
  labels: GenLabel[];
  projects: GenProject[];
  agents: GenAgent[];
  sprints: GenSprint[];
  issues: GenIssue[];
  relations: GenRelation[];
  recurrences: GenRecurrence[];
  /** Old identifiers (e.g. from a renamed team key). */
  aliases: { key: string; seq: number }[];
}

export const DATASETS = {
  small: { count: 440, seed: 11 },
  large: { count: 10_000, seed: 23 },
} as const;
export type DatasetName = keyof typeof DATASETS;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
/** Fixed reference time (Thursday, 2026-10-08, 12:00 UTC). */
export const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Made-up teams: keys of 2–6 characters, 3 of them dormant.
export const TEAMS: GenTeam[] = [
  { key: 'ORB', name: 'Orbit', hue: 255, dormant: false, order: 0, estimates: true },
  { key: 'NOVA', name: 'Nova', hue: 190, dormant: false, order: 1, estimates: false },
  { key: 'PX', name: 'Pixelworks', hue: 330, dormant: false, order: 2, estimates: true },
  { key: 'FLUX', name: 'Flux', hue: 35, dormant: false, order: 3, estimates: false },
  { key: 'KITE', name: 'Kite', hue: 145, dormant: false, order: 4, estimates: false },
  { key: 'ZEN', name: 'Zenith', hue: 15, dormant: false, order: 5, estimates: true },
  { key: 'MOSAIK', name: 'Mosaik', hue: 290, dormant: false, order: 6, estimates: false },
  { key: 'RIFF', name: 'Riff', hue: 215, dormant: true, order: 7, estimates: false },
  { key: 'LUMA', name: 'Luma', hue: 70, dormant: true, order: 8, estimates: false },
  { key: 'QB', name: 'Quartzbase', hue: 170, dormant: true, order: 9, estimates: false },
];
const TEAM_WEIGHTS = [20, 17, 15, 12, 10, 8, 6, 5, 4, 3];

const LABEL_GROUPS: GenLabelGroup[] = [
  { name: 'Type', exclusive: true, hue: 25 },
  { name: 'Area', exclusive: false, hue: 200 },
];

const LABELS: GenLabel[] = [
  { name: 'Bug', hue: 25, group: 'Type' },
  { name: 'Feature', hue: 265, group: 'Type' },
  { name: 'Improvement', hue: 200, group: 'Type' },
  { name: 'Research', hue: 180, group: 'Type' },
  { name: 'Design', hue: 310, group: 'Area' },
  { name: 'Docs', hue: 90, group: 'Area' },
  { name: 'Performance', hue: 55, group: 'Area' },
  { name: 'Security', hue: 350, group: 'Area' },
  { name: 'Data', hue: 130, group: 'Area' },
  { name: 'Mobile', hue: 160, group: 'Area' },
  { name: 'Agent', hue: 230 },
  { name: 'Tech debt', hue: 0 },
  { name: 'Release', hue: 45, teamKey: 'ORB' },
];
const TYPE_LABELS = ['Bug', 'Feature', 'Improvement', 'Research'];
const OTHER_LABELS = ['Design', 'Docs', 'Performance', 'Security', 'Data', 'Mobile', 'Agent', 'Tech debt'];

// Keys have the length of real agent keys (48 characters) and work only against a local backend.
const AGENTS: GenAgent[] = [
  { name: 'Codex', key: 'xlr8_seed_codex_local_only_000000000000000000000' },
  { name: 'Claude Code', key: 'xlr8_seed_claudecode_local_only_0000000000000000' },
];

const PROJECT_WORDS = [
  'Relaunch', 'Import', 'Search', 'Onboarding', 'Sync', 'Billing', 'Dashboard', 'Export', 'Notifications',
  'Offline', 'Accessibility', 'Agent API', 'Sprint planning', 'Logos',
];

const SUBJECTS = [
  'sync error', 'filter bar', 'command menu', 'issue list', 'board column', 'peek preview', 'search index',
  'undo stack', 'keyboard shortcut', 'status change', 'priority budget', 'team logo', 'sprint goal',
  'backlog sorting', 'CSV import', 'JSON export', 'webhook signature', 'MCP endpoint', 'agent comment',
  'history view', 'empty state', 'toast message', 'dark mode', 'font size', 'context menu', 'multi-select',
  'label group', 'project header', 'due date', 'estimate points', 'cold start', 'IndexedDB cache',
  'WebSocket connection', 'rate limit', 'duplicate guard', 'recurring task', 'PR link', 'branch name',
  'sidebar', 'breadcrumb', 'scroll position', 'focus ring', 'sign-in page', 'invite link', 'backup job',
  'database index', 'migration script', 'error message', 'loading state', 'tooltip', 'Markdown preview',
  'image upload', 'time zone', 'language switch', 'print view', 'triage inbox', 'notification',
  'phone layout', 'help overlay', 'shortcut overview',
];

const VERBS = [
  'Fix', 'Rework', 'Speed up', 'Simplify', 'Extend', 'Test', 'Measure', 'Document', 'Rebuild', 'Clean up',
  'Review', 'Rename', 'Remove', 'Harden', 'Unify', 'Preload', 'Cache', 'Migrate', 'Improve accessibility of',
  'Add agent support for', 'Fix mobile layout of', 'Localize', 'Stabilize', 'Add logging to',
];

const QUALIFIERS = [
  'with 10,000 issues', 'in dark mode', 'after restart', 'offline', 'on slow connections',
  'for dormant teams', 'on the board', 'in the list', 'after undo', 'with multi-select', 'on phones',
  'in Firefox', 'after agent changes', 'on first launch', 'with the keyboard', 'in search',
  'with empty filters', 'for new teams', 'in the sprint', 'during import',
];

const SENTENCES = [
  'When switching views quickly, focus sometimes jumps to the top of the list.',
  'The change should show immediately and be saved in the background afterwards.',
  'An agent created several entries here in quick succession.',
  'Please measure with the large test dataset first, otherwise we will not know whether it helps.',
  'The current solution reloads all data even though only one field changed.',
  'In dark mode the sidebar contrast is too weak.',
  'The behaviour should follow the pattern from the UX guide.',
  'If the server rejects the change, the old value has to visibly snap back.',
  'Still open: should this also apply to dormant teams?',
  'The measurement shows an outlier on the first open after launch.',
  'Keyboard users still need a shortcut in the command menu.',
  'After a reload the same view should appear with the same filters.',
  'The hint must not get in the way while everything runs normally.',
  'A small solution is enough here; a dedicated system would be too much.',
  'The import must be repeatable without creating duplicates.',
  'The list should stay smooth even while an arrow key is held down.',
  'There is a conflict when two devices change the same field at the same time.',
  'The description is long, so load it only when the issue is opened.',
  'A screenshot of the current state is attached to the last comment.',
  'The shortcut collides with a default browser function.',
];

const HEADINGS = [
  'Goal', 'Context', 'Proposal', 'Acceptance', 'Open questions', 'Notes',
];

// Status distribution of a real small tracker (438 issues: 244 open, 148 done,
// 32 canceled, 14 duplicates). Open ones split roughly.
const STATUS_SHARES: [GenStatus, number][] = [
  ['triage', 12],
  ['backlog', 104],
  ['todo', 70],
  ['in_progress', 40],
  ['in_review', 18],
  ['done', 148],
  ['canceled', 32],
  ['duplicate', 14],
];
const OPEN: GenStatus[] = ['triage', 'backlog', 'todo', 'in_progress', 'in_review'];

// Sprints relative to NOW (Thursday 2026-10-08): 3 closed, 1 active since Monday, 1 in planning.
const SPRINTS: GenSprint[] = [
  { number: 1, name: 'Sprint 1', goal: 'Solid core: list, filters and search without stutter.', startDate: '2026-08-24', endDate: '2026-09-06', state: 'closed', capacity: 20 },
  { number: 2, name: 'Sprint 2', goal: 'Agent access: MCP endpoint and key management.', startDate: '2026-09-07', endDate: '2026-09-20', state: 'closed', capacity: 22 },
  { number: 3, name: 'Sprint 3', goal: 'Team logos visible everywhere, repeatable import.', startDate: '2026-09-21', endDate: '2026-10-04', state: 'closed', capacity: 24 },
  { number: 4, name: 'Sprint 4', goal: 'Sprint planning across all teams, closing with decisions.', startDate: '2026-10-05', endDate: '2026-10-18', state: 'active', capacity: 22 },
  { number: 5, name: 'Sprint 5', goal: 'Phone layout and ops page.', startDate: '2026-10-19', endDate: '2026-11-01', state: 'planning' },
];
const sprintStart = (s: GenSprint) => Date.parse(`${s.startDate}T07:00:00Z`);
const sprintEnd = (s: GenSprint) => Date.parse(`${s.endDate}T16:00:00Z`);
for (const s of SPRINTS) {
  if (s.state !== 'planning') s.startedAt = sprintStart(s);
  if (s.state === 'closed') s.closedAt = sprintEnd(s);
}

export function generateDataset(set: DatasetName): GenDataset {
  const { count, seed } = DATASETS[set];
  const rand = mulberry32(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
  const chance = (p: number) => rand() < p;
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const weighted = <T>(items: readonly T[], weights: readonly number[]): T => {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rand() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r < 0) return items[i];
    }
    return items[items.length - 1];
  };
  const agentActor = (): GenActor => ({ kind: 'agent', agent: chance(0.6) ? 0 : 1 });
  // A fresh object each time: some actors are mutated below (Object.assign).
  const owner = (): GenActor => ({ kind: OWNER_KIND });

  // Projects: 0–4 per team, at most 1 for dormant teams.
  const projects: GenProject[] = [];
  for (const team of TEAMS) {
    const n = team.dormant ? int(0, 1) : int(0, 4);
    const words = new Set<string>();
    while (words.size < n) words.add(pick(PROJECT_WORDS));
    let order = 0;
    for (const word of words) {
      projects.push({
        teamKey: team.key,
        name: `${team.name} · ${word}`,
        state: team.dormant ? 'done' : pick(['planned', 'active', 'active', 'active', 'paused'] as const),
        order: order++,
      });
    }
  }

  // Status list exactly by share, then shuffled.
  const totalShare = STATUS_SHARES.reduce((a, [, n]) => a + n, 0);
  const statuses: GenStatus[] = [];
  for (const [status, share] of STATUS_SHARES) {
    const n = Math.round((share / totalShare) * count);
    for (let i = 0; i < n; i++) statuses.push(status);
  }
  while (statuses.length < count) statuses.push('backlog');
  statuses.length = count;
  for (let i = statuses.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [statuses[i], statuses[j]] = [statuses[j], statuses[i]];
  }

  // Hand out ranks in random order so the backlog is not sorted by seq.
  const rankKeys = generateNKeysBetween(null, null, count);
  const rankOrder = Array.from({ length: count }, (_, i) => i);
  for (let i = rankOrder.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [rankOrder[i], rankOrder[j]] = [rankOrder[j], rankOrder[i]];
  }

  const createdTimes = Array.from({ length: count }, () => NOW - Math.floor(rand() * 300 * DAY) - HOUR).sort((a, b) => a - b);
  // The newest issues are from the last few days (for "unreviewed" and the inbox).
  const numbers: Record<string, number> = {};
  const issues: GenIssue[] = [];

  for (let seq = 0; seq < count; seq++) {
    const team = weighted(TEAMS, TEAM_WEIGHTS);
    numbers[team.key] = (numbers[team.key] ?? 0) + 1;
    let status = statuses[seq];
    // Dormant teams have hardly any open work.
    if (team.dormant && OPEN.includes(status) && chance(0.7)) status = chance(0.8) ? 'done' : 'canceled';
    const createdAt = createdTimes[seq];
    const age = NOW - createdAt;
    const updatedAt = Math.min(NOW - 60_000, createdAt + Math.floor(rand() * Math.min(age, 20 * DAY)));
    const createdBy: GenActor = chance(0.6) ? agentActor() : owner();
    if (status === 'triage' && createdBy.kind === OWNER_KIND && chance(0.7)) Object.assign(createdBy, agentActor());

    // Subject first, then verb: keeps the order of random draws.
    const subject = pick(SUBJECTS);
    let title = `${pick(VERBS)} ${subject}`;
    if (chance(0.45)) title += ` ${pick(QUALIFIERS)}`;
    const priority = weighted([0, 1, 2, 3, 4] as const, [35, 3, 16, 27, 19]);

    // Labels: at most one from the single-choice group "Type".
    const labels: string[] = [];
    if (chance(0.55)) labels.push(pick(TYPE_LABELS));
    if (chance(0.3)) labels.push(pick(OTHER_LABELS));
    if (chance(0.1)) {
      const extra = pick(OTHER_LABELS);
      if (!labels.includes(extra)) labels.push(extra);
    }
    if (team.key === 'ORB' && chance(0.08)) labels.push('Release');

    const teamProjects = projects.filter((p) => p.teamKey === team.key);
    const project = teamProjects.length > 0 && chance(0.5) ? pick(teamProjects).name : undefined;
    const estimate = team.estimates && chance(0.7) ? pick([1, 2, 3, 5, 8]) : undefined;
    const dueDate = OPEN.includes(status) && chance(0.12) ? berlinDay(NOW + int(-10, 40) * DAY) : undefined;

    // Description: 0.5–3 KB of Markdown with headings.
    const target = 500 + Math.floor(rand() * 2500);
    let description = '';
    while (description.length < target) {
      description += `## ${pick(HEADINGS)}\n\n`;
      const n = 2 + Math.floor(rand() * 4);
      for (let i = 0; i < n; i++) description += `${pick(SENTENCES)} `;
      description += '\n\n';
      if (chance(0.3)) description += `- ${pick(SENTENCES)}\n- ${pick(SENTENCES)}\n\n`;
    }
    // At most 3 KB: cut at the last paragraph before that.
    if (description.length > 3000) description = description.slice(0, description.lastIndexOf('\n\n', 3000));

    // 0–10 comments, mostly few, mixed authors.
    const commentCount = Math.min(10, Math.floor(-Math.log(1 - rand()) * 2.2));
    const comments: GenComment[] = Array.from({ length: commentCount }, (_, i) => ({
      author: chance(0.45) ? owner() : agentActor(),
      body: `${pick(SENTENCES)}${chance(0.5) ? ` ${pick(SENTENCES)}` : ''}`,
      createdAt: Math.min(NOW - 60_000, createdAt + (i + 1) * Math.floor(rand() * DAY)),
    }));

    // Unreviewed: created by agents, recent and not far along yet.
    const recent = age < 6 * DAY;
    const unreviewed = createdBy.kind === 'agent' && (status === 'triage' || (recent && ['backlog', 'todo'].includes(status) && chance(0.6)));
    const reviewedAt = unreviewed ? undefined : Math.min(NOW - 60_000, createdAt + int(1, 48) * HOUR);

    const issue: GenIssue = {
      seq,
      teamKey: team.key,
      number: numbers[team.key],
      title,
      status,
      priority,
      labels,
      project,
      estimate,
      dueDate,
      rank: rankKeys[rankOrder[seq]],
      createdBy,
      reviewedAt,
      createdAt,
      updatedAt,
      description: description.trim(),
      comments,
      sprintItems: [],
      history: [],
    };
    if (status === 'in_progress' || status === 'in_review' || status === 'done') issue.startedAt = Math.min(updatedAt, createdAt + HOUR);
    if (status === 'done') issue.completedAt = updatedAt;
    if (status === 'canceled' || status === 'duplicate') issue.canceledAt = updatedAt;
    issues.push(issue);
  }

  // Sub-issues (~8 %): the parent is an older issue of the same team → no cycles.
  const byTeam = new Map<string, GenIssue[]>();
  for (const issue of issues) byTeam.set(issue.teamKey, [...(byTeam.get(issue.teamKey) ?? []), issue]);
  for (const issue of issues) {
    if (!chance(0.08)) continue;
    const older = (byTeam.get(issue.teamKey) ?? []).filter((o) => o.seq < issue.seq && o.parentSeq === undefined);
    if (older.length > 0) issue.parentSeq = pick(older.slice(-40)).seq;
  }

  // Trash (~1.5 %): deleted in the last 20 days, never in sprints.
  const trashed = new Set<number>();
  for (const issue of issues) {
    if (issue.seq > 5 && chance(0.015)) {
      issue.deletedAt = NOW - int(1, 20) * DAY;
      trashed.add(issue.seq);
    }
  }

  // Sprints: distribute entries so that the invariant holds.
  const live = (i: GenIssue) => !trashed.has(i.seq) && !TEAMS.find((t) => t.key === i.teamKey)!.dormant;
  const used = new Set<number>();
  const take = (filter: (i: GenIssue) => boolean, n: number) => {
    const pool = issues.filter((i) => live(i) && !used.has(i.seq) && filter(i));
    const out: GenIssue[] = [];
    while (out.length < n && pool.length > 0) {
      const [chosen] = pool.splice(Math.floor(rand() * pool.length), 1);
      used.add(chosen.seq);
      out.push(chosen);
    }
    return out;
  };
  const [s1, s2, s3, s4, s5] = SPRINTS;
  const estimated = (i: GenIssue) => i.estimate !== undefined;
  const isDone = (i: GenIssue) => i.status === 'done';
  const isOpenNotTriage = (i: GenIssue) => OPEN.includes(i.status) && i.status !== 'triage';
  const scale = set === 'small' ? 1 : 2;
  const addItem = (issue: GenIssue, item: GenSprintItem) => issue.sprintItems.push(item);
  const doneIn = (issue: GenIssue, sprint: GenSprint) => {
    issue.completedAt = sprintStart(sprint) + int(1, 12) * DAY;
    issue.updatedAt = Math.max(issue.updatedAt, issue.completedAt);
  };
  /** Created before `at` (entries never predate the issue). */
  const before = (at: number) => (i: GenIssue) => i.createdAt < at - DAY;

  // Closed sprints: done entries (mostly planned, some added late).
  for (const sprint of [s1, s2, s3]) {
    for (const issue of take((i) => isDone(i) && before(sprintStart(sprint))(i) && (estimated(i) || chance(0.4)), 9 * scale)) {
      const late = chance(0.25);
      addItem(issue, {
        sprint: sprint.number,
        kind: late ? 'late' : 'planned',
        addedAt: late ? sprintStart(sprint) + int(1, 9) * DAY : sprintStart(sprint) - int(1, 3) * DAY,
        addedBy: late && chance(0.5) ? agentActor() : owner(),
        outcome: 'done',
      });
      issue.sprint = sprint.number;
      doneIn(issue, sprint);
    }
  }
  // Carried over from sprint 1 to 2, done in sprint 2.
  for (const issue of take((i) => isDone(i) && before(sprintStart(s1))(i), 2 * scale)) {
    addItem(issue, { sprint: 1, kind: 'planned', addedAt: sprintStart(s1) - DAY, addedBy: owner(), removedAt: s1.closedAt, outcome: 'next' });
    addItem(issue, { sprint: 2, kind: 'planned', carriedFrom: 1, addedAt: s1.closedAt!, addedBy: owner(), outcome: 'done' });
    issue.sprint = 2;
    doneIn(issue, s2);
  }
  // Sprint 2 → back to the backlog (open, no sprint).
  for (const issue of take((i) => (i.status === 'backlog' || i.status === 'todo') && before(sprintStart(s2))(i), 2 * scale)) {
    addItem(issue, { sprint: 2, kind: 'planned', addedAt: sprintStart(s2) - DAY, addedBy: owner(), removedAt: s2.closedAt, outcome: 'backlog' });
  }
  // Sprint 2: canceled at close.
  for (const issue of take((i) => i.status === 'canceled' && before(sprintStart(s2))(i), 1 * scale)) {
    addItem(issue, { sprint: 2, kind: 'planned', addedAt: sprintStart(s2) - DAY, addedBy: owner(), removedAt: s2.closedAt, outcome: 'canceled' });
    issue.canceledAt = s2.closedAt;
  }
  // Carried over from sprint 3 to 4 (planned, with origin), still open.
  for (const issue of take((i) => (i.status === 'in_progress' || i.status === 'todo') && before(sprintStart(s3))(i), 3 * scale)) {
    addItem(issue, { sprint: 3, kind: 'planned', addedAt: sprintStart(s3) - DAY, addedBy: owner(), removedAt: s3.closedAt, outcome: 'next' });
    addItem(issue, { sprint: 4, kind: 'planned', carriedFrom: 3, addedAt: s3.closedAt!, addedBy: owner() });
    issue.sprint = 4;
  }
  // Active sprint 4: planned (open and already done) and added late (also by agents).
  for (const issue of [
    ...take((i) => isOpenNotTriage(i) && before(sprintStart(s4) - DAY)(i), 12 * scale),
    ...take((i) => isDone(i) && before(sprintStart(s4) - DAY)(i), 4 * scale),
  ]) {
    addItem(issue, { sprint: 4, kind: 'planned', addedAt: sprintStart(s4) - int(1, 2) * DAY, addedBy: owner() });
    issue.sprint = 4;
    if (issue.status === 'done') {
      issue.completedAt = sprintStart(s4) + int(1, 2) * DAY;
      issue.updatedAt = Math.max(issue.updatedAt, issue.completedAt);
    }
  }
  for (const issue of take((i) => isOpenNotTriage(i) && before(sprintStart(s4))(i), 5 * scale)) {
    const addedBy = chance(0.6) ? agentActor() : owner();
    addItem(issue, { sprint: 4, kind: 'late', addedAt: sprintStart(s4) + int(1, 3) * DAY - int(1, 6) * HOUR, addedBy });
    issue.sprint = 4;
  }
  // Sprint 5 in planning.
  for (const issue of take((i) => (i.status === 'backlog' || i.status === 'todo') && before(NOW - 2 * DAY)(i), 8 * scale)) {
    addItem(issue, { sprint: 5, kind: 'planned', addedAt: NOW - int(1, 48) * HOUR, addedBy: owner() });
    issue.sprint = 5;
  }

  // History: exactly one 'created' row, plus status, sprint, trash.
  for (const issue of issues) {
    const team = issue.teamKey;
    issue.history.push({
      field: 'created',
      to: { identifier: `${team}-${issue.number}`, title: issue.title, status: issue.status === 'triage' ? 'triage' : 'backlog' },
      actor: issue.createdBy,
      at: issue.createdAt,
    });
    if (issue.status !== 'triage' && issue.status !== 'backlog') {
      issue.history.push({
        field: 'status',
        from: 'backlog',
        to: issue.status,
        actor: chance(0.5) ? owner() : agentActor(),
        at: issue.completedAt ?? issue.canceledAt ?? issue.updatedAt,
      });
    }
    for (const item of issue.sprintItems) {
      issue.history.push({ field: 'sprint', to: item.sprint, actor: item.addedBy, at: item.addedAt });
    }
    if (issue.deletedAt) issue.history.push({ field: 'deleted', to: issue.deletedAt, actor: owner(), at: issue.deletedAt });
    issue.history.sort((a, b) => a.at - b.at);
    issue.updatedAt = Math.max(issue.updatedAt, ...issue.history.map((h) => h.at), ...issue.comments.map((c) => c.createdAt));
  }

  // Relations (~4 %): unique pairs.
  const relations: GenRelation[] = [];
  const pairs = new Set<string>();
  for (const issue of issues) {
    if (!chance(0.04) || issue.seq < 2) continue;
    const other = issues[Math.floor(rand() * issue.seq)];
    const type = issue.status === 'duplicate' ? 'duplicate' : pick(['blocks', 'related', 'related'] as const);
    const key = `${Math.min(issue.seq, other.seq)}:${Math.max(issue.seq, other.seq)}`;
    if (pairs.has(key)) continue;
    pairs.add(key);
    relations.push({ fromSeq: issue.seq, toSeq: other.seq, type, createdAt: issue.createdAt + HOUR, createdBy: chance(0.5) ? owner() : agentActor() });
  }

  // Old identifiers: team Pixelworks used to have the key "PIX".
  const aliases = issues
    .filter((i) => i.teamKey === 'PX')
    .slice(0, 5)
    .map((i) => ({ key: `PIX-${i.number}`, seq: i.seq }));

  const today = berlinDay(NOW);
  const recurrences: GenRecurrence[] = [
    {
      teamKey: 'ORB',
      title: 'Write weekly review',
      description: '## Goal\n\nBriefly note what got done this week and what got stuck.',
      priority: 3,
      labels: ['Docs'],
      cadence: 'weekly',
      weekday: 1,
      nextDate: nextWeekday(today, 1, true),
    },
    {
      teamKey: 'NOVA',
      title: 'Update dependencies',
      description: '## Goal\n\nBring all packages up to date and run the tests.',
      priority: 2,
      labels: ['Tech debt'],
      cadence: 'monthly',
      monthDay: 1,
      nextDate: nextMonthDay(today, 1, true),
    },
  ];

  return {
    set,
    count,
    teams: TEAMS,
    labelGroups: LABEL_GROUPS,
    labels: LABELS,
    projects,
    agents: AGENTS,
    sprints: SPRINTS,
    issues,
    relations,
    recurrences,
    aliases,
  };
}
