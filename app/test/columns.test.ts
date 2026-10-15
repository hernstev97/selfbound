// List row as table columns (rowHtml) and thresholds of the column stages (columns).
import type { DisplayProp, IssueId, RowState } from '@selfbound/core';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { COLUMN_WIDTH, columnPlan, groupColsHtml, stageOf } from '../src/lib/columns.ts';
import { labelStackHtml, rowRestHtml } from '../src/lib/rowHtml.ts';

const row = (over: Partial<RowState> = {}): RowState => ({
  id: 'i1' as IssueId,
  key: 'ORB-1',
  title: 'Title',
  status: 'todo',
  statusLabel: 'Todo',
  statusColor: null,
  priority: 2,
  priorityLabel: 'High',
  team: { id: 't', key: 'ORB', name: 'Orbit', hue: 200, logo: null },
  labels: [],
  project: null,
  sprint: null,
  estimate: null,
  model: null,
  due: null,
  snoozed: null,
  created: 'Oct 1',
  updated: 'Oct 2',
  age: '',
  deleted: null,
  unread: false,
  inboxText: '',
  pending: false,
  createdBy: 'You',
  decision: null,
  focused: false,
  selected: false,
  ...over,
});
const props = (...p: DisplayProp[]) => new Set<DisplayProp>(p);

