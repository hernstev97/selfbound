// The tools of the Selfbound MCP server: names, descriptions (for agents), input schemas,
// annotations and argument validation.
//
// Execution is not here: `protocol.ts` checks the arguments with `checkToolArguments` and
// passes the normalized values on to `deps.callTool`. The types in `ToolArgs` describe
// exactly these values.

import { LIMITS, PARTIAL_DATE_RE, WIKI } from '../../shared/constants';
import { MODEL_LIMITS } from '../../shared/models';
import { STATE_NAME_MAX } from '../../shared/workflow';
import type { Priority } from '../../shared/constants';
import {
  anyOf,
  array,
  boolean,
  enumOf,
  integer,
  map,
  nullable,
  number,
  object,
  optional,
  string,
  validate,
  type CheckResult,
  type Infer,
  type JsonSchema,
  type Schema,
} from './validate';

// ---------------------------------------------------------------------------
// Building blocks

// Identifiers in any spelling the UI search accepts: "ACME-106", "acme106", "acme 106",
// "Acme-0106", "ACME–106" (en dash), "acme_106". Normal form "ACME-106"; for keys containing
// digits and no separator the input is kept as is and resolution tries every split.
const IDENTIFIER_RE = /^[A-Z][A-Z0-9]{1,5}-?[1-9]\d{0,5}$/;
function normalizeIdentifier(input: string) {
  const s = input.trim().toUpperCase().replace(/[\u2010-\u2015\u2212]/g, '-');
  const separated = /^([A-Z][A-Z0-9]{1,5})[-_ ]+0*(\d{1,6})$/.exec(s);
  if (separated) return `${separated[1]}-${Number(separated[2])}`;
  const letters = /^([A-Z]{2,6})0*(\d{1,6})$/.exec(s);
  if (letters) return `${letters[1]}-${Number(letters[2])}`;
  return s;
}
const TEAM_KEY_RE = /^[A-Z][A-Z0-9]{1,5}$/;
const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const upper = (s: string) => s.trim().toUpperCase();

/** No `pattern` in the JSON Schema: clients should not reject "acme106" up front; the check happens here. */
function identifier(description = 'Issue identifier like "ACME-106" (case-insensitive, also "acme106" or "acme 106"; old identifiers work too).'): Schema<string> {
  const base = string({ description, transform: normalizeIdentifier });
  return {
    ...base,
    check(value, path, errors) {
      const before = errors.length;
      const s = base.check(value, path, errors);
      if (errors.length === before && !IDENTIFIER_RE.test(s)) errors.push(`${path || 'arguments'}: ${JSON.stringify(value)} is not an issue identifier like "ACME-106"`);
      return s;
    },
  };
}

const teamKey = (description = 'Team key like "ACME" (case-insensitive). See list_teams.') =>
  string({ description, pattern: TEAM_KEY_RE, patternHint: 'a team key like "ACME"', transform: upper });

/** Valid calendar date "YYYY-MM-DD" (e.g. no 2026-02-30). */
function realDay(description: string): Schema<string> {
  const base = string({ description, pattern: DAY_RE, patternHint: 'a date in the form YYYY-MM-DD' });
  return {
    ...base,
    check(value, path, errors) {
      const before = errors.length;
      const s = base.check(value, path, errors);
      if (errors.length === before) {
        const d = new Date(`${s}T00:00:00Z`);
        if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) errors.push(`${path}: ${s} is not a real date`);
      }
      return s;
    },
  };
}

export const PRIORITY_WORDS = { none: 0, urgent: 1, high: 2, medium: 3, low: 4 } as const;
export type PriorityWord = keyof typeof PRIORITY_WORDS;

const priority = (): Schema<Priority> =>
  anyOf<Priority>(
    [
      integer({ min: 0, max: 4 }) as Schema<Priority>,
      map(
        string({
          pattern: /^(none|urgent|high|medium|low)$/i,
          patternHint: 'a priority word',
          transform: (s) => s.trim().toLowerCase(),
        }),
        (s) => PRIORITY_WORDS[s as PriorityWord],
      ),
    ],
    {
      description:
        'Priority: 0 = none, 1 = urgent, 2 = high, 3 = medium, 4 = low. The words "none", "urgent", "high", "medium", "low" are accepted too.',
      hint: 'a priority (0-4 or none/urgent/high/medium/low)',
    },
  );

