import type { Doc } from '@selfbound/backend/dataModel';
import type { ExportTable } from '@selfbound/backend/shared/export';

/** All export tables with their rows as stored (the input of the export, from the app or a snapshot). */
export type ExportTables = { [K in ExportTable]: Doc<K>[] };

/** A stored file that goes into the ZIP. */
export type ExportFile = {
  storageId: string;
  /** Path inside the ZIP, e.g. files/images/<token>.png */
  path: string;
  contentType?: string;
  /** Image token (files table), so a re-import can map the Markdown links. */
  token?: string;
};

/** Reads the files in the given order; null for a file that cannot be read. */
export type ExportFileReader = (files: ExportFile[]) => AsyncIterable<Uint8Array | null>;

export type ExportProgress = { phase: 'tables'; table: string; rows: number } | { phase: 'files'; done: number; total: number } | { phase: 'zip' };
