import { describe, expect, test } from 'vitest';
import { App } from '../src/app/index.ts';
import { KEYMAP, actionById } from '../src/app/actions.ts';
import { historyText } from '../src/app/historyText.ts';
import { Auth } from '../src/auth.ts';
import { entryText } from '../src/inboxText.ts';
import { issueModel, modelLabel, type ModelInfo } from '../src/models.ts';
import type { IssueId, Meta } from '../src/types.ts';
import { callName, doc, entry, fakeClient, flush, meta } from './helpers.ts';

// Desired model per issue (XLR8-93): the step-by-step picker (provider → model → effort → speed),
// inheritance from the parent and the team default, and the texts in history and inbox.

const OPUS: ModelInfo = { provider: 'anthropic', providerName: 'Anthropic', modelId: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], modes: ['fast'], context: 1_000_000, enabled: true };
const HAIKU: ModelInfo = { provider: 'anthropic', providerName: 'Anthropic', modelId: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', efforts: [], modes: [], context: 200_000, enabled: true };
const SOL: ModelInfo = { provider: 'openai', providerName: 'OpenAI', modelId: 'gpt-6-sol', name: 'GPT-6 Sol', efforts: ['none', 'low', 'high'], modes: ['fast', 'pro'], enabled: true };
const OLD: ModelInfo = { provider: 'openai', providerName: 'OpenAI', modelId: 'gpt-4', name: 'GPT-4', efforts: [], modes: [], enabled: true, removed: true };

const withModels = (models: ModelInfo[]): Meta => ({
  ...meta,
  models,
  teams: meta.teams.map((t) => (t._id === 't2' ? { ...t, defaultModel: { provider: 'openai', modelId: 'gpt-6-sol', speed: 'pro' } } : t)),
});

let n = 0;
async function setup(models = [OPUS, HAIKU, SOL, OLD]) {
  const client = fakeClient();
  const app = new App({ client: client as never, auth: new Auth({ devToken: 'x' }), debug: true, perf: false, cacheName: `model-${++n}` });
  app.start();
  await flush();
  client.push('meta:get', {}, withModels(models));
  client.push('meta:counter', {}, { maxSeq: 63 });
  client.push('agents:list', {}, [{ _id: 'a1', name: 'Aleister' }]);
  client.push('issues:bucket', { bucket: 0 }, [
    doc(0, { status: 'todo' }),
    doc(1, { status: 'todo' }),
    doc(2, { status: 'todo', model: { provider: 'anthropic', modelId: 'claude-opus-5-5', effort: 'high' } }),
    doc(4, { status: 'todo', parentId: 'i2' as IssueId }),
  ]);
  await flush();
  return { client, app };
}

const state = (app: App) => app.palette.state.get()!;
const ids = (app: App) => state(app).items.map((i) => i.id);
const pick = (app: App, id: string) => {
  const index = state(app).items.findIndex((i) => i.id === id);
  expect(index, id).toBeGreaterThanOrEqual(0);
  app.palette.choose(index);
};
const updates = (client: ReturnType<typeof fakeClient>) => client.mutation.mock.calls.filter((c) => callName(c) === 'issues:update').map((c) => c[1] as { ids: string[]; patch: unknown });

describe('model picker', () => {
  test('⇧M: provider, model, effort, speed, each with what fits; models gone from the catalog are not offered', async () => {
    const { client, app } = await setup();
    expect(KEYMAP.get('shift+m')?.map((a) => a.id)).toEqual(['issue.model']);
    app.palette.open('model', { target: { kind: 'issues', ids: ['i0' as IssueId] } });
    expect(state(app)).toMatchObject({ kind: 'model', title: 'Model', parent: null });
    expect(ids(app)).toEqual(['m:none', 'mp:anthropic', 'mp:openai']);
    expect(state(app).items[1]).toMatchObject({ label: 'Anthropic', detail: '2 models', submenu: true });
    expect(state(app).items[2]).toMatchObject({ detail: '1 model' });

    pick(app, 'mp:anthropic');
    expect(state(app)).toMatchObject({ parent: 'Anthropic', query: '' });
    expect(state(app).items.map((i) => [i.label, i.detail])).toEqual([
      ['Claude Opus 5.5', '1M context'],
      ['Claude Haiku 5.5', '200K context'],
    ]);
    pick(app, 'mm:claude-opus-5-5');
    expect(state(app)).toMatchObject({ parent: 'Claude Opus 5.5', hint: 'Claude Opus 5.5 · 1M context' });
    expect(state(app).items.map((i) => i.label)).toEqual(['Default effort', 'low', 'medium', 'high', 'xhigh', 'max']);
    // Typing filters the step.
    app.palette.setQuery('xh');
    expect(ids(app)).toEqual(['me:xhigh']);
    pick(app, 'me:xhigh');
    expect(state(app)).toMatchObject({ parent: 'Claude Opus 5.5 · xhigh', hint: 'Claude Opus 5.5 · xhigh · 1M context' });
    expect(state(app).items.map((i) => i.label)).toEqual(['Standard speed', 'fast']);
    pick(app, 'ms:fast');
    expect(app.palette.state.get()).toBeNull();
    expect(updates(client).map((u) => [u.ids, u.patch])).toEqual([[['i0'], { model: { provider: 'anthropic', modelId: 'claude-opus-5-5', effort: 'xhigh', speed: 'fast' } }]]);
  });

  test('Esc goes back one step; a model without effort and speed is set right away; "No model" clears', async () => {
    const { client, app } = await setup();
    app.palette.open('model', { target: { kind: 'issues', ids: ['i2' as IssueId] } });
    // The current value is checked and active at each step.
    expect(state(app).items[state(app).active]?.id).toBe('mp:anthropic');
    pick(app, 'mp:anthropic');
    expect(state(app).items[state(app).active]?.id).toBe('mm:claude-opus-5-5');
    pick(app, 'mm:claude-opus-5-5');
    expect(state(app).items[state(app).active]?.id).toBe('me:high');
    pick(app, 'me:');
    expect(state(app).items.map((i) => i.id)).toEqual(['ms:standard', 'ms:fast']);
    app.palette.back();
    expect(ids(app)[0]).toBe('me:');
    app.palette.back();
    expect(ids(app)).toEqual(['mm:claude-opus-5-5', 'mm:claude-haiku-5-5']);
    pick(app, 'mm:claude-haiku-5-5');
    expect(app.palette.state.get()).toBeNull();
    expect(updates(client).at(-1)?.patch).toEqual({ model: { provider: 'anthropic', modelId: 'claude-haiku-5-5' } });

    app.palette.open('model', { target: { kind: 'issues', ids: ['i2' as IssueId] } });
    app.palette.back();
    expect(app.palette.state.get()).toBeNull();
    app.palette.open('model', { target: { kind: 'issues', ids: ['i2' as IssueId] } });
    pick(app, 'm:none');
    expect(updates(client).at(-1)?.patch).toEqual({ model: null });
  });

  test('one provider: the picker starts at its models; none enabled: a way to the settings', async () => {
    const one = await setup([OPUS, HAIKU]);
    one.app.palette.open('model', { target: { kind: 'issues', ids: ['i4' as IssueId] } });
    // The first step says what the issue inherits, whichever step that is.
    expect(state(one.app).hint).toBe('Inherits Claude Opus 5.5 · high from the parent issue');
    one.app.palette.open('model', { target: { kind: 'issues', ids: ['i0' as IssueId] } });
    expect(ids(one.app)).toEqual(['m:none', 'mm:claude-opus-5-5', 'mm:claude-haiku-5-5']);
    pick(one.app, 'mm:claude-opus-5-5');
    one.app.palette.back();
    expect(ids(one.app)[1]).toBe('mm:claude-opus-5-5');
    one.app.palette.back();
    expect(one.app.palette.state.get()).toBeNull();

    const none = await setup([]);
    none.app.palette.open('model', { target: { kind: 'issues', ids: ['i0' as IssueId] } });
    expect(ids(none.app)).toEqual(['m:none', 'm:settings']);
    expect(state(none.app).hint).toBe('No models enabled yet');
    pick(none.app, 'm:settings');
    expect(none.app.nav.page.get()).toMatchObject({ name: 'settings', section: 'models' });
  });

  test('context menu and command menu: the enabled models, effort and speed follow in the picker', async () => {
    const { client, app } = await setup();
    const target = { kind: 'issues' as const, ids: ['i0' as IssueId] };
    const menu = app.palette.pickerItems('model', target);
    expect(menu.items.map((i) => i.label)).toEqual(['No model', 'Claude Opus 5.5', 'Claude Haiku 5.5', 'GPT-6 Sol']);
    menu.run.get('m:openai/gpt-6-sol')!();
    expect(state(app)).toMatchObject({ kind: 'model', parent: 'GPT-6 Sol' });
    expect(state(app).items.map((i) => i.label)).toEqual(['Default effort', 'none', 'low', 'high']);
    app.palette.close();
    app.palette.pickerItems('model', target).run.get('m:anthropic/claude-haiku-5-5')!();
    expect(updates(client).at(-1)?.patch).toEqual({ model: { provider: 'anthropic', modelId: 'claude-haiku-5-5' } });
    expect(actionById('issue.model')).toMatchObject({ picker: 'model', keys: ['shift+m'] });
    // The command menu offers the values too ("Model: GPT-6 Sol").
    app.palette.close();
    app.palette.open('command', { target });
    app.palette.setQuery('model gpt');
    expect(state(app).items.map((i) => i.label)).toContain('Model: GPT-6 Sol');
  });

  test('the first step says what an issue inherits', async () => {
    const { app } = await setup();
    app.palette.open('model', { target: { kind: 'issues', ids: ['i4' as IssueId] } });
    expect(state(app).hint).toBe('Inherits Claude Opus 5.5 · high from the parent issue');
    app.palette.open('model', { target: { kind: 'issues', ids: ['i1' as IssueId] } });
    expect(state(app).hint).toBe('Inherits GPT-6 Sol · pro from the team default');
    app.palette.open('model', { target: { kind: 'issues', ids: ['i0' as IssueId] } });
    expect(state(app).hint).toBeNull();
  });

  test('create dialog: the draft takes the model and sends it', async () => {
    const { client, app } = await setup();
    app.create.open({ teamId: 't1' });
    app.create.update({ title: 'With a model' });
    app.palette.open('model');
    pick(app, 'mp:anthropic');
    pick(app, 'mm:claude-haiku-5-5');
    expect(app.create.state.get().draft.model).toEqual({ provider: 'anthropic', modelId: 'claude-haiku-5-5' });
    app.create.submit();
    const created = client.mutation.mock.calls.find((c) => callName(c) === 'issues:create')![1] as { issues: { model?: unknown }[] };
    expect(created.issues[0]!.model).toEqual({ provider: 'anthropic', modelId: 'claude-haiku-5-5' });
  });
});

describe('inheritance and texts', () => {
  test('own, then parent, then team default; the issue page shows the source', async () => {
    const { app } = await setup();
    const m = app.store.meta.get();
    const get = (id: string) => app.store.get(id as IssueId)!;
    expect(issueModel(m, get('i2'), undefined)).toMatchObject({ source: 'issue' });
    expect(issueModel(m, get('i4'), get('i2'))).toMatchObject({ source: 'parent', choice: { modelId: 'claude-opus-5-5' } });
    expect(issueModel(m, get('i1'), undefined)).toMatchObject({ source: 'team', choice: { modelId: 'gpt-6-sol' } });
    expect(issueModel(m, get('i0'), undefined)).toBeNull();
    expect(modelLabel(m, { provider: 'openai', modelId: 'gpt-6-sol', effort: 'high', speed: 'pro' })).toBe('GPT-6 Sol · high · pro');
    expect(modelLabel(m, { provider: 'x', modelId: 'unknown-1' })).toBe('unknown-1');

    app.nav.go({ name: 'issue', key: 'ACME-5' });
    await flush();
    expect(app.detail.state.get()?.model).toEqual({ label: 'Claude Opus 5.5 · high', context: '1M context', source: 'parent', from: 'ACME-3', problem: null });
    app.nav.go({ name: 'issue', key: 'PX-2' });
    await flush();
    expect(app.detail.state.get()?.model).toMatchObject({ label: 'GPT-6 Sol · pro', source: 'team', from: 'Pixelwerk' });
  });

  test('history and inbox say which model', async () => {
    const { app } = await setup();
    const agent = { kind: 'agent' as const, agentId: 'a1' as never };
    expect(historyText({ field: 'model', from: undefined, to: { provider: 'anthropic', modelId: 'claude-opus-5-5', effort: 'xhigh' }, actor: agent } as never, app.store)).toBe('set the model to Claude Opus 5.5 · xhigh');
    expect(historyText({ field: 'model', from: { provider: 'a', modelId: 'b' }, to: undefined, actor: agent } as never, app.store)).toBe('removed the model');
    const change = entry('i0', { kind: 'changed', changes: [{ field: 'model', actor: agent, at: 2, value: 'openai/gpt-6-sol?effort=high&speed=pro' }] });
    expect(entryText(change, app.store, new Map([['a1', 'Aleister']]))).toBe('Aleister set the model to GPT-6 Sol · high · pro');
  });
});
