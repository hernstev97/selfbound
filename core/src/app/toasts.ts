// Notices at the bottom right. Only for things not visible otherwise: "Link copied", bulk changes
// with "Undo", errors. Success notices disappear on their own, errors stay until dismissed.
import { ConvexError } from 'convex/values';
import { t } from '../i18n.ts';
import { Slice } from '../observable.ts';
import type { Cues } from './cues.ts';
import type { Toast } from '../types.ts';

export class Toasts {
  readonly list = new Slice<Toast[]>([]);
  #seq = 0;

  constructor(private cues?: Cues) {}

  show(text: string, action?: Toast['action'], kind: Toast['kind'] = 'info', detail?: string, duration = 4000) {
    const id = ++this.#seq;
    const run = action ? { label: action.label, run: () => (this.dismiss(id), action.run()) } : undefined;
    // At most three at a time; the oldest success notice goes first, then the oldest error.
    const next: Toast[] = [...this.list.get(), { id, kind, text, detail, action: run }];
    while (next.length > 3) {
      const info = next.findIndex((t) => t.kind === 'info' && t.id !== id);
      next.splice(info >= 0 ? info : 0, 1);
    }
    this.list.set(next);
    if (kind === 'error') this.cues?.emit('error');
    if (kind === 'info') setTimeout(() => this.dismiss(id), duration);
    return id;
  }

  error(text: string, error: unknown, retry?: () => void) {
    return this.show(text, retry ? { label: t('Try again'), run: retry } : undefined, 'error', errorMessage(error));
  }

  dismiss(id: number) {
    const next = this.list.get().filter((t) => t.id !== id);
    if (next.length !== this.list.get().length) this.list.set(next);
  }
}

/** Readable message from a server error. */
export function errorMessage(error: unknown): string {
  if (error instanceof ConvexError) {
    const data = error.data as { message?: string } | string;
    if (typeof data === 'string') return data;
    if (data?.message) return data.message;
  }
  const text = error instanceof Error ? error.message : String(error);
  if (/fetch|network|websocket|connection/i.test(text)) return t('No connection to the server.');
  return text.replace(/^\[CONVEX [^\]]*\]\s*/, '').split('\n')[0] || t('Unknown error');
}

export function errorCode(error: unknown): string | null {
  if (error instanceof ConvexError) return ((error.data as { code?: string }) ?? {}).code ?? null;
  return null;
}
