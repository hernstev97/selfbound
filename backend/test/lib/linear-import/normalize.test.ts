import { describe, expect, test } from 'vitest';
import {
  dayInBerlin,
  mapStatus,
  normalize,
  parseStatusOverrides,
  pullRequestOf,
  pullRequestState,
  snapshotCounts,
  stagingRows,
  UnknownStatusError,
} from '../../../../tooling/linear-import/normalize.ts';
import { IMPORT_KINDS_PHASE_1, IMPORT_KINDS_PHASE_2 } from '../../../convex/shared/importTypes';
import { rawData, SECRET_TEXT } from './fixtures';

const OPTS = { run: '2026-10-08T21-30-00Z', fetchedAt: Date.UTC(2026, 9, 8, 21, 30) };

describe('status mapping', () => {
  test.each([
    ['Triage', 'triage', 'triage'],
    ['Backlog', 'backlog', 'backlog'],
    ['Todo', 'unstarted', 'todo'],
    ['Planned', 'unstarted', 'todo'],
    ['In Progress', 'started', 'in_progress'],
    ['In Review', 'started', 'in_review'],
    ['in review ', 'started', 'in_review'],
    ['Testing', 'started', 'in_progress'],
    ['Done', 'completed', 'done'],
    ['Canceled', 'canceled', 'canceled'],
    ['Duplicate', 'canceled', 'duplicate'],
    ['Duplicate', 'duplicate', 'duplicate'],
    ['Dupe', 'duplicate', 'duplicate'],
  ])('%s (%s) → %s', (name, type, expected) => {
    expect(mapStatus(name, type)).toBe(expected);
  });

  test('unknown type → undefined, the manual mapping wins', () => {
    expect(mapStatus('Parking', 'parked')).toBeUndefined();
    expect(mapStatus('Parking', 'parked', { parking: 'backlog' })).toBe('backlog');
    expect(mapStatus('Testing', 'started', { Testing: 'in_review' })).toBe('in_review');
  });

  test('parseStatusOverrides', () => {
    expect(parseStatusOverrides(['Blocked=in_progress', 'A=B=todo'])).toEqual({ Blocked: 'in_progress', 'A=B': 'todo' });
    expect(() => parseStatusOverrides(['Blocked=doing'])).toThrow(/is invalid/);
    expect(() => parseStatusOverrides(['=todo'])).toThrow(/is invalid/);
  });

  test('an unknown status aborts with a list', () => {
    const raw = rawData();
    raw.issues[0]!.state = { id: 's-x', name: 'Parking', type: 'parked' };
    raw.issues[1]!.state = { id: 's-x', name: 'Parking', type: 'parked' };
    raw.issues[3]!.state = { id: 's-y', name: 'Waiting', type: '' };
    let error: unknown;
    try {
      normalize(raw, OPTS);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnknownStatusError);
    expect((error as UnknownStatusError).unknown).toEqual([
      { team: 'KIU', name: 'Parking', type: 'parked', issues: 2 },
      { team: 'XLR', name: 'Waiting', type: '', issues: 1 },
    ]);
    expect((error as Error).message).toContain('team KIU: "Parking" (type parked), 2 issue(s)');
    expect((error as Error).message).toContain('--map-status');
    // with a manual mapping it goes through
    expect(() => normalize(raw, { ...OPTS, statusOverrides: { Parking: 'backlog', Waiting: 'todo' } })).not.toThrow();
  });
});

