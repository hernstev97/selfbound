// Workflow: configurable states per team. Pure logic for backend, core and UI.
// This file must not import anything from Convex; it also runs in the browser.
//
// Terms:
// - A **state** (`workflowStates`) belongs to exactly one team: name, type, position, color.
// - The **type** is one of triage, backlog, unstarted, started, completed, canceled.
// - The **status** (`issue.status`, the eight legacy keys) is derived from the state
//   (`statusOfState`). It drives indexes, sprint close, the priority budget and MCP filters. The
//   default states keep their key (`legacyKey`); custom states get the key of their type
//   (e.g. "Testing" of type started → in_progress).
// - **Strict order** (`strict`): issues move through the states only in order. Allowed are the
//   next state, the configured exceptions and canceling at any time.

import type { Status } from './constants';

export const STATE_TYPES = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'] as const;
export type StateType = (typeof STATE_TYPES)[number];

/**
 * Display names of the types (settings, groups). English; the UI translates them with t(label)
 * (German in app/src/locales/de/shared.ts).
 */
export const STATE_TYPE_LABEL: Record<StateType, string> = {
  triage: 'Triage',
  backlog: 'Backlog',
  unstarted: 'Unstarted',
  started: 'Started',
  completed: 'Completed',
  canceled: 'Canceled',
};

/** Type of each legacy key. */
export const TYPE_OF_STATUS: Record<Status, StateType> = {
  triage: 'triage',
  backlog: 'backlog',
  todo: 'unstarted',
  in_progress: 'started',
  in_review: 'started',
  done: 'completed',
  canceled: 'canceled',
  duplicate: 'canceled',
};

/** Status of a custom state without a legacy key. */
export const STATUS_OF_TYPE: Record<StateType, Status> = {
  triage: 'triage',
  backlog: 'backlog',
  unstarted: 'todo',
  started: 'in_progress',
  completed: 'done',
  canceled: 'canceled',
};

export const STATE_NAME_MAX = 40;
export const STATE_DESCRIPTION_MAX = 200;
export const MAX_STATES_PER_TEAM = 30;
export const MAX_EXCEPTIONS = 100;

/** What logic and UI need from a state (Convex document or client copy). */
export interface StateLike {
  _id: string;
  name: string;
  type: StateType;
  position: number;
  isDuplicate?: boolean;
  legacyKey?: Status;
  archivedAt?: number;
}

export interface WorkflowException {
  from: string;
  to: string;
}

/** A team's workflow settings (`teams.workflow`). Missing means `strict: false`. */
export interface WorkflowLike {
  strict: boolean;
  exceptions: readonly WorkflowException[];
  defaultStateId?: string;
}

/**
 * The default states every team starts with. Their names are stored per team (data, not UI
 * labels), so a new team gets them in the deployment's language: see `defaultStateName`.
 */
export const DEFAULT_STATES: readonly { name: string; type: StateType; legacyKey: Status; isDuplicate?: true }[] = [
  { name: 'Triage', type: 'triage', legacyKey: 'triage' },
  { name: 'Backlog', type: 'backlog', legacyKey: 'backlog' },
  { name: 'Todo', type: 'unstarted', legacyKey: 'todo' },
  { name: 'In Progress', type: 'started', legacyKey: 'in_progress' },
  { name: 'In Review', type: 'started', legacyKey: 'in_review' },
  { name: 'Done', type: 'completed', legacyKey: 'done' },
  { name: 'Canceled', type: 'canceled', legacyKey: 'canceled' },
  { name: 'Duplicate', type: 'canceled', legacyKey: 'duplicate', isDuplicate: true },
];

/** German names of the default states, for deployments with SELFBOUND_LOCALE=de. */
const DEFAULT_STATE_NAMES_DE: Record<Status, string> = {
  triage: 'Triage',
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In Arbeit',
  in_review: 'In Review',
  done: 'Erledigt',
  canceled: 'Abgebrochen',
  duplicate: 'Duplikat',
};

/** Name of a default state for a new team: German if `locale` is 'de', otherwise English. */
export function defaultStateName(def: (typeof DEFAULT_STATES)[number], locale: string | undefined): string {
  return locale === 'de' ? DEFAULT_STATE_NAMES_DE[def.legacyKey] : def.name;
}

const TYPE_RANK: Record<StateType, number> = { triage: 0, backlog: 1, unstarted: 2, started: 3, completed: 4, canceled: 5 };

export function typeRank(type: StateType) {
  return TYPE_RANK[type];
}

/** Status (legacy key) of a state. */
export function statusOfState(state: Pick<StateLike, 'type' | 'legacyKey' | 'isDuplicate'>): Status {
  if (state.isDuplicate) return 'duplicate';
  return state.legacyKey ?? STATUS_OF_TYPE[state.type];
}

/** Workflow order: by type, then by position within the type. */
export function compareStates(a: StateLike, b: StateLike) {
  return TYPE_RANK[a.type] - TYPE_RANK[b.type] || a.position - b.position || a.name.localeCompare(b.name);
}

/** Non-archived states in workflow order. */
export function activeStates<S extends StateLike>(states: readonly S[]): S[] {
  return states.filter((s) => s.archivedAt === undefined).sort(compareStates);
}

const norm = (text: string) => text.trim().toLowerCase();

