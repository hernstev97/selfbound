// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { decorateMentions, type MentionSource } from '../src/lib/mentions.ts';

type Listener = () => void;
const slice = <T>(value: T) => {
  const listeners = new Set<Listener>();
  return { value, listeners, get: () => value, subscribe: (l: Listener) => (listeners.add(l), () => listeners.delete(l)) };
};

function fake(issues: Record<string, { status: string; title: string }>, phase = 'live', renamed: Record<string, string> = {}) {
  const meta = slice<unknown>({ teams: [], workflowStates: [] });
  const sync = slice({ phase });
  const changes = new Set<(ids: ReadonlySet<string>) => void>();
  const source = {
    byKey: (key: string) => {
      // like the store: also finds an issue by a team key from before a rename
      const [team = '', digits = ''] = key.toUpperCase().split('-');
      const n = String(Number(digits));
      const hit = issues[key.toUpperCase()] ?? issues[`${renamed[team] ?? team}-${n}`];
      const id = issues[key.toUpperCase()] ? key.toUpperCase() : `${renamed[team] ?? team}-${n}`;
      return hit && ({ _id: id, key: id, teamId: 't', stateId: undefined, ...hit } as never);
    },
    renamedKeys: () => new Map(Object.entries(renamed)),
    meta,
    sync,
    onChange: (l: (ids: ReadonlySet<string>) => void) => (changes.add(l), () => changes.delete(l)),
    resolve: async (identifier: string) => (identifier === 'OLD-1' ? { id: 'XLR8-5' as never, identifier: 'XLR8-5' } : null),
  } as unknown as MentionSource;
  return { source, issues, renamed, meta, emit: (id: string) => changes.forEach((l) => l(new Set([id]))), sync };
}

function page(html: string) {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}
const link = (key: string, bare = true) => `<a class="xlink xlink-issue" href="/issue/${key}" data-nav="issue"${bare ? ' data-bare' : ''}>${key}</a>`;

