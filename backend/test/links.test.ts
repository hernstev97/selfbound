import { describe, expect, test } from 'vitest';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { DAY_MS } from '../convex/lib/dates';
import { purgeTrash, TRASH_DAYS } from '../convex/ops/issues';
import { purgeArticleTrash } from '../convex/ops/wiki';
import { articleIdsIn, issueRefsIn } from '../convex/shared/links';
import { createOne, fixture, setup, type Client } from './helpers';

// References between knowledge pages and issues: detection in text, maintenance on every
// write path, "Mentioned in" and the knowledge section on the issue.

const URL = (id: string) => `http://127.0.0.1:5412/wiki/${id}`;

async function wiki(owner: Client) {
  const f = await fixture(owner);
  await owner.mutation(api.teams.update, { teamId: f.orb, wiki: 'on' });
  return f;
}

describe('Detection', () => {
  test('page links, issue links and bare identifiers of known teams only, not in code', () => {
    const id = 'jx7555q8kwtdbcdy58rtr1bs818g3rxq';
    expect(articleIdsIn(`See [page](${URL(id)}) and /wissen/${id} again (older path), /wiki/short`)).toEqual([id]);
    expect(articleIdsIn(`Only the older path: /wissen/${id}`)).toEqual([id]);
    expect(articleIdsIn('no link')).toEqual([]);
    const keys = new Set(['ORB', 'KIU']);
    const text = 'See ORB-12, (KIU-3) and /issue/nova-7. Not: UTF-8, ISO-9001, ORB-0, xORB-5, ORB-5x, `ORB-9`, ```\nKIU-4\n```, ORB-12';
    expect(issueRefsIn(text, keys)).toEqual(['NOVA-7', 'ORB-12', 'KIU-3']);
    expect(issueRefsIn('ORB-1', new Set())).toEqual([]);
  });
});

describe('Maintenance and queries', () => {
  test('description and comment link a page; the page mentions an issue', async () => {
    const { owner } = setup();
    const f = await wiki(owner);
    const { articleId: page } = await owner.mutation(api.wiki.create, { teamId: f.orb, title: 'Process' });
    const { articleId: other } = await owner.mutation(api.wiki.create, { teamId: f.orb, title: 'Glossary', markdown: `See [Process](${URL(page)})` });
    const a = await createOne(owner, f.orb, { description: `Docs: [Process](${URL(page)})` });
    const b = await createOne(owner, f.nova);
    await owner.mutation(api.comments.add, { issueId: b.id, body: `Background in ${URL(page)}` });

    const links = await owner.query(api.wiki.backlinks, { articleId: page });
    expect(links.issues.map((i) => i.identifier).sort()).toEqual([a.identifier, b.identifier].sort());
    expect(links.pages).toEqual([{ id: other, title: 'Glossary' }]);
    expect(await owner.query(api.wiki.forIssue, { issueId: a.id })).toMatchObject([{ id: page, title: 'Process', via: 'linked' }]);

    // The page mentions the issue by bare identifier: listed under "mentioned" on the issue.
    await owner.mutation(api.wiki.setBody, { id: page, markdown: `Affects ${b.identifier} and UTF-8.`, baseVersion: 1 });
    expect((await owner.query(api.wiki.backlinks, { articleId: page })).mentions.map((i) => i.identifier)).toEqual([b.identifier]);
    expect(await owner.query(api.wiki.forIssue, { issueId: b.id })).toMatchObject([{ id: page, via: 'linked' }]);

    // Link removed → reference gone; comment removed → reference gone.
    await owner.mutation(api.issues.setDescription, { id: a.id, markdown: 'no link', baseVersion: 1 });
    expect(await owner.query(api.wiki.forIssue, { issueId: a.id })).toEqual([]);
    const detail = await owner.query(api.issues.detail, { id: b.id });
    await owner.mutation(api.comments.remove, { commentId: detail!.comments[0]!._id });
    expect(await owner.query(api.wiki.forIssue, { issueId: b.id })).toMatchObject([{ id: page, via: 'mentions' }]);
  });

  test('trash hides; permanent deletion cleans up the references', async () => {
    const { t, owner } = setup();
    const f = await wiki(owner);
    const { articleId: page } = await owner.mutation(api.wiki.create, { teamId: f.orb, title: 'Gone' });
    const issue = await createOne(owner, f.orb, { description: `[Gone](${URL(page)})` });
    await owner.mutation(api.wiki.setBody, { id: page, markdown: issue.identifier, baseVersion: 1 });
    await owner.mutation(api.wiki.remove, { id: page });
    expect(await owner.query(api.wiki.forIssue, { issueId: issue.id })).toEqual([]);
    const later = Date.now() + (TRASH_DAYS + 1) * DAY_MS;
    await t.run(async (ctx) => await purgeArticleTrash(ctx, later));
    expect(await t.run(async (ctx) => (await ctx.db.query('articleLinks').collect()).length)).toBe(0);

    // Issue permanently deleted: its references and those pointing to it disappear.
    const { articleId: keep } = await owner.mutation(api.wiki.create, { teamId: f.orb, title: 'Stays', markdown: `About ${issue.identifier}` });
    await owner.mutation(api.issues.setDescription, { id: issue.id, markdown: URL(keep), baseVersion: 1 });
    expect(await t.run(async (ctx) => (await ctx.db.query('articleLinks').collect()).length)).toBe(2);
    await owner.mutation(api.issues.remove, { ids: [issue.id] });
    await t.run(async (ctx) => await purgeTrash(ctx, later));
    expect(await t.run(async (ctx) => (await ctx.db.query('articleLinks').collect()).length)).toBe(0);
    expect((await owner.query(api.wiki.backlinks, { articleId: keep as Id<'articles'> })).mentions).toEqual([]);
  });
});
