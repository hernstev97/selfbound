import { describe, expect, test } from 'vitest';
import { checkToolArguments, TOOLS } from '../../../convex/lib/mcp/tools';

const ok = <T>(r: { ok: true; value: T } | { ok: false; errors: string[] }) => {
  if (!r.ok) throw new Error(`expected ok, got: ${r.errors.join(' | ')}`);
  return r.value;
};
const errors = (r: { ok: boolean; errors?: string[] }) => {
  expect(r.ok).toBe(false);
  return (r as { errors: string[] }).errors;
};

describe('tool definitions', () => {
  test('every tool has a title, a description, an object schema and annotations', () => {
    for (const t of TOOLS) {
      expect(t.title.length).toBeGreaterThan(3);
      expect(t.description.length).toBeGreaterThan(30);
      expect(t.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(t.annotations).toMatchObject({ openWorldHint: false });
      expect(typeof t.annotations.readOnlyHint).toBe('boolean');
      expect(typeof t.annotations.idempotentHint).toBe('boolean');
      expect(typeof t.annotations.destructiveHint).toBe('boolean');
    }
  });

  test('read tools are readOnly, write tools are not', () => {
    const ro = Object.fromEntries(TOOLS.map((t) => [t.name, t.annotations.readOnlyHint]));
    expect(ro).toMatchObject({
      search_issues: true,
      list_issues: true,
      get_issue: true,
      get_current_sprint: true,
      list_teams: true,
      list_projects: true,
      list_labels: true,
      list_models: true,
      create_issues: false,
      update_issue: false,
      set_status: false,
      move_issues: false,
      add_comment: false,
    });
  });

  test('"assigned" is explained in the description', () => {
    const list = TOOLS.find((t) => t.name === 'list_issues')!;
    const filter = (list.inputSchema.properties as Record<string, { description: string }>).filter!;
    expect(filter.description).toMatch(/assigned.*open.*triage.*dormant/s);
    expect(filter.description).toMatch(/no assignee/);
  });
});

describe('argument validation', () => {
  test('defaults and normalization', () => {
    expect(ok(checkToolArguments('search_issues', { q: '  search ', team: 'acme' }))).toEqual({
      q: 'search',
      team: 'ACME',
      includeClosed: true,
      limit: 20,
    });
    expect(ok(checkToolArguments('list_issues', {}))).toEqual({ dueWithinDays: 7, limit: 50 });
    expect(ok(checkToolArguments('list_teams', undefined))).toEqual({ includeDormant: true });
  });

  test('list_issues: filter, status list, limit ≤ 100', () => {
    expect(ok(checkToolArguments('list_issues', { filter: 'overdue', status: ['todo', 'in_progress'], limit: 100 }))).toMatchObject({
      filter: 'overdue',
      status: ['todo', 'in_progress'],
      limit: 100,
    });
    expect(errors(checkToolArguments('list_issues', { limit: 101 }))).toEqual(['limit: must be <= 100']);
    expect(errors(checkToolArguments('list_issues', { limit: 1.5 }))[0]).toMatch(/limit: expected an integer/);
    // Statuses are team-specific names: they are checked when resolved in the team, here only as text.
    expect(ok(checkToolArguments('list_issues', { status: [' In Review '] }))).toMatchObject({ status: ['In Review'] });
    expect(errors(checkToolArguments('list_issues', { status: [''] }))[0]).toMatch(/status\[0\]: must be at least 1 character/);
    expect(errors(checkToolArguments('list_issues', { status: [] }))).toEqual(['status: needs at least 1 item']);
    expect(errors(checkToolArguments('list_issues', { status: ['todo', 'todo'] }))[0]).toMatch(/more than once/);
  });

  test('get_issue: exactly one of identifier or id', () => {
    expect(ok(checkToolArguments('get_issue', { identifier: 'acme-106' }))).toEqual({ identifier: 'ACME-106' });
    expect(ok(checkToolArguments('get_issue', { id: 'k57abc' }))).toEqual({ id: 'k57abc' });
    expect(errors(checkToolArguments('get_issue', {}))).toEqual(['arguments: give exactly one of identifier or id']);
    expect(errors(checkToolArguments('get_issue', { identifier: 'ACME-1', id: 'x' }))).toHaveLength(1);
    // Spellings the UI search accepts.
    expect(ok(checkToolArguments('get_issue', { identifier: 'ACME106' }))).toEqual({ identifier: 'ACME-106' });
    expect(ok(checkToolArguments('get_issue', { identifier: 'acme 0106' }))).toEqual({ identifier: 'ACME-106' });
    expect(ok(checkToolArguments('get_issue', { identifier: 'K8S12' }))).toEqual({ identifier: 'K8S12' });
    expect(errors(checkToolArguments('get_issue', { identifier: 'ACME' }))[0]).toMatch(/not an issue identifier like "ACME-106"/);
    expect(errors(checkToolArguments('get_issue', { identifier: 'ACME-0' }))).toHaveLength(1);
  });

  test('create_issues: requestId required, 1–50 issues, priority as a word', () => {
    const value = ok(
      checkToolArguments('create_issues', {
        requestId: 'req-2026-10-08-0001',
        issues: [
          { team: 'acme', title: ' New issue ', priority: 'High', labels: ['Bug'], dueDate: '2026-10-31', parent: 'acme-100' },
          { team: 'XLR', title: 'Second', priority: 0, estimate: 2.5, status: 'todo', project: 'MVP' },
        ],
      }),
    );
    expect(value.issues[0]).toEqual({
      team: 'ACME',
      title: 'New issue',
      priority: 2,
      labels: ['Bug'],
      dueDate: '2026-10-31',
      parent: 'ACME-100',
    });
    expect(value.issues[1]!.priority).toBe(0);

    expect(errors(checkToolArguments('create_issues', { issues: [{ team: 'ACME', title: 'x' }] }))).toEqual(['requestId: required']);
    expect(errors(checkToolArguments('create_issues', { requestId: 'req-00001', issues: [] }))).toEqual([
      'issues: needs at least 1 item',
    ]);
    const many = Array.from({ length: 51 }, (_, i) => ({ team: 'ACME', title: `T${i}` }));
    expect(errors(checkToolArguments('create_issues', { requestId: 'req-00001', issues: many }))).toEqual([
      'issues: allows at most 50 items',
    ]);
    const bad = errors(
      checkToolArguments('create_issues', {
        requestId: 'req-00001',
        issues: [{ team: 'K', title: '', priority: 'critical', dueDate: '2026-02-30', assignee: 'me' }],
      }),
    );
    expect(bad).toEqual([
      'issues[0].assignee: unknown field (allowed: team, title, description, status, priority, labels, project, estimate, dueDate, parent, model)',
      'issues[0].team: "K" is not a team key like "ACME"',
      'issues[0].title: must be at least 1 character long',
      'issues[0].priority: "critical" is not a priority (0-4 or none/urgent/high/medium/low)',
      'issues[0].dueDate: 2026-02-30 is not a real date',
    ]);
    expect(errors(checkToolArguments('create_issues', { requestId: 'short', issues: [{ team: 'ACME', title: 'x' }] }))).toEqual([
      'requestId: must be at least 8 characters long',
    ]);
  });

  test('model: object with provider and model ID, null removes it in update_issue', () => {
    const ok = checkToolArguments('update_issue', { identifier: 'acme-1', model: { provider: ' anthropic ', modelId: 'claude-opus-5-5', effort: 'xhigh' } });
    expect(ok.ok && ok.value.model).toEqual({ provider: 'anthropic', modelId: 'claude-opus-5-5', effort: 'xhigh' });
    const cleared = checkToolArguments('update_issue', { identifier: 'acme-1', model: null });
    expect(cleared.ok && cleared.value.model).toBeNull();
    expect(errors(checkToolArguments('update_issue', { identifier: 'acme-1', model: 'anthropic/claude-opus-5-5' }))).toEqual([
      'model: expected an object, got string',
    ]);
    expect(errors(checkToolArguments('create_issues', { requestId: 'req-00001', issues: [{ team: 'ACME', title: 'x', model: { provider: 'anthropic' } }] }))).toEqual([
      'issues[0].model.modelId: required',
    ]);
  });

  test('all priority words', () => {
    const p = (priority: unknown) =>
      checkToolArguments('update_issue', { identifier: 'ACME-1', priority }) as { ok: boolean; value?: { priority: number } };
    expect([' none', 'URGENT', 'high', 'Medium', 'low'].map((w) => p(w).value?.priority)).toEqual([0, 1, 2, 3, 4]);
    expect(p(5).ok).toBe(false);
    expect(p(-1).ok).toBe(false);
  });

  test('update_issue: description only with version, null removes, expected', () => {
    expect(ok(checkToolArguments('update_issue', { identifier: 'ACME-1', dueDate: null, project: null, estimate: 3 }))).toEqual({
      identifier: 'ACME-1',
      dueDate: null,
      project: null,
      estimate: 3,
    });
    expect(errors(checkToolArguments('update_issue', { identifier: 'ACME-1', description: 'new' }))).toEqual([
      'expectedDescriptionVersion: required when changing the description (read it with get_issue)',
    ]);
    expect(
      ok(checkToolArguments('update_issue', { identifier: 'ACME-1', description: 'new', expectedDescriptionVersion: 3 })),
    ).toMatchObject({ expectedDescriptionVersion: 3 });
    expect(errors(checkToolArguments('update_issue', { identifier: 'ACME-1' }))[0]).toMatch(/nothing to change/);
    expect(
      ok(
        checkToolArguments('update_issue', {
          identifier: 'ACME-1',
          status: 'done',
          expected: { status: 'in_progress', priority: 'low', labels: ['Bug'], dueDate: null },
        }),
      ).expected,
    ).toEqual({ status: 'in_progress', priority: 4, labels: ['Bug'], dueDate: null });
    expect(errors(checkToolArguments('update_issue', { identifier: 'ACME-1', status: 'done', expected: { colour: 1 } }))[0]).toMatch(
      /^expected\.colour: unknown field/,
    );
  });

  test('move_issues', () => {
    expect(ok(checkToolArguments('move_issues', { identifiers: ['ops-24', 'OPS 25'], team: ' acme ' }))).toEqual({ identifiers: ['OPS-24', 'OPS-25'], team: 'ACME' });
    expect(errors(checkToolArguments('move_issues', { identifiers: [], team: 'ACME' }))).toHaveLength(1);
    expect(errors(checkToolArguments('move_issues', { identifiers: ['OPS-1'] }))).toHaveLength(1);
    expect(errors(checkToolArguments('move_issues', { identifiers: ['OPS-1', 'ops1'], team: 'ACME' }))).toHaveLength(1);
    expect(errors(checkToolArguments('move_issues', { identifiers: ['OPS-1'], team: 'ACME', requestId: 'short' }))).toHaveLength(1);
  });

  test('set_status and add_comment', () => {
    expect(ok(checkToolArguments('set_status', { identifiers: ['acme-1', 'XLR-2'], status: 'done' }))).toEqual({
      identifiers: ['ACME-1', 'XLR-2'],
      status: 'done',
    });
    expect(errors(checkToolArguments('set_status', { identifiers: ['ACME-1'], status: '' }))).toHaveLength(1);
    expect(errors(checkToolArguments('set_status', { identifiers: ['ACME-1'], status: 'x'.repeat(41) }))).toHaveLength(1);
    expect(errors(checkToolArguments('add_comment', { identifier: 'ACME-1', body: '' }))).toEqual([
      'requestId: required',
      'body: must be at least 1 character long',
    ]);
  });

  test('type errors are named clearly', () => {
    expect(errors(checkToolArguments('search_issues', { q: 5 }))).toEqual(['q: expected a string, got number']);
    expect(errors(checkToolArguments('search_issues', 'search'))).toEqual(['arguments: expected an object, got string']);
    expect(errors(checkToolArguments('list_teams', { includeDormant: 'yes' }))).toEqual([
      'includeDormant: expected true or false, got string',
    ]);
    expect(errors(checkToolArguments('get_current_sprint', { x: 1 }))).toEqual(['x: unknown field (allowed: none)']);
  });
});
