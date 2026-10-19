import { v } from 'convex/values';
import { ownerQuery } from './lib/auth';
import { invalid } from './lib/errors';
import { EXPORT_PAGE_BYTES, EXPORT_PAGE_ROWS, EXPORT_URL_BATCH, exportRow, isExportTable } from './shared/export';

// Data export for the owner (SELF-46, Settings → Data export). The app reads every table of
// shared/export.ts page by page and builds the ZIP itself (core/src/export), so no single function
// comes near the read limits. The pages are read one after another, not as one snapshot; for that,
// tooling/export converts a `convex export`.

/** One page of an export table, rows as stored minus the omitted fields. */
export const page = ownerQuery({
  args: { table: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { table, cursor }) => {
    if (!isExportTable(table)) invalid(`Table ${table} is not part of the export.`);
    const result = await ctx.db.query(table).paginate({ cursor, numItems: EXPORT_PAGE_ROWS, maximumBytesRead: EXPORT_PAGE_BYTES });
    return {
      rows: result.page.map((row) => exportRow(table, row as unknown as Record<string, unknown>)),
      cursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

/** Download URLs for stored files (images, logos); null for files that are gone. */
export const fileUrls = ownerQuery({
  args: { storageIds: v.array(v.id('_storage')) },
  handler: async (ctx, { storageIds }) => {
    if (storageIds.length > EXPORT_URL_BATCH) invalid(`At most ${EXPORT_URL_BATCH} files per call.`);
    return await Promise.all(storageIds.map(async (id) => ({ storageId: id, url: await ctx.storage.getUrl(id) })));
  },
});
