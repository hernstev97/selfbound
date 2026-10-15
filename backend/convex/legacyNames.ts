import { v } from 'convex/values';
import type { Doc, TableNames } from './_generated/dataModel';
import { internalMutation, internalQuery, type QueryCtx } from './_generated/server';
import { LEGACY_OWNER_KIND, LEGACY_SPRINT_SOURCE, OWNER_KIND, SPRINT_SOURCE } from './shared/constants';

// Moves stored legacy names to the Selfbound names, page by page. Driven by
// tooling/migrate-legacy-data.mjs (dry run first, then --apply, then --verify).
//
// legacy-xlr8: this file names the old values on purpose. It goes away with the fallbacks.
//   actor kind  'steven' → 'owner'    every actor field, also inside inbox changes, and `requests.owner`
//   theme ID    'xlr8' → 'selfbound'  appearance: dark, light, overrides[].theme
//   sprint source 'xlr8' → 'selfbound'
//
// Only the changed fields are patched: no `updatedAt`, version, rank or anything else moves, and
// nothing runs that would notify, add inbox entries or write history. Idempotent: a second run
// finds nothing. A dry run (`apply: false`) counts and writes nothing.

const LEGACY_THEME = 'xlr8'; // legacy-xlr8
const THEME = 'selfbound';

export const TABLES = [
  'issues',
  'issueBodies',
  'bodyRevisions',
  'comments',
  'relations',
  'history',
  'inboxEntries',
  'sprintItems',
  'files',
  'articles',
  'articleBodies',
  'articleRevisions',
  'articleSources',
  'requests',
  'sprints',
  'appearance',
] as const;
export type MigratedTable = (typeof TABLES)[number];

/** Top-level fields that hold an actor, per table. Checked against the schema in the tests. */
export const ACTOR_FIELDS = {
  issues: ['createdBy'],
  issueBodies: ['updatedBy'],
  bodyRevisions: ['actor'],
  comments: ['author'],
  relations: ['createdBy'],
  history: ['actor'],
  inboxEntries: ['actor'], // and `changes[].actor`, handled below
  sprintItems: ['addedBy'],
  files: ['uploadedBy'],
  articles: ['createdBy', 'updatedBy'],
  articleBodies: ['updatedBy'],
  articleRevisions: ['actor'],
  articleSources: ['createdBy'],
} as const satisfies Partial<Record<MigratedTable, readonly string[]>>;

const PAGE = 200;
/** Read limit per page, well below Convex's 16 MiB (bodies and revisions can be 200 kB each). */
const MAX_BYTES = 4 * 1024 * 1024;

type Row = Record<string, unknown>;

const isLegacyActor = (a: unknown): a is { kind: string } =>
  !!a && typeof a === 'object' && (a as { kind?: unknown }).kind === LEGACY_OWNER_KIND;
const modernActor = <A extends { kind: string }>(a: A): A => (isLegacyActor(a) ? { ...a, kind: OWNER_KIND } : a);

