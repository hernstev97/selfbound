import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Actor } from '../lib/actor';
import { invalid, notFound } from '../lib/errors';
import { imageUrl } from '../lib/image';
import { imageTokens } from '../shared/constants';
import { ACCENT_RE, ROADMAP_LIMITS, STAGE_CHOICES, type StageChoice } from '../shared/roadmap';
import { syncFileRefs } from './files';
import { record } from './history';
import { getIssue, getTeam } from './validate';

// Roadmap (SELF-113): public cards of issues and the roadmap settings of a team.
//
// The public flag itself is an issue field (`issues.public`, through applyPatch like any other field).
// The card texts live in `publicCards` so the buckets every client holds stay small; they are only
// read by the roadmap page (`cardsOfTeam`) and the issue detail (`cardOf`).
// Every actor may write both: agents set up the roadmap (MCP), the owner reviews it.

export type CardField = 'title' | 'summary' | 'image';
/** History field per card field. */
const HISTORY_FIELD: Record<CardField, string> = { title: 'publicTitle', summary: 'publicSummary', image: 'publicImage' };

export interface CardPatch {
  title?: string | null;
  summary?: string | null;
  /** Image token, an image URL (`<site>/img/<token>`) or a Markdown image line; null removes it */
  image?: string | null;
}

/** One line, collapsed whitespace; empty = cleared. */
function checkPublicTitle(title: string): string | undefined {
  const s = title.replace(/\s+/g, ' ').trim();
  if (s.length > ROADMAP_LIMITS.publicTitleMax) invalid(`The public title is too long (at most ${ROADMAP_LIMITS.publicTitleMax} characters).`);
  return s || undefined;
}

function checkPublicSummary(summary: string): string | undefined {
  const s = summary.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length > ROADMAP_LIMITS.publicSummaryMax) invalid(`The public summary is too long (at most ${ROADMAP_LIMITS.publicSummaryMax} characters).`);
  return s || undefined;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** The token of an uploaded image from a token, URL or Markdown line. Unknown tokens are rejected. */
async function checkImage(ctx: QueryCtx, input: string): Promise<string> {
  const s = input.trim();
  const token = TOKEN_RE.test(s) ? s : [...imageTokens(s)][0];
  if (!token) invalid('The image must be an image uploaded to Selfbound (its /img/… address or Markdown line from upload_image).');
  const file = await ctx.db
    .query('files')
    .withIndex('by_token', (q) => q.eq('token', token))
    .unique();
  if (!file) invalid('This image is not known to Selfbound. Upload it first.');
  return token;
}

async function cardRow(ctx: QueryCtx, issueId: Id<'issues'>) {
  return await ctx.db
    .query('publicCards')
    .withIndex('by_issue', (q) => q.eq('issueId', issueId))
    .unique();
}

/** The card as the UI and MCP see it: texts and the image URL. */
export function cardOut(card: Doc<'publicCards'> | null) {
  if (!card) return null;
  return {
    title: card.title ?? null,
    summary: card.summary ?? null,
    image: card.image ? imageUrl(card.image) : null,
  };
}

export async function cardOf(ctx: QueryCtx, issueId: Id<'issues'>) {
  return cardOut(await cardRow(ctx, issueId));
}

/**
 * Changes the public card of an issue. Only the given fields change; null (or an empty text)
 * clears one. A card with nothing left is deleted. Writes one history row per changed field
 * and bumps the issue's `updatedAt` like every other change.
 */
export async function setPublicCard(
  ctx: MutationCtx,
  actor: Actor,
  args: { id: Id<'issues'> } & CardPatch,
  now: number,
  requestId?: string,
): Promise<{ changed: CardField[] }> {
  const issue = await getIssue(ctx, args.id);
  const card = await cardRow(ctx, issue._id);
  const next: Record<CardField, string | undefined> = { title: card?.title, summary: card?.summary, image: card?.image };
  if (args.title !== undefined) next.title = args.title === null ? undefined : checkPublicTitle(args.title);
  if (args.summary !== undefined) next.summary = args.summary === null ? undefined : checkPublicSummary(args.summary);
  if (args.image !== undefined) next.image = args.image === null || !args.image.trim() ? undefined : await checkImage(ctx, args.image);

  const changed = (['title', 'summary', 'image'] as const).filter((f) => (card?.[f] ?? undefined) !== next[f]);
  if (changed.length === 0) return { changed };

  const empty = next.title === undefined && next.summary === undefined && next.image === undefined;
  let rowId = card?._id;
  if (card && empty) await ctx.db.delete('publicCards', card._id);
  else if (card) await ctx.db.patch('publicCards', card._id, { ...next, updatedAt: now, updatedBy: actor });
  else rowId = await ctx.db.insert('publicCards', { issueId: issue._id, teamId: issue.teamId, ...next, updatedAt: now, updatedBy: actor });
  // The cover image counts as a reference like an image in a text, so cleanup keeps it.
  if (rowId && changed.includes('image')) await syncFileRefs(ctx, rowId, next.image && !empty ? `/img/${next.image}` : null, now);

  await ctx.db.patch('issues', issue._id, { updatedAt: now });
  for (const field of changed) {
    await record(ctx, actor, now, requestId, {
      issueId: issue._id,
      field: HISTORY_FIELD[field],
      from: field === 'image' ? (card?.image ? imageUrl(card.image) : undefined) : card?.[field],
      to: field === 'image' ? (next.image ? imageUrl(next.image) : undefined) : next[field],
    });
  }
  return { changed };
}

