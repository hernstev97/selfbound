// Status chips for issue mentions: rendered Markdown (decorateMentions) and the editor (mentionInfo).
// Everything comes from the issues already in the store, so a mention costs a map lookup and no
// request. Only an identifier the store does not know (an old alias) is asked once from the server.
import { statusIcon, workflowsOf, type Issue, type IssueId, type Meta, type Status } from '@selfbound/core';

/** What the chips need from the store (`app.store` fits; tests pass a small fake). */
export interface MentionSource {
  byKey(key: string): Issue | undefined;
  readonly meta: { get(): Meta | null; subscribe(listener: () => void): () => void };
  readonly sync: { get(): { phase: string }; subscribe(listener: () => void): () => void };
  onChange(listener: (ids: ReadonlySet<IssueId>) => void): () => void;
  resolve(identifier: string): Promise<{ id: IssueId; identifier: string } | null>;
}

export interface Mention {
  id: IssueId;
  key: string;
  title: string;
  status: Status;
  stateName: string;
  color: string | null;
}

/** Old identifier → current one (null = does not exist); asked once per session. */
const aliases = new Map<string, string | null>();
const asking = new Set<string>();

export function mentionInfo(source: MentionSource, key: string): Mention | null {
  const upper = key.toUpperCase();
  const issue = source.byKey(upper) ?? source.byKey(aliases.get(upper) ?? '');
  if (!issue || issue.deletedAt) return null;
  const state = workflowsOf(source.meta.get()).of(issue);
  return { id: issue._id, key: issue.key, title: issue.title, status: state.status, stateName: state.name, color: state.color };
}

/** Is the set of issues complete enough to call an identifier unknown? */
export function knowsAll(source: MentionSource) {
  const phase = source.sync.get().phase;
  return phase === 'live' || phase === 'cache';
}

/** Ask the server about an identifier the store lacks (old alias); `done` runs when it is known. */
export function askAlias(source: MentionSource, key: string, done: () => void) {
  const upper = key.toUpperCase();
  if (aliases.has(upper) || asking.has(upper) || source.sync.get().phase !== 'live') return;
  asking.add(upper);
  source
    .resolve(upper)
    .then((found) => aliases.set(upper, found && found.identifier !== upper ? found.identifier.toUpperCase() : null))
    .catch(() => {}) // offline: the chip stays a plain link, asked again next time
    .finally(() => {
      asking.delete(upper);
      done();
    });
}

/** Title and status for the hover text and screen readers. */
export function mentionLabel(m: Mention) {
  return `${m.key} · ${m.title} (${m.stateName})`;
}

const keyOf = (a: HTMLAnchorElement) => /\/issue\/([^/?#]+)/.exec(a.getAttribute('href') ?? '')?.[1]?.toUpperCase() ?? '';

/**
 * Gives the issue links in `root` (`a.xlink-issue`, from markdownRender.ts) a status icon and a hover
 * title, and keeps them current while the store changes. A bare identifier no issue has stays plain
 * text. Returns the cleanup.
 */
export function decorateMentions(root: HTMLElement, source: MentionSource): (() => void) | undefined {
  const links = [...root.querySelectorAll<HTMLAnchorElement>('a.xlink-issue')].map((a) => ({ a, key: keyOf(a), id: '' as string, sig: '' }));
  if (!links.length) return;

  const paint = (link: (typeof links)[number]) => {
    const { a } = link;
    const m = mentionInfo(source, link.key);
    link.id = m?.id ?? '';
    if (!m) {
      link.sig = '';
      a.querySelector('.mention-icon')?.remove();
      a.classList.remove('mention', 'mention-done', 'mention-canceled');
      a.removeAttribute('data-title');
      a.removeAttribute('aria-label');
      // Plain text only once the issues are loaded; an old alias is asked from the server first.
      const bare = a.hasAttribute('data-bare');
      a.classList.toggle('mention-unknown', bare && knowsAll(source));
      if (bare) {
        a.tabIndex = a.classList.contains('mention-unknown') ? -1 : 0;
        if (knowsAll(source)) askAlias(source, link.key, () => paint(link));
      }
      return;
    }
    a.classList.remove('mention-unknown');
    a.removeAttribute('tabindex');
    a.classList.add('mention');
    a.classList.toggle('mention-done', m.status === 'done');
    a.classList.toggle('mention-canceled', m.status === 'canceled' || m.status === 'duplicate');
    const label = mentionLabel(m);
    a.dataset.title = label;
    a.setAttribute('aria-label', label);
    const sig = `${m.status}|${m.color}`;
    if (sig !== link.sig) {
      link.sig = sig;
      let icon = a.querySelector<HTMLElement>('.mention-icon');
      if (!icon) {
        icon = a.ownerDocument.createElement('span');
        icon.className = 'mention-icon icon';
        icon.setAttribute('aria-hidden', 'true');
        a.prepend(icon);
      }
      icon.innerHTML = statusIcon(m.status, m.color); // fixed SVG from core, color validated there
    }
  };

  const all = () => links.forEach(paint);
  all();
  const stopIssues = source.onChange((changed) => {
    for (const link of links) if (!link.id || changed.has(link.id as IssueId)) paint(link);
  });
  // Renamed or recolored statuses and the first load change every chip.
  const stopMeta = source.meta.subscribe(all);
  let phase = source.sync.get().phase;
  const stopSync = source.sync.subscribe(() => {
    const next = source.sync.get().phase;
    if (next !== phase) {
      phase = next;
      all(); // loaded: unknown identifiers are now certain
    }
  });
  return () => {
    stopIssues();
    stopMeta();
    stopSync();
  };
}
