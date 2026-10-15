import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

// The data model. Principles:
// - `issues` stays lean (< 1 KB) because the client subscribes to all issues in buckets of 64.
//   Description, comments, history and import data live in their own tables.
// - Every change carries an actor from the verified identity, never free text from the client.
// - An issue never changes its bucket (`bucket = floor(seq / 64)`); deleted issues stay in their
//   bucket with `deletedAt` (trash).

export const statusValidator = v.union(
  v.literal('triage'),
  v.literal('backlog'),
  v.literal('todo'),
  v.literal('in_progress'),
  v.literal('in_review'),
  v.literal('done'),
  v.literal('canceled'),
  v.literal('duplicate'),
);

export const stateTypeValidator = v.union(
  v.literal('triage'),
  v.literal('backlog'),
  v.literal('unstarted'),
  v.literal('started'),
  v.literal('completed'),
  v.literal('canceled'),
);

// 0 = none, 1 = urgent, 2 = high, 3 = medium, 4 = low
export const priorityValidator = v.union(v.literal(0), v.literal(1), v.literal(2), v.literal(3), v.literal(4));

export const oauthAppValidator = v.union(v.literal('claude'), v.literal('chatgpt'));
/** Why an agent was revoked: by the owner, code or refresh token used twice, disconnected by the app. */
export const revokedReasonValidator = v.union(
  v.literal('owner'),
  v.literal('code_reuse'),
  v.literal('refresh_reuse'),
  v.literal('client'),
);

// 'steven' is OWNER_KIND (shared/constants.ts): the legacy stored value for the instance owner.
export const actorValidator = v.object({
  kind: v.union(v.literal('steven'), v.literal('agent'), v.literal('github'), v.literal('import'), v.literal('system')),
  agentId: v.optional(v.id('agents')),
});

export const inboxKindValidator = v.union(v.literal('created'), v.literal('changed'), v.literal('snoozed'));
export const inboxChangeValidator = v.object({
  field: v.string(), // history field name ('stateId', 'comment', 'description', …)
  actor: actorValidator,
  at: v.number(),
  // What the field became (IDs for references, the preview for texts, 'type:direction:otherId' for
  // relations); missing = cleared or no value. `from` only where the text needs it (labels, team).
  value: v.optional(v.union(v.string(), v.number(), v.array(v.string()))),
  from: v.optional(v.union(v.string(), v.array(v.string()))),
});

export const relationTypeValidator = v.union(v.literal('blocks'), v.literal('related'), v.literal('duplicate'));

export const sprintStateValidator = v.union(v.literal('planning'), v.literal('active'), v.literal('closed'));
export const sprintItemKindValidator = v.union(v.literal('planned'), v.literal('late'), v.literal('imported'));
export const sprintOutcomeValidator = v.union(
  v.literal('done'),
  v.literal('next'),
  v.literal('backlog'),
  v.literal('canceled'),
);

export const projectStateValidator = v.union(
  v.literal('planned'),
  v.literal('active'),
  v.literal('paused'),
  v.literal('done'),
  v.literal('canceled'),
);

export const wikiModeValidator = v.union(v.literal('on'), v.literal('only'));

// ---- Pull requests in Selfbound. Types as in shared/pullRequests.ts.

export const prStateValidator = v.union(v.literal('open'), v.literal('closed'), v.literal('merged'), v.literal('draft'));
export const mergeMethodValidator = v.union(v.literal('merge'), v.literal('squash'), v.literal('rebase'));
export const prPersonValidator = v.object({
  login: v.string(),
  avatarUrl: v.optional(v.string()),
  bot: v.boolean(),
  url: v.optional(v.string()),
});
export const prCheckValidator = v.object({
  key: v.string(),
  name: v.string(),
  source: v.union(v.literal('check'), v.literal('status')),
  app: v.optional(v.string()),
  state: v.union(
    v.literal('success'),
    v.literal('failure'),
    v.literal('pending'),
    v.literal('neutral'),
    v.literal('skipped'),
    v.literal('cancelled'),
  ),
  url: v.optional(v.string()),
  summary: v.optional(v.string()),
  startedAt: v.optional(v.number()),
  completedAt: v.optional(v.number()),
});
/** PrDetail without `fetchedAt` and `error` (those live on the document, even before there is any data). */
export const prDetailDataValidator = v.object({
  bodyHtml: v.string(),
  author: prPersonValidator,
  createdAt: v.number(),
  closedAt: v.optional(v.number()),
  mergedBy: v.optional(prPersonValidator),
  baseRef: v.string(),
  headRef: v.string(),
  headRepo: v.optional(v.string()),
  headSha: v.string(),
  draft: v.boolean(),
  mergeState: v.union(
    v.literal('clean'),
    v.literal('dirty'),
    v.literal('blocked'),
    v.literal('behind'),
    v.literal('unstable'),
    v.literal('draft'),
    v.literal('unknown'),
  ),
  additions: v.number(),
  deletions: v.number(),
  changedFiles: v.number(),
  commits: v.number(),
  labels: v.array(v.object({ name: v.string(), color: v.string() })),
  requestedReviewers: v.array(prPersonValidator),
  checks: v.array(prCheckValidator),
  mergeMethods: v.array(mergeMethodValidator),
  deleteBranchOnMerge: v.boolean(),
  headBranchDeletable: v.boolean(),
});
export const prItemFields = {
  key: v.string(),
  kind: v.union(v.literal('comment'), v.literal('review'), v.literal('review_comment')),
  author: prPersonValidator,
  html: v.string(),
  createdAt: v.number(),
  updatedAt: v.optional(v.number()),
  url: v.string(),
  reviewState: v.optional(
    v.union(v.literal('approved'), v.literal('changes_requested'), v.literal('commented'), v.literal('dismissed')),
  ),
  path: v.optional(v.string()),
  line: v.optional(v.number()),
  replyTo: v.optional(v.string()),
};
export const prItemValidator = v.object(prItemFields);
export const prReviewSummaryValidator = v.union(v.literal('approved'), v.literal('changes_requested'));

