import { describe, expect, test } from 'vitest';
import {
  computeAxis,
  computeProgress,
  computeRelease,
  dayOf,
  dayOfString,
  exportProgress,
  exportRoadmap,
  NO_CATEGORY,
  NO_FILTERS,
  type PublicCard,
  type RoadmapInput,
} from '../src/roadmap.ts';
import type { Issue, IssueDoc, Meta } from '../src/types.ts';
import { doc, meta as baseMeta } from './helpers.ts';

// Roadmap (SELF-113): release columns, progress rows, time axis and, above all, an image export that
// holds nothing but public issues.

const DAY = 86_400_000;
const at = (day: string) => new Date(`${day}T12:00:00`).getTime();

const meta: Meta = {
  ...baseMeta,
  teams: baseMeta.teams.map((t) => (t._id === 't1' ? { ...t, roadmap: { on: true, categoryGroupId: 'g9', title: 'Ember' } } : t)) as Meta['teams'],
  projects: [
    { _id: 'p1', _creationTime: 0, teamId: 't1', name: 'Etappe 1', state: 'done', order: 0, period: '2026-Q3', hue: 25, description: 'Internal goal', updatedAt: 0 },
    { _id: 'p2', _creationTime: 0, teamId: 't1', name: 'Etappe 2', state: 'active', order: 1, period: '2027-Q1', updatedAt: 0 },
    { _id: 'p3', _creationTime: 0, teamId: 't1', name: 'Dropped', state: 'canceled', order: 2, updatedAt: 0 },
    { _id: 'p4', _creationTime: 0, teamId: 't1', name: 'Etappe 3', state: 'planned', order: 3, updatedAt: 0 },
  ] as unknown as Meta['projects'],
  labelGroups: [...baseMeta.labelGroups, { _id: 'g9', _creationTime: 0, name: 'Kategorie', exclusive: true, hue: 30 }] as unknown as Meta['labelGroups'],
  labels: [
    ...baseMeta.labels,
    { _id: 'c2', _creationTime: 0, name: 'Kreise', hue: 140, groupId: 'g9', order: 1 },
    { _id: 'c1', _creationTime: 0, name: 'Figuren', hue: 20, groupId: 'g9', order: 0 },
  ] as unknown as Meta['labels'],
};
const team = meta.teams.find((t) => t._id === 't1')!;

const issue = (seq: number, patch: Record<string, unknown>): Issue => ({ ...doc(seq, { teamId: 't1', ...patch } as Partial<IssueDoc>), key: `ACME-${seq + 1}` }) as Issue;

const issues: Issue[] = [
  issue(1, { title: 'Hero model', projectId: 'p1', labelIds: ['c1'], status: 'done', public: true, startedAt: at('2026-07-02'), completedAt: at('2026-08-15') }),
  issue(2, { title: 'Secret boss', projectId: 'p1', labelIds: ['c2'], status: 'done', startedAt: at('2026-07-10'), completedAt: at('2026-09-01') }),
  issue(3, { title: 'Second circle', projectId: 'p2', labelIds: ['c2'], status: 'in_progress', public: true, startedAt: at('2026-10-01') }),
  issue(4, { title: 'Hidden lore', projectId: 'p2', labelIds: [], status: 'todo' }),
  issue(5, { title: 'Triage thing', projectId: 'p2', status: 'triage' }),
  issue(6, { title: 'Canceled project issue', projectId: 'p3', status: 'todo', public: true }),
  issue(7, { title: 'No project', status: 'todo', public: true }),
  issue(8, { title: 'Deleted', projectId: 'p2', status: 'todo', public: true, deletedAt: 1 }),
  issue(9, { title: 'Other team', teamId: 't2', stateId: 't2:todo', projectId: 'p2', status: 'todo', public: true }),
];
const cards = new Map<string, PublicCard>([
  ['i1', { title: 'The Ember Knight', summary: 'A hero of fire.', image: 'https://x/img/a' }],
  ['i2', { title: 'Boss reveal', summary: 'Never show this.', image: null }],
]);
const input: RoadmapInput = { meta, team, issues, cards };