/**
 * Status: name of a status in the issue's team (as in list_statuses) or a status type key
 * (triage, backlog, todo, in_progress, in_review, done, canceled, duplicate). Resolved in the
 * issue's team (ops/mcp.ts), so only text here.
 */
const STATUS_HINT =
  'A status name of the issue\'s team (case-insensitive, see list_statuses), or one of the keys triage, backlog, todo, in_progress, in_review, done, canceled, duplicate (the team\'s matching status).';
const status = (description = 'Workflow status.') =>
  string({ description: `${description} ${STATUS_HINT}`, min: 1, max: STATE_NAME_MAX, transform: (s) => s.trim() });

const REQUEST_ID_DESCRIPTION =
  'Idempotency key chosen by you (e.g. a UUID). Repeating a call with the same requestId and the same arguments returns the original result instead of acting twice; the same requestId with different arguments is rejected.';

const requestId = (description = REQUEST_ID_DESCRIPTION) =>
  string({
    description,
    min: 8,
    max: 128,
    pattern: /^[A-Za-z0-9._:-]+$/,
    patternHint: 'a key of letters, digits and . _ : -',
  });

/** Said once in the instructions (protocol.ts), repeated where agents write Markdown. */
const VISUAL_BLOCKS = 'Info panel: "> [!INFO] Title" quote; chart: ```chart code block with JSON (examples in the server instructions).';
/** The two layers of an issue description (XLR8-76), repeated where agents write one. */
const TWO_LAYERS = 'Write a short summary for the owner on top and the details for agents (acceptance criteria, files, technical notes, test steps) in one "> [!AGENT]" panel below it, shown collapsed.';

const title = () => string({ description: 'Issue title.', min: 1, max: LIMITS.titleMax, transform: (s) => s.trim() });
const labelNames = () =>
  array(string({ min: 1, max: 100, transform: (s) => s.trim() }), {
    description: 'Label names (case-insensitive). The full set: replaces existing labels. See list_labels.',
    max: 20,
    unique: true,
  });
const estimate = () => number({ description: 'Estimate in points.', min: 0, max: 100 });

/** Desired model (XLR8-93): one of the enabled models of list_models, with its valid effort and speed. */
const modelChoice = (description: string) =>
  object(
    {
      provider: string({ description: 'Provider ID from list_models, e.g. "anthropic".', min: 1, max: MODEL_LIMITS.provider, transform: (s) => s.trim() }),
      modelId: string({ description: 'Model ID from list_models, e.g. "claude-opus-5-5".', min: 1, max: MODEL_LIMITS.modelId, transform: (s) => s.trim() }),
      effort: optional(
        string({ description: 'One of the model\'s `efforts` (list_models). Omit to leave the effort to whoever runs the issue.', min: 1, max: MODEL_LIMITS.value }),
      ),
      speed: optional(string({ description: '"standard" (the default) or one of the model\'s `speeds` (list_models), e.g. "fast".', min: 1, max: MODEL_LIMITS.value })),
    },
    { description },
  );
/** A model as get_issue returns it (`name`, `inCatalog` are read-only and ignored), for `expected`. */
const modelSeen = (description: string) =>
  map(
    object(
      {
        provider: string({ min: 1, max: MODEL_LIMITS.provider, transform: (s) => s.trim() }),
        modelId: string({ min: 1, max: MODEL_LIMITS.modelId, transform: (s) => s.trim() }),
        effort: optional(string({ min: 1, max: MODEL_LIMITS.value })),
        speed: optional(string({ min: 1, max: MODEL_LIMITS.value })),
        name: optional(string({ max: 200 })),
        inCatalog: optional(boolean()),
      },
      { description },
    ),
    ({ provider, modelId, effort, speed }) => ({ provider, modelId, ...(effort ? { effort } : {}), ...(speed ? { speed } : {}) }),
  );
