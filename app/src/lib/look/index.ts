// Appearance: chosen themes for light and dark, fonts and overridden colors. Stored in Convex
// (appearance.ts, applies on all devices) and as finished CSS in localStorage ("xlr8:look"). The
// inline script in index.html applies that CSS before the first paint, so nothing flashes at
// startup. This module loads idle after startup (main.ts) and then syncs with the server.
import type { App } from '@selfbound/core';
import { t } from '@selfbound/core/i18n';
import { api } from '@selfbound/backend/api';
import type { Id } from '@selfbound/backend/dataModel';
import { Slice } from '@selfbound/core';
import { builtin, loadBuiltin } from './builtin.ts';
import { fontCss } from './fonts.ts';
import { mapTheme, themeCss, type ContrastFix, type MappedTheme } from './map.ts';
import { readTheme, type ThemeType, type VsTheme } from './vscode.ts';

export interface Override {
  theme: string;
  colors: Record<string, string>;
}

export interface LookSettings {
  /** "xlr8" (built-in colors), id of a bundled theme, or "custom:<id>" */
  dark: string;
  light: string;
  /** "inter", "system", a Fontsource id or "local:<name>" */
  sans: string;
  /** "system" (default), a Fontsource id or "local:<name>" */
  mono: string;
  overrides: Override[];
}

export interface CustomThemeMeta {
  id: Id<'customThemes'>;
  name: string;
  type: ThemeType;
  updatedAt: number;
}

export const DEFAULT_LOOK: LookSettings = { dark: 'xlr8', light: 'xlr8', sans: 'inter', mono: 'system', overrides: [] };

/** Content of localStorage "xlr8:look"; index.html reads css, bar and preload. */
export interface LookCache {
  v: 1;
  settings: LookSettings;
  /** Server timestamp the copy is based on (0 = never synced) */
  at: number;
  /** Changed locally, not saved on the server yet */
  dirty?: boolean;
  build: string;
  /** Choice `css` was built from (if it differs from `settings`, startup rebuilds) */
  rendered?: LookSettings;
  /** Version (updatedAt) of the custom themes in `css` */
  custom?: Record<string, number>;
  css: string;
  bar: { dark?: string; light?: string };
  preload: string[];
}

export const LOOK_KEY = 'xlr8:look';
const BUILD = typeof __SELFBOUND_BUILD__ === 'string' ? __SELFBOUND_BUILD__ : 'dev';

function readCache(): LookCache | null {
  try {
    const raw = JSON.parse(localStorage.getItem(LOOK_KEY) ?? 'null');
    return raw && raw.v === 1 && raw.settings ? (raw as LookCache) : null;
  } catch {
    return null;
  }
}

export const sameLook = (a: LookSettings, b: LookSettings) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

function normalize(s: LookSettings): LookSettings {
  const overrides = s.overrides
    .filter((o) => Object.keys(o.colors).length > 0)
    .map((o) => ({ theme: o.theme, colors: Object.fromEntries(Object.entries(o.colors).sort(([a], [b]) => a.localeCompare(b))) }))
    .sort((a, b) => a.theme.localeCompare(b.theme));
  return { dark: s.dark, light: s.light, sans: s.sans, mono: s.mono, overrides };
}

export function overridesFor(settings: LookSettings, theme: string): Record<string, string> {
  return settings.overrides.find((o) => o.theme === theme)?.colors ?? {};
}

type ServerValue = { settings: (LookSettings & { updatedAt: number }) | null; themes: CustomThemeMeta[] };

export class Look {
  readonly settings: Slice<LookSettings>;
  readonly themes = new Slice<CustomThemeMeta[]>([]);
  /** Colors adjusted for contrast, per mode (note in settings) */
  readonly fixes = new Slice<Record<ThemeType, ContrastFix[]>>({ dark: [], light: [] });
  /** Server has answered (the list of custom themes is complete) */
  readonly loaded = new Slice(false);
  #app: App | null = null;
  #at: number;
  #dirty: boolean;
  #render = 0;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #saving = false;
  #server: ServerValue | null = null;
  #custom = new Map<string, { updatedAt: number; theme: VsTheme }>();

  constructor() {
    const cache = readCache();
    this.settings = new Slice<LookSettings>(cache ? { ...DEFAULT_LOOK, ...cache.settings } : { ...DEFAULT_LOOK });
    this.#at = cache?.at ?? 0;
    this.#dirty = cache?.dirty ?? false;
  }