describe('release view', () => {
  test('columns are the projects in order without canceled ones; categories in label order; hidden stages left out', () => {
    const view = computeRelease(input, NO_FILTERS, 'No category');
    expect(view.columns.map((c) => c.name)).toEqual(['Etappe 1', 'Etappe 2', 'Etappe 3']);
    const [one, two, three] = view.columns;
    expect(one!.groups.map((g) => g.name)).toEqual(['Figuren', 'Kreise']);
    expect(one!.groups[0]!.cards[0]).toMatchObject({ title: 'The Ember Knight', internalTitle: 'Hero model', summary: 'A hero of fire.', stage: 'done', public: true });
    expect(one).toMatchObject({ done: 2, total: 2 });
    // Triage is hidden by default; no label = "No category".
    expect(two!.groups.map((g) => [g.key, g.cards.map((c) => c.internalTitle)])).toEqual([
      ['c2', ['Second circle']],
      [NO_CATEGORY, ['Hidden lore']],
    ]);
    expect(two!.stages).toMatchObject({ progress: 1, planned: 1 });
    expect(three!.groups).toEqual([]);
    expect(view.categories.map((c) => c.name)).toEqual(['Figuren', 'Kreise', 'No category']);
  });

  test('filters: only public, category, stage', () => {
    const pub = computeRelease(input, { ...NO_FILTERS, publicOnly: true }, '-');
    expect(pub.columns.flatMap((c) => c.groups.flatMap((g) => g.cards.map((x) => x.internalTitle)))).toEqual(['Hero model', 'Second circle']);
    expect(pub.filtered).toBe(2);
    const cat = computeRelease(input, { ...NO_FILTERS, categories: ['c2'] }, '-');
    expect(cat.columns.flatMap((c) => c.groups.flatMap((g) => g.cards.map((x) => x.internalTitle)))).toEqual(['Secret boss', 'Second circle']);
    const stage = computeRelease(input, { ...NO_FILTERS, stages: ['planned'] }, '-');
    expect(stage.shown).toBe(1);
  });

  test('a status mapped to another stage, or hidden, moves or drops the cards', () => {
    const mapped = { ...team, roadmap: { on: true, categoryGroupId: 'g9', stages: [{ stateId: 't1:in_progress', stage: 'testing' as const }, { stateId: 't1:todo', stage: 'hidden' as const }] } } as unknown as typeof team;
    const view = computeRelease({ ...input, team: mapped }, NO_FILTERS, '-');
    const two = view.columns[1]!;
    expect(two.groups.flatMap((g) => g.cards.map((c) => [c.internalTitle, c.stage]))).toEqual([['Second circle', 'testing']]);
  });
});

describe('progress view', () => {
  test('rows per project: start at the first started issue, end once all are done, target = end of the period', () => {
    const rows = computeProgress(input, NO_FILTERS, 'projects', '-');
    expect(rows.map((r) => r.name)).toEqual(['Etappe 1', 'Etappe 2', 'Etappe 3']);
    const [one, two, three] = rows;
    expect(one).toMatchObject({ total: 2, done: 2, start: dayOf(at('2026-07-02')), end: dayOf(at('2026-09-01')), target: dayOfString('2026-09-30') });
    expect(one!.completions.map((c) => c.day)).toEqual([dayOf(at('2026-08-15')), dayOf(at('2026-09-01'))]);
    expect(two).toMatchObject({ total: 2, done: 0, started: 1, start: dayOf(at('2026-10-01')), end: null, target: dayOfString('2027-03-31') });
    expect(three).toMatchObject({ total: 0, start: null, target: null });
  });

  test('rows per category across projects', () => {
    const rows = computeProgress(input, NO_FILTERS, 'categories', 'None');
    expect(rows.map((r) => [r.name, r.total, r.done])).toEqual([
      ['Figuren', 1, 1],
      ['Kreise', 2, 1],
      ['None', 1, 0],
    ]);
  });

  test('the axis covers whole quarters from the first start to the last target and past today', () => {
    const rows = computeProgress(input, NO_FILTERS, 'projects', '-');
    const today = dayOfString('2026-11-01');
    const axis = computeAxis(rows, today, 183);
    expect(axis.start).toBe(dayOfString('2026-07-01'));
    expect(axis.end).toBe(dayOfString('2027-04-01'));
    expect(axis.quarters.map((q) => `${q.year}-Q${q.quarter}`)).toEqual(['2026-Q3', '2026-Q4', '2027-Q1']);
    expect(axis.months).toHaveLength(9);
    expect(axis.months.reduce((sum, m) => sum + m.days, 0)).toBe(axis.end - axis.start);
    // A year zoom on a short span still shows a whole year.
    const year = computeAxis([], today, 366);
    expect(year.end - year.start).toBeGreaterThanOrEqual(366);
    expect(year.start).toBe(dayOfString('2026-10-01'));
  });
});

