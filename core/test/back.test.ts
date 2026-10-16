// Back closes overlays: history entries against a simulated browser history.
import { afterEach, describe, expect, test } from 'vitest';
import { App } from '../src/app/index.ts';
import { Auth } from '../src/auth.ts';
import { doc, fakeClient, fakeWindow, flush, meta, settle } from './helpers.ts';

const original = (globalThis as { window?: unknown }).window;
afterEach(() => {
  (globalThis as { window?: unknown }).window = original;
});

let n = 0;
async function setup(path = '/all') {
  const browser = fakeWindow(`https://selfbound.test${path}`);
  (globalThis as { window?: unknown }).window = browser.win;
  const client = fakeClient();
  const app = new App({ client: client as never, auth: new Auth({ devToken: 'x' }), debug: false, perf: false, cacheName: `back-${++n}` });
  app.start();
  await flush();
  client.push('meta:get', {}, meta);
  client.push('meta:counter', {}, { maxSeq: 63 });
  client.push('issues:bucket', { bucket: 0 }, Array.from({ length: 4 }, (_, i) => doc(i)));
  await settle();
  return { app, browser };
}

describe('back closes overlays', () => {
  test('command menu: own entry, back closes it and stays on the page', async () => {
    const { app, browser } = await setup();
    const before = browser.entries.length;
    app.palette.open('command');
    await settle();
    expect(browser.entries.length).toBe(before + 1);
    await browser.back();
    expect(app.palette.state.get()).toBeNull();
    expect(app.nav.page.get().name).toBe('view');
    expect(browser.path()).toBe('/all');
    expect(browser.index).toBe(before - 1);
  });

  test('Esc closes: the entry is left again, the next back changes the page', async () => {
    const { app, browser } = await setup();
    app.nav.go({ name: 'issue', key: 'ACME-1' });
    await settle();
    const issueIndex = browser.index;
    app.palette.open('command');
    await settle();
    expect(browser.index).toBe(issueIndex + 1);
    app.palette.close();
    await settle();
    expect(browser.index).toBe(issueIndex);
    expect(app.nav.page.get().name).toBe('issue');
    await browser.back();
    expect(app.nav.page.get().name).toBe('view');
  });

  test('a command menu hit opens a page: no dead entry, back leads to the list', async () => {
    const { app, browser } = await setup();
    const listIndex = browser.index;
    app.palette.open('search');
    await settle();
    // Like choose(): close first, then navigate, in the same task.
    app.palette.close();
    app.nav.go({ name: 'issue', key: 'ACME-1' });
    await settle();
    expect(browser.index).toBe(listIndex + 1);
    expect(browser.path()).toBe('/issue/ACME-1');
    expect(browser.win.history.state).toBeNull();
    await browser.back();
    expect(app.nav.page.get().name).toBe('view');
    expect(browser.path()).toBe('/all');
  });

  test('picker in the create dialog: first the picker, then the dialog; the content stays the open draft', async () => {
    const { app, browser } = await setup();
    const listIndex = browser.index;
    app.create.open();
    app.create.update({ title: 'Do not lose' });
    await settle();
    app.palette.open('priority');
    await settle();
    await browser.back();
    expect(app.palette.state.get()).toBeNull();
    expect(app.create.isOpen()).toBe(true);
    await browser.back();
    expect(app.create.isOpen()).toBe(false);
    // Like after navigating away: opening brings it back with its content.
    app.create.open();
    expect(app.create.state.get().draft.title).toBe('Do not lose');
    app.create.discard();
    expect(app.nav.page.get().name).toBe('view');
    expect(browser.index).toBe(listIndex);
  });

  test('phone drawer and context menu close with back', async () => {
    const { app, browser } = await setup();
    app.mobileDrawer.set(true);
    await settle();
    await browser.back();
    expect(app.mobileDrawer.get()).toBe(false);
    app.menu.open('i0' as never, 10, 10);
    await settle();
    await browser.back();
    expect(app.menu.state.get()).toBeNull();
    expect(browser.path()).toBe('/all');
  });

  test('display changes the address while open: after closing, the new address is in the history', async () => {
    const { app, browser } = await setup('/all?group=none');
    app.toggleDisplay();
    await settle();
    app.main.setDisplay({ grouping: 'status' });
    app.nav.syncUrl('replace');
    app.displayOpen.set(false);
    await settle();
    expect(browser.win.history.state).toBeNull();
    expect(browser.win.location.href).not.toContain('group=none');
  });

  test('Esc on the issue page (closeIssue) takes a leftover entry with it', async () => {
    const { app, browser } = await setup();
    const listIndex = browser.index;
    app.openIssue('i0' as never);
    await settle();
    app.palette.open('command');
    await settle();
    // Command "Close issue": menu closed, back in the same task.
    app.palette.close();
    app.closeIssue();
    await settle();
    expect(app.nav.page.get().name).toBe('view');
    expect(browser.index).toBe(listIndex);
  });

  test('jump over several entries with an open overlay: real navigation, nothing overwritten', async () => {
    const { app, browser } = await setup();
    app.nav.go({ name: 'issue', key: 'ACME-1' });
    app.nav.go({ name: 'issue', key: 'ACME-2' });
    await settle();
    app.palette.open('command');
    await settle();
    browser.win.history.go(-3);
    await settle();
    expect(app.palette.state.get()).toBeNull();
    expect(app.nav.page.get().name).toBe('view');
    expect(browser.path()).toBe('/all');
    expect(browser.entries.map((e) => new URL(e.url).pathname).slice(0, 3)).toEqual(['/all', '/issue/ACME-1', '/issue/ACME-2']);
  });

  test('a dialog unregisters only after fading out: back creates no new entry', async () => {
    const { app, browser } = await setup();
    const base = browser.entries.length;
    let release: () => void = () => {};
    // Like backCloses with out:leave: close() fades out, unregistering happens later.
    release = app.nav.hold(() => setTimeout(() => release(), 50));
    await settle();
    expect(browser.entries.length).toBe(base + 1);
    let pushes = 0;
    const push = browser.win.history.pushState;
    browser.win.history.pushState = (...args) => (pushes++, push(...args));
    await browser.back();
    await new Promise((r) => setTimeout(r, 80));
    await settle();
    // No new entry while fading out (else it would swallow the next back).
    expect(pushes).toBe(0);
    expect(browser.win.history.state).toBeNull();
    expect(browser.index).toBe(base - 1);
  });

  // legacy-xlr8: the second entry is the marker written by the build before the rename
  for (const marker of ['selfboundOverlay', 'xlr8Overlay']) {
    test(`reloaded on an overlay entry (${marker}): leaves it right away`, async () => {
      const browser = fakeWindow('https://selfbound.test/all');
      browser.win.history.pushState({ [marker]: true }, '', '/all');
      (globalThis as { window?: unknown }).window = browser.win;
      const client = fakeClient();
      const app = new App({ client: client as never, auth: new Auth({ devToken: 'x' }), debug: false, perf: false, cacheName: `back-reload` });
      app.start();
      await settle();
      expect(browser.index).toBe(0);
      expect(browser.path()).toBe('/all');
    });
  }

  test('new page right after closing: its entry waits for its own back', async () => {
    const { app, browser } = await setup();
    const listIndex = browser.index;
    app.mobileDrawer.set(true);
    await settle();
    // Close (click outside), a new page in the next task already, before the popstate arrives.
    app.mobileDrawer.set(false);
    // Reconcile in a microtask: history.back() is called, but the popstate is not there yet.
    await Promise.resolve();
    await Promise.resolve();
    app.nav.go({ name: 'issue', key: 'ACME-1' });
    await settle();
    expect(browser.path()).toBe('/issue/ACME-1');
    expect(browser.index).toBe(listIndex + 1);
    // No duplicate entry of the new page (else forward would lead nowhere).
    expect(browser.entries).toHaveLength(listIndex + 2);
    await browser.back();
    expect(app.nav.page.get().name).toBe('view');
    expect(browser.path()).toBe('/all');
  });
});