/** The fields to patch for one document; null = nothing legacy in it. Pure. */
export function legacyPatch(table: MigratedTable, doc: Row): Row | null {
  const patch: Row = {};
  const fields: readonly string[] = (ACTOR_FIELDS as Partial<Record<MigratedTable, readonly string[]>>)[table] ?? [];
  for (const field of fields) if (isLegacyActor(doc[field])) patch[field] = modernActor(doc[field] as { kind: string });

  if (table === 'inboxEntries') {
    const changes = doc.changes as { actor: { kind: string } }[] | undefined;
    if (changes?.some((c) => isLegacyActor(c.actor))) patch.changes = changes.map((c) => ({ ...c, actor: modernActor(c.actor) }));
  } else if (table === 'requests') {
    if (doc.owner === LEGACY_OWNER_KIND) patch.owner = OWNER_KIND;
  } else if (table === 'sprints') {
    if (doc.source === LEGACY_SPRINT_SOURCE) patch.source = SPRINT_SOURCE;
  } else if (table === 'appearance') {
    for (const field of ['dark', 'light']) if (doc[field] === LEGACY_THEME) patch[field] = THEME;
    const overrides = doc.overrides as { theme: string; colors: Record<string, string> }[] | undefined;
    if (overrides?.some((o) => o.theme === LEGACY_THEME)) patch.overrides = mergeOverrides(overrides);
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Renames the overrides of the legacy theme; if the new ID has overrides too, its colors win. */
function mergeOverrides(overrides: { theme: string; colors: Record<string, string> }[]) {
  const out: { theme: string; colors: Record<string, string> }[] = [];
  const legacy = overrides.filter((o) => o.theme === LEGACY_THEME);
  for (const o of overrides) {
    if (o.theme === LEGACY_THEME) continue;
    if (o.theme !== THEME) {
      out.push(o);
      continue;
    }
    out.push({ theme: THEME, colors: { ...Object.assign({}, ...legacy.map((l) => l.colors)), ...o.colors } });
  }
  if (!out.some((o) => o.theme === THEME) && legacy.length > 0) {
    out.push({ theme: THEME, colors: Object.assign({}, ...legacy.map((l) => l.colors)) });
  }
  return out;
}

const tableArg = v.optional(v.union(...TABLES.map((t) => v.literal(t))));
const cursorArg = v.optional(v.union(v.string(), v.null()));

async function page(ctx: QueryCtx, table: MigratedTable, cursor: string | null, numItems: number) {
  return await ctx.db.query(table as TableNames).paginate({ cursor, numItems, maximumBytesRead: MAX_BYTES });
}

function nextOf(table: MigratedTable, isDone: boolean, continueCursor: string) {
  if (!isDone) return { table, cursor: continueCursor };
  const following = TABLES[TABLES.indexOf(table) + 1];
  return following ? { table: following, cursor: null } : null;
}

/**
 * One page of one table. Returns what it found (`legacy` documents with an old value), what it wrote
 * (`written`, always 0 in a dry run) and where to continue (`next`, null when all tables are done).
 */
export const step = internalMutation({
  args: { apply: v.boolean(), table: tableArg, cursor: cursorArg, pageSize: v.optional(v.number()) },
  handler: async (ctx, { apply, table = TABLES[0], cursor = null, pageSize = PAGE }) => {
    const rows = await page(ctx, table, cursor, pageSize);
    let legacy = 0;
    let written = 0;
    for (const doc of rows.page as unknown as (Row & { _id: Doc<TableNames>['_id'] })[]) {
      const patch = legacyPatch(table, doc);
      if (!patch) continue;
      legacy++;
      if (!apply) continue;
      // An idempotency record that already exists under the new owner makes the old one redundant.
      if (table === 'requests' && (await existsAsOwner(ctx, doc))) await ctx.db.delete(doc._id);
      else await ctx.db.patch(doc._id, patch as never);
      written++;
    }
    return { table, scanned: rows.page.length, legacy, written, next: nextOf(table, rows.isDone, rows.continueCursor) };
  },
});

async function existsAsOwner(ctx: QueryCtx, doc: Row) {
  const requestId = doc.requestId as string;
  const twin = await ctx.db
    .query('requests')
    .withIndex('by_owner_request', (q) => q.eq('owner', OWNER_KIND).eq('requestId', requestId))
    .first();
  return twin !== null;
}

/** Read-only check: pages like `step` and reports how many documents still hold a legacy value. */
export const verify = internalQuery({
  args: { table: tableArg, cursor: cursorArg, pageSize: v.optional(v.number()) },
  handler: async (ctx, { table = TABLES[0], cursor = null, pageSize = PAGE }) => {
    const rows = await page(ctx, table, cursor, pageSize);
    let remaining = 0;
    for (const doc of rows.page as unknown as Row[]) if (legacyPatch(table, doc)) remaining++;
    return { table, scanned: rows.page.length, remaining, next: nextOf(table, rows.isDone, rows.continueCursor) };
  },
});