describe('normalize', () => {
  const snap = normalize(rawData(), OPTS);
  const issue = (identifier: string) => snap.issues.find((i) => i.identifier === identifier)!;

  test('counts', () => {
    expect(snapshotCounts(snap)).toEqual({
      teams: 3,
      labelGroups: 1,
      labels: 4,
      projects: 2,
      sprints: 2,
      issues: 7,
      comments: 32,
      relations: 2,
      pullRequests: 2,
      links: 1,
    });
  });

  test('teams: archived → dormant', () => {
    expect(snap.teams.map((t) => [t.key, t.dormant])).toEqual([
      ['KIU', false],
      ['XLR', false],
      ['OLD', true],
    ]);
  });

  test('issues: trash removed, ordered by createdAt, fields', () => {
    expect(snap.issues.map((i) => [i.identifier, i.order])).toEqual([
      ['KIU-1', 0],
      ['KIU-2', 1],
      ['KIU-3', 2],
      ['XLR-1', 3],
      ['KIU-4', 4],
      ['KIU-5', 5],
      ['KIU-6', 6],
    ]);
    expect(issue('KIU-2')).toMatchObject({
      linearId: 'i-2',
      teamKey: 'KIU',
      teamLinearId: 'team-kiu',
      number: 2,
      status: 'in_review',
      linearStateName: 'In Review',
      priority: 2,
      estimate: 3,
      dueDate: '2026-10-20',
      labelLinearIds: ['l-bug', 'l-ui'],
      projectLinearId: 'p-web',
      parentLinearId: 'i-1',
      cycleLinearId: 'c-2',
      previousIdentifiers: ['OLD-7'],
      createdAt: Date.UTC(2026, 8, 6, 9),
      startedAt: Date.UTC(2026, 8, 7, 9),
    });
    expect(issue('KIU-3').status).toBe('duplicate');
    expect(issue('KIU-6').status).toBe('canceled');
    expect(issue('KIU-1').status).toBe('done');
    expect(issue('KIU-4')).toMatchObject({ status: 'triage', archivedAt: Date.UTC(2026, 8, 12, 9) });
    expect(issue('KIU-4').parentLinearId).toBeUndefined(); // the parent is in the trash
    expect(issue('XLR-1').status).toBe('in_progress');
    expect(issue('XLR-1').labelLinearIds).toEqual(['l-agent']);
    expect(issue('KIU-5').estimate).toBeUndefined();
  });

  test('labels and groups', () => {
    expect(snap.labelGroups).toEqual([{ linearId: 'lg-type', name: 'Type', color: '#888888', exclusive: true, teamLinearId: undefined }]);
    expect(snap.labels.find((l) => l.linearId === 'l-bug')).toMatchObject({ groupLinearId: 'lg-type' });
    expect(snap.labels.find((l) => l.linearId === 'l-ui')).toMatchObject({ teamLinearId: 'team-kiu', archived: true });
  });

  test('projects: state and one team (the one with the most issues)', () => {
    expect(snap.projects.map((p) => [p.name, p.state, p.teamLinearId, p.teamLinearIds.length])).toEqual([
      ['MVP', 'active', 'team-xlr', 1],
      ['Website', 'done', 'team-kiu', 2],
    ]);
  });

  test('cycles → sprints with source linear, days in Europe/Berlin', () => {
    expect(snap.sprints.map((s) => [s.linearId, s.source, s.name, s.startDate, s.endDate])).toEqual([
      ['c-1', 'linear', 'Start', '2026-09-01', '2026-09-14'],
      ['c-2', 'linear', 'KIU Cycle 2', '2026-09-15', '2026-09-28'],
    ]);
    expect(dayInBerlin(Date.UTC(2026, 11, 31, 23, 30))).toBe('2027-01-01');
  });

  test('comments: author, bot, thread reply', () => {
    const bot = snap.comments.find((c) => c.linearId === 'cb-1')!;
    expect(bot).toMatchObject({ authorName: 'GitHub (Linear)', authorKind: 'bot', issueLinearId: 'i-1' });
    expect(snap.comments.find((c) => c.linearId === 'cr-1')).toMatchObject({
      authorName: 'Owner (Linear)',
      authorKind: 'user',
      parentLinearId: 'cb-1',
    });
    const times = snap.comments.map((c) => c.createdAt);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  test('relations: similar and missing targets are dropped', () => {
    expect(snap.relations).toEqual([
      { linearId: 'r-1', type: 'blocks', fromLinearId: 'i-2', toLinearId: 'i-3' },
      { linearId: 'r-4', type: 'duplicate', fromLinearId: 'i-3', toLinearId: 'i-1' },
    ]);
  });

  test('PR attachments → links to PRs, duplicate PRs once, other attachments stay links', () => {
    expect(snap.pullRequests).toEqual([
      {
        attachmentLinearId: 'a-pr',
        issueLinearId: 'i-2',
        repo: 'acme/app',
        number: 42,
        url: 'https://github.com/acme/app/pull/42',
        title: 'Search field #42',
        state: 'merged',
        branch: 'octocat/kiu-2-search-field',
        createdAt: Date.UTC(2026, 8, 8, 9),
      },
      expect.objectContaining({ attachmentLinearId: 'a-pr2', repo: 'acme/xlr8', number: 7, state: 'open' }),
    ]);
    expect(snap.links).toEqual([expect.objectContaining({ linearId: 'a-link', sourceType: 'figma' })]);
    expect(pullRequestOf({ url: 'https://github.com/a/b/issues/3' } as never)).toBeUndefined();
    expect(pullRequestState({ status: 'closed' })).toBe('closed');
    expect(pullRequestState({ draft: true })).toBe('draft');
    expect(pullRequestState(null)).toBeUndefined();
  });

  test('notes contain only counts, ids and status names', () => {
    expect(snap.notes).toEqual([
      'Dormant teams (archived/retired in Linear): OLD',
      'In the Linear trash, not imported: 1 issue(s)',
      'Projects with several teams (assigned to the team with the most issues): 1',
      'Status "Testing (started)" mapped to in_progress',
      'Label assignments to unknown labels (skipped): 1',
      'Parent not in the import (parent removed): KIU-4',
      'Issues archived in Linear (imported normally): 1',
      'Linear "similar" suggestions not imported: 1',
      'Relations to issues outside the import not imported: 1',
      'PR attachments without a recognizable state (imported as "open"): 1',
      'Other attachments stay links (files are not copied): 1',
    ]);
    expect(snap.notes.join('\n')).not.toContain(SECRET_TEXT);
  });

  test('staging.jsonl: phase 1 before phase 2, row format', () => {
    const rows = stagingRows(snap);
    expect(rows).toHaveLength(Object.values(snapshotCounts(snap)).reduce((a, b) => a + b, 0));
    const order = [...IMPORT_KINDS_PHASE_1, ...IMPORT_KINDS_PHASE_2] as string[];
    const kinds = rows.map((r) => order.indexOf(r.kind));
    expect(kinds).toEqual([...kinds].sort((a, b) => a - b));
    expect(kinds.includes(-1)).toBe(false);
    for (const row of rows) {
      expect(Object.keys(row)).toEqual(['run', 'kind', 'linearId', 'payload']);
      expect(row.run).toBe(OPTS.run);
    }
    expect(rows.find((r) => r.kind === 'issue')!.payload).toMatchObject({ identifier: 'KIU-1' });
    // values Convex accepts: no null, no keys starting with $ or _
    const text = rows.map((r) => JSON.stringify(r)).join('\n');
    expect(text).not.toMatch(/":null/);
    expect(text).not.toMatch(/"[$_][^"]*":/);
  });

  test('normalizing twice gives the same result (repeatable)', () => {
    expect(normalize(rawData(), OPTS)).toEqual(snap);
  });
});
