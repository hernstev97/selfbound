// Roadmap and progress of a team (SELF-113), pure computations over the store's issues and the
// metadata. The release view: projects as columns, categories (labels of one group) inside, cards
// with their stage. The progress view: one row per project (or category) on a time axis. The image
// export: the same, built only from public issues (`exportRoadmap`, `exportProgress`), so whatever
// draws it cannot see anything else.
//
// Rules shared with the backend (stages, periods) live in `@selfbound/backend/shared/roadmap`.
import {
  periodRange,
  STAGES,
  stageOfIssue,
  stageRank,
  type PeriodRange,
  type Stage,
  type StageChoice,
  type StageState,
} from '@selfbound/backend/shared/roadmap';
import type { Issue, IssueId, LabelDoc, Meta, ProjectDoc, ProjectId, TeamDoc } from './types.ts';

export { STAGES, type PeriodRange, type Stage, type StageChoice };

/** Public card of an issue (`roadmap.cards`). */
export interface PublicCard {
  title: string | null;
  summary: string | null;
  image: string | null;
}

/** Category key of issues without a label of the category group. */
export const NO_CATEGORY = 'none';

export interface RoadmapFilters {
  /** Only public issues (what the export may show) */
  publicOnly: boolean;
  /** Category keys (label id or NO_CATEGORY); empty = all */
  categories: string[];
  /** Stages; empty = all */
  stages: Stage[];
}

export const NO_FILTERS: RoadmapFilters = { publicOnly: false, categories: [], stages: [] };

export interface CategoryInfo {
  key: string;
  name: string;
  hue: number | null;
}

export interface RoadmapCard {
  id: IssueId;
  key: string;
  /** Shown title: the public title, else the title */
  title: string;
  /** The issue's own title (shown as a hint when a public title differs) */
  internalTitle: string;
  summary: string | null;
  image: string | null;
  stage: Stage;
  public: boolean;
  category: string;
  estimate: number | null;
  /** Day numbers (local calendar days since 1970), null = not yet */
  started: number | null;
  completed: number | null;
}

export interface CardGroup extends CategoryInfo {
  cards: RoadmapCard[];
}

export interface ReleaseColumn {
  id: ProjectId;
  name: string;
  state: ProjectDoc['state'];
  period: PeriodRange | null;
  hue: number | null;
  description: string | null;
  readyWhen: string | null;
  /** Over the shown cards */
  done: number;
  total: number;
  stages: Record<Stage, number>;
  groups: CardGroup[];
}

export interface ReleaseView {
  columns: ReleaseColumn[];
  /** Categories in order, for filters (only the ones with cards, plus the group's labels) */
  categories: CategoryInfo[];
  /** Cards shown, and cards the filters hide */
  shown: number;
  filtered: number;
  /** The team has a category group */
  grouped: boolean;
}

export interface RoadmapInput {
  meta: Meta;
  team: TeamDoc;
  issues: Iterable<Issue>;
  cards: ReadonlyMap<string, PublicCard>;
}

// ---------------------------------------------------------------- Days

const DAY_MS = 86_400_000;

/** Local calendar day of a time as a day number (days since 1970-01-01). */
export function dayOf(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS;
}

/** Day number of "YYYY-MM-DD". */
export function dayOfString(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!) / DAY_MS;
}

