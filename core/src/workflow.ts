// Per-team statuses in the client: lookup, groups across teams, picker values.
// The rules themselves (order, status type, fixed order) live in @selfbound/backend/shared/workflow
// and apply the same way in the backend.
import {
  activeStates,
  allowedTargets,
  compareStates,
  stateForStatus,
  statusOfState,
  typeRank,
  type StateType,
} from '@selfbound/backend/shared/workflow';
import { STATUS_LABEL } from './format.ts';
import { intlLocale } from './i18n.ts';
import type { Issue, Meta, StateDoc, Status } from './types.ts';

/** What rows, groups and pickers show of a status. */
export interface StateView {
  /** Status id; for issues from before the migration, the status type key */
  id: string;
  name: string;
  /** Status type: decides the icon and the default color */
  status: Status;
  type: StateType;
  /** Own color (#rrggbb) or null = color of the status type */
  color: string | null;
}

const norm = (text: string) => text.trim().toLowerCase();

/** Group key across teams: same type and same name = one group/column. */
export function stateGroupKey(state: Pick<StateDoc, 'type' | 'name'>) {
  return `${state.type}:${norm(state.name)}`;
}

/**
 * Index of all statuses from `meta.get`. Built once per meta version (`workflowsOf`), then only
 * map lookups, so lists with 10,000 issues do not get slower.
 */
export class Workflows {
  readonly byId = new Map<string, StateDoc>();
  readonly #team = new Map<string, StateDoc[]>();
  readonly #views = new Map<string, StateView>();
  readonly #meta: Meta | null;

  constructor(meta: Meta | null) {
    this.#meta = meta;
    const all = meta?.workflowStates ?? [];
    for (const s of all) this.byId.set(s._id, s);
    const byTeam = new Map<string, StateDoc[]>();
    for (const s of all) {
      let list = byTeam.get(s.teamId);
      if (!list) byTeam.set(s.teamId, (list = []));
      list.push(s);
    }
    for (const [teamId, list] of byTeam) this.#team.set(teamId, list.sort(compareStates));
  }

  /** All statuses of a team in workflow order, archived ones included. */
  allOf(teamId: string): readonly StateDoc[] {
    return this.#team.get(teamId) ?? [];
  }

  /** A team's non-archived statuses in workflow order. */
  teamStates(teamId: string): StateDoc[] {
    return activeStates(this.allOf(teamId));
  }

  workflowOf(teamId: string) {
    return this.#meta?.teams.find((t) => t._id === teamId)?.workflow;
  }

  view(stateId: string): StateView | null {
    const cached = this.#views.get(stateId);
    if (cached) return cached;
    const s = this.byId.get(stateId);
    if (!s) return null;
    const v: StateView = { id: s._id, name: s.name, status: statusOfState(s), type: s.type, color: s.color ?? null };
    this.#views.set(stateId, v);
    return v;
  }

  /** An issue's status; without `stateId` (before the migration, provisional) from the status type. */
  of(issue: Pick<Issue, 'stateId' | 'status' | 'teamId'>): StateView {
    if (issue.stateId) {
      const v = this.view(issue.stateId);
      if (v) return v;
    }
    const s = stateForStatus(this.allOf(issue.teamId), issue.status);
    if (s && statusOfState(s) === issue.status) return this.view(s._id)!;
    return { id: issue.status, name: STATUS_LABEL[issue.status], status: issue.status, type: legacyType(issue.status), color: null };
  }

  /** A team's status for a status type (defaults, accepting triage, duplicate). */
  forStatus(teamId: string, status: Status): StateDoc | undefined {
    return stateForStatus(this.allOf(teamId), status);
  }

  /** Status with this name in the team (case-insensitive). */
  byName(teamId: string, name: string): StateDoc | undefined {
    const wanted = norm(name);
    return this.teamStates(teamId).find((s) => norm(s.name) === wanted);
  }

  /** Allowed targets from an issue's status (null = everything allowed). */
  allowed(teamId: string, fromId: string | null): Set<string> | null {
    return allowedTargets(this.allOf(teamId), this.workflowOf(teamId), fromId);
  }

  /**
   * Groups across several teams: same type and same name make one entry (picker, filter, board
   * columns). Order: type, then the smallest position.
   */
  groups(teamIds?: Iterable<string>): StateGroup[] {
    const teams = teamIds ? [...teamIds] : [...this.#team.keys()];
    const map = new Map<string, StateGroup>();
    for (const teamId of teams) {
      for (const s of this.teamStates(teamId)) {
        const key = stateGroupKey(s);
        let g = map.get(key);
        if (!g) map.set(key, (g = { key, name: s.name, type: s.type, status: statusOfState(s), color: s.color ?? null, position: s.position, standard: s.legacyKey !== undefined, byTeam: new Map() }));
        g.byTeam.set(teamId, s._id);
        if (s.position < g.position) g.position = s.position;
      }
    }
    return [...map.values()].sort((a, b) => typeRank(a.type) - typeRank(b.type) || a.position - b.position || a.name.localeCompare(b.name, intlLocale()));
  }
}

/** One status across teams (same type and name). */
export interface StateGroup {
  key: string;
  name: string;
  type: StateType;
  status: Status;
  color: string | null;
  position: number;
  /** A default status (with a legacy key): search words like "progress" match in both languages */
  standard: boolean;
  /** Team id → status id */
  byTeam: Map<string, string>;
}

function legacyType(status: Status): StateType {
  switch (status) {
    case 'triage':
    case 'backlog':
      return status;
    case 'todo':
      return 'unstarted';
    case 'in_progress':
    case 'in_review':
      return 'started';
    case 'done':
      return 'completed';
    default:
      return 'canceled';
  }
}

const cache = new WeakMap<object, Workflows>();
let empty: Workflows | null = null;

/** Index for the current meta version (rebuilt only when `meta.get` changes). */
export function workflowsOf(meta: Meta | null): Workflows {
  if (!meta) return (empty ??= new Workflows(null));
  let w = cache.get(meta);
  if (!w) cache.set(meta, (w = new Workflows(meta)));
  return w;
}

// ---------------------------------------------------------------- Filter by status

const isStatusKey = (value: string): value is Status => Object.hasOwn(STATUS_LABEL, value);

/** Filter value of a status: lowercase name (applies across teams). */
export function statusFilterValue(state: Pick<StateDoc, 'name'>) {
  return norm(state.name);
}

/** Display of a filter value: the status name, or the status type name (older links). */
export function statusFilterLabel(meta: Meta | null, value: string): string {
  const state = meta?.workflowStates.find((s) => norm(s.name) === value && s.archivedAt === undefined) ?? meta?.workflowStates.find((s) => norm(s.name) === value);
  if (state) return state.name;
  return isStatusKey(value) ? STATUS_LABEL[value] : value;
}

/** Test for the status filter: the status name or (older links) the status type key. */
export function statusMatcher(meta: Meta | null, values: readonly string[]): ((issue: Issue) => boolean) | null {
  if (!values.length) return null;
  const wanted = new Set(values);
  const workflows = workflowsOf(meta);
  return (issue) => wanted.has(issue.status) || wanted.has(norm(workflows.of(issue).name));
}
