// Share to XLR8 (Web Share Target): Android sends text and links to /share?title=…&text=…&url=….
// main.ts keeps the values before startup, changes the URL to /inbox and loads this module.
// They become an issue in the inbox (triage) right away, with a toast and "Undo".
import { api } from '@xlr8/backend/api';
import type { Id } from '@xlr8/backend/dataModel';
import { LIMITS } from '@xlr8/backend/constants';
import type { App } from '@xlr8/core';
import { errorMessage } from '@xlr8/core/app/toasts';
import { t } from '@xlr8/core/i18n';

export interface Shared {
  title: string;
  text: string;
  url: string;
}

export function readShare(url: URL): Shared | null {
  if (url.pathname.replace(/\/+$/, '') !== '/share') return null;
  const get = (key: string) => (url.searchParams.get(key) ?? '').trim();
  const shared = { title: get('title'), text: get('text'), url: get('url') };
  return shared.title || shared.text || shared.url ? shared : null;
}

const URL_RE = /https?:\/\/[^\s<>"]+/;

/** Title and description from the shared data. Android usually puts links in `text`, not `url`. */
export function issueFromShare(shared: Shared, maxTitle = 200): { title: string; description: string } {
  const link = shared.url || shared.text.match(URL_RE)?.[0] || '';
  const textWithoutLink = link ? shared.text.replace(link, '').trim() : shared.text;
  const firstLine = textWithoutLink.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  let title = shared.title || firstLine;
  if (!title && link) {
    try {
      const u = new URL(link);
      title = `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`;
    } catch {
      title = link;
    }
  }
  title = (title || t('Shared')).replace(/\s+/g, ' ');
  if (title.length > maxTitle) title = `${title.slice(0, maxTitle - 1).trimEnd()}…`;
  const parts: string[] = [];
  if (textWithoutLink && textWithoutLink !== title) parts.push(textWithoutLink);
  if (link) parts.push(link);
  return { title, description: parts.join('\n\n') };
}

const RECENT_KEY = 'xlr8:shared';
const RECENT_MS = 10 * 60_000;

/**
 * Request id: the same shared content within 10 minutes (e.g. triggered twice) gets the same id
 * and so does not create a second issue. Remembered per content in localStorage.
 */
export async function shareRequestId(shared: Shared, now = Date.now(), storage: Pick<Storage, 'getItem' | 'setItem'> | null = globalThis.localStorage ?? null) {
  const data = new TextEncoder().encode(`${shared.title}\n${shared.text}\n${shared.url}`);
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data)).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
  let recent: Record<string, { id: string; at: number }> = {};
  try {
    recent = JSON.parse(storage?.getItem(RECENT_KEY) ?? '{}');
  } catch {
    recent = {};
  }
  for (const [key, entry] of Object.entries(recent)) if (now - entry.at > RECENT_MS) delete recent[key];
  const id = recent[hash]?.id ?? `share-${hash}-${now.toString(36)}`;
  recent[hash] = { id, at: recent[hash]?.at ?? now };
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    // private/full: then without protection against sharing twice
  }
  return id;
}

function teamFor(app: App): Id<'teams'> | null {
  const meta = app.store.meta.get();
  if (!meta) return null;
  const key = app.currentTeam();
  const team = meta.teams.find((t) => t.key === key) ?? meta.teams.find((t) => !t.dormant) ?? meta.teams[0];
  return (team?._id as Id<'teams'> | undefined) ?? null;
}

function whenMeta(app: App): Promise<void> {
  if (app.store.meta.get()) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = app.store.meta.subscribe(() => {
      if (!app.store.meta.get()) return;
      stop();
      resolve();
    });
  });
}

export async function handleShare(app: App, shared: Shared) {
  await whenMeta(app);
  const teamId = teamFor(app);
  if (!teamId) {
    app.toasts.show(t('Not saved'), undefined, 'error', t('There is no team yet.'));
    return;
  }
  const { title, description } = issueFromShare(shared, LIMITS.titleMax);
  // Computed once: "Try again" reuses the id, so it never creates a second issue.
  const requestId = await shareRequestId(shared);
  const run = async () => {
    try {
      const result = await app.store.call(api.issues.share, { teamId, title, description, requestId });
      const created = result.issues[0];
      app.cues.emit('success');
      app.toasts.show(t('{id} added to the inbox', { id: created.identifier }), {
        label: t('Undo'),
        run: () => void app.store.call(api.issues.remove, { ids: [created.id] }).catch((e: unknown) => app.toasts.error(t('Not removed'), e)),
      }, 'info', title, 6000);
    } catch (error) {
      app.toasts.show(t('Shared content not saved'), { label: t('Try again'), run: () => void run() }, 'error', errorMessage(error));
    }
  };
  await run();
}
