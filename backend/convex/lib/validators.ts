import { v, type Infer } from 'convex/values';
import { priorityValidator, projectStateValidator, sprintOutcomeValidator, statusValidator } from '../schema';

// Shared argument validators for UI mutations and MCP.
// For optional fields, `null` means "clear".

export const requestIdArg = { requestId: v.optional(v.string()) };

export const newIssueValidator = v.object({
  teamId: v.id('teams'),
  title: v.string(),
  description: v.optional(v.string()),
  stateId: v.optional(v.id('workflowStates')), // the team's state; takes precedence over `status`
  status: v.optional(statusValidator), // status type; default: the team's default state ('triage' for the inbox)
  priority: v.optional(priorityValidator), // default 0
  labelIds: v.optional(v.array(v.id('labels'))),
  projectId: v.optional(v.id('projects')),
  estimate: v.optional(v.number()),
  dueDate: v.optional(v.string()), // YYYY-MM-DD
  parentId: v.optional(v.id('issues')),
  sprintId: v.optional(v.id('sprints')),
});
export type NewIssue = Infer<typeof newIssueValidator>;

export const issuePatchValidator = v.object({
  title: v.optional(v.string()),
  stateId: v.optional(v.id('workflowStates')), // the team's state
  status: v.optional(statusValidator), // status type (legacy key): the team's matching state
  priority: v.optional(priorityValidator),
  labelIds: v.optional(v.array(v.id('labels'))),
  projectId: v.optional(v.union(v.id('projects'), v.null())),
  estimate: v.optional(v.union(v.number(), v.null())),
  dueDate: v.optional(v.union(v.string(), v.null())),
  snoozedUntil: v.optional(v.union(v.string(), v.null())), // day after today; hides the issue until then
  parentId: v.optional(v.union(v.id('issues'), v.null())),
  sprintId: v.optional(v.union(v.id('sprints'), v.null())),
});
export type IssuePatch = Infer<typeof issuePatchValidator>;
export type PatchField = keyof IssuePatch;
export const PATCH_FIELDS: PatchField[] = [
  'title',
  'stateId',
  'status',
  'priority',
  'labelIds',
  'projectId',
  'estimate',
  'dueDate',
  'snoozedUntil',
  'parentId',
  'sprintId',
];

export const revertItemValidator = v.object({
  id: v.id('issues'),
  patch: issuePatchValidator,
  expect: issuePatchValidator,
});
export type RevertItem = Infer<typeof revertItemValidator>;

export const sprintDecisionValidator = v.object({
  issueId: v.id('issues'),
  outcome: v.union(v.literal('next'), v.literal('backlog'), v.literal('canceled')),
});
export type SprintDecision = Infer<typeof sprintDecisionValidator>;
export type SprintOutcome = Infer<typeof sprintOutcomeValidator>;

export const projectStateArg = projectStateValidator;

export const logoVariantValidator = v.union(v.literal('light'), v.literal('dark'));
export type LogoVariant = Infer<typeof logoVariantValidator>;

export const cadenceValidator = v.union(v.literal('weekly'), v.literal('monthly'));

// ---------------------------------------------------------------- Knowledge base

/** A source when creating. At least `url` or `title`; missing `accessedAt` = today. */
export const sourceInputValidator = v.object({
  url: v.optional(v.string()),
  title: v.optional(v.string()),
  author: v.optional(v.string()),
  publishedAt: v.optional(v.string()), // YYYY, YYYY-MM or YYYY-MM-DD
  accessedAt: v.optional(v.string()), // YYYY-MM-DD
  note: v.optional(v.string()),
});
export type SourceInput = Infer<typeof sourceInputValidator>;

/** Change to a source; `null` clears a field. */
export const sourcePatchValidator = v.object({
  url: v.optional(v.union(v.string(), v.null())),
  title: v.optional(v.union(v.string(), v.null())),
  author: v.optional(v.union(v.string(), v.null())),
  publishedAt: v.optional(v.union(v.string(), v.null())),
  accessedAt: v.optional(v.string()),
  note: v.optional(v.union(v.string(), v.null())),
});
export type SourcePatch = Infer<typeof sourcePatchValidator>;

export const newArticleValidator = {
  teamId: v.id('teams'),
  title: v.string(),
  markdown: v.optional(v.string()),
  parentId: v.optional(v.id('articles')),
  projectId: v.optional(v.id('projects')),
  topicIds: v.optional(v.array(v.id('wikiTopics'))),
  sources: v.optional(v.array(sourceInputValidator)),
};