/** Calendar day as a string "YYYY-MM-DD" (Europe/Berlin). */
const day = v.string();

export default defineSchema({
  teams: defineTable({
    key: v.string(), // "KIU", immutable after the first issue
    name: v.string(),
    hue: v.number(), // color of the placeholder without a logo (OKLCH hue)
    dormant: v.boolean(), // inactive: not in the sidebar, but in search and lists
    order: v.number(),
    logoId: v.optional(v.id('_storage')),
    logoDarkId: v.optional(v.id('_storage')),
    logoType: v.optional(v.string()), // image/svg+xml | image/png
    // Workflow settings. Missing = no strict order, default state from the type.
    workflow: v.optional(
      v.object({
        strict: v.boolean(), // strict order
        exceptions: v.array(v.object({ from: v.id('workflowStates'), to: v.id('workflowStates') })),
        defaultStateId: v.optional(v.id('workflowStates')), // state for new issues
      }),
    ),
    // Knowledge base: 'on' = next to the issues, 'only' = knowledge base only. Missing = none.
    wiki: v.optional(wikiModeValidator),
    updatedAt: v.number(),
  }).index('by_key', ['key']),

  // A team's workflow states. Never hard-deleted, only archived: history and old references stay
  // readable. Order: type, then `position` (shared/workflow.ts).
  workflowStates: defineTable({
    teamId: v.id('teams'),
    name: v.string(),
    type: stateTypeValidator,
    position: v.number(),
    color: v.optional(v.string()), // #rrggbb; missing = color of the status type
    description: v.optional(v.string()),
    isDuplicate: v.optional(v.boolean()), // target of "mark as duplicate" (type canceled)
    legacyKey: v.optional(statusValidator), // default states: legacy status key (migration, MCP)
    archivedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_team', ['teamId']),

  projects: defineTable({
    teamId: v.id('teams'),
    name: v.string(),
    state: projectStateValidator,
    iconId: v.optional(v.id('_storage')),
    order: v.number(),
    updatedAt: v.number(),
  }).index('by_team', ['teamId']),

  labelGroups: defineTable({
    name: v.string(),
    teamId: v.optional(v.id('teams')), // missing = workspace group
    exclusive: v.boolean(), // single choice within the group
    hue: v.number(),
  }),

  labels: defineTable({
    name: v.string(),
    hue: v.number(),
    groupId: v.optional(v.id('labelGroups')),
    teamId: v.optional(v.id('teams')), // missing = workspace label
    archived: v.optional(v.boolean()),
  }),

  // Running counters in their own table, so creating an issue doesn't re-run every client's meta
  // query. name = 'seq' | 'team:<teamId>' | 'sprint'.
  counters: defineTable({
    name: v.string(),
    value: v.number(),
  }).index('by_name', ['name']),

  // Metadata only, so a bucket of 64 issues stays small.
  issues: defineTable({
    seq: v.number(),
    bucket: v.number(),
    teamId: v.id('teams'),
    number: v.number(), // identifier = team.key + '-' + number
    title: v.string(),
    // The team's state (source of truth). Optional only until the migration (migrations.ts).
    stateId: v.optional(v.id('workflowStates')),
    // Status type, derived from the state (shared/workflow.ts statusOfState). Carries the indexes.
    status: statusValidator,
    priority: priorityValidator,
    labelIds: v.array(v.id('labels')),
    projectId: v.optional(v.id('projects')),
    estimate: v.optional(v.number()),
    dueDate: v.optional(day),
    // Snoozed: hidden from the lists until this day (Europe/Berlin). The morning job clears it and
    // puts the issue back into the inbox. Missing = not snoozed (no migration needed).
    snoozedUntil: v.optional(day),
    parentId: v.optional(v.id('issues')),
    sprintId: v.optional(v.id('sprints')),
    rank: v.string(), // order in the backlog (fractional-indexing)
    createdBy: actorValidator,
    // Legacy inbox markers. Inbox entries live in `inboxEntries` now; these two stay in the schema
    // because stored issues still carry them. `reviewedAt` is still written at creation for issues
    // that do not start in the inbox, so `migrations.inboxBackfill` can tell them apart at any time.
    // Nothing else reads or writes them.
    reviewedAt: v.optional(v.number()),
    readAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()), // done
    canceledAt: v.optional(v.number()), // canceled | duplicate
    deletedAt: v.optional(v.number()), // trash
    recurrenceId: v.optional(v.id('recurrences')),
  })
    .index('by_bucket', ['bucket'])
    .index('by_seq', ['seq'])
    .index('by_team_number', ['teamId', 'number'])
    .index('by_status', ['status', 'updatedAt'])
    .index('by_sprint', ['sprintId'])
    .index('by_due', ['dueDate'])
    .index('by_snoozed', ['snoozedUntil'])
    .index('by_completed', ['completedAt'])
    // For MCP list_issues (due/overdue, done today): read only the wanted statuses.
    .index('by_status_due', ['status', 'dueDate'])
    .index('by_status_completed', ['status', 'completedAt'])
    .index('by_parent', ['parentId'])
    .index('by_rank', ['rank'])
    .index('by_updated', ['updatedAt'])
    .index('by_deleted', ['deletedAt'])
    // For the priority budget: count open urgent/high issues per team without scanning the team.
    .index('by_team_priority', ['teamId', 'priority', 'status'])
    // For MCP list_issues (project filter) without a scan over all issues.
    .index('by_project', ['projectId', 'status'])
    // Issues in a state (archive with move, migration check).
    .index('by_state', ['stateId'])
    .searchIndex('search_title', { searchField: 'title', filterFields: ['teamId', 'status'] }),

  // Old identifiers (e.g. Linear's previousIdentifiers, team moves) → issue.
  identifierAliases: defineTable({
    key: v.string(), // uppercase, "KIU-106"
    issueId: v.id('issues'),
  })
    .index('by_key', ['key'])
    // Delete aliases together with the issue when it is purged from the trash.
    .index('by_issue', ['issueId']),

  issueBodies: defineTable({
    issueId: v.id('issues'),
    markdown: v.string(),
    version: v.number(),
    updatedAt: v.number(),
    updatedBy: actorValidator,
  }).index('by_issue', ['issueId']),

  // Search text of the description (the first BODY_SEARCH_CHARS characters), so full-text search
  // doesn't have to read whole descriptions (up to 200,000 characters).
  // Written only through ops/bodies.ts, together with issueBodies.
  bodySearch: defineTable({
    issueId: v.id('issues'),
    text: v.string(),
  })
    .index('by_issue', ['issueId'])
    .searchIndex('search_text', { searchField: 'text' }),

  // Earlier versions of a description that the import overwrote (full text), and on conflicts the
  // Linear version that was NOT applied.
  bodyRevisions: defineTable({
    issueId: v.id('issues'),
    markdown: v.string(),
    version: v.number(), // description version this text belonged to (conflict: the current version)
    reason: v.union(v.literal('import_overwrite'), v.literal('import_conflict')),
    at: v.number(),
    actor: actorValidator,
    runId: v.optional(v.id('importRuns')),
  }).index('by_issue', ['issueId', 'at']),

  comments: defineTable({
    issueId: v.id('issues'),
    body: v.string(),
    author: actorValidator,
    authorName: v.optional(v.string()), // only for imported comments
    createdAt: v.number(),
    editedAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),
  })
    .index('by_issue', ['issueId', 'createdAt'])
    .searchIndex('search_comment', { searchField: 'body' }),

  relations: defineTable({
    fromId: v.id('issues'),
    toId: v.id('issues'),
    type: relationTypeValidator, // blocks: from blocks to; duplicate: from is a duplicate of to
    createdAt: v.number(),
    createdBy: actorValidator,
  })
    .index('by_from', ['fromId'])
    .index('by_to', ['toId']),

  history: defineTable({
    issueId: v.id('issues'),
    field: v.string(), // 'created' | field name | 'description' | 'comment' | 'relation' | 'sprint' | …
    from: v.optional(v.any()),
    to: v.optional(v.any()),
    actor: actorValidator,
    at: v.number(),
    requestId: v.optional(v.string()),
  }).index('by_issue', ['issueId', 'at']),

  // Inbox: one open entry per issue (removedAt missing). An agent that creates an issue or changes
  // an existing one adds to the open entry or opens one; reading and removing only touch the entry,
  // never the issue. Removed entries stay (undo, history) until the cleanup deletes them.
  // `kind` is why the entry exists: an agent created the issue, an agent changed it, or it came back
  // from a snooze (the morning job).
  inboxEntries: defineTable({
    issueId: v.id('issues'),
    kind: inboxKindValidator,
    actor: actorValidator, // who caused the latest change
    changes: v.array(inboxChangeValidator), // latest change per field, oldest first
    createdAt: v.number(),
    updatedAt: v.number(), // latest change: the entry's place in the list
    readAt: v.optional(v.number()),
    removedAt: v.optional(v.number()),
  })
    .index('by_issue', ['issueId', 'removedAt'])
    .index('by_removed', ['removedAt', 'updatedAt']),

  sprints: defineTable({
    number: v.number(),
    name: v.string(),
    goal: v.string(),
    startDate: day,
    endDate: day,
    state: sprintStateValidator,
    capacity: v.optional(v.number()),
    source: v.union(v.literal('xlr8'), v.literal('linear')),
    startedAt: v.optional(v.number()),
    closedAt: v.optional(v.number()),
    retro: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index('by_state', ['state'])
    .index('by_number', ['number'])
    // Most recently closed sprints per source (meta.get, capacity), by close time.
    .index('by_source_state_closed', ['source', 'state', 'closedAt']),

  // Membership in a sprint, also for past sprints.
  // Rule for sprints S that are NOT closed: issue.sprintId === S exactly when there is an item for
  // S without removedAt. Items of closed sprints are frozen (never changed, never deleted, not even
  // when the issue is purged).
  sprintItems: defineTable({
    sprintId: v.id('sprints'),
    issueId: v.id('issues'),
    kind: sprintItemKindValidator,
    carriedFrom: v.optional(v.id('sprints')),
    addedAt: v.number(),
    addedBy: actorValidator,
    removedAt: v.optional(v.number()),
    outcome: v.optional(sprintOutcomeValidator),
    points: v.optional(v.number()), // estimate at close (keeps capacity stable)
  })
    .index('by_sprint', ['sprintId'])
    .index('by_issue', ['issueId']),

  // Agents: with a key (Claude Code, Codex …) or as a connector via OAuth
  // (claude.ai, ChatGPT; one row per connection, created with the first token).
  agents: defineTable({
    name: v.string(), // "Claude Code", "Codex" …
    keyHash: v.optional(v.string()), // SHA-256 (hex) of the key; missing for connectors
    keyPrefix: v.optional(v.string()), // first characters for recognition; missing for connectors
    connector: v.optional(v.object({ app: oauthAppValidator, clientId: v.string() })),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
    revokedReason: v.optional(revokedReasonValidator),
    lastUsedAt: v.optional(v.number()),
    canManageTeams: v.optional(v.boolean()), // default: no
  }).index('by_hash', ['keyHash']),

  // OAuth for connectors (lib/oauth, ops/oauth.ts). Secrets only as SHA-256 (hex).
  // Registered clients (RFC 7591). The app follows from the redirect URIs alone.
  oauthClients: defineTable({
    clientId: v.string(),
    app: oauthAppValidator,
    clientName: v.string(),
    redirectUris: v.array(v.string()),
    authMethod: v.union(v.literal('none'), v.literal('client_secret_basic'), v.literal('client_secret_post')),
    secretHash: v.optional(v.string()),
    createdAt: v.number(),
    approvedAt: v.optional(v.number()), // first redeemed code
  })
    .index('by_client', ['clientId'])
    .index('by_approved_created', ['approvedAt', 'createdAt']),
  // Authorization requests (/oauth/authorize) until consent and code redemption.
  oauthRequests: defineTable({
    publicId: v.string(), // in the consent page URL; useful only to the owner (owner-only functions)
    clientId: v.string(),
    app: oauthAppValidator,
    redirectUri: v.string(),
    redirectGiven: v.boolean(),
    state: v.optional(v.string()),
    codeChallenge: v.string(), // PKCE S256
    issuer: v.optional(v.string()), // issuer the client saw (iss in the redirect); missing on old requests
    createdAt: v.number(),
    expiresAt: v.number(),
    status: v.union(v.literal('pending'), v.literal('approved'), v.literal('denied'), v.literal('redeemed'), v.literal('failed')),
    name: v.optional(v.string()), // connector name (consent page)
    codeHash: v.optional(v.string()),
    codeExpiresAt: v.optional(v.number()),
    agentId: v.optional(v.id('agents')),
  })
    .index('by_public', ['publicId'])
    .index('by_code', ['codeHash'])
    .index('by_client_status', ['clientId', 'status'])
    .index('by_expires', ['expiresAt']),
  // Access and refresh tokens. The "family" of a grant is the connector (agentId).
  oauthTokens: defineTable({
    hash: v.string(),
    kind: v.union(v.literal('access'), v.literal('refresh')),
    agentId: v.id('agents'),
    clientId: v.string(),
    expiresAt: v.number(),
    rotatedAt: v.optional(v.number()), // refresh token: redeemed once
  })
    .index('by_hash', ['hash'])
    .index('by_agent', ['agentId'])
    .index('by_expires', ['expiresAt']),

  // Rate limiting per agent and time window (minute or day).
  rateWindows: defineTable({
    agentId: v.id('agents'),
    window: v.string(), // 'm:<minute>' | 'd:<day>'
    count: v.number(),
  }).index('by_agent_window', ['agentId', 'window']),

  // Idempotency: the same request ID from one actor takes effect only once.
  requests: defineTable({
    owner: v.string(), // actor kind ('steven' = OWNER_KIND, 'system' …) | agentId
    requestId: v.string(),
    argsHash: v.string(),
    operation: v.string(),
    result: v.any(), // only IDs and identifiers, no whole issues
    createdAt: v.number(),
  })
    .index('by_owner_request', ['owner', 'requestId'])
    .index('by_created', ['createdAt']),

  pullRequests: defineTable({
    repo: v.string(), // "owner/name"
    number: v.number(),
    title: v.string(),
    url: v.string(),
    state: prStateValidator,
    branch: v.string(),
    author: v.optional(v.string()),
    updatedAt: v.number(),
    mergedAt: v.optional(v.number()),
    headSha: v.optional(v.string()), // last known head commit (webhook or fetch), for check events
  })
    .index('by_repo_number', ['repo', 'number'])
    // Check and status events often name only the commit.
    .index('by_repo_head', ['repo', 'headSha']),

  // A PR's state from the GitHub API (ops/githubPr.ts), one document per PR. Created on the first
  // fetch, or already when a fetch is scheduled (then only `refreshAt`, without `data`).
  pullRequestDetails: defineTable({
    prId: v.id('pullRequests'),
    // Access guard for GET /ghmedia/<mediaKey>/<index> (32 random bytes, base64url), fixed per PR.
    // Missing only until the first fetch has been stored.
    mediaKey: v.optional(v.string()),
    // Rewritten media (lib/githubMedia.ts); index = number in the proxy path, entries keep their index.
    media: v.array(
      v.object({
        kind: v.union(v.literal('repo'), v.literal('attachment')),
        url: v.string(), // repo: raw.githubusercontent.com URL · attachment: signed URL (valid for 5 min)
        signedAt: v.optional(v.number()),
        source: v.optional(v.string()), // attachment: 'body' or item key, to fetch a fresh signature
        resolved: v.optional(v.string()), // repo: last fetched download_url (cached briefly)
        resolvedAt: v.optional(v.number()),
        resigningAt: v.optional(v.number()), // attachment: the item is being re-fetched (coalesces parallel calls)
      }),
    ),
    fetchedAt: v.optional(v.number()),
    error: v.optional(v.string()), // error (or partial error) of the last fetch, text for the UI
    data: v.optional(prDetailDataValidator), // last successful state
    summary: v.optional(
      v.object({ comments: v.number(), review: v.optional(prReviewSummaryValidator) }),
    ),
    refreshAt: v.optional(v.number()), // scheduled fetch (debounces webhook events)
    fetchingSince: v.optional(v.number()), // fetch running since (valid 30 s): parallel calls don't fetch twice
    viewedAt: v.optional(v.number()), // last opened in the UI (webhooks then also fetch unlinked PRs)
    mergeRetries: v.optional(v.number()), // retries while GitHub is still computing mergeability
  })
    .index('by_pr', ['prId'])
    .index('by_media_key', ['mediaKey']),

  // Check runs from `check_run` webhook deliveries, only for known PRs. A fine-grained token cannot
  // read check runs through the API; GitHub Actions comes through the Actions API, third-party apps
  // (e.g. CodeRabbit as a check) only through here. Cleaned up after 30 days (ops/maintenance.ts).
  githubCheckRuns: defineTable({
    repo: v.string(),
    headSha: v.string(),
    checkId: v.number(),
    check: prCheckValidator, // key = "check:<checkId>"
    receivedAt: v.number(),
  })
    .index('by_repo_sha', ['repo', 'headSha'])
    .index('by_check', ['checkId'])
    .index('by_received', ['receivedAt']),

  // Comments, reviews and line comments of a PR (at most PR_LIMITS.items, the newest).
  pullRequestItems: defineTable({
    prId: v.id('pullRequests'),
    ...prItemFields,
  })
    .index('by_pr_created', ['prId', 'createdAt'])
    .index('by_pr_key', ['prId', 'key']),

  issuePullRequests: defineTable({
    issueId: v.id('issues'),
    prId: v.id('pullRequests'),
    via: v.union(v.literal('branch'), v.literal('title'), v.literal('body'), v.literal('import')),
    closes: v.boolean(), // magic word or branch → closes on merge
  })
    .index('by_issue', ['issueId'])
    .index('by_pr', ['prId']),

  githubDeliveries: defineTable({
    deliveryId: v.string(),
    event: v.string(),
    receivedAt: v.number(),
  })
    .index('by_delivery', ['deliveryId'])
    .index('by_received', ['receivedAt']),

  recurrences: defineTable({
    teamId: v.id('teams'),
    title: v.string(),
    description: v.optional(v.string()),
    priority: priorityValidator,
    labelIds: v.array(v.id('labels')),
    projectId: v.optional(v.id('projects')),
    estimate: v.optional(v.number()),
    cadence: v.union(v.literal('weekly'), v.literal('monthly')),
    weekday: v.optional(v.number()), // 1 = Monday … 7 = Sunday
    monthDay: v.optional(v.number()), // 1–28
    nextDate: day,
    active: v.boolean(),
    sourceIssueId: v.optional(v.id('issues')),
    createdAt: v.number(),
  }).index('by_next', ['active', 'nextDate']),

  recurrenceRuns: defineTable({
    recurrenceId: v.id('recurrences'),
    date: day,
    issueId: v.id('issues'),
  }).index('by_recurrence_date', ['recurrenceId', 'date']),

  // Mapping Linear ID → Selfbound ID for a repeatable import without duplicates.
  linearLinks: defineTable({
    kind: v.string(), // 'team' | 'label' | 'labelGroup' | 'project' | 'issue' | 'comment' | 'cycle'
    linearId: v.string(),
    localId: v.string(),
    hash: v.optional(v.string()), // checksum of the imported state
    runId: v.optional(v.id('importRuns')),
    // Issues: last imported Linear values per field (in Selfbound form) for the three-way merge.
    base: v.optional(v.any()),
    // Issue purged in Selfbound (trash emptied): the import does not recreate it.
    purgedAt: v.optional(v.number()),
  })
    .index('by_kind_linear', ['kind', 'linearId'])
    .index('by_local', ['localId']),

  // Staging table for the import (filled via `importer:stage` in batches).
  importStaging: defineTable({
    run: v.string(),
    kind: v.string(),
    linearId: v.string(),
    payload: v.any(),
  }).index('by_run_kind', ['run', 'kind']),

  importRuns: defineTable({
    run: v.string(),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    status: v.union(v.literal('running'), v.literal('done'), v.literal('failed')),
    counts: v.any(),
    deviations: v.array(v.string()),
    error: v.optional(v.string()),
    // Resumption: every step (batch) is its own function scheduled via the scheduler.
    phase: v.optional(v.string()), // 'scan' | import step | 'cleanup'
    cursor: v.optional(v.union(v.string(), v.null())),
    maxNumbers: v.optional(v.array(v.array(v.union(v.string(), v.number())))),
    heartbeatAt: v.optional(v.number()), // last finished batch (detects stuck runs)
  })
    .index('by_run', ['run'])
    .index('by_status', ['status']),

  importConflicts: defineTable({
    runId: v.id('importRuns'),
    issueId: v.optional(v.id('issues')),
    note: v.string(),
  }).index('by_run', ['runId']),

  // Uploaded images (descriptions, comments). Served via GET /img/<token>; the token is unguessable
  // and appears in the Markdown. `deleteAfter`: no references; the cron deletes the file after this
  // time (missing = there are references).
  files: defineTable({
    token: v.string(),
    storageId: v.id('_storage'),
    contentType: v.string(),
    size: v.number(),
    createdAt: v.number(),
    uploadedBy: actorValidator,
    deleteAfter: v.optional(v.number()),
  })
    .index('by_token', ['token'])
    .index('by_delete_after', ['deleteAfter']),

  // References to images: one row per text (description, comment, earlier version, recurrence)
  // and token. `owner` is the ID of the document that holds the text. Maintained only through
  // ops/files.ts (syncFileRefs) whenever a text is written or deleted.
  fileRefs: defineTable({
    token: v.string(),
    owner: v.string(),
  })
    .index('by_owner', ['owner'])
    .index('by_token', ['token']),

  // Cache for embeds (video and post cards, XLR8-73): what the backend fetched from the provider
  // for a link, plus the media it stored. `key` = "<provider>:<id>". The app refreshes entries
  // after EMBED_TTL_MS when it shows them; the cron `purge-embeds` deletes entries (and their
  // files) that nobody refreshed for EMBED_PURGE_MS. Only ops/embeds.ts writes it.
  embeds: defineTable({
    key: v.string(),
    provider: v.union(v.literal('youtube'), v.literal('x')),
    status: v.union(v.literal('ok'), v.literal('unavailable')),
    fetchedAt: v.number(),
    title: v.optional(v.string()),
    author: v.optional(v.string()),
    handle: v.optional(v.string()),
    authorUrl: v.optional(v.string()),
    text: v.optional(v.string()),
    createdAt: v.optional(v.number()),
    media: v.array(
      v.object({
        slot: v.string(),
        kind: v.union(v.literal('photo'), v.literal('video'), v.literal('gif'), v.literal('avatar'), v.literal('thumb')),
        storageId: v.id('_storage'),
        contentType: v.string(),
        width: v.optional(v.number()),
        height: v.optional(v.number()),
        alt: v.optional(v.string()),
      }),
    ),
  })
    .index('by_key', ['key'])
    .index('by_fetched', ['fetchedAt']),

  // Operational status for the ops page: last backup, audits etc.
  opsStatus: defineTable({
    key: v.string(),
    value: v.any(),
    at: v.number(),
  }).index('by_key', ['key']),

  // Test switches (only effective with XLR8_TEST_SWITCHES=1), e.g. "server rejects writes".
  settings: defineTable({
    key: v.string(),
    value: v.any(),
  }).index('by_key', ['key']),

  // ---- Web Push notifications (ops/notify.ts, push.ts)

  // A device (browser or installed app) that receives push messages.
  pushSubscriptions: defineTable({
    endpoint: v.string(), // URL at the browser's push service (unique per device and browser)
    p256dh: v.string(), // the browser's public key (base64url)
    auth: v.string(), // the browser's auth secret (base64url)
    device: v.string(), // display name, e.g. "Android · Chrome"
    vapidKey: v.string(), // public VAPID key at subscription time; new key = subscribe again
    createdAt: v.number(),
    lastSentAt: v.optional(v.number()),
    failures: v.number(), // consecutive failed attempts
    lastError: v.optional(v.string()),
  }).index('by_endpoint', ['endpoint']),

  // Notification settings (one row). If missing, the defaults from shared/notifyEvents.ts apply.
  pushSettings: defineTable({
    events: v.record(v.string(), v.boolean()), // only deviations from the default
    morningHour: v.optional(v.number()), // Berlin hour of the morning notification
  }),

  // Events that lead to a notification (outbox). `key` is unique: the same event reported twice
  // (retry, second cron run) does not produce a second notification. Cleaned up after 7 days.
  pushEvents: defineTable({
    key: v.string(), // e.g. "comment:<id>", "due:2026-10-11"
    kind: v.string(), // NotifyKind
    group: v.string(), // same group in the same send = one combined notification
    title: v.string(),
    body: v.string(),
    url: v.string(),
    tag: v.string(),
    issueId: v.optional(v.id('issues')),
    // Combined notification if several events of the same group are sent together ({n} = count)
    bundle: v.optional(v.object({ title: v.string(), url: v.string() })),
    state: v.union(
      v.literal('pending'), // waiting to be sent
      v.literal('sending'), // picked up by the sender
      v.literal('sent'), // sent to the devices
      v.literal('in_app'), // Selfbound was open: shown in the app instead of a push
      v.literal('skipped'), // no device, or push not configured
    ),
    at: v.number(),
    sentAt: v.optional(v.number()),
    // Shown in the app (the app confirms). If that is missing after a short time, the notification
    // goes out as a push after all, e.g. when the window was just closed while the device still
    // counted as active.
    seenAt: v.optional(v.number()),
    retry: v.optional(v.boolean()), // second attempt: send regardless of presence
  })
    .index('by_key', ['key'])
    .index('by_state', ['state', 'at'])
    .index('by_at', ['at']),

  // Devices on which Selfbound is currently open, visible and in use. While one is active, no push goes
  // out; the app shows the notification itself.
  pushPresence: defineTable({
    device: v.string(), // random ID per browser (localStorage)
    activeUntil: v.number(),
  })
    .index('by_device', ['device'])
    .index('by_active', ['activeUntil']),

  // ---- Appearance (appearance.ts): themes and fonts, shared across all devices.

  // Chosen themes and fonts (one row). If missing, the default applies (Selfbound colors, Inter).
  // Theme ID: "xlr8", a bundled theme ("catppuccin-mocha") or "custom:<id>".
  appearance: defineTable({
    dark: v.string(),
    light: v.string(),
    sans: v.string(), // "inter", "system", a Fontsource ID or "local:<name>"
    mono: v.string(),
    // Individual colors overridden per theme (key = CSS variable without "--", value = #rrggbb)
    overrides: v.array(v.object({ theme: v.string(), colors: v.record(v.string(), v.string()) })),
    updatedAt: v.number(),
  }),

  // Custom themes (only name and type; every device loads the list at startup).
  customThemes: defineTable({
    name: v.string(),
    type: v.union(v.literal('dark'), v.literal('light')),
    createdAt: v.number(),
    updatedAt: v.number(),
  }),

  // JSON of a custom theme (sanitized, without comments, up to 300 kB), separate so the list stays small.
  customThemeSources: defineTable({
    themeId: v.id('customThemes'),
    source: v.string(),
  }).index('by_theme', ['themeId']),

  // ---- Knowledge base (ops/wiki.ts). In code "wiki"/"article", in the UI "knowledge"/"page"/"topic".
  // As with issues, a page row stays small: a team's knowledge base subscribes to all page rows.
  // Text, search text, revisions and sources live in their own tables.

  // A page. Tree via `parentId` (same team, no cycle), order among siblings via `rank`.
  // Deleting moves the whole subtree to the trash with the same `deletedAt`.
  articles: defineTable({
    teamId: v.id('teams'),
    parentId: v.optional(v.id('articles')),
    projectId: v.optional(v.id('projects')), // project docs (a project of the same team)
    title: v.string(),
    rank: v.string(), // fractional-indexing, compared only among siblings
    topicIds: v.array(v.id('wikiTopics')),
    createdAt: v.number(),
    createdBy: actorValidator,
    // Last change to title, location, topics or project; text edits at most once per minute
    // (the exact time is in articleBodies.updatedAt).
    updatedAt: v.number(),
    updatedBy: actorValidator,
    deletedAt: v.optional(v.number()), // trash
  })
    .index('by_team_deleted', ['teamId', 'deletedAt'])
    .index('by_team_parent', ['teamId', 'parentId', 'rank'])
    .index('by_project', ['projectId'])
    .index('by_updated', ['updatedAt'])
    .index('by_deleted', ['deletedAt'])
    .searchIndex('search_title', { searchField: 'title', filterFields: ['teamId'] }),

  // Text of a page (Markdown, at most WIKI.articleMax characters) with a version for `baseVersion`.
  articleBodies: defineTable({
    articleId: v.id('articles'),
    markdown: v.string(),
    version: v.number(),
    updatedAt: v.number(), // exact time of the last text edit
    updatedBy: actorValidator,
    revisionCount: v.optional(v.number()), // stored revisions (trimming without reading them all)
  })
    .index('by_article', ['articleId'])
    .index('by_updated', ['updatedAt']),

  // Search text of a page in chunks (lib/wikiText.ts), so a hit doesn't read 200,000 characters and
  // passages far down are found too. Without URLs and image tokens.
  articleSearch: defineTable({
    articleId: v.id('articles'),
    teamId: v.id('teams'),
    n: v.number(), // chunk number from 0
    text: v.string(),
  })
    .index('by_article', ['articleId', 'n'])
    .searchIndex('search_text', { searchField: 'text', filterFields: ['teamId'] }),

  // Earlier versions of the text (saved before overwriting, at most WIKI.revisionsMax per page).
  articleRevisions: defineTable({
    articleId: v.id('articles'),
    title: v.string(), // title at that time (display only)
    markdown: v.string(),
    version: v.number(), // text version this revision belonged to
    at: v.number(), // time of this text (the last edit before it)
    actor: actorValidator, // who wrote this text
    savedAt: v.number(), // saved because someone overwrote the text
  }).index('by_article', ['articleId', 'savedAt']),

  // Sources of a page. At least a URL or a title.
  articleSources: defineTable({
    articleId: v.id('articles'),
    url: v.optional(v.string()),
    title: v.optional(v.string()),
    author: v.optional(v.string()),
    publishedAt: v.optional(v.string()), // "YYYY", "YYYY-MM" or "YYYY-MM-DD"
    accessedAt: day, // accessed on
    note: v.optional(v.string()),
    order: v.number(),
    createdAt: v.number(),
    createdBy: actorValidator,
  }).index('by_article', ['articleId', 'order']),

  // Topics: labels for pages, per team, across the tree. Separate from issue labels.
  wikiTopics: defineTable({
    teamId: v.id('teams'),
    name: v.string(),
    hue: v.number(),
    archived: v.optional(v.boolean()),
  }).index('by_team', ['teamId']),

  // Links that involve a knowledge base page (ops/links.ts): from descriptions and comments to pages,
  // from pages to pages and issues. `from` = ID of the document that holds the text.
  articleLinks: defineTable({
    from: v.string(),
    fromKind: v.union(v.literal('article'), v.literal('body'), v.literal('comment')),
    fromArticleId: v.optional(v.id('articles')),
    fromIssueId: v.optional(v.id('issues')),
    toArticleId: v.optional(v.id('articles')),
    toIssueId: v.optional(v.id('issues')),
  })
    .index('by_from', ['from'])
    .index('by_from_issue', ['fromIssueId'])
    .index('by_to_article', ['toArticleId'])
    .index('by_to_issue', ['toIssueId']),

  // Purged pages (trash emptied), so a later sync with an external system also notices the
  // deletion.
  articleTombstones: defineTable({
    articleId: v.string(),
    teamId: v.id('teams'),
    purgedAt: v.number(),
  }).index('by_purged', ['purgedAt']),
});
