import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { ownerQuery, ownerWriteMutation } from './lib/auth';
import { invalid, notFound } from './lib/errors';

// Appearance: chosen themes for light and dark mode, fonts, color overrides and custom VS Code
// themes. Applies on all devices; the app keeps a copy in localStorage so nothing flashes at
// startup (app/src/lib/look/). Mapping themes and checking contrast happens in the app.

/** Largest theme JSON in characters. The largest bundled themes are about 75 kB. */
export const MAX_THEME_SOURCE = 300_000;
const MAX_THEMES = 30;
const MAX_NAME = 80;
const MAX_OVERRIDES = 80;

export type ThemeType = 'dark' | 'light';

const overridesValidator = v.array(v.object({ theme: v.string(), colors: v.record(v.string(), v.string()) }));

const DEFAULTS = { dark: 'xlr8', light: 'xlr8', sans: 'inter', mono: 'system', overrides: [] as { theme: string; colors: Record<string, string> }[] };

async function row(ctx: QueryCtx): Promise<Doc<'appearance'> | null> {
  return await ctx.db.query('appearance').first();
}

/** Chosen appearance (null = never saved) and the list of custom themes without their JSON. */
export const get = ownerQuery({
  args: {},
  handler: async (ctx) => {
    const settings = await row(ctx);
    const themes = await ctx.db.query('customThemes').take(MAX_THEMES);
    return {
      settings: settings && { dark: settings.dark, light: settings.light, sans: settings.sans, mono: settings.mono, overrides: settings.overrides, updatedAt: settings.updatedAt },
      themes: themes.map((t) => ({ id: t._id, name: t.name, type: t.type, updatedAt: t.updatedAt })),
    };
  },
});

/** JSON of a custom theme (null = deleted). */
export const theme = ownerQuery({
  args: { id: v.id('customThemes') },
  handler: async (ctx, { id }) => {
    const doc = await ctx.db.get('customThemes', id);
    const source = doc && (await sourceOf(ctx, id));
    return doc && source && { id: doc._id, name: doc.name, type: doc.type, source: source.source, updatedAt: doc.updatedAt };
  },
});

const THEME_REF = /^(xlr8|[a-z0-9-]{1,60}|custom:[A-Za-z0-9]{1,80})$/;
const FONT_REF = /^(inter|system|[a-z0-9-]{1,60}|local:[\p{L}\p{N} ._-]{1,64})$/u;
const VAR_NAME = /^[a-z][a-z0-9-]{0,40}$/;
const HEX = /^#[0-9a-f]{6}$/;

/** Sets the appearance (replaces the stored one entirely). */
export const save = ownerWriteMutation({
  args: { dark: v.string(), light: v.string(), sans: v.string(), mono: v.string(), overrides: overridesValidator },
  handler: async (ctx, args) => {
    for (const ref of [args.dark, args.light]) if (!THEME_REF.test(ref)) invalid(`Unknown theme "${ref.slice(0, 80)}".`);
    for (const ref of [args.sans, args.mono]) if (!FONT_REF.test(ref)) invalid(`Invalid font "${ref.slice(0, 80)}".`);
    if (args.overrides.length > MAX_OVERRIDES) invalid('Too many themes with overrides.');
    for (const o of args.overrides) {
      if (!THEME_REF.test(o.theme)) invalid(`Unknown theme "${o.theme.slice(0, 80)}".`);
      const entries = Object.entries(o.colors);
      if (entries.length > 100) invalid('Too many color overrides.');
      for (const [key, value] of entries) if (!VAR_NAME.test(key) || !HEX.test(value)) invalid(`Invalid color ${key.slice(0, 40)}: ${value.slice(0, 20)}`);
    }
    for (const ref of [args.dark, args.light]) await assertTheme(ctx, ref);
    const value = { dark: args.dark, light: args.light, sans: args.sans, mono: args.mono, overrides: args.overrides.filter((o) => Object.keys(o.colors).length > 0), updatedAt: Date.now() };
    const existing = await row(ctx);
    if (existing) await ctx.db.replace('appearance', existing._id, value);
    else await ctx.db.insert('appearance', value);
    return { updatedAt: value.updatedAt };
  },
});

async function sourceOf(ctx: QueryCtx, themeId: Id<'customThemes'>) {
  return await ctx.db
    .query('customThemeSources')
    .withIndex('by_theme', (q) => q.eq('themeId', themeId))
    .first();
}

