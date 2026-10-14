// Read VS Code themes: JSON with comments and trailing commas (JSONC) as in VS Code, then check
// what is needed: name, light or dark, `colors`, `tokenColors`.
import { t } from '@selfbound/core/i18n';

export type ThemeType = 'dark' | 'light';

export interface TokenRule {
  scope?: string | string[];
  settings?: { foreground?: string; background?: string; fontStyle?: string };
}

export interface VsTheme {
  name: string;
  type: ThemeType;
  colors: Record<string, string>;
  tokenColors: TokenRule[];
}

/** Removes comments (// and /* *\/) and commas before } or ], without touching strings. */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      const start = i++;
      while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (ch === ',') {
      // Trailing comma: the next character after whitespace and comments is } or ].
      let j = i + 1;
      for (;;) {
        while (j < n && /\s/.test(text[j])) j++;
        if (text[j] === '/' && text[j + 1] === '/') while (j < n && text[j] !== '\n') j++;
        else if (text[j] === '/' && text[j + 1] === '*') {
          const end = text.indexOf('*/', j + 2);
          j = end < 0 ? n : end + 2;
        } else break;
      }
      if (text[j] !== '}' && text[j] !== ']') out += ch;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** Parses JSONC; throws a SyntaxError with a readable message. A leading byte order mark is allowed. */
export function parseJsonc(text: string): unknown {
  const clean = stripJsonc(text.replace(/^﻿/, ''));
  try {
    return JSON.parse(clean);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SyntaxError(t('Not valid JSON: {detail}', { detail }));
  }
}

export class ThemeError extends Error {}

/** Checks and normalizes a VS Code theme. `typeHint` (for bundled themes, from package.json) wins. */
export function readTheme(text: string, opts: { name?: string; typeHint?: ThemeType } = {}): VsTheme {
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch (error) {
    throw new ThemeError(error instanceof Error ? error.message : String(error));
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ThemeError(t('The theme must be a JSON object.'));
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.include === 'string') throw new ThemeError(t('The theme includes "{file}". Paste the JSON that contains the colors (usually under themes/ in the package).', { file: raw.include }));
  const colors: Record<string, string> = {};
  if (raw.colors && typeof raw.colors === 'object' && !Array.isArray(raw.colors)) {
    for (const [key, value] of Object.entries(raw.colors)) if (typeof value === 'string') colors[key] = value;
  }
  const tokenColors = Array.isArray(raw.tokenColors) ? (raw.tokenColors.filter((r) => r && typeof r === 'object') as TokenRule[]) : [];
  if (Object.keys(colors).length === 0 && tokenColors.length === 0) throw new ThemeError(t('The theme contains neither "colors" nor "tokenColors".'));
  const name = (opts.name ?? (typeof raw.name === 'string' ? raw.name : '')).trim() || t('Custom theme');
  const type = opts.typeHint ?? typeOf(raw.type, colors);
  return { name, type, colors, tokenColors };
}

/** Light or dark: by the editor surface (some themes declare `type` wrongly, e.g. Tokyo Night Light), otherwise by `type`. */
function typeOf(declared: unknown, colors: Record<string, string>): ThemeType {
  const bg = /^#([0-9a-f]{6})/i.exec(colors['editor.background'] ?? '');
  if (bg) {
    const n = parseInt(bg[1], 16);
    const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
    return lum > 128 ? 'light' : 'dark';
  }
  return declared === 'light' || declared === 'hc-light' || declared === 'vs' ? 'light' : 'dark';
}

/** Cleaned JSON for storage in Convex: only name, type, colors and tokenColors. */
export function compactSource(theme: VsTheme): string {
  return JSON.stringify({ name: theme.name, type: theme.type, colors: theme.colors, tokenColors: theme.tokenColors });
}
