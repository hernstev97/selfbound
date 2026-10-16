// A renamed team key (XLR8-72): old identifiers, team URLs and saved views lead to the current key.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { App } from '../src/app/index.ts';
import { Auth } from '../src/auth.ts';
import { withCurrentTeamKeys } from '../src/route.ts';
import { renamedKeys } from '../src/store.ts';
import type { Meta } from '../src/types.ts';
import { doc, fakeClient, fakeWindow, flush, meta, settle } from './helpers.ts';

/** ACME was renamed to NOVA: the team keeps ACME as its old key. */
const renamedMeta: Meta = { ...meta, teams: meta.teams.map((t) => (t.key === 'ACME' ? { ...t, key: 'NOVA', previousKeys: ['ACME'] } : t)) };

const original = (globalThis as { window?: unknown }).window;
afterEach(() => {
  (globalThis as { window?: unknown }).window = original;
});

let n = 0;
async function setup(path: string, first: Meta = renamedMeta) {
  const browser = fakeWindow(`https://selfbound.test${path}`);
  (globalThis as { window?: unknown }).window = browser.win;
  const client = fakeClient();
  const app = new App({ client: client as never, auth: new Auth({ devToken: 'x' }), debug: false, perf: false, cacheName: `rename-${++n}` });
  app.start();
  await flush();
  client.push('meta:get', {}, first);
  client.push('meta:counter', {}, { maxSeq: 63 });
  client.push('issues:bucket', { bucket: 0 }, Array.from({ length: 4 }, (_, i) => doc(i)));
  await settle();
  return { app, browser, client };
}

const url = (browser: ReturnType<typeof fakeWindow>) => {
  const u = new URL(browser.win.location.href);
  return u.pathname + u.search;
};

describe('renamed team key', () => {
  test('old key → current key; a key some team holds now is never mapped', () => {
    expect([...renamedKeys(renamedMeta.teams)]).toEqual([['ACME', 'NOVA']]);
    const taken = [{ key: 'NOVA', previousKeys: ['ACME', 'PX'] }, { key: 'PX' }];
    expect([...renamedKeys(taken)]).toEqual([['ACME', 'NOVA']]);
    const current = (k: string) => (k === 'ACME' ? 'NOVA' : k);
    const page = { name: 'view', view: { kind: 'backlog', team: 'PX' } } as const;
    expect(withCurrentTeamKeys(page, current)).toBe(page);
    expect(withCurrentTeamKeys({ name: 'settings', section: 'teams', sub: 'ACME' }, current)).toEqual({ name: 'settings', section: 'teams', sub: 'NOVA' });
    expect(withCurrentTeamKeys({ name: 'settings', section: 'agents', sub: 'ACME' }, current)).toEqual({ name: 'settings', section: 'agents', sub: 'ACME' });
  });

  test('the store finds issues under the old key; the issue page shows the current identifier', async () => {
    const { app, browser } = await setup('/issue/ACME-1');
    expect(app.store.byKey('acme-1')?._id).toBe('i0');
    expect(app.store.byKey('NOVA-1')?._id).toBe('i0');
    expect(app.store.currentTeamKey('acme')).toBe('NOVA');
    expect(app.store.currentTeamKey('PX')).toBe('PX');
    expect(app.nav.page.get()).toEqual({ name: 'issue', key: 'NOVA-1' });
    expect(url(browser)).toBe('/issue/NOVA-1');
  });

  test.each([
    ['/team/ACME/backlog', '/team/NOVA/backlog'],
    ['/team/ACME/projects', '/team/NOVA/projects'],
    ['/all?fteam=ACME,PX', '/all?fteam=NOVA%2CPX'],
    ['/settings/teams/ACME', '/settings/teams/NOVA'],
  ])('%s → %s', async (from, to) => {
    const { browser } = await setup(from);
    expect(decodeURIComponent(url(browser))).toBe(decodeURIComponent(to));
  });

  test('display options saved under the old key apply until the view saves under the new one', async () => {
    const storage = new Map<string, string>([['selfbound:display:backlog:ACME', JSON.stringify({ grouping: 'priority' })]]);
    vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) });
    try {
      const { app } = await setup('/team/ACME/backlog');
      expect(app.list.displayFor({ kind: 'backlog', team: 'NOVA' }).grouping).toBe('priority');
      expect(app.list.displayFor({ kind: 'backlog', team: 'PX' }).grouping).not.toBe('priority');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('a rename that arrives later moves the open team page to the new key', async () => {
    const { app, browser, client } = await setup('/team/ACME', meta);
    expect(url(browser)).toBe('/team/ACME');
    client.push('meta:get', {}, renamedMeta);
    await settle();
    expect(url(browser)).toBe('/team/NOVA');
    expect(app.currentTeam()).toBe('NOVA');
  });
});