/** { year, month (1–12), day } of a day number. */
export function dateOfDay(day: number) {
  const d = new Date(day * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

const dayNumber = (year: number, month: number, day = 1) => Date.UTC(year, month - 1, day) / DAY_MS;

// ---------------------------------------------------------------- Shared parts

/** The team's projects on the roadmap, in order: canceled ones stay off. */
export function roadmapProjects(meta: Meta, team: TeamDoc): ProjectDoc[] {
  return meta.projects.filter((p) => p.teamId === team._id && p.state !== 'canceled').sort((a, b) => a.order - b.order);
}

/** Labels in their order within the group: ordered ones first, then by name. */
export function byLabelOrder(a: LabelDoc, b: LabelDoc) {
  return (a.order ?? Infinity) - (b.order ?? Infinity) || a.name.localeCompare(b.name);
}

/** The labels that are the team's categories, in order (archived ones too: issues may still carry them). */
export function categoryLabels(meta: Meta, team: TeamDoc): LabelDoc[] {
  const groupId = team.roadmap?.categoryGroupId;
  if (!groupId || !meta.labelGroups.some((g) => g._id === groupId)) return [];
  return meta.labels.filter((l) => l.groupId === groupId && (!l.teamId || l.teamId === team._id)).sort(byLabelOrder);
}

function stateIndex(meta: Meta, team: TeamDoc): Map<string, StageState> {
  const map = new Map<string, StageState>();
  for (const s of meta.workflowStates) if (s.teamId === team._id) map.set(s._id, s);
  return map;
}

/** Stage of an issue in its team; `hidden` keeps it off the roadmap. */
export function stageOf(issue: Issue, states: ReadonlyMap<string, StageState>, team: TeamDoc): StageChoice {
  return stageOfIssue(issue, states, team.roadmap);
}

function cardOf(issue: Issue, stage: Stage, category: string, card: PublicCard | undefined): RoadmapCard {
  return {
    id: issue._id,
    key: issue.key,
    title: card?.title || issue.title,
    internalTitle: issue.title,
    summary: card?.summary ?? null,
    image: card?.image ?? null,
    stage,
    public: issue.public === true,
    category,
    estimate: issue.estimate ?? null,
    started: issue.startedAt !== undefined ? dayOf(issue.startedAt) : null,
    completed: issue.completedAt !== undefined && stage === 'done' ? dayOf(issue.completedAt) : null,
  };
}

const byStageThenRank = (a: { stage: Stage; rank: string }, b: { stage: Stage; rank: string }) =>
  stageRank(a.stage) - stageRank(b.stage) || (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0);

const emptyStages = (): Record<Stage, number> => ({ done: 0, testing: 0, progress: 0, planned: 0, tentative: 0 });

/** All cards of the team's roadmap projects (no filters), per project, sorted by stage and rank. */
function cardsByProject(input: RoadmapInput, only?: (issue: Issue) => boolean) {
  const { meta, team } = input;
  const projects = roadmapProjects(meta, team);
  const ids = new Set(projects.map((p) => p._id as string));
  const states = stateIndex(meta, team);
  const labels = categoryLabels(meta, team);
  const out = new Map<string, { card: RoadmapCard; rank: string }[]>();
  for (const issue of input.issues) {
    if (issue.teamId !== team._id || issue.deletedAt !== undefined || !issue.projectId || !ids.has(issue.projectId)) continue;
    if (only && !only(issue)) continue;
    const stage = stageOf(issue, states, team);
    if (stage === 'hidden') continue;
    const category = labels.find((l) => issue.labelIds.includes(l._id))?._id ?? NO_CATEGORY;
    const list = out.get(issue.projectId) ?? [];
    list.push({ card: cardOf(issue, stage, category, input.cards.get(issue._id)), rank: issue.rank });
    out.set(issue.projectId, list);
  }
  for (const list of out.values()) list.sort((a, b) => byStageThenRank({ stage: a.card.stage, rank: a.rank }, { stage: b.card.stage, rank: b.rank }));
  return { projects, labels, cards: new Map([...out].map(([k, v]) => [k, v.map((x) => x.card)])) };
}

function categoryInfos(labels: LabelDoc[]): CategoryInfo[] {
  return labels.map((l) => ({ key: l._id, name: l.name, hue: l.hue }));
}

const matches = (card: RoadmapCard, filters: RoadmapFilters) =>
  (!filters.publicOnly || card.public) &&
  (filters.categories.length === 0 || filters.categories.includes(card.category)) &&
  (filters.stages.length === 0 || filters.stages.includes(card.stage));

// ---------------------------------------------------------------- Release view

/** Projects as columns, categories inside, cards with their stage. `noCategory` names the rest. */
export function computeRelease(input: RoadmapInput, filters: RoadmapFilters, noCategory: string): ReleaseView {
  const { projects, labels, cards } = cardsByProject(input);
  const infos = categoryInfos(labels);
  const none: CategoryInfo = { key: NO_CATEGORY, name: noCategory, hue: null };
  let shown = 0;
  let filtered = 0;
  let usesNone = false;
  const columns: ReleaseColumn[] = projects.map((p) => {
    const all = cards.get(p._id) ?? [];
    const visible = all.filter((c) => matches(c, filters));
    shown += visible.length;
    filtered += all.length - visible.length;
    const stages = emptyStages();
    for (const c of visible) stages[c.stage]++;
    const byCategory = new Map<string, RoadmapCard[]>();
    for (const c of visible) {
      if (c.category === NO_CATEGORY) usesNone = true;
      const list = byCategory.get(c.category) ?? [];
      list.push(c);
      byCategory.set(c.category, list);
    }
    if (all.some((c) => c.category === NO_CATEGORY)) usesNone = true;
    const groups = [...infos, none].filter((info) => byCategory.has(info.key)).map((info) => ({ ...info, cards: byCategory.get(info.key)! }));
    return {
      id: p._id,
      name: p.name,
      state: p.state,
      period: periodRange(p.period),
      hue: p.hue ?? null,
      description: p.description ?? null,
      readyWhen: p.readyWhen ?? null,
      done: stages.done,
      total: visible.length,
      stages,
      groups,
    };
  });
  return { columns, categories: usesNone ? [...infos, none] : infos, shown, filtered, grouped: labels.length > 0 };
}

// ---------------------------------------------------------------- Progress view

export type ProgressRows = 'projects' | 'categories';

export interface ProgressIssue {
  id: IssueId;
  key: string;
  title: string;
  stage: Stage;
  public: boolean;
  start: number | null;
  end: number | null;
}

export interface ProgressRow {
  key: string;
  name: string;
  hue: number | null;
  state: ProjectDoc['state'] | null;
  period: PeriodRange | null;
  total: number;
  done: number;
  started: number;
  /** First started issue (day number); null = nothing started yet */
  start: number | null;
  /** Last completion, once everything is done; null = still open */
  end: number | null;
  /** End of the period; null = none */
  target: number | null;
  /** Completed issues as points on the axis */
  completions: { day: number; id: IssueId }[];
  issues: ProgressIssue[];
}

function progressRow(key: string, name: string, hue: number | null, project: ProjectDoc | null, cards: RoadmapCard[]): ProgressRow {
  const period = project ? periodRange(project.period) : null;
  let start: number | null = null;
  let last: number | null = null;
  let done = 0;
  let started = 0;
  const completions: { day: number; id: IssueId }[] = [];
  for (const c of cards) {
    const first = c.started ?? c.completed;
    if (first !== null) start = start === null ? first : Math.min(start, first);
    if (c.stage === 'done') {
      done++;
      if (c.completed !== null) {
        completions.push({ day: c.completed, id: c.id });
        last = last === null ? c.completed : Math.max(last, c.completed);
      }
    } else if (c.stage === 'progress' || c.stage === 'testing') started++;
  }
  completions.sort((a, b) => a.day - b.day);
  const issues = cards.map((c) => ({ id: c.id, key: c.key, title: c.title, stage: c.stage, public: c.public, start: c.started ?? c.completed, end: c.completed }));
  return {
    key,
    name,
    hue,
    state: project?.state ?? null,
    period,
    total: cards.length,
    done,
    started,
    start,
    end: cards.length > 0 && done === cards.length ? last : null,
    target: period ? dayOfString(period.end) : null,
    completions,
    issues,
  };
}

/** One row per project, or per category across the projects. */
export function computeProgress(input: RoadmapInput, filters: RoadmapFilters, rows: ProgressRows, noCategory: string): ProgressRow[] {
  const { projects, labels, cards } = cardsByProject(input);
  if (rows === 'projects') {
    return projects.map((p) => progressRow(p._id, p.name, p.hue ?? null, p, (cards.get(p._id) ?? []).filter((c) => matches(c, filters))));
  }
  const byCategory = new Map<string, RoadmapCard[]>();
  for (const p of projects) {
    for (const c of cards.get(p._id) ?? []) {
      if (!matches(c, filters)) continue;
      const list = byCategory.get(c.category) ?? [];
      list.push(c);
      byCategory.set(c.category, list);
    }
  }
  const infos = [...categoryInfos(labels), { key: NO_CATEGORY, name: noCategory, hue: null }];
  return infos.filter((i) => byCategory.has(i.key)).map((i) => progressRow(i.key, i.name, i.hue, null, byCategory.get(i.key)!));
}

// ---------------------------------------------------------------- Time axis

export type Zoom = 'quarter' | 'half' | 'year';
export const ZOOMS: readonly Zoom[] = ['quarter', 'half', 'year'];
/** Days the visible width shows per zoom */
export const ZOOM_DAYS: Record<Zoom, number> = { quarter: 92, half: 183, year: 366 };

export interface AxisMonth {
  start: number;
  days: number;
  year: number;
  month: number;
}

export interface AxisQuarter {
  start: number;
  days: number;
  year: number;
  quarter: number;
}

export interface Axis {
  /** First and last day shown (day numbers, inclusive start, exclusive end) */
  start: number;
  end: number;
  today: number;
  months: AxisMonth[];
  quarters: AxisQuarter[];
}

/**
 * The days the axis covers: whole quarters from the earliest start (or today) to the latest
 * target or completion (or today), and at least `minDays` (one visible width) past today.
 */
export function computeAxis(rows: readonly Pick<ProgressRow, 'start' | 'end' | 'target' | 'period'>[], today: number, minDays = ZOOM_DAYS.quarter): Axis {
  let lo = today;
  let hi = today;
  for (const r of rows) {
    for (const d of [r.start, r.end, r.target, r.period ? dayOfString(r.period.start) : null]) {
      if (d === null) continue;
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
  }
  // Short spans still fill one visible width, and "now" never sits at the right edge.
  hi = Math.max(hi, today + Math.ceil(minDays / 2), lo + minDays);
  const first = dateOfDay(lo);
  const last = dateOfDay(hi);
  let year = first.year;
  let month = Math.floor((first.month - 1) / 3) * 3 + 1;
  const start = dayNumber(year, month);
  const lastQuarter = Math.floor((last.month - 1) / 3);
  const end = lastQuarter === 3 ? dayNumber(last.year + 1, 1) : dayNumber(last.year, lastQuarter * 3 + 4);
  const months: AxisMonth[] = [];
  const quarters: AxisQuarter[] = [];
  while (dayNumber(year, month) < end) {
    const s = dayNumber(year, month);
    const next = month === 12 ? dayNumber(year + 1, 1) : dayNumber(year, month + 1);
    months.push({ start: s, days: next - s, year, month });
    if ((month - 1) % 3 === 0) {
      const after = month === 10 ? dayNumber(year + 1, 1) : dayNumber(year, month + 3);
      quarters.push({ start: s, days: after - s, year, quarter: (month - 1) / 3 + 1 });
    }
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  return { start, end, today, months, quarters };
}

// ---------------------------------------------------------------- Image export

/** What an export card may show. No identifier, no internal title, no description. */
export interface ExportCard {
  title: string;
  summary: string | null;
  image: string | null;
  stage: Stage;
}

export interface ExportGroup {
  name: string;
  hue: number | null;
  cards: ExportCard[];
}

export interface ExportColumn {
  name: string;
  state: ProjectDoc['state'];
  period: PeriodRange | null;
  hue: number | null;
  goal: string | null;
  /** Over public issues only */
  done: number;
  total: number;
  groups: ExportGroup[];
}

export interface ExportRow {
  name: string;
  hue: number | null;
  state: ProjectDoc['state'] | null;
  period: PeriodRange | null;
  done: number;
  total: number;
  start: number | null;
  end: number | null;
  target: number | null;
  completions: number[];
}

export interface ExportOptions {
  /** Projects to include (ids, in roadmap order); null = all */
  projects: readonly string[] | null;
  /** Columns or rows without public issues */
  includeEmpty: boolean;
  /** The project's goal under its name (the owner decides; it is internal text) */
  showGoals: boolean;
}

/** Only public issues, before anything else is computed: the rest never reaches the export. */
function publicInput(input: RoadmapInput): RoadmapInput {
  const issues = [...input.issues].filter((i) => i.public === true && i.teamId === input.team._id && i.deletedAt === undefined);
  const cards = new Map<string, PublicCard>();
  for (const i of issues) {
    const card = input.cards.get(i._id);
    if (card) cards.set(i._id, card);
  }
  return { ...input, issues, cards };
}

const chosen = (options: ExportOptions, id: string) => options.projects === null || options.projects.includes(id);

/** The release view for the image export: public issues only, nothing that identifies an issue. */
export function exportRoadmap(input: RoadmapInput, options: ExportOptions, noCategory: string): ExportColumn[] {
  const view = computeRelease(publicInput(input), { publicOnly: true, categories: [], stages: [] }, noCategory);
  return view.columns
    .filter((c) => chosen(options, c.id) && (options.includeEmpty || c.total > 0))
    .map((c) => ({
      name: c.name,
      state: c.state,
      period: c.period,
      hue: c.hue,
      goal: options.showGoals ? c.description : null,
      done: c.done,
      total: c.total,
      groups: c.groups.map((g) => ({
        name: g.name,
        hue: g.hue,
        cards: g.cards.map((card) => ({ title: card.title, summary: card.summary, image: card.image, stage: card.stage })),
      })),
    }));
}

/** The progress view for the image export: public issues only, rows without issue lists. */
export function exportProgress(input: RoadmapInput, options: ExportOptions, rows: ProgressRows, noCategory: string): ExportRow[] {
  const list = computeProgress(publicInput(input), { publicOnly: true, categories: [], stages: [] }, rows, noCategory);
  return list
    .filter((r) => (rows === 'categories' || chosen(options, r.key)) && (options.includeEmpty || r.total > 0))
    .map((r) => ({
      name: r.name,
      hue: r.hue,
      state: r.state,
      period: r.period,
      done: r.done,
      total: r.total,
      start: r.start,
      end: r.end,
      target: r.target,
      completions: r.completions.map((c) => c.day),
    }));
}