describe('issue mention chips', () => {
  it('adds the status icon and title, and shows done and canceled differently', () => {
    const { source } = fake({ 'XLR8-1': { status: 'in_progress', title: 'Open one' }, 'XLR8-2': { status: 'done', title: 'Done one' }, 'XLR8-3': { status: 'canceled', title: 'Gone' } });
    const root = page(`${link('XLR8-1')} ${link('XLR8-2')} ${link('XLR8-3')}`);
    decorateMentions(root, source);
    const [a, b, c] = [...root.querySelectorAll('a')];
    expect(a!.querySelector('.mention-icon svg')).toBeTruthy();
    expect(a!.dataset.title).toContain('Open one');
    expect(a!.className).not.toMatch(/done|canceled/);
    expect(b!.classList.contains('mention-done')).toBe(true);
    expect(c!.classList.contains('mention-canceled')).toBe(true);
    expect(b!.querySelector('svg')!.outerHTML).not.toBe(a!.querySelector('svg')!.outerHTML);
  });

  it('updates live when the status changes', () => {
    const f = fake({ 'XLR8-1': { status: 'todo', title: 'T' } });
    const root = page(link('XLR8-1'));
    const stop = decorateMentions(root, f.source)!;
    const a = root.querySelector('a')!;
    expect(a.classList.contains('mention-done')).toBe(false);
    f.issues['XLR8-1']!.status = 'done';
    f.emit('XLR8-1');
    expect(a.classList.contains('mention-done')).toBe(true);
    stop();
    f.issues['XLR8-1']!.status = 'todo';
    f.emit('XLR8-1');
    expect(a.classList.contains('mention-done')).toBe(true); // cleaned up: no more updates
  });

  it('a typed identifier without an issue stays plain; an explicit link does not', () => {
    const { source } = fake({});
    const root = page(`${link('XLR8-99')} ${link('XLR8-98', false)}`);
    decorateMentions(root, source);
    const [typed, explicit] = [...root.querySelectorAll('a')];
    expect(typed!.classList.contains('mention-unknown')).toBe(true);
    expect(explicit!.classList.contains('mention-unknown')).toBe(false);
  });

  it('waits for the issues before calling anything unknown', () => {
    const f = fake({}, 'empty');
    const root = page(link('XLR8-1'));
    decorateMentions(root, f.source);
    const a = root.querySelector('a')!;
    expect(a.classList.contains('mention-unknown')).toBe(false);
  });

  it('resolves an old identifier once through the server', async () => {
    const f = fake({ 'XLR8-5': { status: 'done', title: 'Moved' } });
    const root = page(link('OLD-1'));
    decorateMentions(root, f.source);
    await new Promise((r) => setTimeout(r, 0));
    const a = root.querySelector('a')!;
    expect(a.classList.contains('mention-done')).toBe(true);
    expect(a.dataset.title).toContain('XLR8-5');
  });

  describe('after a team key rename', () => {
    const self = () => ({ 'SELF-72': { status: 'done', title: 'Rename keys' } }); // a fresh object per test: tests delete from it
    const withOld = (renamed: Record<string, string>) => fake(self(), 'live', renamed);
    const text = (a: Element) => a.textContent;

    it('shows the current key with the icon; hover names the typed form', () => {
      const f = withOld({ XLR8: 'SELF' });
      const root = page(`${link('XLR8-72')} and ${link('SELF-72')}`);
      decorateMentions(root, f.source);
      const [old, current] = [...root.querySelectorAll('a')];
      expect(text(old!)).toBe('SELF-72');
      expect(old!.querySelector('.mention-icon svg')).toBeTruthy();
      expect(old!.dataset.title).toBe('SELF-72 · Rename keys (Done) · written as XLR8-72');
      expect(old!.getAttribute('aria-label')).toBe(old!.dataset.title);
      expect(old!.getAttribute('href')).toBe('/issue/XLR8-72'); // the link itself is untouched
      expect(text(current!)).toBe('SELF-72');
      expect(current!.dataset.title).toBe('SELF-72 · Rename keys (Done)');
    });

    it('keeps the digits as typed', () => {
      const f = withOld({ XLR8: 'SELF' });
      const root = page(link('XLR8-072'));
      decorateMentions(root, f.source);
      expect(text(root.querySelector('a')!)).toBe('SELF-072');
    });

    it('follows a chain A→B→C and restores the typed form when renamed back', () => {
      const f = withOld({ A: 'C', B: 'C' });
      f.issues['C-1'] = { status: 'todo', title: 'Chain' };
      const root = page(`${link('A-1')} ${link('B-1')} ${link('C-1')}`);
      decorateMentions(root, f.source);
      expect([...root.querySelectorAll('a')].map(text)).toEqual(['C-1', 'C-1', 'C-1']);
      // renamed back to A: the store maps B and C to A and no longer A
      delete f.renamed.A;
      f.renamed.B = 'A';
      f.renamed.C = 'A';
      f.issues['A-1'] = f.issues['C-1']!;
      delete f.issues['C-1'];
      f.meta.listeners.forEach((l) => l());
      expect([...root.querySelectorAll('a')].map(text)).toEqual(['A-1', 'A-1', 'A-1']);
      expect(root.querySelectorAll('a')[0]!.dataset.typed).toBeUndefined();
    });

    it('leaves explicit links, unknown numbers, moved issues and unrelated keys as written', () => {
      const f = withOld({ XLR8: 'SELF' });
      const root = page(`${link('XLR8-72', false)} ${link('XLR8-99')} ${link('OLD-1')} ${link('ORB-5')}`);
      decorateMentions(root, f.source);
      expect([...root.querySelectorAll('a')].map(text)).toEqual(['XLR8-72', 'XLR8-99', 'OLD-1', 'ORB-5']);
      expect(root.querySelector('a.mention-unknown')!.textContent).toBe('XLR8-99');
    });

    it('keeps the text of an issue that moved to another team after the rename', async () => {
      const f = fake({ 'BEAR-32': { status: 'todo', title: 'Moved' } }, 'live', { XLR8: 'SELF' });
      f.source.resolve = async () => ({ id: 'BEAR-32' as never, identifier: 'BEAR-32' });
      const root = page(link('XLR8-5'));
      decorateMentions(root, f.source);
      await new Promise((r) => setTimeout(r, 0));
      const a = root.querySelector('a')!;
      expect(a.classList.contains('mention')).toBe(true); // found through the alias …
      expect(text(a)).toBe('XLR8-5'); // … but shown as typed
      expect(a.dataset.typed).toBeUndefined();
    });

    it('goes back to the typed text when the issue disappears', () => {
      const f = withOld({ XLR8: 'SELF' });
      const root = page(link('XLR8-72'));
      decorateMentions(root, f.source);
      const a = root.querySelector('a')!;
      expect(text(a)).toBe('SELF-72');
      delete f.issues['SELF-72'];
      f.emit('SELF-72');
      expect(text(a)).toBe('XLR8-72');
      expect(a.dataset.typed).toBeUndefined();
    });

    it('a second run on the same DOM still knows what was typed', () => {
      const f = withOld({ XLR8: 'SELF' });
      const root = page(link('XLR8-72'));
      decorateMentions(root, f.source)!();
      decorateMentions(root, f.source);
      expect(text(root.querySelector('a')!)).toBe('SELF-72');
      expect(root.querySelector('a')!.dataset.title).toContain('written as XLR8-72');
    });
  });
});