const MODEL_INPUT =
  'Desired model for the issue: provider and model ID of an enabled model (list_models), optionally effort and speed valid for that model. Invalid combinations are rejected. Without it the issue inherits its parent\'s model, else the team default, else none (whoever runs it decides).';
const modelFilter = () =>
  string({
    description:
      'Only issues whose effective model (own, else the parent\'s, else the team default) is this: "provider/modelId" (e.g. "anthropic/claude-opus-5-5"), a model ID, a provider ID (e.g. "anthropic"), or "none" for issues without a model. See list_models.',
    min: 1,
    max: MODEL_LIMITS.provider + MODEL_LIMITS.modelId + 1,
    transform: (s) => s.trim(),
  });

// ---------------------------------------------------------------------------
// Input schemas

const searchIssues = object({
  q: string({ description: 'Search text (title and description).', min: 1, max: 200, transform: (s) => s.trim() }),
  team: optional(teamKey('Only issues of this team.')),
  includeClosed: optional(boolean({ description: 'Also return done, canceled and duplicate issues.' }), true),
  model: optional(modelFilter()),
  limit: optional(integer({ description: 'Maximum number of results.', min: 1, max: 50 }), 20),
});

export const LIST_FILTERS = ['assigned', 'due', 'overdue', 'in_progress', 'done_today', 'triage', 'sprint'] as const;

const listIssues = object({
  filter: optional(
    enumOf(LIST_FILTERS, {
      description: [
        'Preset filter:',
        '"assigned" = all open issues (status type backlog, unstarted or started) outside triage, in teams that are not dormant and not knowledge-only. Selfbound has a single user (the owner) and no assignee field, so this is what "assigned to me" means;',
        '"due" = open issues due within `dueWithinDays` days from today, overdue ones included;',
        '"overdue" = open issues with a due date before today;',
        '"in_progress" = issues in a started status (e.g. In Progress, In Review);',
        '"done_today" = issues completed today;',
        '"triage" = issues in triage (the inbox);',
        '"sprint" = issues in the currently active sprint.',
        'Days are calendar days in the instance\'s time zone (Settings → Time zone).',
      ].join(' '),
    }),
  ),
  team: optional(teamKey('Only issues of this team.')),
  status: optional(
    array(
      string({ min: 1, max: STATE_NAME_MAX, transform: (s) => s.trim() }),
      {
        description:
          'Only issues with one of these statuses: status names (case-insensitive, see list_statuses), status keys (triage, backlog, todo, in_progress, in_review, done, canceled, duplicate) or status types (unstarted, started, completed).',
        min: 1,
        max: 20,
        unique: true,
      },
    ),
  ),
  label: optional(string({ description: 'Only issues with this label (name, case-insensitive).', min: 1, max: 100 })),
  project: optional(string({ description: 'Only issues in this project (name, case-insensitive).', min: 1, max: 200 })),
  model: optional(modelFilter()),
  dueWithinDays: optional(integer({ description: 'Window for the "due" filter, in days.', min: 0, max: 60 }), 7),
  snoozed: optional(
    boolean({
      description:
        'true = only snoozed issues (`snoozedUntil` is set), false = only issues that are not snoozed. Without it, snoozed issues are listed like any other; each shows its `snoozedUntil`.',
    }),
  ),
  limit: optional(integer({ description: 'Maximum number of results.', min: 1, max: 100 }), 50),
});

const getIssue = object(
  {
    identifier: optional(identifier()),
    id: optional(string({ description: 'Internal issue id (from an earlier result).', min: 1, max: 64 })),
  },
  {
    refine(v, _path, errors) {
      if ((v.identifier === undefined) === (v.id === undefined)) errors.push('arguments: give exactly one of identifier or id');
    },
  },
);

