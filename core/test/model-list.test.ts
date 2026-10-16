import { describe, expect, test } from 'vitest';
import { App } from '../src/app/index.ts';
import { Auth } from '../src/auth.ts';
import type { ModelInfo } from '../src/models.ts';
import { computeList, computeVisible, emptyFilters } from '../src/query.ts';
import { readLocation, writeLocation } from '../src/route.ts';
import type { Display, Filters, Issue, IssueDoc, IssueId, ListRow, Meta, ViewRoute, ViewState } from '../src/types.ts';
import { VIEWS, type ViewContext } from '../src/views.ts';
import { doc, fakeClient, flush, meta } from './helpers.ts';

// Desired model per issue in lists (XLR8-93): filter, grouping and column by the effective model
// (own, parent's, team default), and sub-issues following a parent's change.

const OPUS: ModelInfo = { provider: 'anthropic', providerName: 'Anthropic', modelId: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'xhigh'], modes: ['fast'], enabled: true, logo: 'https://x/logo/anthropic' };
const SOL: ModelInfo = { provider: 'openai', providerName: 'OpenAI', modelId: 'gpt-6-sol', name: 'GPT-6 Sol', efforts: [], modes: [], enabled: true };
const withModels: Meta = {
  ...meta,
  models: [OPUS, SOL],
  // Team PX (t2) defaults to GPT-6 Sol.
  teams: meta.teams.map((t) => (t._id === 't2' ? { ...t, defaultModel: { provider: 'openai', modelId: 'gpt-6-sol' } } : t)),
};

const enrich = (d: IssueDoc): Issue => Object.freeze({ ...d, key: `${d.teamId === 't1' ? 'ACME' : 'PX'}-${d.number}` }) as Issue;
// i0, i2: team t1; i1, i3: team t2 (default Sol). i2 has Opus, i4 (t1) is a child of i2, i6 (t1) has a removed model.
const issues = [
  enrich(doc(0, { status: 'todo' })),
  enrich(doc(1, { status: 'todo' })),
  enrich(doc(2, { status: 'todo', model: { provider: 'anthropic', modelId: 'claude-opus-5-5', effort: 'xhigh' } })),
  enrich(doc(3, { status: 'todo', model: { provider: 'anthropic', modelId: 'claude-opus-5-5' } })),
  enrich(doc(4, { status: 'todo', parentId: 'i2' as IssueId })),
  enrich(doc(6, { status: 'todo', model: { provider: 'acme', modelId: 'old-1' } })),
];
const ctx = (): ViewContext => ({ teamId: null, activeSprintId: 's4', projectId: null, keep: new Set(), issueOf: (id) => issues.find((i) => i._id === id) });
const route: ViewRoute = { kind: 'all', team: null };
const view = (display: Partial<Display>, filters: Partial<Filters> = {}): ViewState => ({
  route,
  filters: { ...emptyFilters(), ...filters },
  quick: '',
  quickOpen: false,
  display: { ...VIEWS.all.display(route), ...display },
});
const visible = (filters: Partial<Filters>) => computeVisible(issues, view({}, filters), withModels, ctx()).map((i) => i._id).sort();
function outline(rows: ListRow[]) {
  const out: Record<string, string[]> = {};
  let key = '';
  for (const r of rows) {
    if (r.kind === 'group') out[(key = `${r.group.value}|${r.group.label}`)] = [];
    else out[key].push(r.id);
  }
  return out;
}

describe('filter by model', () => {
  test('one model, a whole provider, none; inherited values count', () => {
    expect(visible({ model: ['anthropic/claude-opus-5-5'] })).toEqual(['i2', 'i3', 'i4']);
    expect(visible({ model: ['openai'] })).toEqual(['i1']);
    expect(visible({ model: ['none'] })).toEqual(['i0']);
    expect(visible({ model: ['none', 'openai/gpt-6-sol'] })).toEqual(['i0', 'i1']);
    expect(visible({ model: ['acme/old-1'] })).toEqual(['i6']);
    // Same matching as MCP: a bare model ID, any case.
    expect(visible({ model: ['Claude-Opus-5-5'] })).toEqual(['i2', 'i3', 'i4']);
    expect(visible({ model: ['OpenAI'] })).toEqual(['i1']);
  });

  test('in the address', () => {
    const loc = readLocation(new URL('http://x/all?model=anthropic/claude-opus-5-5,none'));
    expect(loc.filters.model).toEqual(['anthropic/claude-opus-5-5', 'none']);
    const url = writeLocation(new URL('http://x/all'), { page: loc.page, filters: loc.filters, quick: '', group: 'model', sub: null, order: null });
    expect(url.searchParams.get('model')).toBe('anthropic/claude-opus-5-5,none');
    expect(url.searchParams.get('group')).toBe('model');
    // A comma inside a model ID survives the round trip.
    const odd = writeLocation(new URL('http://x/all'), { page: loc.page, filters: { ...loc.filters, model: ['x/a,b', 'none'] }, quick: '', group: null, sub: null, order: null });
    expect(readLocation(odd).filters.model).toEqual(['x/a,b', 'none']);
  });
});

