import { describe, expect, test } from 'vitest';
import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import type { Actor } from '../convex/lib/actor';
import { berlinDay, DAY_MS } from '../convex/lib/dates';
import { CHUNK_CHARS, plainText, searchChunks } from '../convex/lib/wikiText';
import { TRASH_DAYS } from '../convex/ops/issues';
import { appendArticleBodyCore, purgeArticleTrash, setArticleBodyCore } from '../convex/ops/wiki';
import { OWNER_KIND, WIKI } from '../convex/shared/constants';
import { expectCode, fixture, setup, type Client, type T } from './helpers';

// Knowledge base (wiki): page tree, versioned text with revisions, search, sources, topics, trash.

const IMG = (token: string) => `![image](http://127.0.0.1:3211/img/${token})`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);

async function wiki(owner: Client) {
  const f = await fixture(owner);
  await owner.mutation(api.teams.update, { teamId: f.orb, wiki: 'on' });
  return f;
}

async function page(owner: Client, teamId: Id<'teams'>, title: string, extra: { markdown?: string; parentId?: Id<'articles'> } = {}) {
  return (await owner.mutation(api.wiki.create, { teamId, title, ...extra })).articleId;
}

async function agentActor(t: T): Promise<Actor> {
  const agentId = await t.run(
    async (ctx) => await ctx.db.insert('agents', { name: 'Claude Code', keyHash: 'c'.repeat(64), keyPrefix: 'xlr8_ccccc', createdAt: 0 }),
  );
  return { kind: 'agent', agentId };
}

async function bodyOf(t: T, articleId: Id<'articles'>) {
  return await t.run(async (ctx) => await ctx.db.query('articleBodies').withIndex('by_article', (q) => q.eq('articleId', articleId)).unique());
}

async function revisionTexts(t: T, articleId: Id<'articles'>) {
  return await t.run(async (ctx) =>
    (await ctx.db.query('articleRevisions').withIndex('by_article', (q) => q.eq('articleId', articleId)).order('desc').collect()).map((r) => r.markdown),
  );
}

/** Writes text at a fixed time (the revision rule depends on time). */
async function write(t: T, actor: Actor, id: Id<'articles'>, markdown: string, now: number) {
  return await t.run(async (ctx) => {
    const body = await ctx.db.query('articleBodies').withIndex('by_article', (q) => q.eq('articleId', id)).unique();
    return await setArticleBodyCore(ctx, actor, { id, markdown, baseVersion: body!.version }, now);
  });
}

async function registerImage(t: T, owner: Client) {
  const storageId = await t.run(async (ctx) => await ctx.storage.store(new Blob([PNG], { type: 'image/png' })));
  const { url } = await owner.action(api.files.register, { storageId });
  return url.split('/img/')[1]!;
}

async function fileOf(t: T, token: string) {
  return await t.run(async (ctx) => await ctx.db.query('files').withIndex('by_token', (q) => q.eq('token', token)).unique());
}