const newIssue = object({
  team: teamKey(),
  title: title(),
  description: optional(string({ description: `Markdown description. ${TWO_LAYERS} ${VISUAL_BLOCKS}`, max: LIMITS.descriptionMax })),
  status: optional(status('Initial status. Default: triage for agents.')),
  priority: optional(priority()),
  labels: optional(labelNames()),
  project: optional(string({ description: 'Project name (case-insensitive), must belong to the team.', min: 1, max: 200 })),
  estimate: optional(estimate()),
  dueDate: optional(realDay('Due date, YYYY-MM-DD.')),
  parent: optional(identifier('Parent issue identifier, e.g. "ACME-100".')),
  model: optional(modelChoice(MODEL_INPUT)),
});

const createIssues = object({
  requestId: requestId(),
  issues: array(newIssue, {
    description: `Issues to create, 1 to ${LIMITS.batchCreateMax}. All are created in one transaction.`,
    min: 1,
    max: LIMITS.batchCreateMax,
  }),
});

const expected = object(
  {
    title: optional(string({ max: LIMITS.titleMax })),
    status: optional(status()),
    priority: optional(priority()),
    labels: optional(array(string({ min: 1, max: 100 }), { max: 20 })),
    project: optional(nullable(string({ min: 1, max: 200 }))),
    estimate: optional(nullable(number({ min: 0, max: 100 }))),
    dueDate: optional(nullable(realDay('YYYY-MM-DD'))),
    snoozedUntil: optional(nullable(realDay('YYYY-MM-DD'))),
    parent: optional(nullable(identifier())),
    model: optional(nullable(modelSeen('The issue\'s own model as you saw it (`model` from get_issue, as is), or null for none.'))),
  },
  {
    description:
      'Optional: the values you believe the fields have right now. If a field changed in the meantime, that field is not written and the result reports a conflict. Labels are compared as a set.',
  },
);

const UPDATE_FIELDS = ['title', 'status', 'priority', 'labels', 'project', 'estimate', 'dueDate', 'snoozedUntil', 'parent', 'model', 'description'] as const;

// For update_issue and set_status the requestId is optional: setting the same values again
// changes nothing. With a requestId, though, a retry returns the original result instead of a
// conflict (`expected` no longer matches afterwards).
const optionalRequestId = () =>
  optional(
    requestId(
      `${REQUEST_ID_DESCRIPTION} Optional here; recommended together with \`expected\`, so that a retry after a lost response does not report a conflict with your own change.`,
    ),
  );

const updateIssue = object(
  {
    requestId: optionalRequestId(),
    identifier: identifier(),
    title: optional(title()),
    status: optional(status()),
    priority: optional(priority()),
    labels: optional(labelNames()),
    project: optional(nullable(string({ description: 'Project name, or null to remove.', min: 1, max: 200 }))),
    estimate: optional(nullable(estimate())),
    dueDate: optional(nullable(realDay('Due date YYYY-MM-DD, or null to remove.'))),
    snoozedUntil: optional(
      nullable(
        realDay(
          'Snooze the issue until this day, YYYY-MM-DD (after today in the instance\'s time zone), or null to unsnooze. A snoozed issue is hidden from the owner\'s lists; on that day, in the morning, it returns to the inbox with a push notification. Only open issues can be snoozed; closing an issue ends its snooze.',
        ),
      ),
    ),
    parent: optional(nullable(identifier('Parent identifier, or null to remove.'))),
    model: optional(nullable(modelChoice(`${MODEL_INPUT} null removes the issue's own model (it then inherits again).`))),
    description: optional(
      string({
        description: `New Markdown description (replaces the old one). Requires expectedDescriptionVersion. ${TWO_LAYERS} ${VISUAL_BLOCKS}`,
        max: LIMITS.descriptionMax,
      }),
    ),
    expectedDescriptionVersion: optional(
      integer({
        description:
          'Version of the description you based your edit on (from get_issue). If the description changed since, nothing is overwritten and the result tells you so.',
        min: 0,
      }),
    ),
    expected: optional(expected),
  },
  {
    refine(v, _path, errors) {
      if (!UPDATE_FIELDS.some((f) => v[f] !== undefined))
        errors.push(`arguments: nothing to change; give at least one of ${UPDATE_FIELDS.join(', ')}`);
      if (v.description !== undefined && v.expectedDescriptionVersion === undefined)
        errors.push('expectedDescriptionVersion: required when changing the description (read it with get_issue)');
    },
  },
);

