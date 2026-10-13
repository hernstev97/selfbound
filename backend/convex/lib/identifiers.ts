import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { identifierOf, TEAM_KEY_RE } from '../shared/constants';

// Identifiers like "KIU-106" are derived from the team key and number and not stored.
// Old identifiers (e.g. from Linear, or from before a team move) live in `identifierAliases`.

/** Possible splits into key and number: "kiu-106", "KIU106", "kiu 106". */
export function identifierCandidates(input: string): { key: string; number: number }[] {
  const s = input.trim().toUpperCase();
  const dashed = /^([A-Z][A-Z0-9]{1,5})[-_ ](\d{1,6})$/.exec(s);
  if (dashed) return [{ key: dashed[1], number: Number(dashed[2]) }];
  const out: { key: string; number: number }[] = [];
  // Without a separator the boundary is ambiguous (keys may contain digits): try every split.
  for (let i = 2; i <= 6 && i < s.length; i++) {
    const key = s.slice(0, i);
    const rest = s.slice(i);
    if (TEAM_KEY_RE.test(key) && /^\d{1,6}$/.test(rest)) out.push({ key, number: Number(rest) });
  }
  return out;
}

/** Normal form for aliases: uppercase with a hyphen. */
export function aliasKey(key: string, number: number) {
  return identifierOf(key.toUpperCase(), number);
}

/**
 * Resolves an identifier or issue ID. Order: Convex ID, current identifier
 * (teams.by_key + issues.by_team_number), old identifier (identifierAliases).
 */
export async function resolveIssue(ctx: QueryCtx, input: string): Promise<Doc<'issues'> | null> {
  const id = ctx.db.normalizeId('issues', input.trim());
  if (id) return await ctx.db.get('issues', id);
  const candidates = identifierCandidates(input);
  for (const { key, number } of candidates) {
    const team = await ctx.db
      .query('teams')
      .withIndex('by_key', (q) => q.eq('key', key))
      .unique();
    if (!team) continue;
    const issue = await ctx.db
      .query('issues')
      .withIndex('by_team_number', (q) => q.eq('teamId', team._id).eq('number', number))
      .unique();
    if (issue) return issue;
  }
  for (const { key, number } of candidates) {
    const alias = await ctx.db
      .query('identifierAliases')
      .withIndex('by_key', (q) => q.eq('key', aliasKey(key, number)))
      .first();
    if (alias) return await ctx.db.get('issues', alias.issueId);
  }
  return null;
}

/** Reads team keys through a cache, for many identifiers in one function. */
export function teamKeys(ctx: QueryCtx) {
  const cache = new Map<Id<'teams'>, string>();
  return async (issue: Pick<Doc<'issues'>, 'teamId' | 'number'>) => {
    let key = cache.get(issue.teamId);
    if (key === undefined) {
      key = (await ctx.db.get('teams', issue.teamId))?.key ?? '?';
      cache.set(issue.teamId, key);
    }
    return identifierOf(key, issue.number);
  };
}
