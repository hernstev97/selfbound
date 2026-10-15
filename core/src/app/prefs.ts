// Browser preferences: color scheme, font size, current team, collapsed sections, size of team rows. Take effect without a reload.
import type { LocalePref } from '../i18n.ts';
import { Slice } from '../observable.ts';

export type Theme = 'system' | 'dark' | 'light';
export type FontSize = 'small' | 'normal' | 'large';
/** Other teams in the sidebar: small rows (logo, name) or large cards with numbers */
export type SidebarTeamSize = 'small' | 'large';

export interface PrefsState {
  theme: Theme;
  fontSize: FontSize;
  /** Key of the current team (top of the sidebar); null = first active team */
  currentTeam: string | null;
  /** "Teams" section collapsed */
  teamsCollapsed: boolean;
  /** "Inactive" section (dormant teams) collapsed */
  dormantCollapsed: boolean;
  /** How teams under "Teams" and "Inactive" are shown; the current team is always a large card */
  sidebarTeams: SidebarTeamSize;
  /** Split inbox: width of the list in px */
  inboxSplit: number;
  /** UI sounds on/off */
  sound: boolean;
  /** Sound volume, 0.05 to 1 */
  soundVolume: number;
  /** UI language; 'auto' follows the browser language. Takes effect after a reload (app/src/main.ts). */
  locale: LocalePref;
}

/** Width of the list in the split inbox without a saved choice. */
export const INBOX_SPLIT_DEFAULT = 420;

/** Sound volume without a saved choice: half */
export const SOUND_VOLUME_DEFAULT = 0.5;

/** Status bar color per color scheme, same as --bg-panel in app/src/styles/app.css (also in app/index.html). */
export const THEME_COLOR = { dark: '#0f0f10', light: '#fcfcfd' } as const;

const KEY = 'selfbound:prefs';
const DEFAULTS: PrefsState = { theme: 'system', fontSize: 'normal', currentTeam: null, teamsCollapsed: false, dormantCollapsed: false, sidebarTeams: 'small', inboxSplit: INBOX_SPLIT_DEFAULT, sound: true, soundVolume: SOUND_VOLUME_DEFAULT, locale: 'auto' };
/** Old sidebar keys, dropped on load */
const OLD = ['teamOpen', 'showDormant'];

function load(): PrefsState {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const stored = JSON.parse(raw);
    for (const key of OLD) delete stored[key];
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Status bar colors from the copy of the look (localStorage "selfbound:look", as in index.html). */
function readBar(): { dark?: string; light?: string } {
  try {
    const bar = JSON.parse(globalThis.localStorage?.getItem('selfbound:look') ?? 'null')?.bar;
    return bar && typeof bar === 'object' ? bar : {};
  } catch {
    return {};
  }
}

export class Prefs {
  readonly state = new Slice<PrefsState>(load());
  /** Scheme actually shown (system resolved) */
  readonly dark = new Slice(true);
  #media: MediaQueryList | null = null;
  /** Status bar per mode from the chosen theme (app/src/lib/look); THEME_COLOR if missing. */
  #bar: { dark?: string; light?: string } = readBar();

  constructor(override?: Partial<PrefsState>) {
    if (override) this.state.set({ ...this.state.get(), ...override });
    if (typeof matchMedia !== 'undefined') {
      this.#media = matchMedia('(prefers-color-scheme: dark)');
      this.#media.addEventListener('change', () => this.apply());
    }
    this.apply();
  }

  set(patch: Partial<PrefsState>) {
    const next = { ...this.state.get(), ...patch };
    this.state.set(next);
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(next));
    } catch {
      // private mode or full: applies to this session only
    }
    this.apply();
  }

  apply() {
    const { theme, fontSize } = this.state.get();
    const dark = theme === 'system' ? (this.#media?.matches ?? true) : theme === 'dark';
    this.dark.set(dark);
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    // Only write on change: every write to the root element can trigger a style recalculation of the whole page.
    const shown = dark ? 'dark' : 'light';
    if (root.dataset.theme !== shown) root.dataset.theme = shown;
    // Status bar of the installed app (Android) in the surface color (--bg-panel).
    const bar = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const color = (dark ? this.#bar.dark : this.#bar.light) ?? (dark ? THEME_COLOR.dark : THEME_COLOR.light);
    if (bar && bar.content !== color) bar.content = color;
    if (root.dataset.font !== fontSize) root.dataset.font = fontSize;
  }

  /** Set the status bar colors from the theme (undefined = default). */
  setBarColors(bar: { dark?: string; light?: string }) {
    this.#bar = bar;
    this.apply();
  }

  toggleTheme() {
    this.set({ theme: this.dark.get() ? 'light' : 'dark' });
  }
}
