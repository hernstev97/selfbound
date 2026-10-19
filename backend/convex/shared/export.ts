// Data export for the owner (SELF-46): which tables an export contains and what never leaves the
// instance. Shared by the export query (dataExport.ts), the app (core/src/export) and the script
// tooling/export, which reads the same tables from a `convex export` snapshot.
// No imports: Node runs this file directly (tooling/export/index.ts).

/** Format name and version in `json/manifest.json`. A later re-import checks both. */
export const EXPORT_FORMAT = 'selfbound-export';
export const EXPORT_VERSION = 1;

/**
 * The tables of an export, in the order they are read. Everything the owner wrote or set up,
 * trash included. Left out on purpose: secrets (OAuth, push subscriptions), derived search text
 * (bodySearch, articleSearch, articleLinks), caches (embeds, models catalog, PR details, check
 * runs), running state (counters, inbox, requests, rate windows, push outbox, import staging) and
 * ops data. Add a table here only together with its omitted fields below.
 */
export const EXPORT_TABLES = [
  'teams',
  'workflowStates',
  'projects',
  'labelGroups',
  'labels',
  'issues',
  'identifierAliases',
  'issueBodies',
  'bodyRevisions',
  'comments',
  'relations',
  'history',
  'sprints',
  'sprintItems',
  'recurrences',
  'wikiTopics',
  'articles',
  'articleBodies',
  'articleRevisions',
  'articleSources',
  'files',
  'pullRequests',
  'issuePullRequests',
  'agents',
  'profile',
  'instanceSettings',
  'appearance',
  'customThemes',
  'customThemeSources',
  'pushSettings',
] as const;

export type ExportTable = (typeof EXPORT_TABLES)[number];

/** Fields removed from every row: key hashes and prefixes identify agent keys. */
const OMIT: Partial<Record<ExportTable, readonly string[]>> = {
  agents: ['keyHash', 'keyPrefix'],
};

export function isExportTable(name: string): name is ExportTable {
  return (EXPORT_TABLES as readonly string[]).includes(name);
}

/** A row as it goes into the export (a copy without the omitted fields). */
export function exportRow<T extends Record<string, unknown>>(table: ExportTable, row: T): T {
  const omit = OMIT[table];
  if (!omit) return row;
  const copy: Record<string, unknown> = { ...row };
  for (const field of omit) delete copy[field];
  return copy as T;
}

/** Rows per page of `dataExport.page`; large texts end a page earlier (EXPORT_PAGE_BYTES). */
export const EXPORT_PAGE_ROWS = 1000;
/** Bytes read per page, well below the 8 MiB a query may read and return. */
export const EXPORT_PAGE_BYTES = 4 * 1024 * 1024;
/** Storage ids per `dataExport.fileUrls` call. */
export const EXPORT_URL_BATCH = 100;