describe('rowRestHtml: columns', () => {
  it('every enabled column is in the DOM, as an empty cell without a value, right to left', () => {
    const html = rowRestHtml(row({ estimate: 3 }), props('labels', 'project', 'estimate', 'due', 'created'), false);
    const cells = [...html.matchAll(/class="c c-(\w+)/g)].map((m) => m[1]);
    expect(cells).toEqual(['due', 'estimate', 'project', 'labels']);
    expect(html).toContain('<span class="c c-due"></span>');
    expect(html).toContain('<span class="c c-project"></span>');
    expect(html).toContain('<span class="c c-labels"></span>');
    expect(html).toMatch(/<span class="row-end"><span class="row-date" title="Created">Oct 1<\/span><\/span>$/);
  });

  it('disabled columns are missing entirely; without dates no right column', () => {
    const html = rowRestHtml(row(), props('estimate'), false);
    expect(html).not.toContain('c-labels');
    expect(html).not.toContain('row-end');
  });

  it('pills sit in their own cell, user text is escaped', () => {
    const html = rowRestHtml(row({ project: '<b>P</b>', labels: [{ id: 'l', name: 'A&B', hue: 1 }] }), props('project', 'labels'), false);
    expect(html).toContain('<span class="c c-project"><span class="pill project"');
    expect(html).toContain('&lt;b&gt;P&lt;/b&gt;');
    expect(html).toContain('A&amp;B');
    expect(html).not.toContain('<b>');
  });

  it('model: own and inherited (dimmed), escaped, empty cell without one', () => {
    const own = rowRestHtml(row({ model: { label: 'Claude <Opus>', inherited: false, logo: null } }), props('model'), false);
    expect(own).toContain('<span class="c c-model"><span class="pill mi ui-model" title="Claude &lt;Opus&gt;">Claude &lt;Opus&gt;</span></span>');
    // With the provider's logo: a mask class per logo (lib/providerLogo.ts).
    const inherited = rowRestHtml(row({ model: { label: 'GPT-6 Sol', inherited: true, logo: 'https://x/logo/abc' } }), props('model'), false);
    expect(inherited).toMatch(/class="pill mi plogo pl-\d+ inherited"/);
    expect(rowRestHtml(row(), props('model'), false)).toContain('<span class="c c-model"></span>');
  });

  it('trash: columns stay, "Restore" on the right', () => {
    const html = rowRestHtml(row({ deleted: '2 days ago', estimate: 1 }), props('estimate', 'created'), true);
    expect(html).toContain('c-estimate row-est');
    expect(html).toContain('data-cell="restore"');
    expect(html).not.toContain('title="Created"');
  });
});

describe('columnPlan', () => {
  it('medium = wide without the label column; equal without labels', () => {
    const all = props('priority', 'id', 'status', 'labels', 'project', 'estimate', 'created');
    const plan = columnPlan(all, 60);
    expect(plan.wide - plan.mid).toBe(COLUMN_WIDTH.labels + 8);
    const noLabels = columnPlan(props('priority', 'id', 'status', 'project', 'estimate', 'created'), 60);
    expect(noLabels.mid).toBe(noLabels.wide);
    expect(noLabels.wide).toBe(plan.mid);
  });

  it('every additional column moves the threshold by its width', () => {
    const base = columnPlan(props('id', 'status'), 60);
    expect(columnPlan(props('id', 'status', 'sprint'), 60).wide - base.wide).toBe(COLUMN_WIDTH.sprint + 8);
    expect(columnPlan(props('id', 'status'), 90).wide - base.wide).toBe(30);
  });

  it('stage from the list width', () => {
    const plan = { wide: 1200, mid: 1000 };
    expect(stageOf(1200, plan)).toBe('wide');
    expect(stageOf(1199, plan)).toBe('mid');
    expect(stageOf(1000, plan)).toBe('mid');
    expect(stageOf(999, plan)).toBe('narrow');
  });

  it('column widths in app.css match COLUMN_WIDTH (thresholds and rendering agree)', () => {
    const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');
    for (const [prop, w] of Object.entries(COLUMN_WIDTH)) expect(css).toContain(`--cw-${prop}: ${w}px;`);
  });

  it('header icons in the same order as the cells, dates separate', () => {
    const html = groupColsHtml(props('labels', 'project', 'estimate', 'created', 'updated'));
    expect([...html.matchAll(/class="c c-(\w+)/g)].map((m) => m[1])).toEqual(['estimate', 'project', 'labels']);
    expect(html).toContain('<span class="group-end" aria-hidden="true">');
    expect(html.indexOf('title="Updated"')).toBeLessThan(html.indexOf('title="Created"'));
    expect(groupColsHtml(props('estimate'))).not.toContain('group-end');
  });
});

describe('rowRestHtml: decision', () => {
  it('sits left of the dates (after them in the DOM) so the dates stay aligned', () => {
    const html = rowRestHtml(row({ decision: { outcome: 'next', label: 'Next sprint' } }), props('created'), false);
    expect(html.indexOf('title="Created"')).toBeLessThan(html.indexOf('row-decision'));
  });
});

describe('labelStackHtml', () => {
  const labels = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `l${i}`, name: `Label ${i}`, hue: i * 10 }));
  const count = (html: string, cls: string) => html.split(`class="${cls}`).length - 1;

  it('no labels: empty cell, up to three labels: only chips, every chip with its full name as tooltip', () => {
    expect(labelStackHtml([], 'c c-labels')).toBe('<span class="c c-labels"></span>');
    const html = labelStackHtml(labels(3), 'card-labels');
    expect(count(html, 'pill label')).toBe(3);
    expect(html).not.toContain('class="more');
    expect(html.startsWith('<span class="card-labels lstack" data-cell="labels">')).toBe(true);
    for (let i = 0; i < 3; i++) expect(html).toContain(`title="Label ${i}">Label ${i}</span>`);
  });

  it('more than three: three chips and one "+n" chip (dots in the colors of the rest, their names in the tooltip)', () => {
    const html = labelStackHtml(labels(5), 'c c-labels');
    expect(count(html, 'pill label')).toBe(3);
    expect([...html.matchAll(/class="more d(\d)" style="--n:1;([^"]*)" title="([^"]*)">\+(\d)</g)].map((m) => [m[1], m[2], m[3], m[4]])).toEqual([['2', '--c0:30;--c1:40;', 'Label 3, Label 4', '2']]);
    expect(html.endsWith('</span></span>')).toBe(true);
  });

  it('dots up to three, two digit counts are announced for the chip width, names are escaped', () => {
    const html = labelStackHtml([...labels(12), { id: 'x', name: '<b>"x"</b>', hue: 1 }], 'c c-labels');
    expect(html).toContain('class="more d3" style="--n:2;--c0:30;--c1:40;--c2:50;"');
    expect(html).toContain('+10<');
    expect(html).toContain('&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
    expect(html).not.toContain('<b>');
  });
});