async function assertTheme(ctx: QueryCtx, ref: string) {
  if (!ref.startsWith('custom:')) return;
  const id = ctx.db.normalizeId('customThemes', ref.slice('custom:'.length));
  if (!id || !(await ctx.db.get('customThemes', id))) notFound('The theme');
}

function checkName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (!trimmed) invalid('The theme needs a name.');
  if (trimmed.length > MAX_NAME) invalid(`The name is too long (at most ${MAX_NAME} characters).`);
  return trimmed;
}

/** Checks the cleaned theme JSON: an object with `colors` and/or `tokenColors`. */
function checkSource(source: string) {
  if (source.length > MAX_THEME_SOURCE) invalid(`The theme is too large (at most ${MAX_THEME_SOURCE / 1000} kB).`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    invalid('The theme is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid('The theme must be a JSON object.');
  const theme = parsed as { colors?: unknown; tokenColors?: unknown };
  const hasColors = !!theme.colors && typeof theme.colors === 'object' && !Array.isArray(theme.colors);
  if (!hasColors && !Array.isArray(theme.tokenColors)) invalid('The theme contains neither "colors" nor "tokenColors".');
}

/** Creates a custom theme or replaces one (with `id`). */
export const saveTheme = ownerWriteMutation({
  args: { id: v.optional(v.id('customThemes')), name: v.string(), type: v.union(v.literal('dark'), v.literal('light')), source: v.string() },
  handler: async (ctx, args): Promise<{ id: Id<'customThemes'> }> => {
    const name = checkName(args.name);
    checkSource(args.source);
    const now = Date.now();
    if (args.id) {
      const existing = await ctx.db.get('customThemes', args.id);
      if (!existing) notFound('The theme');
      if (existing.type !== args.type) await unselect(ctx, `custom:${args.id}`, existing.type);
      await ctx.db.patch('customThemes', args.id, { name, type: args.type, updatedAt: now });
      const source = await sourceOf(ctx, args.id);
      if (source) await ctx.db.patch('customThemeSources', source._id, { source: args.source });
      else await ctx.db.insert('customThemeSources', { themeId: args.id, source: args.source });
      return { id: args.id };
    }
    const count = (await ctx.db.query('customThemes').take(MAX_THEMES)).length;
    if (count >= MAX_THEMES) invalid(`At most ${MAX_THEMES} custom themes.`);
    const id = await ctx.db.insert('customThemes', { name, type: args.type, createdAt: now, updatedAt: now });
    await ctx.db.insert('customThemeSources', { themeId: id, source: args.source });
    return { id };
  },
});

export const renameTheme = ownerWriteMutation({
  args: { id: v.id('customThemes'), name: v.string() },
  handler: async (ctx, { id, name }) => {
    if (!(await ctx.db.get('customThemes', id))) notFound('The theme');
    await ctx.db.patch('customThemes', id, { name: checkName(name), updatedAt: Date.now() });
  },
});

/** Deletes a custom theme. Where it was selected the default applies again; its color overrides are dropped. */
export const deleteTheme = ownerWriteMutation({
  args: { id: v.id('customThemes') },
  handler: async (ctx, { id }) => {
    const doc = await ctx.db.get('customThemes', id);
    if (!doc) return { removed: false };
    await unselect(ctx, `custom:${id}`);
    const source = await sourceOf(ctx, id);
    if (source) await ctx.db.delete('customThemeSources', source._id);
    await ctx.db.delete('customThemes', id);
    return { removed: true };
  },
});

/** Deselects a theme (only in mode `type`, else in both) and drops its color overrides. */
async function unselect(ctx: MutationCtx, ref: string, type?: ThemeType) {
  const settings = await row(ctx);
  if (!settings) return;
  const patch: Partial<Doc<'appearance'>> = {};
  if (settings.dark === ref && type !== 'light') patch.dark = DEFAULTS.dark;
  if (settings.light === ref && type !== 'dark') patch.light = DEFAULTS.light;
  if (!type && settings.overrides.some((o) => o.theme === ref)) patch.overrides = settings.overrides.filter((o) => o.theme !== ref);
  if (Object.keys(patch).length) await ctx.db.patch('appearance', settings._id, { ...patch, updatedAt: Date.now() });
}