const setStatus = object({
  requestId: optionalRequestId(),
  identifiers: array(identifier(), { description: 'Issues to change, 1 to 50.', min: 1, max: 50, unique: true }),
  status: status('New status.'),
});

const moveIssues = object({
  requestId: optionalRequestId(),
  identifiers: array(identifier(), { description: 'Issues to move, 1 to 50 (old identifiers work too).', min: 1, max: 50, unique: true }),
  team: teamKey('Key of the team to move the issues to. See list_teams.'),
});

const addComment = object({
  requestId: requestId(),
  identifier: identifier(),
  body: string({ description: `Comment in Markdown. ${VISUAL_BLOCKS}`, min: 1, max: LIMITS.commentMax }),
});

const getCurrentSprint = object({});

const listTeams = object({
  includeDormant: optional(boolean({ description: 'Also list dormant (inactive) teams.' }), true),
});

const listProjects = object({
  team: optional(teamKey('Only projects of this team.')),
  includeClosed: optional(boolean({ description: 'Also list done and canceled projects.' }), false),
});

const listLabels = object({
  team: optional(teamKey('Only workspace labels and labels of this team.')),
});

const listStatuses = object({
  team: optional(teamKey('Only the statuses of this team.')),
});

const listModels = object({
  provider: optional(string({ description: 'Only models of this provider (ID, e.g. "anthropic").', min: 1, max: MODEL_LIMITS.provider, transform: (s) => s.trim() })),
});

const listInbox = object({
  unreadOnly: optional(boolean({ description: 'Only entries the owner has not read yet.' }), false),
  limit: optional(integer({ description: 'Maximum number of entries.', min: 1, max: 100 }), 50),
});

// ---------------------------------------------------------------------------
// Knowledge: pages per team

const articleId = (description = 'Article id (from search_articles, list_articles or an earlier result).') =>
  string({ description, min: 1, max: 64, transform: (s) => s.trim() });
const topicNames = () =>
  array(string({ min: 1, max: 60, transform: (s) => s.trim() }), {
    description: `Topic names (case-insensitive), the full set. Unknown topics are created in the team. At most ${WIKI.topicsMax}.`,
    max: WIKI.topicsMax,
    unique: true,
  });
const source = object({
  url: optional(string({ description: 'http(s) address of the source.', min: 1, max: 2000, pattern: /^https?:\/\/\S+$/i, patternHint: 'an http(s) address' })),
  title: optional(string({ description: 'Title of the source (required if there is no url).', min: 1, max: 500 })),
  author: optional(string({ description: 'Author or publisher.', min: 1, max: 300 })),
  publishedAt: optional(string({ description: 'Publication date: YYYY, YYYY-MM or YYYY-MM-DD.', pattern: PARTIAL_DATE_RE, patternHint: 'YYYY, YYYY-MM or YYYY-MM-DD' })),
  accessedAt: optional(realDay('Day the source was accessed, YYYY-MM-DD. Default: today.')),
  note: optional(string({ description: 'Short note, e.g. what the source supports.', min: 1, max: 2000 })),
}, {
  refine(v, path, errors) {
    if (v.url === undefined && v.title === undefined) errors.push(`${path || 'source'}: give a url or a title`);
  },
});
const sources = (description: string) => array(source, { description, min: 1, max: WIKI.sourcesMax });

const searchArticles = object({
  q: string({ description: 'Search text (title and full text of the pages).', min: 1, max: 200, transform: (s) => s.trim() }),
  team: optional(teamKey('Only pages of this team.')),
  limit: optional(integer({ description: 'Maximum number of results.', min: 1, max: 50 }), 20),
});

const listArticles = object({
  team: teamKey('Team whose knowledge area to list. See list_teams (field `wiki`).'),
  project: optional(string({ description: 'Only pages of this project (name, case-insensitive).', min: 1, max: 200 })),
  topic: optional(string({ description: 'Only pages with this topic (name, case-insensitive).', min: 1, max: 60 })),
});

