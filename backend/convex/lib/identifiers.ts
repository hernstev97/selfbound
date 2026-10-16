import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { identifierOf, TEAM_KEY_RE } from '../shared/constants';

// Identifiers like "KIU-106" are derived from the team key and number and not stored.
// Old identifiers (e.g. from Linear, or from before a team move) live in `identifierAliases`;
// identifiers with a key the team had before a rename resolve through `teams.previousKeys`.

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
 * (teams.by_key + issues.by_team_number), the same with a key the team had before a rename
 * (teams.previousKeys), old identifier (identifierAliases).
 */
export async function resolveIssue(ctx: QueryCtx, input: string): Promise<Doc<'issues'> | null> {
  const id = ctx.db.normalizeId('issues', input.trim());
  if (id) return await ctx.db.get('issues', id);
  const candidates = identifierCandidates(input);
  const aliases = new Set<string>();
  let teams: Doc<'teams'>[] | undefined;
  for (const { key, number } of candidates) {
    const current = await ctx.db
      .query('teams')
      .withIndex('by_key', (q) => q.eq('key', key))
      .unique();
    const team = current ?? (teams ??= await ctx.db.query('teams').take(500)).find((t) => t.previousKeys?.includes(key));
    if (team) {
      const issue = await ctx.db
        .query('issues')
        .withIndex('by_team_number', (q) => q.eq('teamId', team._id).eq('number', number))
        .unique();
      if (issue) return issue;
      // Moved to another team: the alias holds the key the team had at the time of the move.
      for (const k of keysOf(team)) aliases.add(aliasKey(k, number));
    }
    aliases.add(aliasKey(key, number));
  }
  for (const key of aliases) {
    const alias = await ctx.db
      .query('identifierAliases')
      .withIndex('by_key', (q) => q.eq('key', key))
      .first();
    if (alias) return await ctx.db.get('issues', alias.issueId);
  }
  return null;
}

/** Every key a team has had. Aliases of moved issues hold the key from the time of the move. */
export const keysOf = (team: Doc<'teams'>) => [team.key, ...(team.previousKeys ?? [])];

/** Current and previous keys → team, for many identifiers at once. A current key wins. */
export function teamsByKey(teams: Doc<'teams'>[]) {
  const map = new Map<string, Doc<'teams'>>();
  for (const t of teams) for (const k of t.previousKeys ?? []) map.set(k, t);
  for (const t of teams) map.set(t.key, t);
  return map;
}

/** The team that had this key before a rename. Teams are few, so a scan instead of an index. */
export async function teamByPreviousKey(ctx: QueryCtx, key: string): Promise<Doc<'teams'> | null> {
  const teams = await ctx.db.query('teams').take(500);
  return teams.find((t) => t.previousKeys?.includes(key)) ?? null;
}

/** A team by its current key, else by a key it had before a rename. */
export async function teamByKey(ctx: QueryCtx, key: string): Promise<Doc<'teams'> | null> {
  const team = await ctx.db
    .query('teams')
    .withIndex('by_key', (q) => q.eq('key', key))
    .unique();
  return team ?? (await teamByPreviousKey(ctx, key));
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
