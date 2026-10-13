// Types of the Linear snapshot (import, copy only).
//
// `tooling/linear-import` writes a snapshot in this format to
// ~/.local/share/xlr8/import/<run>/snapshot.json and the same records as rows
// for the staging table `importStaging` (staging.jsonl). The processing in the
// backend reads `importStaging` and relies on these types. Format and order:
// docs/architecture/import.md.
//
// Value rules: times as milliseconds since 1970 (UTC), calendar days as
// "YYYY-MM-DD", references always by Linear ID (`…LinearId`), never by XLR8 IDs.
// Fields without a value are absent (no `null`), so Convex accepts them.
// This file imports nothing; it runs in Node, in the browser and in Convex.

export const IMPORT_SNAPSHOT_VERSION = 1;

export type ImportStatus =
  | 'triage'
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'canceled'
  | 'duplicate';

export type ImportProjectState = 'planned' | 'active' | 'paused' | 'done' | 'canceled';
export type ImportRelationType = 'blocks' | 'related' | 'duplicate';
export type ImportPullRequestState = 'open' | 'closed' | 'merged' | 'draft';

export interface ImportTeam {
  linearId: string;
  key: string; // "KIU"
  name: string;
  color?: string; // Linear color as hex, e.g. "#5e6ad2"
  description?: string;
  /** Archived or retired in Linear → dormant in XLR8. */
  dormant: boolean;
  createdAt: number;
}

/** Label group (in Linear a label with `isGroup`). Always single-choice in Linear. */
export interface ImportLabelGroup {
  linearId: string;
  name: string;
  color?: string;
  teamLinearId?: string; // absent = workspace group
  exclusive: boolean;
}

export interface ImportLabel {
  linearId: string;
  name: string;
  color?: string;
  groupLinearId?: string;
  teamLinearId?: string; // absent = workspace label
  archived: boolean;
}

export interface ImportProject {
  linearId: string;
  name: string;
  description?: string;
  /** The single team in XLR8 (in Linear a project can have several, see `teamLinearIds`). */
  teamLinearId: string;
  teamLinearIds: string[];
  state: ImportProjectState;
  linearStatusName?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  canceledAt?: number;
  archivedAt?: number;
}

/** Linear cycle → closed sprint with `source: 'linear'`. */
export interface ImportSprint {
  linearId: string;
  source: 'linear';
  teamLinearId: string;
  teamKey: string;
  linearNumber: number; // cycle number in Linear (per team)
  name: string; // name from Linear or "KIU Cycle 12"
  description?: string;
  startDate: string; // YYYY-MM-DD (Europe/Berlin)
  endDate: string; // YYYY-MM-DD (Europe/Berlin), last day
  startsAt: number;
  endsAt: number;
  completedAt?: number;
}

export interface ImportIssue {
  linearId: string;
  identifier: string; // "KIU-106"
  teamLinearId: string;
  teamKey: string;
  number: number;
  title: string;
  description?: string; // Markdown
  status: ImportStatus;
  linearStateName: string;
  linearStateType: string;
  priority: 0 | 1 | 2 | 3 | 4;
  estimate?: number;
  dueDate?: string; // YYYY-MM-DD
  labelLinearIds: string[];
  projectLinearId?: string;
  parentLinearId?: string;
  cycleLinearId?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  canceledAt?: number;
  archivedAt?: number;
  /** Old identifiers (e.g. after a team move) → `identifierAliases`. */
  previousIdentifiers: string[];
  url?: string;
  /** Order by creation date, starting at 0 → basis for `seq`. */
  order: number;
}

export interface ImportComment {
  linearId: string;
  issueLinearId: string;
  body: string;
  authorName: string; // "Jane Doe (Linear)" or bot name
  authorKind: 'user' | 'bot';
  parentLinearId?: string; // reply in a thread (XLR8 shows comments flat)
  createdAt: number;
  editedAt?: number;
}

export interface ImportRelation {
  linearId: string;
  type: ImportRelationType; // blocks: from blocks to; duplicate: from is a duplicate of to
  fromLinearId: string;
  toLinearId: string;
}

/** GitHub PR from a Linear attachment → `pullRequests` + `issuePullRequests` (via 'import'). */
export interface ImportPullRequest {
  attachmentLinearId: string;
  issueLinearId: string;
  repo: string; // "owner/name"
  number: number;
  url: string;
  title: string;
  state: ImportPullRequestState;
  branch?: string;
  createdAt: number;
}

/** Other attachments stay links (files are not copied). */
export interface ImportLink {
  linearId: string;
  issueLinearId: string;
  url: string;
  title: string;
  sourceType?: string;
  createdAt: number;
}

export interface ImportSnapshot {
  version: typeof IMPORT_SNAPSHOT_VERSION;
  source: 'linear';
  run: string; // timestamp of the run, e.g. "2026-10-08T21-30-00Z"
  fetchedAt: number;
  teams: ImportTeam[];
  labelGroups: ImportLabelGroup[];
  labels: ImportLabel[];
  projects: ImportProject[];
  sprints: ImportSprint[];
  issues: ImportIssue[];
  comments: ImportComment[];
  relations: ImportRelation[];
  pullRequests: ImportPullRequest[];
  links: ImportLink[];
  /** Notes on deviations in this run (numbers and identifiers only). */
  notes: string[];
}

/** Kinds in `importStaging.kind`, in processing order. */
export const IMPORT_KINDS_PHASE_1 = ['team', 'labelGroup', 'label', 'project', 'sprint', 'issue'] as const;
export const IMPORT_KINDS_PHASE_2 = ['comment', 'relation', 'pullRequest', 'link'] as const;
export type ImportKind = (typeof IMPORT_KINDS_PHASE_1)[number] | (typeof IMPORT_KINDS_PHASE_2)[number];

export type ImportPayload = {
  team: ImportTeam;
  labelGroup: ImportLabelGroup;
  label: ImportLabel;
  project: ImportProject;
  sprint: ImportSprint;
  issue: ImportIssue;
  comment: ImportComment;
  relation: ImportRelation;
  pullRequest: ImportPullRequest;
  link: ImportLink;
};

/** One line in staging.jsonl = one document in `importStaging`. */
export interface ImportStagingRow<K extends ImportKind = ImportKind> {
  run: string;
  kind: K;
  linearId: string;
  payload: ImportPayload[K];
}