/** Public cards of a team (roadmap page). Small rows; a team has at most a few thousand. */
export async function cardsOfTeam(ctx: QueryCtx, teamId: Id<'teams'>) {
  const rows = await ctx.db
    .query('publicCards')
    .withIndex('by_team', (q) => q.eq('teamId', teamId))
    .take(5000);
  return rows.map((row) => ({ issueId: row.issueId, ...cardOut(row)! }));
}

/** Moving an issue to another team takes its card along. */
export async function moveCard(ctx: MutationCtx, issueId: Id<'issues'>, teamId: Id<'teams'>) {
  const card = await cardRow(ctx, issueId);
  if (card && card.teamId !== teamId) await ctx.db.patch('publicCards', card._id, { teamId });
}

/** Deleting an issue for good deletes its card and the image reference. */
export async function purgeCard(ctx: MutationCtx, issueId: Id<'issues'>, now: number) {
  const card = await cardRow(ctx, issueId);
  if (!card) return;
  await syncFileRefs(ctx, card._id, null, now);
  await ctx.db.delete('publicCards', card._id);
}

// ---------------------------------------------------------------- Settings

export interface RoadmapSettingsPatch {
  on?: boolean;
  /** null = no category group */
  categoryGroupId?: Id<'labelGroups'> | null;
  /** The full list of statuses with their own stage (replaces the stored one) */
  stages?: { stateId: Id<'workflowStates'>; stage: StageChoice }[];
  /** null or '' = cleared */
  title?: string | null;
  subtitle?: string | null;
  accent?: string | null;
}

function checkBrand(text: string, what: string, max: number): string | undefined {
  const s = text.replace(/\s+/g, ' ').trim();
  if (s.length > max) invalid(`${what} is too long (at most ${max} characters).`);
  return s || undefined;
}

/** Changes a team's roadmap settings; only the given fields. */
export async function updateRoadmapSettings(
  ctx: MutationCtx,
  _actor: Actor,
  args: { teamId: Id<'teams'> } & RoadmapSettingsPatch,
) {
  const team = await getTeam(ctx, args.teamId);
  if (team.wiki === 'only') invalid(`${team.key} is a knowledge-only team and has no issues for a roadmap.`);
  const current = team.roadmap ?? { on: false };
  const next: Doc<'teams'>['roadmap'] & object = { ...current };
  if (args.on !== undefined) next.on = args.on;
  if (args.categoryGroupId !== undefined) {
    if (args.categoryGroupId === null) delete next.categoryGroupId;
    else {
      const group = (await ctx.db.get('labelGroups', args.categoryGroupId)) ?? notFound('The label group');
      if (group.teamId && group.teamId !== team._id) invalid('The label group belongs to another team.');
      next.categoryGroupId = group._id;
    }
  }
  if (args.stages !== undefined) {
    if (args.stages.length > ROADMAP_LIMITS.stagesMax) invalid('Too many status mappings.');
    const states = await ctx.db
      .query('workflowStates')
      .withIndex('by_team', (q) => q.eq('teamId', team._id))
      .take(200);
    const seen = new Set<string>();
    for (const m of args.stages) {
      if (!states.some((s) => s._id === m.stateId)) invalid('A status of the mapping does not belong to the team.', { stateId: m.stateId });
      if (!(STAGE_CHOICES as readonly string[]).includes(m.stage)) invalid(`Unknown stage "${m.stage}".`);
      if (seen.has(m.stateId)) invalid('A status appears twice in the mapping.', { stateId: m.stateId });
      seen.add(m.stateId);
    }
    if (args.stages.length) next.stages = args.stages.map((m) => ({ stateId: m.stateId, stage: m.stage }));
    else delete next.stages;
  }
  for (const [field, what, max] of [
    ['title', 'The title', ROADMAP_LIMITS.brandTitleMax],
    ['subtitle', 'The subtitle', ROADMAP_LIMITS.brandSubtitleMax],
  ] as const) {
    const value = args[field];
    if (value === undefined) continue;
    const s = value === null ? undefined : checkBrand(value, what, max);
    if (s === undefined) delete next[field];
    else next[field] = s;
  }
  if (args.accent !== undefined) {
    if (args.accent === null || args.accent === '') delete next.accent;
    else if (!ACCENT_RE.test(args.accent)) invalid('The accent color must be a hex color like #b87333.');
    else next.accent = args.accent.toLowerCase();
  }
  await ctx.db.patch('teams', team._id, { roadmap: next, updatedAt: Date.now() });
  return { teamId: team._id };
}
