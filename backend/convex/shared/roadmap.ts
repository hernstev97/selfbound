// Roadmap and progress per team (SELF-113): the stages a team's statuses show as, the rough period
// of a project, and the limits of the public texts. Pure logic for backend, core and UI.
// This file must not import anything from Convex; it also runs in the browser.
//
// Terms:
// - A **stage** is what the roadmap shows instead of the team's status: done, testing, in progress,
//   planned, tentative. Each status of the team maps to a stage or to `hidden` (not on the roadmap).
//   Missing in the settings = the default from the status type (`defaultStage`).
// - A **period** is a project's rough time frame: a quarter ("2027-Q1") or a month ("2027-03").
//   No exact date: the progress view draws up to the end of the period.
// - **Public** issues (`issues.public`) are the only ones an image export contains. Their public
//   card (`publicCards`) holds an optional title, a short summary for players and a cover image.

import type { StateType } from './workflow';
import { TYPE_OF_STATUS } from './workflow';
import type { Status } from './constants';

export const STAGES = ['done', 'testing', 'progress', 'planned', 'tentative'] as const;
export type Stage = (typeof STAGES)[number];
/** What a status maps to: a stage, or not on the roadmap. */
export const STAGE_CHOICES = [...STAGES, 'hidden'] as const;
export type StageChoice = (typeof STAGE_CHOICES)[number];

/**
 * Display names. English; the UI translates them with t(label) (German in app/src/locales/de/shared.ts),
 * MCP shows the keys.
 */
export const STAGE_LABEL: Record<StageChoice, string> = {
  done: 'Done',
  testing: 'Testing',
  progress: 'In progress',
  planned: 'Planned',
  tentative: 'Tentative',
  hidden: 'Not shown',
};

export const ROADMAP_LIMITS = {
  /** Goal and "ready when" of a project */
  projectTextMax: 2000,
  publicTitleMax: 120,
  /** Two or three sentences for players */
  publicSummaryMax: 600,
  brandTitleMax: 80,
  brandSubtitleMax: 160,
  /** Status mappings per team (a team has at most 30 statuses) */
  stagesMax: 60,
} as const;

/** Accent color of the export: #rrggbb. */
export const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;

/** Started statuses whose name says "testing" map to `testing` by default. */
const TESTING_NAME = /review|test|qa\b|prüf|abnahme|staging|polish/i;

export interface StageState {
  _id: string;
  name: string;
  type: StateType;
}

export interface StageMapping {
  stateId: string;
  stage: StageChoice;
}

/** A team's roadmap settings as stored (`teams.roadmap`). */
export interface RoadmapSettingsLike {
  on: boolean;
  categoryGroupId?: string;
  stages?: readonly StageMapping[];
  title?: string;
  subtitle?: string;
  accent?: string;
}

/** Stage of a status without its own mapping. Triage and canceled stay off the roadmap. */
export function defaultStage(state: Pick<StageState, 'name' | 'type'>): StageChoice {
  switch (state.type) {
    case 'completed':
      return 'done';
    case 'started':
      return TESTING_NAME.test(state.name) ? 'testing' : 'progress';
    case 'unstarted':
      return 'planned';
    case 'backlog':
      return 'tentative';
    default:
      return 'hidden';
  }
}

/** Stage of a status in a team: its mapping, else the default. */
export function stageOfState(state: StageState, settings: RoadmapSettingsLike | null | undefined): StageChoice {
  const own = settings?.stages?.find((s) => s.stateId === state._id);
  return own?.stage ?? defaultStage(state);
}

/** Stage of an issue: through its status, or the status type for issues without one (old data). */
export function stageOfIssue(
  issue: { stateId?: string; status: Status },
  states: ReadonlyMap<string, StageState> | readonly StageState[],
  settings: RoadmapSettingsLike | null | undefined,
): StageChoice {
  const state = issue.stateId ? ('get' in states ? states.get(issue.stateId) : states.find((s) => s._id === issue.stateId)) : undefined;
  if (state) return stageOfState(state, settings);
  return defaultStage({ name: '', type: TYPE_OF_STATUS[issue.status] });
}

/** Order of the stages on cards and in filters: done first, as on the roadmap columns. */
export function stageRank(stage: StageChoice) {
  const i = (STAGE_CHOICES as readonly string[]).indexOf(stage);
  return i < 0 ? STAGE_CHOICES.length : i;
}

// ---------------------------------------------------------------- Periods

/** "2027-Q1" (quarter) or "2027-03" (month). */
export const PERIOD_RE = /^(\d{4})-(?:Q([1-4])|(0[1-9]|1[0-2]))$/;

export interface PeriodRange {
  kind: 'quarter' | 'month';
  year: number;
  /** Quarter 1–4 or month 1–12 */
  index: number;
  /** First and last calendar day, "YYYY-MM-DD" */
  start: string;
  end: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Normal form of a period input ("2027-q1", " 2027-3 ") or null if it is none. */
export function normalizePeriod(input: string): string | null {
  const s = input.trim().toUpperCase().replace(/\s+/g, '');
  const yearFirst = /^(\d{4})[-/]?Q([1-4])$/.exec(s);
  if (yearFirst) return `${yearFirst[1]}-Q${yearFirst[2]}`;
  const quarterFirst = /^Q([1-4])[-/]?(\d{4})$/.exec(s);
  if (quarterFirst) return `${quarterFirst[2]}-Q${quarterFirst[1]}`;
  const month = /^(\d{4})[-/](\d{1,2})$/.exec(s);
  if (month) {
    const m = Number(month[2]);
    if (m >= 1 && m <= 12) return `${month[1]}-${pad(m)}`;
  }
  return null;
}

export function periodRange(period: string | null | undefined): PeriodRange | null {
  const m = period ? PERIOD_RE.exec(period) : null;
  if (!m) return null;
  const year = Number(m[1]);
  if (m[2]) {
    const q = Number(m[2]);
    const first = (q - 1) * 3 + 1;
    return { kind: 'quarter', year, index: q, start: `${year}-${pad(first)}-01`, end: `${year}-${pad(first + 2)}-${pad(lastDay(year, first + 2))}` };
  }
  const month = Number(m[3]);
  return { kind: 'month', year, index: month, start: `${year}-${pad(month)}-01`, end: `${year}-${pad(month)}-${pad(lastDay(year, month))}` };
}
