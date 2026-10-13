import { describe, expect, test } from 'vitest';
import { BodyEditSession } from '../src/bodyEdit.ts';

// Versioned editing (description, wiki page): saving, Done, leaving while a save runs.

function setup(opts: { fail?: boolean } = {}) {
  const saved: { id: string; text: string; base: number }[] = [];
  const pending: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  let version = 1;
  const errors: unknown[] = [];
  const session = new BodyEditSession({
    draftKey: (id) => `t:${id}`,
    save: (id, text, base) =>
      new Promise((resolve, reject) => {
        pending.push({
          resolve: () => {
            saved.push({ id, text, base });
            resolve({ version: ++version });
          },
          reject,
        });
        if (opts.fail) pending.at(-1)!.reject(new Error('broken'));
      }),
    current: () => null,
    errorCode: () => null,
    onError: (e) => errors.push(e),
    notify: () => {},
  });
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const settle = async () => {
    while (pending.length) {
      pending.shift()!.resolve();
      await flush();
    }
  };
  return { session, saved, pending, errors, flush, settle };
}

describe('BodyEditSession', () => {
  test('Done saves and closes; on an error the editor stays open', async () => {
    const ok = setup();
    ok.session.start('a', { markdown: 'old', version: 1, by: 'You' });
    ok.session.input('new');
    const done = ok.session.finish();
    await ok.flush();
    await ok.settle();
    await done;
    expect(ok.saved).toEqual([{ id: 'a', text: 'new', base: 1 }]);
    expect(ok.session.state.get().editing).toBe(false);

    const bad = setup({ fail: true });
    bad.session.start('a', { markdown: 'old', version: 1, by: 'You' });
    bad.session.input('new');
    await bad.session.finish();
    expect(bad.session.state.get()).toMatchObject({ editing: true, text: 'new' });
    expect(bad.errors).toHaveLength(1);
  });

  test('Done also waits for text typed while saving', async () => {
    const t = setup();
    t.session.start('a', { markdown: '', version: 1, by: 'You' });
    t.session.input('one');
    void t.session.save();
    const done = t.session.finish();
    t.session.input('one two');
    await t.flush();
    await t.settle();
    await done;
    expect(t.saved.at(-1)).toMatchObject({ text: 'one two' });
    expect(t.session.state.get().editing).toBe(false);
  });

  test('leaving while saving: the newest text is saved afterwards, the new document stays untouched', async () => {
    const t = setup();
    t.session.start('a', { markdown: '', version: 1, by: 'You' });
    t.session.input('first draft');
    void t.session.save();
    t.session.input('first draft, longer');
    t.session.end(true);
    t.session.start('b', { markdown: 'B', version: 7, by: 'You' });
    await t.flush();
    await t.settle();
    expect(t.saved).toEqual([
      { id: 'a', text: 'first draft', base: 1 },
      { id: 'a', text: 'first draft, longer', base: 2 },
    ]);
    expect(t.session.state.get()).toMatchObject({ editing: true, text: 'B', base: 7 });
  });
});
