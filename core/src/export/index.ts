// Data export (SELF-46). Loaded only on demand (Settings → Data export), never in the start bundle.
export { buildExport, exportFiles, tableJson, type ExportResult } from './build.ts';
export { readTables, urlFileReader } from './collect.ts';
export type { ExportFile, ExportFileReader, ExportProgress, ExportTables } from './types.ts';

/** File name of an export downloaded on this day. */
export function exportFileName(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `selfbound-export-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.zip`;
}