/**
 * A team's state for a status, e.g. "done" for a GitHub merge or "todo" for recurrences: first
 * the default state with that key, then the first custom state with that status, then the first
 * state of the same type. Non-archived states only.
 */
export function stateForStatus<S extends StateLike>(states: readonly S[], status: Status): S | undefined {
  const active = activeStates(states);
  if (status === 'duplicate') {
    return active.find((s) => s.isDuplicate) ?? active.find((s) => s.type === 'canceled');
  }
  return (
    active.find((s) => s.legacyKey === status && !s.isDuplicate) ??
    active.find((s) => statusOfState(s) === status) ??
    active.find((s) => s.type === TYPE_OF_STATUS[status] && !s.isDuplicate) ??
    active.find((s) => s.type === TYPE_OF_STATUS[status])
  );
}

/** A team's state by name (case-insensitive), archived ones included. */
export function stateByName<S extends StateLike>(states: readonly S[], name: string): S | undefined {
  const wanted = norm(name);
  return activeStates(states).find((s) => norm(s.name) === wanted) ?? states.find((s) => norm(s.name) === wanted);
}

/**
 * State for new issues: the configured default, else the first backlog state, then the first
 * unstarted one. With `triage` (agents, inbox) the triage state, if there is one.
 */
export function defaultState<S extends StateLike>(
  states: readonly S[],
  workflow: WorkflowLike | undefined,
  opts: { triage?: boolean } = {},
): S | undefined {
  const active = activeStates(states);
  if (opts.triage) {
    const triage = active.find((s) => s.type === 'triage');
    if (triage) return triage;
  }
  const chosen = workflow?.defaultStateId ? active.find((s) => s._id === workflow.defaultStateId) : undefined;
  return (
    chosen ??
    active.find((s) => s.type === 'backlog') ??
    active.find((s) => s.type === 'unstarted') ??
    active.find((s) => s.type !== 'triage')
  );
}

/**
 * Counterpart of a state in another team (moving teams): same legacy key, then same name,
 * then same status.
 */
export function matchingState<S extends StateLike>(target: readonly S[], state: StateLike): S | undefined {
  const active = activeStates(target);
  return (
    (state.legacyKey ? active.find((s) => s.legacyKey === state.legacyKey && !!s.isDuplicate === !!state.isDuplicate) : undefined) ??
    active.find((s) => norm(s.name) === norm(state.name)) ??
    stateForStatus(target, statusOfState(state))
  );
}

// ---------------------------------------------------------------- Strict order

/** Types new issues may start in under strict order. */
const START_TYPES: ReadonlySet<StateType> = new Set(['triage', 'backlog', 'unstarted']);

/**
 * Allowed targets from `fromId` (`null` = new issue). A `null` result means everything is allowed
 * (no strict order). Otherwise the IDs of the allowed states, without the current one.
 *
 * Rules:
 * - the next state in workflow order,
 * - any state of type canceled (Canceled, Duplicate) at any time,
 * - from triage (inbox) any backlog or unstarted state (accepting),
 * - the configured exceptions "from → to".
 * New issues: only triage, backlog or unstarted states.
 */
export function allowedTargets(
  states: readonly StateLike[],
  workflow: WorkflowLike | undefined,
  fromId: string | null,
): Set<string> | null {
  if (!workflow?.strict) return null;
  const active = activeStates(states);
  if (fromId === null) return new Set(active.filter((s) => START_TYPES.has(s.type)).map((s) => s._id));
  const index = active.findIndex((s) => s._id === fromId);
  // Current state archived or unknown: no dead end, everything is allowed.
  if (index < 0) return new Set(active.map((s) => s._id));
  const from = active[index]!;
  const allowed = new Set<string>();
  const next = active[index + 1];
  if (next) allowed.add(next._id);
  for (const s of active) {
    if (s.type === 'canceled') allowed.add(s._id);
    if (from.type === 'triage' && (s.type === 'backlog' || s.type === 'unstarted')) allowed.add(s._id);
  }
  const live = new Set(active.map((s) => s._id));
  for (const e of workflow.exceptions) if (e.from === fromId && live.has(e.to)) allowed.add(e.to);
  allowed.delete(fromId);
  return allowed;
}

/** Is the transition allowed? The same state is always allowed (no change). */
export function transitionAllowed(
  states: readonly StateLike[],
  workflow: WorkflowLike | undefined,
  fromId: string | null,
  toId: string,
): boolean {
  if (fromId === toId) return true;
  const allowed = allowedTargets(states, workflow, fromId);
  return allowed === null || allowed.has(toId);
}

/**
 * Exceptions suggested when strict order is turned on, so there is no dead end: from later
 * started states back to the first started one (review → in progress), and from completed or
 * canceled back to the first unstarted state (reopen).
 */
export function suggestedExceptions(states: readonly StateLike[]): WorkflowException[] {
  const active = activeStates(states);
  const out: WorkflowException[] = [];
  const started = active.filter((s) => s.type === 'started');
  for (const s of started.slice(1)) out.push({ from: s._id, to: started[0]!._id });
  const reopen = active.find((s) => s.type === 'unstarted') ?? active.find((s) => s.type === 'backlog');
  if (reopen) {
    for (const s of active) if (s.type === 'completed' || (s.type === 'canceled' && !s.isDuplicate)) out.push({ from: s._id, to: reopen._id });
  }
  return out;
}