describe('Knowledge base on a team', () => {
  test('no pages without a knowledge base; turn on, turn off only without pages', async () => {
    const { owner } = setup();
    const f = await fixture(owner);
    await expectCode(owner.mutation(api.wiki.create, { teamId: f.orb, title: 'Home' }), 'invalid');
    await owner.mutation(api.teams.update, { teamId: f.orb, wiki: 'on' });
    expect((await owner.query(api.meta.get, {})).teams.find((x) => x._id === f.orb)?.wiki).toBe('on');
    const id = await page(owner, f.orb, 'Home');
    await expectCode(owner.mutation(api.teams.update, { teamId: f.orb, wiki: null }), 'invalid');
    await owner.mutation(api.wiki.remove, { id });
    await owner.mutation(api.teams.update, { teamId: f.orb, wiki: null });
    expect((await owner.query(api.meta.get, {})).teams.find((x) => x._id === f.orb)?.wiki).toBeUndefined();
  });

  test('list and detail: path, subpages, empty text has version 1', async () => {
    const { owner } = setup();
    const f = await wiki(owner);
    const root = await page(owner, f.orb, '  Law  ');
    const child = await page(owner, f.orb, 'Constitution', { parentId: root, markdown: '# GG' });
    const list = await owner.query(api.wiki.list, { teamId: f.orb });
    expect(list.articles.map((a) => a.title)).toEqual(['Law', 'Constitution']);
    expect(list.truncated).toBe(false);
    const detail = (await owner.query(api.wiki.get, { id: child }))!;
    expect(detail.path).toEqual([{ id: root, title: 'Law' }]);
    expect(detail.body).toMatchObject({ markdown: '# GG', version: 1 });
    expect(detail.team).toMatchObject({ key: 'ORB', wiki: 'on' });
    expect((await owner.query(api.wiki.get, { id: root }))!.children.map((c) => c.id)).toEqual([child]);
    expect(await owner.query(api.wiki.get, { id: 'broken' })).toBeNull();
  });

  test('idempotency: the same requestId creates only one page', async () => {
    const { t, owner } = setup();
    const f = await wiki(owner);
    const a = await owner.mutation(api.wiki.create, { teamId: f.orb, title: 'Once', requestId: 'r-1' });
    const b = await owner.mutation(api.wiki.create, { teamId: f.orb, title: 'Once', requestId: 'r-1' });
    expect(b).toEqual(a);
    expect(await t.run(async (ctx) => (await ctx.db.query('articles').collect()).length)).toBe(1);
    await expectCode(owner.mutation(api.wiki.create, { teamId: f.orb, title: 'Different', requestId: 'r-1' }), 'invalid');
  });
});