describe('image export: public issues only', () => {
  const secrets = ['Secret boss', 'Boss reveal', 'Never show this', 'Hidden lore', 'Triage thing', 'Internal goal', 'Hero model', 'ACME-', 'i1', 'i2', 'i3', 'Dropped', 'Canceled project issue', 'Other team', 'No project', 'Deleted'];

  test('roadmap: only public cards with their public texts, counts over public issues, no identifiers', () => {
    const columns = exportRoadmap(input, { projects: null, includeEmpty: false, showGoals: false }, 'No category');
    expect(columns).toEqual([
      { name: 'Etappe 1', state: 'done', period: expect.objectContaining({ start: '2026-07-01' }), hue: 25, goal: null, done: 1, total: 1, groups: [{ name: 'Figuren', hue: 20, cards: [{ title: 'The Ember Knight', summary: 'A hero of fire.', image: 'https://x/img/a', stage: 'done' }] }] },
      { name: 'Etappe 2', state: 'active', period: expect.objectContaining({ end: '2027-03-31' }), hue: null, goal: null, done: 0, total: 1, groups: [{ name: 'Kreise', hue: 140, cards: [{ title: 'Second circle', summary: null, image: null, stage: 'progress' }] }] },
    ]);
    const text = JSON.stringify(columns);
    for (const secret of secrets) expect(text, secret).not.toContain(secret);
  });

  test('options: chosen projects, empty columns, goals only when asked', () => {
    const one = exportRoadmap(input, { projects: ['p2'], includeEmpty: true, showGoals: true }, '-');
    expect(one.map((c) => c.name)).toEqual(['Etappe 2']);
    const empty = exportRoadmap(input, { projects: null, includeEmpty: true, showGoals: true }, '-');
    expect(empty.map((c) => [c.name, c.total])).toEqual([
      ['Etappe 1', 1],
      ['Etappe 2', 1],
      ['Etappe 3', 0],
    ]);
    expect(empty[0]!.goal).toBe('Internal goal');
  });

  test('progress: spans and completions from public issues only', () => {
    const rows = exportProgress(input, { projects: null, includeEmpty: false, showGoals: false }, 'projects', '-');
    expect(rows).toEqual([
      expect.objectContaining({ name: 'Etappe 1', done: 1, total: 1, start: dayOf(at('2026-07-02')), end: dayOf(at('2026-08-15')), completions: [dayOf(at('2026-08-15'))] }),
      expect.objectContaining({ name: 'Etappe 2', done: 0, total: 1, start: dayOf(at('2026-10-01')), end: null }),
    ]);
    const text = JSON.stringify(rows);
    for (const secret of secrets) expect(text, secret).not.toContain(secret);
    // The secret boss was finished on 2026-09-01: that day appears nowhere.
    expect(text).not.toContain(String(dayOf(at('2026-09-01'))));
    expect(DAY).toBeGreaterThan(0);
  });
});
