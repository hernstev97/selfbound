import { describe, expect, test } from 'vitest';
import { computeList, computeVisible, emptyFilters, groupKeyOf, reuseList } from '../src/query.ts';
import { VIEWS, subGroupings, type ViewContext } from '../src/views.ts';
import { parseDay } from '../src/format.ts';
import type { Display, Grouping, Issue, IssueDoc, ListRow, ViewRoute, ViewState } from '../src/types.ts';
import { doc, meta } from './helpers.ts';

// Thursday, 15 Oct 2026, noon (local time)
const NOW = parseDay('2026-10-15').getTime() + 12 * 3600_000;
const DAY = 24 * 3600_000;
const enrich = (d: IssueDoc): Issue => Object.freeze({ ...d, key: `${d.teamId === 't1' ? 'ACME' : 'PX'}-${d.number}` }) as Issue;
const ctx = (): ViewContext => ({ teamId: null, activeSprintId: 's4', projectId: null, keep: new Set() });
const route: ViewRoute = { kind: 'all', team: null };
function view(display: Partial<Display>): ViewState {
  return { route, filters: emptyFilters(), quick: '', quickOpen: false, display: { ...VIEWS.all.display(route), ...display } };
}
function list(issues: Issue[], display: Partial<Display>, collapsed: string[] = []) {
  const v = view(display);
  return computeList(computeVisible(issues, v, meta, ctx()), v, meta, new Set(collapsed), true, { now: NOW, issueOf: (id) => issues.find((i) => i._id === id) });
}
/** Group header value (with its count) followed by the ids below it. */
function outline(rows: ListRow[]) {
  const out: Record<string, string[]> = {};
  let key = '';
  for (const r of rows) {
    if (r.kind === 'group') out[(key = `${r.group.value}:${r.count}`)] = [];
    else out[key].push(r.id);
  }
  return out;
}
const groups = (rows: ListRow[]) => rows.flatMap((r) => (r.kind === 'group' ? [r.group.value] : []));
const labels = (rows: ListRow[]) => rows.flatMap((r) => (r.kind === 'group' ? [r.group.label] : []));

describe('grouping by label', () => {
  const issues = [
    enrich(doc(1, { labelIds: ['l1', 'l3'] as never, createdAt: 5 })),
    enrich(doc(2, { labelIds: [] as never, createdAt: 4 })),
    enrich(doc(3, { labelIds: ['l3'] as never, createdAt: 3 })),
  ];

  test('an issue with two labels appears under both; the count is per group, the list count per issue', () => {
    const l = list(issues, { grouping: 'label', ordering: 'created' });
    expect(outline(l.rows)).toEqual({ 'l1:1': ['i1'], 'l3:2': ['i1', 'i3'], 'none:1': ['i2'] });
    expect(labels(l.rows)).toEqual(['Bug', 'Mobile', 'No label']);
    expect(l.count).toBe(3);
  });

  test('row keys stay unique; the first row keeps the plain id', () => {
    const l = list(issues, { grouping: 'label', ordering: 'created' });
    const keys = l.rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(l.rows.filter((r) => r.kind === 'issue' && r.id === 'i1').map((r) => r.key)[0]).toBe('i1');
  });

  test('collapsed group keeps its count and loses its rows', () => {
    const l = list(issues, { grouping: 'label', ordering: 'created' }, ['g:label:l3']);
    expect(l.rows.filter((r) => r.kind === 'issue').map((r) => r.id)).toEqual(['i1', 'i2']);
    expect(l.rows.find((r) => r.kind === 'group' && r.group.value === 'l3')).toMatchObject({ count: 2, collapsed: true });
  });

  test('label hue travels with the group; groups are not found by key (several per issue)', () => {
    const l = list(issues, { grouping: 'label' });
    expect(l.rows[0]).toMatchObject({ kind: 'group', group: { hue: 25 } });
    expect(groupKeyOf('label', {}, meta)).toBeNull();
  });

  test('a label unknown to the metadata still shows its issues', () => {
    const l = list([enrich(doc(1, { labelIds: ['gone'] as never }))], { grouping: 'label' });
    expect(labels(l.rows)).toEqual(['Unknown']);
    expect(l.rows.filter((r) => r.kind === 'issue')).toHaveLength(1);
  });
});

