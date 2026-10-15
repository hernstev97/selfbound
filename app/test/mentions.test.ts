// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { decorateMentions, type MentionSource } from '../src/lib/mentions.ts';

type Listener = () => void;
const slice = <T>(value: T) => {
  const listeners = new Set<Listener>();
  return { value, listeners, get: () => value, subscribe: (l: Listener) => (listeners.add(l), () => listeners.delete(l)) };
};

function fake(issues: Record<string, { status: string; title: string }>, phase = 'live') {
  const meta = slice<unknown>({ teams: [], workflowStates: [] });
  const sync = slice({ phase });
  const changes = new Set<(ids: ReadonlySet<string>) => void>();
  const source = {
    byKey: (key: string) => {
      const hit = issues[key.toUpperCase()];
      return hit && ({ _id: key.toUpperCase(), key: key.toUpperCase(), teamId: 't', stateId: undefined, ...hit } as never);
    },
    meta,
    sync,
    onChange: (l: (ids: ReadonlySet<string>) => void) => (changes.add(l), () => changes.delete(l)),
    resolve: async (identifier: string) => (identifier === 'OLD-1' ? { id: 'XLR8-5' as never, identifier: 'XLR8-5' } : null),
  } as unknown as MentionSource;
  return { source, issues, emit: (id: string) => changes.forEach((l) => l(new Set([id]))), sync };
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
});
