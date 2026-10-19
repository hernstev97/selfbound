// Builds the export ZIP from the exported tables. Shared by the app (Settings → Data export) and
// tooling/export (from a `convex export` snapshot); only where the rows and files come from differs.
//
//   json/manifest.json      format, version, time, rows per table, files
//   json/<table>.json       rows as stored, one per line (complete, for a later re-import)
//   markdown/…              readable copy (markdown.ts)
//   files/…                 images, team logos
import { EXPORT_FORMAT, EXPORT_TABLES, EXPORT_VERSION, exportRow } from '@selfbound/backend/shared/export';
import { ExportIndex, articleMarkdown, articlePaths, issueMarkdown, issuePaths, readmeMarkdown, safeName } from './markdown.ts';
import type { ExportFile, ExportFileReader, ExportProgress, ExportTables } from './types.ts';
import { ZipWriter } from './zip.ts';

const EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};
const ext = (contentType: string | undefined) => (contentType && EXTENSION[contentType] ? `.${EXTENSION[contentType]}` : '');

/** The stored files of an export: referenced images (orphans waiting for cleanup are left out) and team logos. */
export function exportFiles(tables: ExportTables): ExportFile[] {
  const files: ExportFile[] = [];
  const paths = new Set<string>();
  const add = (file: ExportFile) => {
    // A path twice (the same token in two rows) would end the whole export; the first one wins.
    if (paths.has(file.path)) return;
    paths.add(file.path);
    files.push(file);
  };
  for (const f of tables.files) {
    if (f.deleteAfter !== undefined) continue;
    add({ storageId: f.storageId, path: `files/images/${f.token}${ext(f.contentType)}`, contentType: f.contentType, token: f.token });
  }
  for (const team of tables.teams) {
    const name = safeName(team.key); // CON, AUX … are valid team keys but no valid Windows file names
    if (team.logoId) add({ storageId: team.logoId, path: `files/logos/${name}${ext(team.logoType)}`, contentType: team.logoType });
    if (team.logoDarkId) add({ storageId: team.logoDarkId, path: `files/logos/${name}-dark${ext(team.logoType)}`, contentType: team.logoType });
  }
  return files;
}

/** A table as JSON: an array with one row per line, so it stays readable and diffable. */
export function tableJson(rows: readonly unknown[]): string {
  return rows.length ? `[\n${rows.map((r) => JSON.stringify(r)).join(',\n')}\n]\n` : '[]\n';
}

export type ExportResult = {
  parts: Uint8Array[];
  bytes: number;
  counts: Record<string, number>;
  files: number;
  missingFiles: string[];
};

export async function buildExport(
  tables: ExportTables,
  options: { exportedAt: number; source: 'app' | 'snapshot'; readFiles?: ExportFileReader; onProgress?: (p: ExportProgress) => void },
): Promise<ExportResult> {
  const index = new ExportIndex(tables);
  const zip = new ZipWriter(options.exportedAt);
  const wanted = exportFiles(tables);
  const stored: ExportFile[] = [];
  const missingFiles: string[] = [];

  if (options.readFiles && wanted.length) {
    let i = 0;
    for await (const data of options.readFiles(wanted)) {
      const file = wanted[i++]!;
      if (data) {
        // SVG is text and compresses; raster images are compressed already.
        await zip.add(file.path, data, { compress: file.contentType === 'image/svg+xml' });
        stored.push(file);
      } else missingFiles.push(file.path);
      options.onProgress?.({ phase: 'files', done: i, total: wanted.length });
    }
  } else missingFiles.push(...wanted.map((f) => f.path));
  for (const file of stored) if (file.token) index.images.set(file.token, file.path);

  options.onProgress?.({ phase: 'zip' });
  const counts: Record<string, number> = {};
  for (const table of EXPORT_TABLES) {
    counts[table] = tables[table].length;
    // Again here, not only in dataExport.page: a snapshot still holds the omitted fields.
    await zip.add(`json/${table}.json`, tableJson(tables[table].map((row) => exportRow(table, row as unknown as Record<string, unknown>))));
  }
  const manifest = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date(options.exportedAt).toISOString(),
    source: options.source,
    tables: counts,
    files: stored,
    missingFiles,
  };
  await zip.add('json/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

  await zip.add('markdown/README.md', readmeMarkdown(index, { exportedAt: options.exportedAt, counts, files: stored.length, missingFiles: missingFiles.length }));
  const issueFiles = issuePaths(index);
  for (const issue of tables.issues) {
    const path = issueFiles.get(issue._id)!;
    await zip.add(path, issueMarkdown(issue, index, path));
  }
  const paths = articlePaths(index);
  for (const article of tables.articles) {
    const path = paths.get(article._id)!;
    await zip.add(path, articleMarkdown(article, index, path));
  }

  const parts = zip.finish();
  return { parts, bytes: zip.size, counts, files: stored.length, missingFiles };
}
