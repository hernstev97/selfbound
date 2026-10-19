import { describe, expect, test } from 'vitest';
import {
  listCheckCounts,
  PR_GROUPS,
  prBlockers,
  prGroup,
  prStatusOf,
  sameStatus,
  type PrCheck,
  type PrCheckState,
  type PrGroupInput,
  type PrMergeState,
  type PrState,
} from '../../convex/shared/pullRequests';

// Grouping of the pull requests page (SELF-100): every combination of state, checks, review and
// mergeability lands in exactly one group.

type Review = 'approved' | 'changes_requested';
const check = (state: PrCheckState, n = 0): PrCheck => ({ key: `check:${state}:${n}`, name: `CI ${n}`, source: 'check', state });
const checks = (states: PrCheckState[]) => states.map(check);
/** The status a fetch would store for these checks. */
const detail = (states: PrCheckState[], mergeState: PrMergeState = 'clean', draft = false, review?: Review) => prStatusOf({ draft, mergeState, checks: checks(states) }, review);
const input = (state: PrState, status: PrGroupInput['status'], review?: Review): PrGroupInput => ({ state, status: status && review ? { ...status, review } : status });

const STATES: PrState[] = ['open', 'draft', 'merged', 'closed'];
const MERGE_STATES: PrMergeState[] = ['clean', 'dirty', 'blocked', 'behind', 'unstable', 'draft', 'unknown'];
const REVIEWS = [undefined, 'approved', 'changes_requested'] as const;
const CHECK_SETS: PrCheckState[][] = [[], ['success'], ['success', 'neutral', 'skipped'], ['failure'], ['cancelled'], ['pending'], ['success', 'pending'], ['failure', 'pending'], ['cancelled', 'pending']];

describe('prGroup', () => {
  test('merged and closed are done, whatever else is known', () => {
    for (const state of ['merged', 'closed'] as const) {
      expect(prGroup(input(state, null))).toBe('done');
      expect(prGroup(input(state, detail(['failure'], 'dirty')))).toBe('done');
      expect(prGroup(input(state, detail(['success']), 'approved'))).toBe('done');
    }
  });

  test('a draft stays a draft: by stored state, by fetched flag or by mergeability', () => {
    expect(prGroup(input('draft', null))).toBe('draft');
    expect(prGroup(input('draft', detail(['failure'])))).toBe('draft');
    expect(prGroup(input('open', detail(['success'], 'clean', true)))).toBe('draft');
    expect(prGroup(input('open', detail(['pending'], 'draft')))).toBe('draft');
  });

  test('failing before running before the rest; a canceled check counts as failing', () => {
    expect(prGroup(input('open', detail(['failure'])))).toBe('failing');
    expect(prGroup(input('open', detail(['cancelled'])))).toBe('failing');
    expect(prGroup(input('open', detail(['failure', 'pending'], 'dirty'), 'changes_requested'))).toBe('failing');
    expect(prGroup(input('open', detail(['pending'])))).toBe('running');
    expect(prGroup(input('open', detail(['success', 'pending'], 'dirty')))).toBe('running');
  });

  test('ready: open, checks successful, neutral or skipped (or none), no requested changes, nothing blocking', () => {
    expect(prGroup(input('open', detail([])))).toBe('ready');
    expect(prGroup(input('open', detail(['success', 'neutral', 'skipped'])))).toBe('ready');
    expect(prGroup(input('open', detail(['success']), 'approved'))).toBe('ready');
    // Same rule as the merge button in the PR view: only conflicts, rules and drafts block.
    for (const mergeState of ['clean', 'behind', 'unstable', 'unknown'] as const) expect(prGroup(input('open', detail(['success'], mergeState)))).toBe('ready');
  });

  test('blocked: checks fine, but conflicts, requested changes, rules, or no state from GitHub yet', () => {
    expect(prGroup(input('open', detail(['success'], 'dirty')))).toBe('blocked');
    expect(prGroup(input('open', detail(['success'], 'blocked')))).toBe('blocked');
    expect(prGroup(input('open', detail(['success']), 'changes_requested'))).toBe('blocked');
    expect(prGroup(input('open', null))).toBe('blocked');
    expect(prBlockers(input('open', null))).toEqual(['unknown']);
    expect(prBlockers(input('open', detail(['success'], 'dirty'), 'changes_requested'))).toEqual(['conflicts', 'changes_requested']);
    expect(prBlockers(input('open', detail(['success'], 'blocked')))).toEqual(['rules']);
    expect(prBlockers(input('open', detail(['success'], 'behind'), 'approved'))).toEqual([]);
  });

  test('every combination lands in one known group, consistent with the rules above', () => {
    let seen = 0;
    for (const state of STATES)
      for (const mergeState of MERGE_STATES)
        for (const review of REVIEWS)
          for (const checkStates of CHECK_SETS)
            for (const draft of [false, true])
              for (const fetched of [true, false]) {
                const i = input(state, fetched ? detail(checkStates, mergeState, draft) : null, review);
                const group = prGroup(i);
                expect(PR_GROUPS).toContain(group);
                seen++;
                const counts = fetched ? listCheckCounts(checks(checkStates)) : null;
                if (state === 'merged' || state === 'closed') expect(group).toBe('done');
                else if (state === 'draft' || (fetched && (draft || mergeState === 'draft'))) expect(group).toBe('draft');
                else if (counts?.failed) expect(group).toBe('failing');
                else if (counts?.pending) expect(group).toBe('running');
                else if (!fetched || mergeState === 'dirty' || mergeState === 'blocked' || review === 'changes_requested') expect(group).toBe('blocked');
                else expect(group).toBe('ready');
              }
    expect(seen).toBe(STATES.length * MERGE_STATES.length * REVIEWS.length * CHECK_SETS.length * 4);
  });
});

describe('listCheckCounts, prStatusOf, sameStatus', () => {
  test('failed includes canceled; pending separate; total all', () => {
    expect(listCheckCounts(['success', 'failure', 'cancelled', 'pending', 'skipped', 'neutral'].map((s, n) => check(s as PrCheckState, n)))).toEqual({ total: 6, failed: 2, pending: 1 });
    expect(listCheckCounts([])).toEqual({ total: 0, failed: 0, pending: 0 });
  });

  test('the stored status holds only what the grouping reads; equal statuses are not written again', () => {
    const a = detail(['success', 'pending'], 'unstable', false, 'approved');
    expect(a).toEqual({ draft: false, mergeState: 'unstable', checks: { total: 2, failed: 0, pending: 1 }, review: 'approved' });
    expect(detail(['success'])).not.toHaveProperty('review');
    expect(sameStatus(a, detail(['pending', 'success'], 'unstable', false, 'approved'))).toBe(true);
    expect(sameStatus(a, detail(['success', 'success'], 'unstable', false, 'approved'))).toBe(false);
    expect(sameStatus(a, detail(['success', 'pending'], 'clean', false, 'approved'))).toBe(false);
    expect(sameStatus(a, detail(['success', 'pending'], 'unstable', true, 'approved'))).toBe(false);
    expect(sameStatus(a, detail(['success', 'pending'], 'unstable'))).toBe(false);
  });
});