describe('Text and revisions', () => {
  test('baseVersion: wrong version → conflict; identical text is no change', async () => {
    const { owner } = setup();
    const f = await wiki(owner);
    const id = await page(owner, f.orb, 'Notes', { markdown: 'one' });
    expect(await owner.mutation(api.wiki.setBody, { id, markdown: 'two', baseVersion: 1 })).toEqual({ version: 2, changed: true });
    const data = await expectCode(owner.mutation(api.wiki.setBody, { id, markdown: 'three', baseVersion: 1 }), 'conflict');
    expect(data).toMatchObject({ version: 2, updatedBy: { kind: OWNER_KIND } });
    expect(await owner.mutation(api.wiki.setBody, { id, markdown: 'two', baseVersion: 2 })).toEqual({ version: 2, changed: false });
    await expectCode(owner.mutation(api.wiki.setBody, { id, markdown: 'x'.repeat(WIKI.articleMax + 1), baseVersion: 2 }), 'invalid');
  });

  test('revision before overwrite: first change, after 10 minutes, different actor, agent', async () => {
    const { t, owner } = setup();
    const f = await wiki(owner);
    const agent = await agentActor(t);
    const me: Actor = { kind: OWNER_KIND };
    const id = await page(owner, f.orb, 'History', { markdown: 'A' });
    const t0 = Date.now() - 60 * 60 * 1000; // in the past: the restore below is the latest change
    await write(t, me, id, 'B', t0); // no revision yet → A
    await write(t, me, id, 'C', t0 + 1000); // same session → none
    await write(t, me, id, 'D', t0 + WIKI.revisionGapMs + 2000); // 10 minutes later → C
    await write(t, agent, id, 'E', t0 + WIKI.revisionGapMs + 3000); // agent → D
    await write(t, me, id, 'F', t0 + WIKI.revisionGapMs + 4000); // different actor than last time → E
    expect(await revisionTexts(t, id)).toEqual(['E', 'D', 'C', 'A']);
    expect((await bodyOf(t, id))!.revisionCount).toBe(4);

    // Restoring writes a new version and saves the current text first.
    const page1 = await owner.query(api.wiki.revisions, { articleId: id });
    const a = page1.revisions.at(-1)!;
    expect(a).toMatchObject({ preview: 'A', version: 1, actor: { kind: OWNER_KIND }, chars: 1 });
    const body = (await bodyOf(t, id))!;
    await expectCode(owner.mutation(api.wiki.restoreRevision, { revisionId: a.id, baseVersion: body.version - 1 }), 'conflict');
    const restored = await owner.mutation(api.wiki.restoreRevision, { revisionId: a.id, baseVersion: body.version });
    expect(restored).toEqual({ version: body.version + 1, changed: true });
    expect((await bodyOf(t, id))!.markdown).toBe('A');
    expect((await revisionTexts(t, id))[0]).toBe('F');
    expect((await owner.query(api.wiki.revision, { revisionId: a.id }))?.markdown).toBe('A');
  });

  test(`at most ${WIKI.revisionsMax} revisions, the oldest is dropped`, async () => {
    const { t, owner } = setup();
    const f = await wiki(owner);
    const agent = await agentActor(t);
    const id = await page(owner, f.orb, 'Many', { markdown: 'v0' });
    for (let i = 1; i <= WIKI.revisionsMax + 3; i++) await write(t, agent, id, `v${i}`, Date.now() + i);
    const texts = await revisionTexts(t, id);
    expect(texts).toHaveLength(WIKI.revisionsMax);
    expect(texts.at(-1)).toBe('v3');
    expect((await bodyOf(t, id))!.revisionCount).toBe(WIKI.revisionsMax);
    // Paginated reads
    const first = await owner.query(api.wiki.revisions, { articleId: id });
    expect(first.revisions).toHaveLength(20);
    expect(first.hasMore).toBe(true);
    const second = await owner.query(api.wiki.revisions, { articleId: id, before: first.revisions.at(-1)!.savedAt });
    expect(second.revisions[0]!.preview).toBe(`v${WIKI.revisionsMax + 3 - 21}`);
  });

  test('append without version; the page row changes at most once per minute', async () => {
    const { t, owner } = setup();
    const f = await wiki(owner);
    const me: Actor = { kind: OWNER_KIND };
    const id = await page(owner, f.orb, 'Collection', { markdown: 'First point\n\n' });
    const created = (await t.run(async (ctx) => await ctx.db.get('articles', id)))!.updatedAt;
    await t.run(async (ctx) => await appendArticleBodyCore(ctx, me, { id, markdown: ' Second point ' }, created + 1000));
    expect((await bodyOf(t, id))!.markdown).toBe('First point\n\nSecond point\n');
    expect((await t.run(async (ctx) => await ctx.db.get('articles', id)))!.updatedAt).toBe(created);
    await write(t, me, id, 'New', created + WIKI.touchGapMs + 1);
    expect((await t.run(async (ctx) => await ctx.db.get('articles', id)))!.updatedAt).toBe(created + WIKI.touchGapMs + 1);
  });

  test('images: text and revisions keep the file; purged → file orphaned', async () => {
    const { t, owner } = setup();
    const f = await wiki(owner);
    const token = await registerImage(t, owner);
    const id = await page(owner, f.orb, 'With image', { markdown: `Before\n\n${IMG(token)}` });
    expect((await fileOf(t, token))?.deleteAfter).toBeUndefined();
    await owner.mutation(api.wiki.setBody, { id, markdown: 'No image', baseVersion: 1 });
    // The first revision keeps the old text with the image.
    expect((await fileOf(t, token))?.deleteAfter).toBeUndefined();
    await owner.mutation(api.wiki.remove, { id });
    const later = Date.now() + (TRASH_DAYS + 1) * DAY_MS;
    expect(await t.run(async (ctx) => await purgeArticleTrash(ctx, later))).toEqual({ purged: 1, more: false });
    expect((await fileOf(t, token))?.deleteAfter).toBeGreaterThan(0);
    expect(await t.run(async (ctx) => (await ctx.db.query('fileRefs').collect()).length)).toBe(0);
  });
});

