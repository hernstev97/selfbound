// Search text of an issue ("kiu-106 title", lowercase) for quick search and search.
// Computed on demand and remembered per issue object (issues are frozen and replaced on every
// change): as long as nobody searches, nothing is kept in memory for it.
import type { Issue } from './types.ts';

const cache = new WeakMap<Issue, string>();

export function haystackOf(issue: Issue): string {
  let text = cache.get(issue);
  if (text === undefined) cache.set(issue, (text = `${issue.key} ${issue.title}`.toLowerCase()));
  return text;
}
