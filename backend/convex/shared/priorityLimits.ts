// Priority limits (XLR8-91): at most `max` open urgent / high issues per team. Soft limits only
// warn; hard limits reject every change that adds another issue to a full (team, priority) set.
// One setting for the instance (instanceSettings.priorityLimits), counted per team.

export type LimitedPriority = 1 | 2;
export const LIMITED_PRIORITIES: readonly LimitedPriority[] = [1, 2];

/** `max: null` = no limit. */
export interface PriorityLimit {
  max: number | null;
  hard: boolean;
}
export interface PriorityLimits {
  urgent: PriorityLimit;
  high: PriorityLimit;
}

/** Without a stored setting: 1 urgent and 3 high, warning only (the behaviour before the setting). */
export const DEFAULT_PRIORITY_LIMITS: PriorityLimits = {
  urgent: { max: 1, hard: false },
  high: { max: 3, hard: false },
};

export const PRIORITY_LIMIT_MAX = 99;

const KEY = { 1: 'urgent', 2: 'high' } as const;

export function isLimited(priority: number): priority is LimitedPriority {
  return priority === 1 || priority === 2;
}

/** The limit for a priority, or null for priorities without one (medium, low, none). */
export function limitFor(limits: PriorityLimits | null | undefined, priority: number): PriorityLimit | null {
  if (!isLimited(priority)) return null;
  return (limits ?? DEFAULT_PRIORITY_LIMITS)[KEY[priority]];
}

/** Over the limit with `open` issues? Never without a limit. */
export function overLimit(limit: PriorityLimit | null, open: number) {
  return limit?.max != null && open > limit.max;
}