describe('Search', () => {
  test('chunks: no URLs, split at headings and paragraphs, none too long', () => {
    expect(plainText('See [report](https://example.org/a) and https://example.org/b plus ![map](/img/x)')).toBe('See report and plus map');
    const para = 'word '.repeat(300).trim(); // 1499 characters
    const chunks = searchChunks([para, para, '# New chapter', para, 'x'.repeat(9000)].join('\n\n'));
    expect(chunks.every((c) => c.length <= CHUNK_CHARS)).toBe(true);
    expect(chunks[1]!.startsWith('# New chapter')).toBe(true);
    expect(chunks.join('').replace(/\s/g, '').length).toBe((para.repeat(3) + '#Newchapter' + 'x'.repeat(9000)).replace(/\s/g, '').length);
    expect(searchChunks('')).toEqual([]);
  });

  test('finds titles and text far down a page, filters by team, skips the trash', async () => {
    const { t, owner } = setup();
    const f = await wiki(owner);
    await owner.mutation(api.teams.update, { teamId: f.nova, wiki: 'on' });
    const filler = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${'placeholder '.repeat(60)}`).join('\n\n');
    const long = await page(owner, f.orb, 'Long report', { markdown: `${filler}\n\nAt the very end: Crosswalk.` });
    const titled = await page(owner, f.nova, 'Crosswalk in Nova');
    const gone = await page(owner, f.orb, 'Crosswalk old');
    await owner.mutation(api.wiki.remove, { id: gone });
    const chunks = await t.run(async (ctx) => await ctx.db.query('articleSearch').withIndex('by_article', (q) => q.eq('articleId', long)).collect());
    expect(chunks.length).toBeGreaterThan(3);

    const all = await owner.query(api.wiki.search, { q: 'crosswalk' });
    expect(all.map((h) => h.id).sort()).toEqual([long, titled].sort());
    expect(all.find((h) => h.id === long)).toMatchObject({ match: 'text', snippet: expect.stringContaining('Crosswalk') });
    expect(all.find((h) => h.id === titled)).toMatchObject({ match: 'title' });
    expect((await owner.query(api.wiki.search, { q: 'crosswalk', teamId: f.orb })).map((h) => h.id)).toEqual([long]);
    expect(await owner.query(api.wiki.search, { q: '   ' })).toEqual([]);

    // Shortening: surplus chunks disappear, search follows the new text.
    await owner.mutation(api.wiki.setBody, { id: long, markdown: 'Short text now', baseVersion: 1 });
    const after = await t.run(async (ctx) => await ctx.db.query('articleSearch').withIndex('by_article', (q) => q.eq('articleId', long)).collect());
    expect(after.map((c) => c.text)).toEqual(['Short text now']);
    expect((await owner.query(api.wiki.search, { q: 'crosswalk' })).map((h) => h.id)).toEqual([titled]);
  });

  test('appending changes only the last chunk', async () => {
    const { t, owner } = setup();
    const f = await wiki(owner);
    const para = 'text '.repeat(700).trim();
    const id = await page(owner, f.orb, 'Growing', { markdown: [para, para, para].join('\n\n') });
    const before = await t.run(async (ctx) => await ctx.db.query('articleSearch').withIndex('by_article', (q) => q.eq('articleId', id)).collect());
    await t.run(async (ctx) => await appendArticleBodyCore(ctx, { kind: OWNER_KIND }, { id, markdown: 'Addendum' }, Date.now()));
    const after = await t.run(async (ctx) => await ctx.db.query('articleSearch').withIndex('by_article', (q) => q.eq('articleId', id)).collect());
    expect(after.slice(0, -1)).toEqual(before.slice(0, -1));
    expect(after.at(-1)!.text.endsWith('Addendum')).toBe(true);
  });
});

describe('Tree', () => {
  test('reparent, reorder, no cycles, no other team', async () => {
    const { owner } = setup();
    const f = await wiki(owner);
    await owner.mutation(api.teams.update, { teamId: f.nova, wiki: 'on' });
    const a = await page(owner, f.orb, 'A');
    const b = await page(owner, f.orb, 'B');
    const c = await page(owner, f.orb, 'C');
    const foreign = await page(owner, f.nova, 'Foreign');
    const order = async (parentId?: Id<'articles'>) =>
      (await owner.query(api.wiki.list, { teamId: f.orb })).articles
        .filter((x) => x.parentId === parentId)
        .sort((x, y) => (x.rank < y.rank ? -1 : 1))
        .map((x) => x.title);
    expect(await order()).toEqual(['A', 'B', 'C']);
    await owner.mutation(api.wiki.move, { id: c, parentId: null, afterId: a });
    expect(await order()).toEqual(['C', 'A', 'B']);
    await owner.mutation(api.wiki.move, { id: c, parentId: null, beforeId: a });
    expect(await order()).toEqual(['A', 'C', 'B']);
    await owner.mutation(api.wiki.move, { id: b, parentId: a });
    await owner.mutation(api.wiki.move, { id: c, parentId: a, beforeId: b });
    expect(await order(a)).toEqual(['B', 'C']);
    await owner.mutation(api.wiki.move, { id: c, parentId: null });
    expect(await order()).toEqual(['A', 'C']);
    await expectCode(owner.mutation(api.wiki.move, { id: a, parentId: b }), 'invalid'); // b is under a
    await expectCode(owner.mutation(api.wiki.move, { id: a, parentId: a }), 'invalid');
    await expectCode(owner.mutation(api.wiki.move, { id: a, parentId: foreign }), 'invalid');
    await expectCode(owner.mutation(api.wiki.move, { id: c, parentId: null, beforeId: b }), 'invalid'); // b is not on that level
  });

  test(`at most ${WIKI.depthMax} levels`, async () => {
    const { owner } = setup();
    const f = await wiki(owner);
    let parentId: Id<'articles'> | undefined;
    for (let i = 1; i <= WIKI.depthMax; i++) parentId = await page(owner, f.orb, `Level ${i}`, { parentId });
    await expectCode(owner.mutation(api.wiki.create, { teamId: f.orb, title: 'Too deep', parentId }), 'invalid');
    // Moving takes the subpages along: a branch with 2 levels does not fit under level 19.
    const branch = await page(owner, f.orb, 'Branch');
    await page(owner, f.orb, 'Branch child', { parentId: branch });
    const level19 = (await owner.query(api.wiki.get, { id: parentId! }))!.path.at(-1)!.id;
    await expectCode(owner.mutation(api.wiki.move, { id: branch, parentId: level19 }), 'invalid');
    const level18 = (await owner.query(api.wiki.get, { id: level19 }))!.path.at(-1)!.id;
    await owner.mutation(api.wiki.move, { id: branch, parentId: level18 });
  });

  test('project and topics: same team only, archived ones only if already set', async () => {
    const { owner } = setup();
    const f = await wiki(owner);
    const id = await page(owner, f.orb, 'Docs');
    const { topicId } = await owner.mutation(api.wiki.createTopic, { teamId: f.orb, name: 'Elections' });
    await expectCode(owner.mutation(api.wiki.createTopic, { teamId: f.orb, name: ' elections ' }), 'invalid');
    await expectCode(owner.mutation(api.wiki.createTopic, { teamId: f.nova, name: 'Nova' }), 'invalid'); // no knowledge base
    expect(await owner.mutation(api.wiki.update, { id, projectId: f.orbProject, topicIds: [topicId, topicId] })).toMatchObject({ changed: true });
    expect(await owner.mutation(api.wiki.update, { id, projectId: f.orbProject })).toMatchObject({ changed: false });
    await expectCode(owner.mutation(api.wiki.update, { id, projectId: f.novaProject }), 'invalid');
    await owner.mutation(api.wiki.updateTopic, { topicId, archived: true });
    await owner.mutation(api.wiki.update, { id, title: 'Docs 2', topicIds: [topicId] }); // already set: allowed
    const other = await page(owner, f.orb, 'Other');
    await expectCode(owner.mutation(api.wiki.update, { id: other, topicIds: [topicId] }), 'invalid');
    const list = await owner.query(api.wiki.list, { teamId: f.orb });
    expect(list.articles.find((a) => a._id === id)).toMatchObject({ title: 'Docs 2', projectId: f.orbProject, topicIds: [topicId] });
    expect(list.topics).toMatchObject([{ name: 'Elections', archived: true }]);
    await owner.mutation(api.wiki.update, { id, projectId: null });
    expect((await owner.query(api.wiki.list, { teamId: f.orb })).articles.find((a) => a._id === id)?.projectId).toBeUndefined();
  });
});

describe('Trash', () => {
  test('subtree goes and comes back together; earlier deletions stay in the trash', async () => {
    const { owner } = setup();
    const f = await wiki(owner);
    const root = await page(owner, f.orb, 'Root');
    const child = await page(owner, f.orb, 'Child', { parentId: root });
    const grandchild = await page(owner, f.orb, 'Grandchild', { parentId: child });
    const early = await page(owner, f.orb, 'Deleted earlier', { parentId: root });
    await owner.mutation(api.wiki.remove, { id: early });
    expect(await owner.mutation(api.wiki.remove, { id: root })).toMatchObject({ removed: 3 });
    expect((await owner.query(api.wiki.list, { teamId: f.orb })).articles).toEqual([]);
    const trash = await owner.query(api.wiki.trash, { teamId: f.orb });
    expect(trash.map((x) => [x.title, x.pages])).toEqual([
      ['Root', 3],
      ['Deleted earlier', 1],
    ]);
    await expectCode(owner.mutation(api.wiki.setBody, { id: child, markdown: 'x', baseVersion: 1 }), 'invalid');
    expect(await owner.mutation(api.wiki.restore, { id: root })).toMatchObject({ restored: 3, movedToTop: false });
    expect((await owner.query(api.wiki.list, { teamId: f.orb })).articles.map((a) => a._id).sort()).toEqual([root, child, grandchild].sort());
    // Child deleted alone, then the root: restoring the child → top level.
    await owner.mutation(api.wiki.remove, { id: child });
    await owner.mutation(api.wiki.remove, { id: root });
    expect(await owner.mutation(api.wiki.restore, { id: child })).toMatchObject({ restored: 2, movedToTop: true });
    const detail = (await owner.query(api.wiki.get, { id: child }))!;
    expect(detail.article.parentId).toBeUndefined();
    expect(detail.children.map((c) => c.id)).toEqual([grandchild]);
  });

  test('only the owner deletes; purged after 30 days with tombstone, Linear link marked', async () => {
    const { t, owner } = setup();
    const f = await wiki(owner);
    const agent = await agentActor(t);
    const root = await page(owner, f.orb, 'Old', { markdown: 'one' });
    const child = await page(owner, f.orb, 'Subpage', { parentId: root });
    await owner.mutation(api.wiki.addSources, { articleId: root, sources: [{ url: 'https://example.org' }] });
    await owner.mutation(api.wiki.setBody, { id: root, markdown: 'two', baseVersion: 1 });
    await t.run(async (ctx) => await ctx.db.insert('linearLinks', { kind: 'document', linearId: 'lin-1', localId: root }));
    await expectCode(
      t.run(async (ctx) => {
        const { removeArticle } = await import('../convex/ops/wiki');
        return await removeArticle(ctx, agent, { id: root });
      }),
      'access_denied',
    );
    await owner.mutation(api.wiki.remove, { id: root });
    const now = Date.now();
    expect(await t.run(async (ctx) => await purgeArticleTrash(ctx, now + (TRASH_DAYS - 1) * DAY_MS))).toEqual({ purged: 0, more: false });
    expect(await t.run(async (ctx) => await purgeArticleTrash(ctx, now + (TRASH_DAYS + 1) * DAY_MS))).toEqual({ purged: 2, more: false });
    const left = await t.run(async (ctx) => ({
      articles: (await ctx.db.query('articles').collect()).length,
      bodies: (await ctx.db.query('articleBodies').collect()).length,
      search: (await ctx.db.query('articleSearch').collect()).length,
      revisions: (await ctx.db.query('articleRevisions').collect()).length,
      sources: (await ctx.db.query('articleSources').collect()).length,
      tombstones: (await ctx.db.query('articleTombstones').collect()).map((x) => x.articleId).sort(),
      link: (await ctx.db.query('linearLinks').collect())[0]!.purgedAt,
    }));
    expect(left).toMatchObject({ articles: 0, bodies: 0, search: 0, revisions: 0, sources: 0, tombstones: [root, child].sort() });
    expect(left.link).toBeGreaterThan(0);
  });

  test('the cron empties issues and pages', async () => {
    const { t, owner } = setup();
    const f = await wiki(owner);
    const id = await page(owner, f.orb, 'Gone');
    await owner.mutation(api.wiki.remove, { id });
    await t.run(async (ctx) => await ctx.db.patch('articles', id, { deletedAt: Date.now() - (TRASH_DAYS + 1) * DAY_MS }));
    expect(await t.mutation(internal.maintenance.purgeTrash, {})).toMatchObject({ articles: 1, more: false });
  });
});

describe('Sources', () => {
  test('validate, create, update, reorder, remove', async () => {
    const { owner } = setup();
    const f = await wiki(owner);
    const id = await owner.mutation(api.wiki.create, {
      teamId: f.orb,
      title: 'With sources',
      sources: [{ url: 'https://example.org/a', title: 'Report A', publishedAt: '2026-03' }],
    });
    const articleId = id.articleId;
    await expectCode(owner.mutation(api.wiki.addSources, { articleId, sources: [{ url: 'ftp://x' }] }), 'invalid');
    await expectCode(owner.mutation(api.wiki.addSources, { articleId, sources: [{ author: 'Author only' }] }), 'invalid');
    await expectCode(owner.mutation(api.wiki.addSources, { articleId, sources: [{ title: 'T', publishedAt: '2026-13' }] }), 'invalid');
    await expectCode(owner.mutation(api.wiki.addSources, { articleId, sources: [{ title: 'T', accessedAt: '2026-02-30' }] }), 'invalid');
    const { sourceIds } = await owner.mutation(api.wiki.addSources, {
      articleId,
      sources: [{ title: 'Book B', author: ' Doe ', publishedAt: '2024' }, { url: 'http://example.org/c', accessedAt: '2026-10-01', note: 'Note' }],
    });
    const sources = async () => (await owner.query(api.wiki.get, { id: articleId }))!.sources;
    expect((await sources()).map((s) => [s.title ?? s.url, s.order])).toEqual([
      ['Report A', 0],
      ['Book B', 1],
      ['http://example.org/c', 2],
    ]);
    expect((await sources())[0]!.accessedAt).toBe(berlinDay(Date.now()));
    expect((await sources())[1]!.author).toBe('Doe');
    expect(await owner.mutation(api.wiki.updateSource, { sourceId: sourceIds[1]!, patch: { note: null, title: 'Page C' } })).toMatchObject({ changed: true });
    expect(await owner.mutation(api.wiki.updateSource, { sourceId: sourceIds[1]!, patch: { title: 'Page C' } })).toMatchObject({ changed: false });
    await expectCode(owner.mutation(api.wiki.updateSource, { sourceId: sourceIds[0]!, patch: { title: null } }), 'invalid');
    await owner.mutation(api.wiki.reorderSources, { articleId, sourceIds: [sourceIds[1]!] });
    expect((await sources()).map((s) => s.title)).toEqual(['Page C', 'Report A', 'Book B']);
    expect((await sources())[0]!.note).toBeUndefined();
    await owner.mutation(api.wiki.removeSource, { sourceId: sourceIds[0]! });
    expect((await sources()).map((s) => s.title)).toEqual(['Page C', 'Report A']);
    await expectCode(
      owner.mutation(api.wiki.addSources, { articleId, sources: Array.from({ length: WIKI.sourcesMax - 1 }, (_, i) => ({ title: `Q${i}` })) }),
      'invalid',
    );
  });
});

describe('Removing the test team', () => {
  test('removes pages, topics and revisions', async () => {
    const { t, owner } = setup();
    await fixture(owner);
    const { teamId } = await owner.mutation(api.teams.create, { key: 'TEST', name: 'Test Team' });
    await owner.mutation(api.teams.update, { teamId, wiki: 'on' });
    const id = await page(owner, teamId, 'Test page', { markdown: 'a' });
    await owner.mutation(api.wiki.setBody, { id, markdown: 'b', baseVersion: 1 });
    await owner.mutation(api.wiki.createTopic, { teamId, name: 'Topic' });
    const list = await t.mutation(internal.migrations.removeTestTeam, { teamKey: 'TEST' });
    expect(list).toMatchObject({ articles: 1, topics: 1 });
    await t.mutation(internal.migrations.removeTestTeam, { teamKey: 'TEST', apply: true });
    const left = await t.run(async (ctx) => ({
      articles: (await ctx.db.query('articles').collect()).length,
      revisions: (await ctx.db.query('articleRevisions').collect()).length,
      topics: (await ctx.db.query('wikiTopics').collect()).length,
      tombstones: (await ctx.db.query('articleTombstones').collect()).length,
    }));
    expect(left).toEqual({ articles: 0, revisions: 0, topics: 0, tombstones: 0 });
  });
});

describe('Linear import', () => {
  const doc = {
    linearId: '00000000-1111-4222-8333-444444444444',
    teamKey: 'orb',
    projectName: 'Orbit · Search',
    title: 'Test document',
    markdown: '## Section\n\nTest text\n',
    createdAt: Date.parse('2026-09-01T08:00:00Z'),
    updatedAt: Date.parse('2026-09-02T09:00:00Z'),
    sources: [{ url: 'https://linear.app/test/document/x', title: 'Linear document (original)', accessedAt: '2026-10-11' }],
  };

  test('run twice: one page, knowledge base turned on, timestamps and source kept', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    await expectCode(t.mutation(internal.importer.importArticle, doc), 'invalid'); // without enableWiki
    const first = await t.mutation(internal.importer.importArticle, { ...doc, enableWiki: true });
    expect(first).toMatchObject({ result: 'created', enabledWiki: true });
    const second = await t.mutation(internal.importer.importArticle, { ...doc, enableWiki: true });
    expect(second).toEqual({ result: 'unchanged', articleId: first.articleId, enabledWiki: false });
    const detail = (await owner.query(api.wiki.get, { id: first.articleId }))!;
    expect(detail.article).toMatchObject({
      teamId: f.orb,
      projectId: f.orbProject,
      title: 'Test document',
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      createdBy: { kind: 'import' },
    });
    expect(detail.body).toMatchObject({ markdown: doc.markdown, version: 1, updatedAt: doc.updatedAt });
    expect(detail.sources).toMatchObject([{ url: doc.sources[0]!.url, accessedAt: '2026-10-11' }]);
    expect(await t.run(async (ctx) => (await ctx.db.query('articles').collect()).length)).toBe(1);

    // Changed copy: new version, old text as a revision.
    const third = await t.mutation(internal.importer.importArticle, { ...doc, markdown: 'New\n', enableWiki: true });
    expect(third).toMatchObject({ result: 'updated', articleId: first.articleId });
    expect(await revisionTexts(t, first.articleId as Id<'articles'>)).toEqual([doc.markdown]);
    // A page in the trash stays there.
    await owner.mutation(api.wiki.remove, { id: first.articleId as Id<'articles'> });
    expect(await t.mutation(internal.importer.importArticle, { ...doc, enableWiki: true })).toMatchObject({ result: 'in_trash' });
  });

  test('the project must exist exactly once in the team', async () => {
    const { t, owner } = setup();
    await fixture(owner);
    await expectCode(t.mutation(internal.importer.importArticle, { ...doc, projectName: 'Nova · Sync', enableWiki: true }), 'invalid');
  });
});
