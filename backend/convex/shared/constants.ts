// Constants shared by backend, core and UI.
// This file must not import anything from Convex; it also runs in the browser.

/** Fixed bucket size for issue subscriptions. An issue never changes its bucket. */
export const BUCKET_SIZE = 64;

export function bucketOf(seq: number) {
  return Math.floor(seq / BUCKET_SIZE);
}

/** Fixed order of the statuses in lists. */
export const STATUSES = [
  'triage',
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'canceled',
  'duplicate',
] as const;
export type Status = (typeof STATUSES)[number];

/** Statuses that count as open (sprints, the MCP "assigned" filter, sprint close). */
export const OPEN_STATUSES: readonly Status[] = ['triage', 'backlog', 'todo', 'in_progress', 'in_review'];
export const CLOSED_STATUSES: readonly Status[] = ['done', 'canceled', 'duplicate'];
export function isOpen(status: Status) {
  return OPEN_STATUSES.includes(status);
}

/** 0 = none, 1 = urgent, 2 = high, 3 = medium, 4 = low. */
export const PRIORITIES = [0, 1, 2, 3, 4] as const;
export type Priority = (typeof PRIORITIES)[number];

export const RELATION_TYPES = ['blocks', 'related', 'duplicate'] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

/** Actor kind of the instance owner. New writes store this value. */
export const OWNER_KIND = 'owner' as const;
// The owner used to be stored as 'steven', still present in data until the migration (legacyNames.ts)
// has run and accepted everywhere; a follow-up removes it.
// legacy-xlr8: old stored actor kind
export const LEGACY_OWNER_KIND = 'steven' as const;

/** Is this actor kind the instance owner? Always use this for owner checks, never `=== OWNER_KIND`. */
export function isOwnerKind(kind: string): boolean {
  return kind === OWNER_KIND || kind === LEGACY_OWNER_KIND;
}

export const ACTOR_KINDS = [OWNER_KIND, LEGACY_OWNER_KIND, 'agent', 'github', 'import', 'system'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** `sprints.source` of sprints made in Selfbound (the other value is 'linear', imported cycles). */
export const SPRINT_SOURCE = 'selfbound' as const;
// legacy-xlr8: old value of `sprints.source`; present until legacyNames.ts has migrated it, queries cover both
export const LEGACY_SPRINT_SOURCE = 'xlr8' as const;
export function isSelfboundSource(source: string): boolean {
  return source === SPRINT_SOURCE || source === LEGACY_SPRINT_SOURCE;
}

export const SPRINT_STATES = ['planning', 'active', 'closed'] as const;
export type SprintState = (typeof SPRINT_STATES)[number];

export const SPRINT_ITEM_KINDS = ['planned', 'late', 'imported'] as const;
export type SprintItemKind = (typeof SPRINT_ITEM_KINDS)[number];

export const SPRINT_OUTCOMES = ['done', 'next', 'backlog', 'canceled'] as const;
export type SprintOutcome = (typeof SPRINT_OUTCOMES)[number];

export const PROJECT_STATES = ['planned', 'active', 'paused', 'done', 'canceled'] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

/** Team key: 2–6 characters, uppercase letters and digits, starts with a letter. */
export const TEAM_KEY_RE = /^[A-Z][A-Z0-9]{1,5}$/;

/** Issue identifier such as "KIU-106", case-insensitive. */
export const IDENTIFIER_RE = /\b([A-Za-z][A-Za-z0-9]{1,5})-(\d{1,6})\b/g;

export function identifierOf(teamKey: string, number: number) {
  return `${teamKey}-${number}`;
}

/** Upper limits that backend and MCP both check. */
export const LIMITS = {
  titleMax: 500,
  descriptionMax: 200_000,
  commentMax: 50_000,
  batchCreateMax: 50,
  bulkUpdateMax: 500,
  logoMaxBytes: 256 * 1024,
  imageMaxBytes: 5 * 1024 * 1024,
  /** Profile picture after the browser has cropped it (256 × 256 WebP is about 10–30 KB). */
  avatarMaxBytes: 256 * 1024,
  /** Edge length of the cropped profile picture the UI produces. */
  avatarPx: 256,
  profileNameMax: 60,
} as const;

/** Knowledge base: limits for pages, sources, topics and revisions. */
export const WIKI = {
  articleMax: 200_000, // characters of text per page (like a description)
  articlesPerTeam: 2000, // pages returned by a team's page list
  depthMax: 20, // levels in the tree
  subtreeMax: 500, // pages a single delete or restore moves at once
  sourcesMax: 100, // sources per page
  topicsMax: 20, // topics per page
  revisionsMax: 100, // stored revisions per page
  /** New revision when the last one is older than this (otherwise only for another actor or an agent). */
  revisionGapMs: 10 * 60 * 1000,
  /** Text edits bump `articles.updatedAt` at most this often (keeps the page list calm). */
  touchGapMs: 60 * 1000,
} as const;

/** Publication date of a source: year, month or day. */
export const PARTIAL_DATE_RE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;

// ---------------------------------------------------------------- Images in descriptions and comments

/** Allowed image types (the server checks the content, not just the declared type). */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/** Types allowed for the profile picture: no GIF (animation), no SVG. */
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/**
 * Images appear as `![name](<site>/img/<token>)` in Markdown. The token (32 random bytes,
 * base64url, 43 characters) is also the access control, because `<img>` sends no auth header.
 * It is recognized regardless of the site address (moves, local vs. production).
 */
export const IMAGE_PATH = '/img/';
const IMAGE_TOKEN_RE = /\/img\/([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/g;

/** All image tokens in a text (for references and cleanup). */
export function imageTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  if (!text.includes(IMAGE_PATH)) return tokens;
  for (const m of text.matchAll(IMAGE_TOKEN_RE)) tokens.add(m[1]!);
  return tokens;
}