describe('grouping by model', () => {
  test('one group per effective model whatever the effort; a model no longer enabled by its ID; then "No model"', () => {
    const v = view({ grouping: 'model', ordering: 'created' });
    const l = computeList(computeVisible(issues, v, withModels, ctx()), v, withModels, new Set(), true, { issueOf: (id) => issues.find((i) => i._id === id) });
    expect(outline(l.rows)).toEqual({
      'anthropic/claude-opus-5-5|Claude Opus 5.5': ['i4', 'i3', 'i2'],
      'openai/gpt-6-sol|GPT-6 Sol': ['i1'],
      'acme/old-1|old-1 · acme': ['i6'],
      'none|No model': ['i0'],
    });
  });
});

describe('list column', () => {
  let n = 0;
  async function setup() {
    const client = fakeClient();
    const app = new App({ client: client as never, auth: new Auth({ devToken: 'x' }), debug: true, perf: false, cacheName: `model-list-${++n}` });
    app.start();
    await flush();
    client.push('meta:get', {}, withModels);
    client.push('meta:counter', {}, { maxSeq: 63 });
    client.push('agents:list', {}, []);
    client.push('issues:bucket', { bucket: 0 }, issues.map(({ key: _k, ...d }) => d as IssueDoc));
    await flush();
    app.nav.goView({ kind: 'all', team: null }, { group: 'none', order: 'created' });
    app.main.toggleProp('model');
    return { client, app };
  }

  test('own model, inherited ones marked; a parent change redraws its sub-issues', async () => {
    const { client, app } = await setup();
    const row = (id: string) => app.main.rows.get(id as IssueId).get()!;
    expect(row('i2').model).toEqual({ label: 'Claude Opus 5.5 · xhigh', inherited: false, logo: 'https://x/logo/anthropic' });
    expect(row('i4').model).toEqual({ label: 'Claude Opus 5.5 · xhigh', inherited: true, logo: 'https://x/logo/anthropic' });
    expect(row('i1').model).toEqual({ label: 'GPT-6 Sol', inherited: true, logo: null });
    expect(row('i0').model).toBeNull();
    expect(row('i6').model).toEqual({ label: 'old-1', inherited: false, logo: null });

    client.push('issues:bucket', { bucket: 0 }, issues.map(({ key: _k, ...d }) => (d._id === 'i2' ? { ...d, model: { provider: 'openai', modelId: 'gpt-6-sol' } } : d) as IssueDoc));
    await flush();
    expect(row('i4').model).toEqual({ label: 'GPT-6 Sol', inherited: true, logo: null });
  });

  test('with the column hidden, a parent change still reaches its sub-issue once the column is shown', async () => {
    const { client, app } = await setup();
    app.main.toggleProp('model');
    client.push('issues:bucket', { bucket: 0 }, issues.map(({ key: _k, ...d }) => (d._id === 'i2' ? { ...d, model: { provider: 'openai', modelId: 'gpt-6-sol' } } : d) as IssueDoc));
    await flush();
    app.main.toggleProp('model');
    expect(app.main.rows.get('i4' as IssueId).get()!.model).toMatchObject({ label: 'GPT-6 Sol', inherited: true });
  });

  test('grouped by model, a parent change moves its sub-issue to the other group', async () => {
    const { client, app } = await setup();
    app.main.setDisplay({ grouping: 'model' });
    const groupOf = (id: string) => {
      let current = '';
      for (const r of app.main.list.get().rows) {
        if (r.kind === 'group') current = r.group.value;
        else if (r.id === id) return current;
      }
      return null;
    };
    expect(groupOf('i4')).toBe('anthropic/claude-opus-5-5');
    client.push('issues:bucket', { bucket: 0 }, issues.map(({ key: _k, ...d }) => (d._id === 'i2' ? { ...d, model: { provider: 'openai', modelId: 'gpt-6-sol' } } : d) as IssueDoc));
    await flush();
    expect(groupOf('i4')).toBe('openai/gpt-6-sol');
  });

  test('filter picker: none, providers, models; the chip names them', async () => {
    const { app } = await setup();
    app.palette.open('filter');
    const s = () => app.palette.state.get()!;
    app.palette.choose(s().items.findIndex((i) => i.id === 'ff:model'));
    expect(s().items.map((i) => i.label)).toEqual(['No model', 'Anthropic', 'OpenAI', 'Claude Opus 5.5', 'GPT-6 Sol']);
    app.palette.choose(s().items.findIndex((i) => i.id === 'fm:p:anthropic'));
    expect(app.main.view.get().filters.model).toEqual(['anthropic']);
    expect(app.main.header.get().chips).toContainEqual({ field: 'model', label: 'Model: Anthropic' });
  });
});