const getArticle = object({ id: articleId() });

const createArticle = object({
  requestId: requestId(),
  team: teamKey('Team of the page. The team needs a knowledge area (list_teams: `wiki`).'),
  title: string({ description: 'Page title.', min: 1, max: LIMITS.titleMax, transform: (s) => s.trim() }),
  markdown: optional(string({ description: `Markdown text of the page. ${VISUAL_BLOCKS}`, max: WIKI.articleMax })),
  parent: optional(articleId('Parent page id: the new page becomes a sub-page.')),
  project: optional(string({ description: 'Project name (case-insensitive) of the same team, for project documentation.', min: 1, max: 200 })),
  topics: optional(topicNames()),
  sources: optional(sources('Sources of the page.')),
});

const UPDATE_ARTICLE_FIELDS = ['title', 'parent', 'project', 'topics', 'markdown', 'append', 'addSources'] as const;

const updateArticle = object(
  {
    requestId: requestId(),
    id: articleId(),
    title: optional(string({ description: 'New title.', min: 1, max: LIMITS.titleMax, transform: (s) => s.trim() })),
    parent: optional(nullable(articleId('New parent page id, or null for the top level.'))),
    project: optional(nullable(string({ description: 'Project name, or null to remove.', min: 1, max: 200 }))),
    topics: optional(topicNames()),
    markdown: optional(string({ description: `New Markdown text (replaces the old one). Requires expectedVersion. ${VISUAL_BLOCKS}`, max: WIKI.articleMax })),
    expectedVersion: optional(integer({ description: 'Version of the text you based your edit on (from get_article). If the text changed since, nothing is overwritten and the call fails with conflict.', min: 0 })),
    append: optional(string({ description: `Markdown to add at the end of the text (no version needed), e.g. new findings. ${VISUAL_BLOCKS}`, min: 1, max: WIKI.articleMax })),
    addSources: optional(sources('Sources to add at the end of the list.')),
  },
  {
    refine(v, _path, errors) {
      if (!UPDATE_ARTICLE_FIELDS.some((f) => v[f] !== undefined)) errors.push(`arguments: nothing to change; give at least one of ${UPDATE_ARTICLE_FIELDS.join(', ')}`);
      if (v.markdown !== undefined && v.expectedVersion === undefined) errors.push('expectedVersion: required when replacing the text (read it with get_article)');
      if (v.markdown !== undefined && v.append !== undefined) errors.push('arguments: give either markdown or append, not both');
    },
  },
);

// ---------------------------------------------------------------------------
// Tool list

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations: ToolAnnotations;
}

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const SCHEMAS = {
  search_issues: searchIssues,
  list_issues: listIssues,
  get_issue: getIssue,
  create_issues: createIssues,
  update_issue: updateIssue,
  set_status: setStatus,
  move_issues: moveIssues,
  add_comment: addComment,
  get_current_sprint: getCurrentSprint,
  list_teams: listTeams,
  list_projects: listProjects,
  list_labels: listLabels,
  list_statuses: listStatuses,
  list_models: listModels,
  list_inbox: listInbox,
  search_articles: searchArticles,
  list_articles: listArticles,
  get_article: getArticle,
  create_article: createArticle,
  update_article: updateArticle,
} as const;

export type ToolName = keyof typeof SCHEMAS;
export type ToolArgs = { [K in ToolName]: Infer<(typeof SCHEMAS)[K]> };

