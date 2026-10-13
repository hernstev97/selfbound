// Fonts: a selection from Fontsource, self-hosted like Inter (no requests to Google). Latin and Latin
// Extended only; the browser loads the files only once a font is chosen (@font-face applies only
// when used). Plus the system font and a locally installed font.
import atkinsonExt from '@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-ext-wght-normal.woff2?url';
import atkinson from '@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-wght-normal.woff2?url';
import cascadiaExt from '@fontsource-variable/cascadia-code/files/cascadia-code-latin-ext-wght-normal.woff2?url';
import cascadia from '@fontsource-variable/cascadia-code/files/cascadia-code-latin-wght-normal.woff2?url';
import figtreeExt from '@fontsource-variable/figtree/files/figtree-latin-ext-wght-normal.woff2?url';
import figtree from '@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2?url';
import firaExt from '@fontsource-variable/fira-code/files/fira-code-latin-ext-wght-normal.woff2?url';
import fira from '@fontsource-variable/fira-code/files/fira-code-latin-wght-normal.woff2?url';
import geistMonoExt from '@fontsource-variable/geist-mono/files/geist-mono-latin-ext-wght-normal.woff2?url';
import geistMono from '@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?url';
import geistExt from '@fontsource-variable/geist/files/geist-latin-ext-wght-normal.woff2?url';
import geist from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url';
import plexExt from '@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-ext-wght-normal.woff2?url';
import plex from '@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2?url';
import jetbrainsExt from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-ext-wght-normal.woff2?url';
import jetbrains from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url';
import notoExt from '@fontsource-variable/noto-sans/files/noto-sans-latin-ext-wght-normal.woff2?url';
import noto from '@fontsource-variable/noto-sans/files/noto-sans-latin-wght-normal.woff2?url';
import openSansExt from '@fontsource-variable/open-sans/files/open-sans-latin-ext-wght-normal.woff2?url';
import openSans from '@fontsource-variable/open-sans/files/open-sans-latin-wght-normal.woff2?url';
import robotoMonoExt from '@fontsource-variable/roboto-mono/files/roboto-mono-latin-ext-wght-normal.woff2?url';
import robotoMono from '@fontsource-variable/roboto-mono/files/roboto-mono-latin-wght-normal.woff2?url';
import robotoExt from '@fontsource-variable/roboto/files/roboto-latin-ext-wght-normal.woff2?url';
import roboto from '@fontsource-variable/roboto/files/roboto-latin-wght-normal.woff2?url';
import sourceCodeExt from '@fontsource-variable/source-code-pro/files/source-code-pro-latin-ext-wght-normal.woff2?url';
import sourceCode from '@fontsource-variable/source-code-pro/files/source-code-pro-latin-wght-normal.woff2?url';
import sourceSansExt from '@fontsource-variable/source-sans-3/files/source-sans-3-latin-ext-wght-normal.woff2?url';
import sourceSans from '@fontsource-variable/source-sans-3/files/source-sans-3-latin-wght-normal.woff2?url';

export type FontKind = 'sans' | 'mono';

export interface Font {
  id: string;
  name: string;
  kind: FontKind;
  /** font-family in @font-face */
  family: string;
  weight: string;
  latin: string;
  latinExt: string;
}

