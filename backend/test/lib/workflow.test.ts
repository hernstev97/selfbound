import { describe, expect, test } from 'vitest';
import {
  activeStates,
  allowedTargets,
  DEFAULT_STATES,
  defaultState,
  matchingState,
  stateForStatus,
  statusOfState,
  suggestedExceptions,
  transitionAllowed,
  type StateLike,
  type WorkflowLike,
} from '../../convex/shared/workflow';

// Pure workflow logic: ordering, status type, strict order.

function team(prefix: string, extra: Partial<StateLike>[] = []): StateLike[] {
  const positions = new Map<string, number>();
  const base = DEFAULT_STATES.map((d) => {
    const position = positions.get(d.type) ?? 0;
    positions.set(d.type, position + 1);
    return { _id: `${prefix}:${d.legacyKey}`, name: d.name, type: d.type, position, legacyKey: d.legacyKey, isDuplicate: d.isDuplicate };
  });
  return [...base, ...extra.map((e, i) => ({ _id: `${prefix}:x${i}`, name: `X${i}`, type: 'started' as const, position: 9, ...e }))];
}
const ids = (set: Set<string> | null) => (set ? [...set].sort() : null);

describe('States and status types', () => {
  test('ordered by type and position, archived ones omitted', () => {
    const states = team('a', [{ name: 'Ready', type: 'backlog', position: 5 }, { name: 'Old', archivedAt: 1 }]);
    expect(activeStates(states).map((s) => s.name)).toEqual([
      'Triage',
      'Backlog',
      'Ready',
      'Todo',
      'In Progress',
      'In Review',
      'Done',
      'Canceled',
      'Duplicate',
    ]);
  });

  test('statusOfState: legacy key, else the key of the type, duplicate flag', () => {
    expect(statusOfState({ type: 'started', legacyKey: 'in_review' })).toBe('in_review');
    expect(statusOfState({ type: 'started' })).toBe('in_progress');
    expect(statusOfState({ type: 'unstarted' })).toBe('todo');
    expect(statusOfState({ type: 'canceled', isDuplicate: true })).toBe('duplicate');
  });

  test('stateForStatus: default state, then a custom state of the same kind, then the same type', () => {
    const states = team('a');
    expect(stateForStatus(states, 'in_review')?._id).toBe('a:in_review');
    const custom = team('b', [{ name: 'Testing', type: 'started', position: 0 }]).filter((s) => s.legacyKey !== 'in_progress');
    expect(stateForStatus(custom, 'in_progress')?.name).toBe('Testing');
    const noReview = states.map((s) => (s.legacyKey === 'in_review' ? { ...s, archivedAt: 1 } : s));
    expect(stateForStatus(noReview, 'in_review')?._id).toBe('a:in_progress');
    expect(stateForStatus(states, 'duplicate')?._id).toBe('a:duplicate');
    expect(stateForStatus(states, 'canceled')?._id).toBe('a:canceled');
  });

  test('defaultState: configured default, else Backlog; Triage for agents', () => {
    const states = team('a');
    expect(defaultState(states, undefined)?._id).toBe('a:backlog');
    expect(defaultState(states, { strict: false, exceptions: [], defaultStateId: 'a:todo' })?._id).toBe('a:todo');
    expect(defaultState(states, undefined, { triage: true })?._id).toBe('a:triage');
    const noTriage = states.filter((s) => s.type !== 'triage');
    expect(defaultState(noTriage, undefined, { triage: true })?._id).toBe('a:backlog');
  });

  test('matchingState: same key, then name, then status type', () => {
    const target = team('t', [{ name: 'testing' }]);
    expect(matchingState(target, team('s')[4]!)?._id).toBe('t:in_review');
    expect(matchingState(target, { _id: 's:x', name: 'Testing', type: 'started', position: 0 })?.name).toBe('testing');
    expect(matchingState(target, { _id: 's:y', name: 'QA', type: 'completed', position: 3 })?._id).toBe('t:done');
  });
});

describe('Strict order', () => {
  const states = team('a');
  const strict: WorkflowLike = { strict: true, exceptions: [{ from: 'a:in_review', to: 'a:in_progress' }] };

  test('without strict order everything is allowed', () => {
    expect(allowedTargets(states, undefined, 'a:todo')).toBeNull();
    expect(allowedTargets(states, { strict: false, exceptions: [] }, 'a:todo')).toBeNull();
    expect(transitionAllowed(states, undefined, 'a:todo', 'a:done')).toBe(true);
  });

  test('next state, cancel and duplicate always, exceptions', () => {
    expect(ids(allowedTargets(states, strict, 'a:todo'))).toEqual(['a:canceled', 'a:duplicate', 'a:in_progress']);
    expect(ids(allowedTargets(states, strict, 'a:in_review'))).toEqual(['a:canceled', 'a:done', 'a:duplicate', 'a:in_progress']);
    expect(transitionAllowed(states, strict, 'a:todo', 'a:done')).toBe(false);
    expect(transitionAllowed(states, strict, 'a:todo', 'a:todo')).toBe(true);
    // Done: only cancel onward (the next state would be Canceled); reopening only through an exception.
    expect(ids(allowedTargets(states, strict, 'a:done'))).toEqual(['a:canceled', 'a:duplicate']);
  });

  test('Triage is the entry: accept into Backlog or unstarted', () => {
    expect(ids(allowedTargets(states, strict, 'a:triage'))).toEqual(['a:backlog', 'a:canceled', 'a:duplicate', 'a:todo']);
  });

  test('new issues only in Triage, Backlog or unstarted; an archived state is no dead end', () => {
    expect(ids(allowedTargets(states, strict, null))).toEqual(['a:backlog', 'a:todo', 'a:triage']);
    const archived = states.map((s) => (s._id === 'a:in_review' ? { ...s, archivedAt: 1 } : s));
    expect(allowedTargets(archived, strict, 'a:in_review')?.size).toBe(7);
    // An exception to an archived state does not count.
    const toArchived = { strict: true, exceptions: [{ from: 'a:done', to: 'a:in_review' }] };
    expect(allowedTargets(archived, toArchived, 'a:done')?.has('a:in_review')).toBe(false);
  });

  test('suggested exceptions: In Review → In Progress, Done/Canceled → Todo', () => {
    expect(suggestedExceptions(states)).toEqual([
      { from: 'a:in_review', to: 'a:in_progress' },
      { from: 'a:done', to: 'a:todo' },
      { from: 'a:canceled', to: 'a:todo' },
    ]);
  });
});
