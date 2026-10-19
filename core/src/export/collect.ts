// The app's side of the export: reads every export table page by page through dataExport.page and
// fetches the files through short-lived storage URLs (dataExport.fileUrls).
import type { ConvexClient } from 'convex/browser';
import { api } from '@selfbound/backend/api';
import type { Id } from '@selfbound/backend/dataModel';
import { EXPORT_TABLES, EXPORT_URL_BATCH } from '@selfbound/backend/shared/export';
import type { ExportFile, ExportFileReader, ExportProgress, ExportTables } from './types.ts';

type Client = Pick<ConvexClient, 'query'>;

export async function readTables(client: Client, onProgress?: (p: ExportProgress) => void): Promise<ExportTables> {
  const tables: Record<string, unknown[]> = {};
  for (const table of EXPORT_TABLES) {
    const rows: unknown[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: { rows: unknown[]; cursor: string; isDone: boolean } = await client.query(api.dataExport.page, { table, cursor });
      rows.push(...page.rows);
      onProgress?.({ phase: 'tables', table, rows: rows.length });
      if (page.isDone) break;
      cursor = page.cursor;
    }
    tables[table] = rows;
  }
  return tables as ExportTables;
}

/** Fetches a few files at a time; a file that is gone or fails to load yields null. */
export function urlFileReader(client: Client, fetchFile: typeof fetch = fetch, parallel = 4): ExportFileReader {
  return async function* (files: ExportFile[]) {
    for (let start = 0; start < files.length; start += EXPORT_URL_BATCH) {
      const batch = files.slice(start, start + EXPORT_URL_BATCH);
      const urls = await client.query(api.dataExport.fileUrls, { storageIds: batch.map((f) => f.storageId as Id<'_storage'>) });
      for (let i = 0; i < urls.length; i += parallel) {
        const loaded = await Promise.all(
          urls.slice(i, i + parallel).map(async ({ url }) => {
            if (!url) return null;
            try {
              const response = await fetchFile(url);
              return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
            } catch {
              return null;
            }
          }),
        );
        yield* loaded;
      }
    }
  };
}