  /** Connect to the server. If the cached CSS does not match (new build, interrupted run): rebuild it. */
  start(app: App) {
    if (this.#app) return;
    this.#app = app;
    const cache = readCache();
    const settings = this.settings.get();
    if (cache ? cache.build !== BUILD || !sameLook(cache.rendered ?? DEFAULT_LOOK, settings) : !sameLook(settings, DEFAULT_LOOK)) void this.render();
    const watch = app.store.watch(api.appearance.get, {});
    watch.slice.subscribe(() => {
      const value = watch.slice.get();
      if (value) this.#onServer(value);
    });
  }

  #onServer(value: ServerValue) {
    this.#server = value;
    this.themes.set(value.themes);
    this.loaded.set(true);
    const server = value.settings;
    const remote: LookSettings | null = server && { dark: server.dark, light: server.light, sans: server.sans, mono: server.mono, overrides: server.overrides };
    if (this.#dirty) {
      // Echo of our own change: saved. Otherwise save, unless a save is already in flight.
      if (server && remote && sameLook(remote, this.settings.get())) {
        this.#dirty = false;
        this.#at = server.updatedAt;
        this.#persistMeta();
      } else if (!this.#saving && !this.#saveTimer) this.#scheduleSave(0);
    } else if (!server || !remote) {
      // Never saved: upload the local choice (e.g. from before server sync existed).
      if (!sameLook(this.settings.get(), DEFAULT_LOOK)) {
        this.#dirty = true;
        this.#scheduleSave(0);
      }
    } else if (server.updatedAt !== this.#at) {
      this.#at = server.updatedAt;
      if (!sameLook(remote, this.settings.get())) {
        this.settings.set(remote);
        void this.render();
        return;
      }
      this.#persistMeta();
    }
    // A chosen custom theme was changed (possibly on another device): rebuild the CSS.
    const built = readCache()?.custom ?? {};
    if (value.themes.some((t) => this.#uses(`custom:${t.id}`) && built[t.id] !== t.updatedAt)) void this.render();
  }

  #uses(ref: string) {
    const s = this.settings.get();
    return s.dark === ref || s.light === ref;
  }

  /** Change the choice: apply at once, then save (color sliders: debounced). */
  set(patch: Partial<LookSettings>, opts: { debounce?: boolean } = {}) {
    this.settings.set({ ...this.settings.get(), ...patch });
    this.#dirty = true;
    void this.render();
    this.#scheduleSave(opts.debounce ? 600 : 0);
  }

  /** Override one color of a theme (null = back to the derived value). */
  setOverride(theme: string, name: string, value: string | null, opts: { debounce?: boolean } = {}) {
    const overrides = this.settings.get().overrides.map((o) => ({ theme: o.theme, colors: { ...o.colors } }));
    let entry = overrides.find((o) => o.theme === theme);
    if (!entry) overrides.push((entry = { theme, colors: {} }));
    if (value) entry.colors[name] = value;
    else delete entry.colors[name];
    this.set({ overrides: overrides.filter((o) => Object.keys(o.colors).length > 0) }, opts);
  }

  resetOverrides(theme: string) {
    this.set({ overrides: this.settings.get().overrides.filter((o) => o.theme !== theme) });
  }

  #scheduleSave(delay: number) {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => void this.#save(), delay);
  }

  /** Drop references to custom themes that no longer exist (deleted on another device). */
  #withoutDeleted(settings: LookSettings): LookSettings {
    if (!this.loaded.get()) return settings;
    const known = new Set(this.themes.get().map((t) => `custom:${t.id}`));
    const ok = (ref: string) => !ref.startsWith('custom:') || known.has(ref);
    return { ...settings, dark: ok(settings.dark) ? settings.dark : 'xlr8', light: ok(settings.light) ? settings.light : 'xlr8', overrides: settings.overrides.filter((o) => ok(o.theme)) };
  }

