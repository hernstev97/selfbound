import { describe, expect, test } from 'vitest';
import type { PrList, PrListItem } from '@selfbound/backend/shared/pullRequests';
import { App } from '../src/app/index.ts';
import { ACTIONS } from '../src/app/actions.ts';
import { Auth } from '../src/auth.ts';
import { callName, doc, fakeClient, flush, meta } from './helpers.ts';

// Pull requests page (SELF-100): sidebar count, page and keys, PR beside the list, one batched refresh.

let n = 0;
async function setup() {
  const client = fakeClient();
  const app = new App({ client: client as never, auth: new Auth({ devToken: 'x' }), debug: true, perf: false, cacheName: `pulls-${++n}` });
  app.start();
  await flush();
  client.push('meta:get', {}, meta);
  client.push('meta:counter', {}, { maxSeq: 63 });
  client.push('issues:bucket', { bucket: 0 }, Array.from({ length: 4 }, (_, i) => doc(i)));
  await flush();
  return { client, app };
}

const HOUR = 3_600_000;
function item(number: number, group: PrListItem['group'], extra: Partial<PrListItem> = {}): PrListItem {
  return {
    id: `pr${number}`,
    repo: 'acme/app',
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    state: group === 'done' ? 'merged' : group === 'draft' ? 'draft' : 'open',
    updatedAt: Date.now() - number * HOUR,
    group,
    issueIds: ['i1'],
    ...extra,
  };
}
const LIST: PrList = {
  configured: true,
  items: [item(1, 'ready'), item(2, 'failing'), item(3, 'running'), item(4, 'draft'), item(5, 'done'), item(6, 'done')],
};

const run = (app: App, id: string) => ACTIONS.find((a) => a.id === id)!.run(app);
const when = (app: App, id: string) => ACTIONS.find((a) => a.id === id)!.when?.(app) ?? true;
const refreshes = (client: ReturnType<typeof fakeClient>) => client.action.mock.calls.filter((c) => callName(c) === 'githubPr:refresh');

async function openPage(client: ReturnType<typeof fakeClient>, app: App, list = LIST) {
  run(app, 'go.pulls');
  await app.loadPulls();
  await flush();
  client.push('githubPr:list', {}, list);
  await flush();
}

describe('sidebar entry', () => {
  test('count from githubPr.attention after watchPullCounts; active on the page; G P goes there', async () => {
    const { client, app } = await setup();
    expect(client.has('githubPr:attention', {})).toBe(false);
    app.watchPullCounts();
    app.watchPullCounts();
    client.push('githubPr:attention', {}, { ready: 2, failing: 1 });
    await flush();
    expect(app.sidebar.get().pulls).toEqual({ ready: 2, failing: 1 });
    expect(ACTIONS.find((a) => a.id === 'go.pulls')!.keys).toEqual(['g p']);
    run(app, 'go.pulls');
    expect(app.nav.page.get()).toEqual({ name: 'pulls' });
    expect(app.sidebar.get().active).toBe('pulls');
    // Issue shortcuts do not reach the hidden list.
    expect(app.targets()).toEqual([]);
  });
});

