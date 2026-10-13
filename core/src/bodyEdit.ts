// Editing a longer versioned text (issue description, wiki page): saves automatically after a short
// typing pause, keeps a local draft (survives reloads), and turns someone else's change while typing
// into a conflict with a choice instead of overwriting.
import { t } from './i18n.ts';
import { Slice } from './observable.ts';

export interface BodyEdit {
  editing: boolean;
  text: string;
  /** Version that the own text is based on */
  base: number;
  saving: boolean;
  /** Input since the last save that is not saved yet (status line "Unsaved") */
  dirty: boolean;
  /** Someone else's change during editing */
  conflict: { by: string; version: number; markdown: string } | null;
}

export const IDLE_EDIT: BodyEdit = { editing: false, text: '', base: 0, saving: false, dirty: false, conflict: null };

/** Version on the server; `by` = name of the actor of the last change. */
export interface BodySource {
  markdown: string;
  version: number;
  by: string;
}

export interface BodyEditHooks {
  /** Key of the local draft (localStorage) */
  draftKey: (id: string) => string;
  /** Save on top of `base`; if the server differs → error with code `conflict` (`data.version`). */
  save: (id: string, text: string, base: number) => Promise<{ version: number }>;
  /** Current version from the server (after a conflict), if already there */
  current: (id: string) => BodySource | null | undefined;
  /** Error code of an error (`conflict` …) */
  errorCode: (error: unknown) => string | null | undefined;
  /** Other error while saving; `retry` tries again. */
  onError: (error: unknown, retry: () => void) => void;
  notify: (message: string) => void;
}

/** Saves after this typing pause. */
export const SAVE_DELAY_MS = 900;

export class BodyEditSession {
  readonly state = new Slice<BodyEdit>(IDLE_EDIT);
  #id: string | null = null;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #inflight: number | null = null;
  /** A save is running: resolves when it is done (also on error). */
  #saving: Promise<void> | null = null;
  #lastSaved = '';
  /** Counts start and end of an edit: a save that finishes afterwards does not change the new state. */
  #session = 0;
  /** Text not yet saved when leaving while a save was running: save it afterwards. */
  #exitText: { id: string; text: string } | null = null;

  constructor(private hooks: BodyEditHooks) {}

  /** Id of the document being edited (null = none). */
  editingId() {
    return this.state.get().editing ? this.#id : null;
  }

  start(id: string, body: BodySource) {
    this.#session++;
    this.#id = id;
    const local = this.#readDraft(id);
    const text = local && local.base === body.version ? local.text : body.markdown;
    this.#lastSaved = body.markdown;
    this.state.set({ editing: true, text, base: body.version, saving: false, dirty: text !== body.markdown, conflict: local && local.base !== body.version ? { by: body.by, version: body.version, markdown: body.markdown } : null });
    if (local && local.base !== body.version) this.state.set({ ...this.state.get(), text: local.text, base: local.base });
  }