export const FONTS: Font[] = [
  { id: 'geist', name: 'Geist', kind: 'sans', family: 'Geist Variable', weight: '100 900', latin: geist, latinExt: geistExt },
  { id: 'ibm-plex-sans', name: 'IBM Plex Sans', kind: 'sans', family: 'IBM Plex Sans Variable', weight: '100 700', latin: plex, latinExt: plexExt },
  { id: 'source-sans-3', name: 'Source Sans 3', kind: 'sans', family: 'Source Sans 3 Variable', weight: '200 900', latin: sourceSans, latinExt: sourceSansExt },
  { id: 'open-sans', name: 'Open Sans', kind: 'sans', family: 'Open Sans Variable', weight: '300 800', latin: openSans, latinExt: openSansExt },
  { id: 'roboto', name: 'Roboto', kind: 'sans', family: 'Roboto Variable', weight: '100 900', latin: roboto, latinExt: robotoExt },
  { id: 'noto-sans', name: 'Noto Sans', kind: 'sans', family: 'Noto Sans Variable', weight: '100 900', latin: noto, latinExt: notoExt },
  { id: 'figtree', name: 'Figtree', kind: 'sans', family: 'Figtree Variable', weight: '300 900', latin: figtree, latinExt: figtreeExt },
  { id: 'atkinson-hyperlegible-next', name: 'Atkinson Hyperlegible Next', kind: 'sans', family: 'Atkinson Hyperlegible Next Variable', weight: '200 800', latin: atkinson, latinExt: atkinsonExt },
  { id: 'jetbrains-mono', name: 'JetBrains Mono', kind: 'mono', family: 'JetBrains Mono Variable', weight: '100 800', latin: jetbrains, latinExt: jetbrainsExt },
  { id: 'fira-code', name: 'Fira Code', kind: 'mono', family: 'Fira Code Variable', weight: '300 700', latin: fira, latinExt: firaExt },
  { id: 'geist-mono', name: 'Geist Mono', kind: 'mono', family: 'Geist Mono Variable', weight: '100 900', latin: geistMono, latinExt: geistMonoExt },
  { id: 'source-code-pro', name: 'Source Code Pro', kind: 'mono', family: 'Source Code Pro Variable', weight: '200 900', latin: sourceCode, latinExt: sourceCodeExt },
  { id: 'cascadia-code', name: 'Cascadia Code', kind: 'mono', family: 'Cascadia Code Variable', weight: '200 700', latin: cascadia, latinExt: cascadiaExt },
  { id: 'roboto-mono', name: 'Roboto Mono', kind: 'mono', family: 'Roboto Mono Variable', weight: '100 700', latin: robotoMono, latinExt: robotoMonoExt },
];

// As in app/src/styles/fonts.css (Fontsource subsets).
const LATIN = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
const LATIN_EXT = 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF';

/** Fallback behind the chosen font, like --font and --mono in app.css. */
export const SANS_STACK = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
export const MONO_STACK = "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace";

/** Allowed local font names: letters, digits, space, dot, hyphen and underscore. */
export const LOCAL_NAME = /^[\p{L}\p{N} ._-]{1,64}$/u;

export function font(id: string): Font | undefined {
  return FONTS.find((f) => f.id === id);
}

export interface FontCss {
  /** Value for --font or --mono, null = default from app.css */
  stack: string | null;
  faces: string;
  /** File to preload at startup (Latin) */
  preload: string | null;
}

/** CSS for a choice: "inter" (default text font), "system", a Fontsource id or "local:<name>". */
export function fontCss(ref: string, kind: FontKind): FontCss {
  const fallback = kind === 'sans' ? SANS_STACK : MONO_STACK;
  if (ref === 'system') return { stack: fallback, faces: '', preload: null };
  if (ref.startsWith('local:')) {
    const name = ref.slice('local:'.length).trim();
    if (!LOCAL_NAME.test(name)) return { stack: null, faces: '', preload: null };
    return { stack: `'${name}', ${fallback}`, faces: '', preload: null };
  }
  const f = font(ref);
  if (!f || f.kind !== kind) return { stack: null, faces: '', preload: null };
  const face = (src: string, range: string) => `@font-face{font-family:'${f.family}';font-style:normal;font-display:swap;font-weight:${f.weight};src:url(${src}) format('woff2-variations');unicode-range:${range}}`;
  return { stack: `'${f.family}', ${fallback}`, faces: face(f.latin, LATIN) + face(f.latinExt, LATIN_EXT), preload: f.latin };
}