describe('page', () => {
  test('groups in order, done collapsed; one refresh for the stale open PRs; subscription only while needed', async () => {
    const { client, app } = await setup();
    await openPage(client, app);
    const state = app.pulls.state.get();
    expect(state.loaded).toBe(true);
    expect(state.groups.map((g) => [g.group, g.items.map((i) => i.number), g.collapsed])).toEqual([
      ['ready', [1], false],
      ['failing', [2], false],
      ['running', [3], false],
      ['draft', [4], false],
      ['done', [5, 6], true],
    ]);
    // The open ones in one call (the server skips fresh ones), the done ones left out.
    expect(refreshes(client).map((c) => c[1])).toEqual([{ prIds: ['pr1', 'pr2', 'pr3', 'pr4'], maxAgeMs: 120_000 }]);
    client.push('githubPr:list', {}, { ...LIST, items: LIST.items.slice(1) });
    await flush();
    expect(refreshes(client)).toHaveLength(1);

    // The PR page opened from the list keeps the subscription (Back shows the list at once), other pages end it.
    app.nav.go({ name: 'pr', repo: 'acme/app', number: 2 });
    expect(client.has('githubPr:list', {})).toBe(true);
    app.nav.go({ name: 'view', view: { kind: 'all', team: null } });
    expect(client.has('githubPr:list', {})).toBe(false);
    expect(app.pulls.state.get().loaded).toBe(false);
  });

  test('more than ten open PRs: only the first ten; without a token no refresh; the reload button forces it', async () => {
    const { client, app } = await setup();
    const many = { configured: true, items: Array.from({ length: 14 }, (_, i) => item(i + 1, 'ready')) };
    await openPage(client, app, many);
    expect((refreshes(client)[0]![1] as { prIds: string[] }).prIds).toHaveLength(10);

    await app.pulls.refresh(undefined, true);
    expect((refreshes(client)[1]![1] as { maxAgeMs: number }).maxAgeMs).toBe(0);

    const other = await setup();
    await openPage(other.client, other.app, { ...LIST, configured: false });
    expect(refreshes(other.client)).toHaveLength(0);
  });

  test('J/K move the focus over the open groups; done opens and closes', async () => {
    const { client, app } = await setup();
    await openPage(client, app);
    expect(when(app, 'pulls.down')).toBe(true);
    expect(when(app, 'nav.down')).toBe(false);
    expect(when(app, 'pulls.open')).toBe(false);
    run(app, 'pulls.down');
    expect(app.pulls.state.get().focus).toBe('pr1');
    for (let i = 0; i < 6; i++) run(app, 'pulls.down');
    expect(app.pulls.state.get().focus).toBe('pr4');
    run(app, 'pulls.done');
    expect(app.pulls.state.get().groups.at(-1)!.collapsed).toBe(false);
    run(app, 'pulls.down');
    run(app, 'pulls.down');
    expect(app.pulls.state.get().focus).toBe('pr6');
    // Collapsing the group with the focus clears it.
    run(app, 'pulls.done');
    expect(app.pulls.state.get().focus).toBeNull();
    run(app, 'pulls.up');
    expect(app.pulls.state.get().focus).toBe('pr4');
  });

  test('wide: a click opens the PR beside the list, a second closes it; J/K follow; Enter on it opens full size', async () => {
    const { client, app } = await setup();
    app.wide.set(true);
    await openPage(client, app);
    app.pulls.open('pr2');
    expect(app.prSplit.get()).toEqual({ repo: 'acme/app', number: 2 });
    app.pulls.open('pr2');
    expect(app.prSplit.get()).toBeNull();
    app.pulls.open('pr1');
    run(app, 'pulls.down');
    expect(app.prSplit.get()).toEqual({ repo: 'acme/app', number: 2 });
    expect(app.pulls.state.get().focus).toBe('pr2');
    // A page re-shown (same page) keeps it; another page closes it.
    app.onPage(app.nav.page.get());
    expect(app.prSplit.get()).toEqual({ repo: 'acme/app', number: 2 });
    run(app, 'pulls.open');
    expect(app.nav.page.get()).toEqual({ name: 'pr', repo: 'acme/app', number: 2 });
    expect(app.prSplit.get()).toBeNull();
  });

  test('narrow: a click opens the PR as its own page; the PR beside an issue does not carry over', async () => {
    const { client, app } = await setup();
    app.wide.set(false);
    await openPage(client, app);
    app.pulls.open('pr1');
    expect(app.nav.page.get()).toEqual({ name: 'pr', repo: 'acme/app', number: 1 });

    app.wide.set(true);
    app.openIssue('i1' as never);
    app.prSplit.set({ repo: 'acme/app', number: 1 });
    run(app, 'go.pulls');
    expect(app.prSplit.get()).toBeNull();
  });
});