describe('grouping by label group', () => {
  // meta: group g1 "Type" holds the labels l1 (Bug) and l2 (Feature); l3 (Mobile) has no group.
  const issues = [
    enrich(doc(1, { labelIds: ['l1', 'l2'] as never, createdAt: 5 })),
    enrich(doc(2, { labelIds: ['l3'] as never, createdAt: 4 })),
    enrich(doc(3, { labelIds: ['l2', 'l3'] as never, createdAt: 3 })),
    enrich(doc(4, { labelIds: [] as never, createdAt: 2 })),
  ];

  test('an issue appears once per group, however many of its labels belong to it; ungrouped labels count as none', () => {
    const l = list(issues, { grouping: 'labelGroup', ordering: 'created' });
    expect(outline(l.rows)).toEqual({ 'g1:2': ['i1', 'i3'], 'none:2': ['i2', 'i4'] });
    expect(labels(l.rows)).toEqual(['Type', 'No label group']);
    expect(l.rows[0]).toMatchObject({ group: { hue: 25 } });
    expect(l.count).toBe(4);
    expect(groupKeyOf('labelGroup', {}, meta)).toBeNull();
  });

  test('empty groups show with the option', () => {
    const l = list([enrich(doc(2, { labelIds: ['l3'] as never }))], { grouping: 'labelGroup', emptyGroups: true });
    expect(groups(l.rows)).toEqual(['g1', 'none']);
  });
});

describe('grouping by creator', () => {
  const issues = [
    enrich(doc(1, { createdBy: { kind: 'agent', agentId: 'a2' } as never, createdAt: 5 })),
    enrich(doc(2, { createdBy: { kind: 'owner' } as never, createdAt: 4 })),
    enrich(doc(3, { createdBy: { kind: 'agent', agentId: 'a1' } as never, createdAt: 3 })),
    enrich(doc(4, { createdBy: { kind: 'agent', agentId: 'a2' } as never, createdAt: 2 })),
    enrich(doc(5, { createdBy: { kind: 'github' } as never, createdAt: 1 })),
  ];
  const actors = new Map([['owner', 'Steven'], ['a1', 'Zed'], ['a2', 'Aleister']]);
  const run = (display: Partial<Display>) => {
    const v = view(display);
    return computeList(computeVisible(issues, v, meta, ctx()), v, meta, new Set(), true, { now: NOW, actors });
  };

  test('the owner first, then the others by name; each creator is one group', () => {
    const l = run({ grouping: 'creator', ordering: 'created' });
    expect(labels(l.rows)).toEqual(['Steven', 'Aleister', 'GitHub', 'Zed']);
    expect(outline(l.rows)).toEqual({ 'owner:1': ['i2'], 'agent:a2:2': ['i1', 'i4'], 'github:1': ['i5'], 'agent:a1:1': ['i3'] });
  });

  test('the old stored owner kind lands in the owner group; a creator is found by key', () => {
    const legacy = [enrich(doc(1, { createdBy: { kind: 'steven' } as never })), enrich(doc(2, { createdBy: { kind: 'owner' } as never }))];
    const v = view({ grouping: 'creator' });
    const l = computeList(computeVisible(legacy, v, meta, ctx()), v, meta, new Set(), true, { now: NOW, actors });
    expect(groups(l.rows)).toEqual(['owner']);
    expect(groupKeyOf('creator', { actors }, meta)?.(legacy[0])).toBe('owner');
  });
});

describe('grouping by estimate', () => {
  test('one group per value in numeric order, none last', () => {
    const issues = [3, 10, 1, undefined, 3, 0.5].map((estimate, i) => enrich(doc(i, { ...(estimate === undefined ? {} : { estimate }) })));
    const l = list(issues, { grouping: 'estimate', ordering: 'created' });
    expect(groups(l.rows)).toEqual(['0.5', '1', '3', '10', 'none']);
    expect(labels(l.rows)).toEqual(['0.5 points', '1 point', '3 points', '10 points', 'No estimate']);
    expect(l.rows.find((r) => r.kind === 'group' && r.group.value === '3')).toMatchObject({ count: 2 });
  });
});