  input(text: string) {
    const d = this.state.get();
    if (!d.editing) return;
    this.state.set({ ...d, text, dirty: text !== this.#lastSaved });
    if (this.#id) this.#writeDraft(this.#id, text, d.base);
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => void this.save(), SAVE_DELAY_MS);
  }

  /** Saves the current text. true: saved or nothing to save; false: conflict, error, already running. */
  async save(): Promise<boolean> {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    const id = this.#id;
    const d = this.state.get();
    if (!id || !d.editing || d.conflict || d.saving) return false;
    if (d.text === this.#lastSaved) {
      this.#clearDraft(id);
      if (d.dirty) this.state.set({ ...d, dirty: false });
      return true;
    }
    const session = this.#session;
    const text = d.text;
    this.#inflight = d.base + 1;
    this.state.set({ ...d, saving: true });
    let saved!: () => void;
    this.#saving = new Promise((resolve) => (saved = resolve));
    try {
      const result = await this.hooks.save(id, text, d.base);
      // Another document by now (or editing ended): only clean up the own draft.
      if (session !== this.#session) {
        // Typing continued while leaving: save the newest text on top of the new version.
        const exit = this.#exitText?.id === id ? this.#exitText.text : null;
        if (this.#exitText?.id === id) this.#exitText = null;
        const latest = exit !== null && exit !== text ? exit : text;
        if (latest !== text) {
          try {
            await this.hooks.save(id, latest, result.version);
          } catch (error) {
            if (this.hooks.errorCode(error) !== 'conflict') this.hooks.onError(error, () => void this.hooks.save(id, latest, result.version).catch(() => {}));
            return false;
          }
        }
        if (this.#readDraft(id)?.text === latest) this.#clearDraft(id);
        return true;
      }
      this.#lastSaved = text;
      const now = this.state.get();
      this.state.set({ ...now, saving: false, base: result.version, dirty: now.text !== text });
      if (now.text === text) this.#clearDraft(id);
      else this.#writeDraft(id, now.text, result.version);
      // Typing continued while saving: save again right away.
      if (now.text !== text && now.editing) this.#saveTimer = setTimeout(() => void this.save(), 300);
      return true;
    } catch (error) {
      if (session !== this.#session) {
        // The draft is still stored locally; "Try again" saves exactly this text.
        if (this.hooks.errorCode(error) !== 'conflict') {
          this.hooks.onError(error, () => void this.hooks.save(id, text, d.base).then(() => this.#readDraft(id)?.text === text && this.#clearDraft(id), () => {}));
        }
        return false;
      }
      const now = this.state.get();
      if (this.hooks.errorCode(error) === 'conflict') {
        const data = (error as { data?: { version?: number } }).data;
        const current = this.hooks.current(id);
        this.state.set({
          ...now,
          saving: false,
          conflict: {
            by: current?.by ?? t('someone else'),
            version: data?.version ?? current?.version ?? now.base,
            markdown: current?.markdown ?? '',
          },
        });
      } else {
        this.state.set({ ...now, saving: false });
        this.hooks.onError(error, () => void this.save());
      }
      return false;
    } finally {
      this.#inflight = null;
      this.#saving = null;
      saved();
    }
  }

  /** New version from the server while typing → notice instead of overwriting. */
  check(id: string, body: BodySource) {
    const d = this.state.get();
    if (!d.editing || d.conflict || id !== this.#id) return;
    const v = body.version;
    if (v === d.base || v === this.#inflight) return;
    if (v > d.base && body.markdown !== d.text) {
      this.state.set({ ...d, conflict: { by: body.by, version: v, markdown: body.markdown } });
    } else if (v > d.base) {
      this.state.set({ ...d, base: v });
      this.#lastSaved = body.markdown;
    }
  }

  /** Keep the own text: save it on top of the new version. */
  keepMine() {
    const d = this.state.get();
    if (!d.conflict) return;
    this.state.set({ ...d, base: d.conflict.version, conflict: null });
    this.#lastSaved = d.conflict.markdown;
    void this.save();
  }

  /** Take the other text; the own one stays in the clipboard. */
  takeTheirs() {
    const d = this.state.get();
    if (!d.conflict) return;
    void globalThis.navigator?.clipboard?.writeText(d.text).catch(() => {});
    if (this.#id) this.#clearDraft(this.#id);
    this.#lastSaved = d.conflict.markdown;
    this.state.set({ ...d, text: d.conflict.markdown, base: d.conflict.version, conflict: null, dirty: false });
    this.hooks.notify(t('Took the other version, yours is in the clipboard'));
  }

  /** "Done": wait for a running save, save the newest text, then close. */
  async finish() {
    // Only for the edit that triggered "Done" (document switched in between: do nothing).
    const session = this.#session;
    // If typing continues while saving, save again; at most a few rounds.
    for (let round = 0; round < 5; round++) {
      if (this.#saving) await this.#saving;
      if (session !== this.#session) return;
      const ok = await this.save();
      if (session !== this.#session) return;
      const d = this.state.get();
      // Not saved (error, conflict): the editor stays open, nothing is lost.
      if (!ok || d.conflict) return;
      if (!d.saving && !d.dirty) {
        this.state.set(IDLE_EDIT);
        return;
      }
    }
  }

  /** End editing (document switch); `save` saves first. */
  end(save: boolean) {
    const d = this.state.get();
    if (!d.editing) return;
    if (save && !d.conflict) {
      // If a save is already running, its end saves the newest text too (see save()).
      if (d.saving && this.#id) this.#exitText = { id: this.#id, text: d.text };
      else void this.save();
    }
    this.#session++;
    this.state.set(IDLE_EDIT);
  }

  #readDraft(id: string): { text: string; base: number } | null {
    try {
      return JSON.parse(globalThis.localStorage?.getItem(this.hooks.draftKey(id)) ?? 'null');
    } catch {
      return null;
    }
  }

  #writeDraft(id: string, text: string, base: number) {
    try {
      globalThis.localStorage?.setItem(this.hooks.draftKey(id), JSON.stringify({ text, base }));
    } catch {
      // ignore
    }
  }

  #clearDraft(id: string) {
    try {
      globalThis.localStorage?.removeItem(this.hooks.draftKey(id));
    } catch {
      // ignore
    }
  }
}