const META: Record<ToolName, Omit<ToolDefinition, 'name' | 'inputSchema'>> = {
  search_issues: {
    title: 'Search issues',
    description:
      'Full-text search over issue titles and descriptions across all teams. Returns identifier, title, status, priority and team for each hit, best matches first.',
    annotations: READ,
  },
  list_issues: {
    title: 'List issues',
    description:
      'List issues with a preset filter (assigned, due, overdue, in_progress, done_today, triage, sprint) and/or by team, status, label, project and model. Filters combine with AND; without filter or status you get all open issues (triage up to the started statuses). Deleted issues are never returned. Sorted by priority (urgent first, none last), then due date.',
    annotations: READ,
  },
  get_issue: {
    title: 'Get issue',
    // legacy-xlr8: the description names the deprecated field reviewedBySteven
    description:
      'Get one issue by identifier (e.g. "ACME-106", old identifiers resolve too) or internal id: all fields, the Markdown description with its version, comments, relations (blocks, related, duplicate), sub-issues, linked pull requests, related knowledge pages (`knowledge`, read them with get_article) and the most recent history entries. `model` is the issue\'s own desired model; `effectiveModel` the one that applies, with its `source` (issue, parent or team default). `reviewedByOwner` is true unless an unread inbox entry waits for the owner; `reviewedBySteven` is a deprecated copy of it and will be removed.',
    annotations: READ,
  },
  create_issues: {
    title: 'Create issues',
    description:
      'Create 1 to 50 issues in one transaction. Teams are given by key, labels and project by name. Issues created by agents are marked as "not yet reviewed" for the owner. requestId makes the call safe to retry. The result lists the new identifiers and any warnings (e.g. budget_warning: a team is over its priority limit). If a priority limit of the team is hard and the new urgent/high issues would go over it, the call fails with priority_limit and nothing is created. An issue created with a status of type completed or canceled (done, canceled, duplicate) gets no priority; a warning with code priority_cleared names the priority that was dropped.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  update_issue: {
    title: 'Update issue',
    description:
      'Change fields of one issue. Only the given fields change; null removes project, estimate, due date, snooze, parent or model. Pass `expected` with the values you saw to avoid overwriting a concurrent change. Changing the description requires expectedDescriptionVersion from get_issue. Set `snoozedUntil` to a future day to snooze an issue (hidden from the owner\'s lists, back in the inbox with a push that morning) and null to unsnooze it. The result lists applied fields, conflicts and warnings. Moving an issue to done, canceled or duplicate removes its priority (only open work carries one); a warning with code priority_cleared names the removed priority, and reopening the issue does not restore it. Raising an issue to urgent or high in a team whose hard priority limit is full fails with priority_limit (lower another issue first); a soft limit only adds a budget_warning.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  set_status: {
    title: 'Set status',
    description:
      'Set the status of 1 to 50 issues at once, by status name of each issue\'s team (see list_statuses) or by key, e.g. "done" or "in_progress". Each change is recorded in the issue history with you as the actor. Moving an issue to done, canceled or duplicate removes its priority (only open work carries one); the result then has warnings with code priority_cleared naming each removed priority, and reopening does not restore it.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  move_issues: {
    title: 'Move issues to another team',
    description:
      'Move 1 to 50 issues to another team in one transaction. Each issue gets a new identifier in the target team (e.g. OPS-24 becomes ACME-120); the old identifier stays valid as an alias in every tool. What happens: the project is removed unless it belongs to the target team (projects belong to exactly one team); labels of the old team are removed, workspace labels stay; the status becomes the matching status of the target team (same default status, else same name, else same status type), the strict workflow order is not applied; sprint, parent, priority, estimate, due date, description, comments and history are kept. The result names old and new identifier, the removed project and labels and the status set for every issue; issues already in the target team are listed under `unchanged`. If any issue cannot be moved (unknown, in the trash, or an urgent/high issue would go over a hard priority limit of the target team: priority_limit), nothing is moved. requestId makes the call safe to retry.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  add_comment: {
    title: 'Add comment',
    description:
      'Add a Markdown comment to an issue, e.g. a progress report. requestId makes the call safe to retry without duplicate comments.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  get_current_sprint: {
    title: 'Get current sprint',
    description:
      'Get the active sprint (spans all teams): name, goal, dates, capacity, points done/total and its issues split into planned and added later. If no sprint is active, returns the sprint in planning, if any.',
    annotations: READ,
  },
  list_teams: {
    title: 'List teams',
    description:
      'List teams with key, name, whether they are dormant (inactive) and their knowledge area (`wiki`: "on" next to issues, "only" knowledge without issues, null none). Use the key in other tools. A renamed team lists its old keys in `previousKeys`; identifiers and team references with an old key still work.',
    annotations: READ,
  },
  list_projects: {
    title: 'List projects',
    description: 'List projects with name, team and state. Every project belongs to exactly one team.',
    annotations: READ,
  },
  list_statuses: {
    title: 'List statuses',
    description:
      'List the workflow statuses of each team in workflow order: name, type (triage, backlog, unstarted, started, completed, canceled) and key. Teams define their own statuses; use the names in set_status, update_issue and list_issues. A team with strictOrder only allows moving to the next status, canceling, and the listed exceptions; get_issue then returns allowedStatuses, and a disallowed change fails with invalid_transition and the allowed targets.',
    annotations: READ,
  },
  list_models: {
    title: 'List models',
    description:
      'List the models the owner enabled for issues (Settings → Models, from the models.dev catalog): provider, model ID, name, the valid `efforts` (empty = no effort setting) and `speeds` ("standard" plus modes such as "fast"), context window and output limit in tokens. Only these models, efforts and speeds can be set as an issue\'s `model`. Also lists the team defaults. An issue\'s effective model is its own, else its parent\'s, else its team\'s default, else none: then whoever runs the issue decides.',
    annotations: READ,
  },
  list_inbox: {
    title: 'List inbox',
    description:
      'Read-only view of the owner\'s inbox, newest first: one entry per issue that agents created or changed and the owner has not removed yet. Each entry names the agents and their latest change per field (status, comment, description, …), and whether the owner has read it. Several changes to the same issue are one entry. Use it to see what is still waiting for the owner; reading and removing entries is reserved for the owner.',
    annotations: READ,
  },
  search_articles: {
    title: 'Search knowledge pages',
    description:
      'Full-text search over the knowledge pages of all teams or one team: titles and the whole text. Returns id, title, team, path of parent pages and a snippet; pages with all words first. Pages in the trash are not returned.',
    annotations: READ,
  },
  list_articles: {
    title: 'List knowledge pages',
    description:
      'List the knowledge pages of one team as a tree (each page with its parent id), optionally only of one project or topic, without text. Also returns the team\'s topics. Use get_article for the text.',
    annotations: READ,
  },
  get_article: {
    title: 'Get knowledge page',
    description:
      'Get one knowledge page by id: title, Markdown text with its version (for update_article), sources, topics, project, path of parent pages, sub-pages, and who changed it when.',
    annotations: READ,
  },
  create_article: {
    title: 'Create knowledge page',
    description:
      'Create a knowledge page in a team with a knowledge area, optionally as a sub-page, with project, topics (unknown ones are created) and structured sources. requestId makes the call safe to retry. Use search_articles first to avoid duplicates.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  update_article: {
    title: 'Update knowledge page',
    description:
      'Change a knowledge page: title, parent, project, topics, and the text, either replaced (`markdown` with expectedVersion from get_article; a concurrent change fails with conflict) or extended (`append`, no version needed). `addSources` adds sources. The previous text is kept as an earlier version that the owner can restore. Deleting pages is reserved for the owner.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  list_labels: {
    title: 'List labels',
    description:
      'List labels with name, group and scope (workspace-wide or team). In an exclusive group an issue can carry only one label.',
    annotations: READ,
  },
};

export const TOOLS: readonly ToolDefinition[] = (Object.keys(SCHEMAS) as ToolName[]).map((name) => ({
  name,
  ...META[name],
  annotations: { title: META[name].title, ...META[name].annotations },
  inputSchema: SCHEMAS[name].json,
}));

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(SCHEMAS, name);
}

/** Checks and normalizes a tool's arguments. Missing arguments count as `{}`. */
export function checkToolArguments<N extends ToolName>(name: N, args: unknown): CheckResult<ToolArgs[N]> {
  return validate(SCHEMAS[name] as Schema<ToolArgs[N]>, args ?? {});
}