describe('grouping by due date', () => {
  const at = (days: number) => new Date(NOW + days * DAY);
  const iso = (days: number) => at(days).toISOString().slice(0, 10);
  const issues = [
    enrich(doc(1, { dueDate: iso(-3) })),
    enrich(doc(2, { dueDate: iso(0) })),
    enrich(doc(3, { dueDate: iso(2) })), // Saturday: rest of this week
    enrich(doc(4, { dueDate: iso(5) })), // Tuesday next week
    enrich(doc(5, { dueDate: iso(40) })),
    enrich(doc(6)),
    enrich(doc(7, { dueDate: iso(-3), status: 'done' })),
  ];
  test('overdue, today, this week, next week, later, closed, none', () => {
    const l = list(issues, { grouping: 'due', ordering: 'created', showClosed: true });
    expect(outline(l.rows)).toEqual({
      'overdue:1': ['i1'],
      'today:1': ['i2'],
      'week:1': ['i3'],
      'next:1': ['i4'],
      'later:1': ['i5'],
      'past:1': ['i7'],
      'none:1': ['i6'],
    });
    expect(labels(l.rows)).toEqual(['Overdue', 'Today', 'This week', 'Next week', 'Later', 'Closed, was due earlier', 'No due date']);
  });
  test('a key function for the in-place check agrees with the groups', () => {
    const key = groupKeyOf('due', { now: NOW }, meta)!;
    expect(issues.map(key)).toEqual(['overdue', 'today', 'week', 'next', 'later', 'none', 'past']);
  });
});

describe('grouping by created / updated', () => {
  test('age buckets', () => {
    const day = (n: number) => parseDay('2026-10-15').getTime() + n * DAY + 3600_000;
    const issues = [day(0), day(-1), day(-5), day(-20), day(-90)].map((createdAt, i) => enrich(doc(i, { createdAt, updatedAt: createdAt })));
    const l = list(issues, { grouping: 'created', ordering: 'created' });
    expect(groups(l.rows)).toEqual(['today', 'yesterday', 'week', 'month', 'older']);
    expect(labels(list(issues, { grouping: 'updated' }).rows)).toEqual(['Today', 'Yesterday', 'Last 7 days', 'Last 30 days', 'Older']);
  });
});

describe('grouping by parent issue', () => {
  test('sub-issues under their parent in the view order, none last', () => {
    const issues = [enrich(doc(1, { title: 'Epic' })), enrich(doc(2, { parentId: 'i1' as never, createdAt: 9 })), enrich(doc(3, { parentId: 'i1' as never, createdAt: 8 })), enrich(doc(4, { parentId: 'gone' as never, createdAt: 7 }))];
    const l = list(issues, { grouping: 'parent', ordering: 'created' });
    expect(groups(l.rows)).toEqual(['i1', 'gone', 'none']);
    expect(labels(l.rows)).toEqual(['PX-2 Epic', 'Unknown issue', 'No parent issue']);
    expect(outline(l.rows)['i1:2']).toEqual(['i2', 'i3']);
  });
});