  async #save() {
    this.#saveTimer = null;
    const app = this.#app;
    if (!app || this.#saving) return this.#persistMeta();
    const current = this.settings.get();
    const settings = this.#withoutDeleted(current);
    if (!sameLook(settings, current)) {
      this.settings.set(settings);
      void this.render();
    }
    this.#saving = true;
    try {
      const { updatedAt } = await app.store.call(api.appearance.save, settings);
      // Changed again meanwhile: the next run saves.
      if (sameLook(settings, this.settings.get())) {
        this.#dirty = false;
        this.#at = updatedAt;
      } else this.#scheduleSave(0);
    } catch (error) {
      app.toasts.error(t('Appearance not saved'), error);
      // If the server rejects the choice (invalid, theme gone), do not retry forever: the server state wins.
      const code = (error as { data?: { code?: string } }).data?.code;
      if (code === 'invalid' || code === 'not_found') {
        this.#dirty = false;
        this.#at = -1;
        if (this.#server) this.#onServer(this.#server);
      }
    } finally {
      this.#saving = false;
    }
    this.#persistMeta();
  }

  /** Update only timestamp and flags in the cache (CSS and `rendered` stay; if they do not match, the next startup rebuilds). */
  #persistMeta() {
    const cache = readCache();
    if (!cache) return;
    write({ ...cache, settings: this.settings.get(), at: this.#at, dirty: this.#dirty || undefined });
  }

  /** Load the theme for an id (null = Selfbound colors, or unknown/deleted). */
  async theme(ref: string): Promise<VsTheme | null> {
    if (ref === 'xlr8') return null;
    if (!ref.startsWith('custom:')) return builtin(ref) ? await loadBuiltin(ref) : null;
    const id = ref.slice('custom:'.length);
    const meta = this.themes.get().find((t) => t.id === id);
    const cached = this.#custom.get(id);
    if (cached && (!meta || cached.updatedAt === meta.updatedAt)) return cached.theme;
    if (!this.#app) return null;
    const doc = await this.#app.store.client.query(api.appearance.theme, { id: id as Id<'customThemes'> });
    if (!doc) return null;
    const theme = readTheme(doc.source, { name: doc.name, typeHint: doc.type });
    this.#custom.set(id, { updatedAt: doc.updatedAt, theme });
    return theme;
  }

  /** Mapping of a theme with its saved overrides. */
  async mapped(ref: string, settings = this.settings.get()): Promise<MappedTheme | null> {
    const theme = await this.theme(ref);
    return theme && mapTheme(theme, overridesFor(settings, ref));
  }

  /** Build the CSS, apply it and store it for the next startup. If loading fails, the previous CSS stays. */
  async render() {
    const run = ++this.#render;
    const settings = this.settings.get();
    let dark: MappedTheme | null;
    let light: MappedTheme | null;
    try {
      [dark, light] = await Promise.all([this.mapped(settings.dark, settings), this.mapped(settings.light, settings)]);
    } catch (error) {
      if (run === this.#render) this.#app?.toasts.error(t('Theme not loaded'), error);
      return;
    }
    if (run !== this.#render) return;
    // Only matching themes: a light theme in dark mode would contradict rules like [data-theme='dark'].
    if (dark?.type !== 'dark') dark = null;
    if (light?.type !== 'light') light = null;
    const sans = fontCss(settings.sans, 'sans');
    const mono = fontCss(settings.mono, 'mono');
    // :root:root beats :root from app.css regardless of the order of the style elements.
    const root: string[] = [];
    if (sans.stack) root.push(`--font:${sans.stack}`);
    if (settings.sans !== 'inter') root.push('--font-features:normal');
    if (mono.stack) root.push(`--mono:${mono.stack}`);
    const css = [dark ? themeCss('dark', dark.vars) : '', light ? themeCss('light', light.vars) : '', root.length ? `:root:root{${root.join(';')}}` : '', sans.faces, mono.faces].join('');
    const bar = { dark: dark?.bar, light: light?.bar };
    apply(css);
    this.#app?.prefs.setBarColors(bar);
    this.fixes.set({ dark: dark?.fixes ?? [], light: light?.fixes ?? [] });
    const preload = [sans.preload, mono.preload].filter((p): p is string => !!p);
    // Versions of the custom themes the CSS was built from (if another device changes one, #onServer rebuilds).
    const custom: Record<string, number> = {};
    for (const ref of [settings.dark, settings.light]) {
      const id = ref.startsWith('custom:') ? ref.slice('custom:'.length) : null;
      const used = id && this.#custom.get(id);
      if (id && used) custom[id] = used.updatedAt;
    }
    write({ v: 1, settings: this.settings.get(), rendered: settings, custom, at: this.#at, dirty: this.#dirty || undefined, build: BUILD, css, bar, preload });
  }
}

/** Write the CSS into the style element from index.html (id "selfbound-look"). */
function apply(css: string) {
  let el = document.getElementById('selfbound-look') as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = 'selfbound-look';
    document.head.append(el);
  }
  if (el.textContent !== css) el.textContent = css;
}

function write(cache: LookCache) {
  try {
    localStorage.setItem(LOOK_KEY, JSON.stringify(cache));
  } catch {
    // full or private mode: then it only applies to this session
  }
}

export const look = new Look();