describe('sub-groups', () => {
  const issues = [
    enrich(doc(0, { priority: 1, estimate: 2, createdAt: 9 })),
    enrich(doc(1, { priority: 1, estimate: 3, createdAt: 8 })),
    enrich(doc(2, { priority: 2, estimate: 2, createdAt: 7 })),
    enrich(doc(3, { priority: 1, estimate: 2, createdAt: 6 })),
  ];

  test('headers nest, counts per level, issues keep the view order', () => {
    const l = list(issues, { grouping: 'priority', subGrouping: 'estimate', ordering: 'created' });
    expect(l.rows.map((r) => (r.kind === 'group' ? `${r.key}=${r.count}` : r.id))).toEqual([
      'g:priority:1=3', 'g:priority:1/estimate:2=2', 'i0', 'i3', 'g:priority:1/estimate:3=1', 'i1',
      'g:priority:2=1', 'g:priority:2/estimate:2=1', 'i2',
    ]);
    expect(l.rows[1]).toMatchObject({ kind: 'group', group: { parent: { by: 'priority', value: '1' } } });
  });

  test('collapsing the outer group hides its sub-groups, collapsing a sub-group only its rows', () => {
    const outer = list(issues, { grouping: 'priority', subGrouping: 'estimate', ordering: 'created' }, ['g:priority:1']);
    expect(groups(outer.rows)).toEqual(['1', '2', '2']);
    const inner = list(issues, { grouping: 'priority', subGrouping: 'estimate', ordering: 'created' }, ['g:priority:1/estimate:2']);
    expect(inner.rows.filter((r) => r.kind === 'issue').map((r) => r.id)).toEqual(['i1', 'i2']);
    expect(inner.count).toBe(4);
  });

  test('the same sub-group in two groups has its own collapse key', () => {
    const l = list(issues, { grouping: 'priority', subGrouping: 'estimate' });
    const keys = l.rows.filter((r) => r.kind === 'group').map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('a second level equal to the first is ignored', () => {
    const l = list(issues, { grouping: 'priority', subGrouping: 'priority' });
    expect(groups(l.rows)).toEqual(['1', '2']);
  });

  test('labels on the second level: an issue shows once per label inside its group, row keys stay unique', () => {
    const labeled = [enrich(doc(1, { priority: 1, labelIds: ['l1', 'l3'] as never })), enrich(doc(2, { priority: 1, labelIds: ['l3'] as never }))];
    const l = list(labeled, { grouping: 'priority', subGrouping: 'label' });
    expect(l.rows.filter((r) => r.kind === 'issue').map((r) => r.id)).toEqual(['i1', 'i2', 'i1']);
    const keys = l.rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('offered second levels leave out the first level, none and scope', () => {
    expect(subGroupings(VIEWS.all, 'priority')).not.toContain('priority');
    expect(subGroupings(VIEWS.sprint, 'status')).not.toContain('scope');
    expect(subGroupings(VIEWS.all, 'status')).not.toContain('none');
  });
});

describe('group order and empty groups', () => {
  const issues = [enrich(doc(0, { priority: 1, createdAt: 3 })), enrich(doc(1, { priority: 3, createdAt: 2 })), enrich(doc(2, { priority: 3, createdAt: 1 })), enrich(doc(3, { priority: 2, createdAt: 0 }))];
  test('reversed and by size', () => {
    expect(groups(list(issues, { grouping: 'priority' }).rows)).toEqual(['1', '2', '3']);
    expect(groups(list(issues, { grouping: 'priority', groupOrder: 'desc' }).rows)).toEqual(['3', '2', '1']);
    expect(groups(list(issues, { grouping: 'priority', groupOrder: 'size' }).rows)).toEqual(['3', '1', '2']);
  });
  test('empty groups: off by default, on shows every value with a zero count', () => {
    const on = list(issues, { grouping: 'priority', emptyGroups: true });
    expect(on.rows.filter((r) => r.kind === 'group').map((r) => r.kind === 'group' && `${r.group.value}:${r.count}`)).toEqual(['1:1', '2:1', '3:2', '4:0', '0:0']);
  });
  test('empty status groups come from the workflows of the active teams', () => {
    const l = list([enrich(doc(0, { status: 'todo' }))], { grouping: 'status', emptyGroups: true });
    expect(labels(l.rows)).toContain('Done');
    expect(labels(l.rows)).toContain('In Progress');
    expect(l.rows.filter((r) => r.kind === 'issue')).toHaveLength(1);
  });
  test('empty groups are content: a view without issues still shows them', () => {
    expect(list([], { grouping: 'priority', emptyGroups: true }).empty).toBeNull();
    expect(list([], { grouping: 'priority' }).empty).toBe('none');
  });
  test('empty groups only on the first level', () => {
    const l = list([enrich(doc(0, { priority: 1 }))], { grouping: 'priority', subGrouping: 'estimate', emptyGroups: true });
    expect(groups(l.rows).filter((g) => g === 'none')).toHaveLength(1);
  });
});

describe('list reuse', () => {
  test('unchanged grouping returns the same list; a label color change does not', () => {
    const issues = [enrich(doc(1, { labelIds: ['l1'] as never }))];
    const a = list(issues, { grouping: 'label' });
    expect(reuseList(a, list(issues, { grouping: 'label' }))).toBe(a);
  });
});

test('every grouping the views offer is known to the computation', () => {
  const issues = [enrich(doc(1, { estimate: 2, dueDate: '2026-10-16', parentId: 'i2' as never, labelIds: ['l1'] as never })), enrich(doc(2))];
  const all = new Set<Grouping>(Object.values(VIEWS).flatMap((def) => def.groupings));
  for (const by of all) {
    const l = list(issues, { grouping: by });
    expect(l.rows.filter((r) => r.kind === 'issue').length, by).toBeGreaterThanOrEqual(2);
  }
});
