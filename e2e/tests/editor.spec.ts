// Rich text editor: editing directly in the formatted text, real typing (keyboard.type).
// The storage format stays Markdown; opening and saving without a change changes nothing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { api, backend, expectMarkdown, markdownOf, open, settled } from '../support/helpers.ts';
import { root } from '../support/env.ts';

/** Created issues; moved to the trash after each test (otherwise they push other teams out of the list in later tests). */
const created: string[] = [];

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
  if (created.length) await backend().mutation(api.issues.remove, { ids: created.splice(0) as never[] });
});

/** A fresh issue via the server, detail page open. */
async function freshIssue(page: Page, description = '') {
  const meta = await backend().query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  const title = `Editor ${Date.now()}`;
  const { issues } = await backend().mutation(api.issues.create, { issues: [{ teamId: team._id, title, description }] });
  created.push(issues[0].id);
  await open(page, `/issue/${issues[0].identifier}`);
  return { ...issues[0], title };
}

const body = async (id: string) => (await backend().query(api.issues.detail, { id: id as never }))!.body;

/** Clicks the description (empty: the placeholder); the editor has focus. */
async function edit(page: Page) {
  // Only once the description has loaded (before that a skeleton shows and clicks do nothing).
  await expect(page.getByTestId('detail-loading')).toHaveCount(0);
  await page.getByTestId('detail-description').click();
  const editor = page.getByTestId('desc-editor');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  return editor;
}

test('The editor loads on first edit (not when the detail opens)', async ({ page }) => {
  await freshIssue(page, 'Some text');
  const editorChunk = () => page.evaluate(() => performance.getEntriesByType('resource').some((e) => /RichEditor-[\w-]+\.js/.test(e.name)));
  expect(await editorChunk()).toBe(false);
  await edit(page);
  expect(await editorChunk()).toBe(true);
});

test('Markdown shortcuts while typing: #, -, 1., [ ], >, ```, ---', async ({ page }) => {
  const issue = await freshIssue(page);
  const editor = await edit(page);
  await page.keyboard.type('# Title\n');
  await page.keyboard.type('- Item\n\n');
  await page.keyboard.type('1. Number\n\n');
  await page.keyboard.type('[ ] Task\n\n');
  await page.keyboard.type('> Quote\n\n');
  await page.keyboard.type('```ts\nconst a = 1;\n\n');
  await page.keyboard.type('---');
  await page.keyboard.type('End with **bold** and `code`.');
  await expect(editor.locator('h1')).toHaveText('Title');
  await expect(editor.locator('ul > li').first()).toHaveText('Item');
  await expect(editor.locator('ol > li')).toHaveText('Number');
  await expect(editor.locator('li.task input[type="checkbox"]')).toHaveCount(1);
  await expect(editor.locator('blockquote')).toHaveText('Quote');
  await expect(editor.locator('pre[data-lang="ts"]')).toContainText('const a = 1;');
  // Syntax colors in the editor too
  await expect(editor.locator('pre .hljs-keyword').first()).toHaveText('const');
  await expect(editor.locator('hr')).toHaveCount(1);
  await expect(editor.locator('strong')).toHaveText('bold');
  const expected = '# Title\n\n- Item\n\n1. Number\n\n- [ ] Task\n\n> Quote\n\n```ts\nconst a = 1;\n```\n\n---\n\nEnd with **bold** and `code`.';
  await expectMarkdown(editor, expected);
  await expect.poll(async () => (await body(issue.id)).markdown, { timeout: 8000 }).toBe(expected);
});

test('Ctrl B / I / K, Ctrl Shift 7 / 8, Ctrl Z in the editor', async ({ page }) => {
  await freshIssue(page);
  const editor = await edit(page);
  await page.keyboard.type('bold');
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('Control+b');
  // At the end of bold text, typing continues in bold; Ctrl B turns it off.
  await page.keyboard.press('End');
  await page.keyboard.press('Control+b');
  await page.keyboard.type(' ');
  await page.keyboard.press('Control+i');
  await page.keyboard.type('italic');
  await page.keyboard.press('Control+i');
  await page.keyboard.type(' Link');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Control+k');
  const input = page.getByTestId('link-input');
  await expect(input).toBeFocused();
  await page.keyboard.type('https://example.com');
  await page.keyboard.press('Enter');
  await expect(editor).toBeFocused();
  await expectMarkdown(editor, '**bold** *italic* [Link](https://example.com)');
  // Lists by keyboard shortcut
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('first');
  await page.keyboard.press('Control+Shift+8');
  await expect(editor.locator('ul > li')).toHaveText('first');
  await page.waitForTimeout(700); // separate step in the undo history
  await page.keyboard.press('Control+Shift+7');
  await expect(editor.locator('ol > li')).toHaveText('first');
  await expectMarkdown(editor, '**bold** *italic* [Link](https://example.com)\n\n1. first');
  // Undo works on the text, not on issues
  await page.keyboard.press('Control+z');
  await expect(editor.locator('ul > li')).toHaveText('first');
});

test('"/" menu: insert a table and Tab through the cells; checklist', async ({ page }) => {
  await freshIssue(page);
  const editor = await edit(page);
  await page.keyboard.type('/tab');
  const menu = page.getByTestId('slash-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId('slash-item').first()).toHaveAttribute('data-id', 'table');
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(editor.locator('table tr')).toHaveCount(3);
  await page.keyboard.type('Case');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Expected');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Actual');
  await page.keyboard.press('Tab');
  await page.keyboard.type('A');
  await expectMarkdown(editor, '| Case | Expected | Actual |\n| --- | --- | --- |\n| A | | |\n| | | |');
  // After the table: a checklist from the menu
  await page.keyboard.press('Control+End');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('/check');
  await expect(menu.locator('.slash-item.active')).toHaveAttribute('data-id', 'task');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Get it done');
  await expect(editor.locator('li.task')).toHaveText('Get it done');
  // Esc closes only the menu, the editor stays
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(editor).toBeFocused();
});

test('Tasks are clickable in the editor; global shortcuts are off, Esc leaves the editor and saves', async ({ page }) => {
  const issue = await freshIssue(page, '- [ ] one\n- [ ] two');
  const editor = await edit(page);
  await editor.locator('li.task input').nth(1).click();
  await expect(editor.locator('li.task').nth(1)).toHaveClass(/done/);
  await expect(editor.locator('li.task input').nth(1)).toBeChecked();
  await expectMarkdown(editor, '- [ ] one\n- [x] two');
  // S, P, J and "/" are just letters here
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nspj c');
  await expect(page.getByTestId('palette')).toHaveCount(0);
  await expect(page.getByTestId('create-dialog')).toHaveCount(0);
  await expectMarkdown(editor, '- [ ] one\n- [x] two\n- [ ] spj c');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('desc-editor')).toHaveCount(0);
  await expect(page.getByTestId('detail-description')).toContainText('spj c');
  await expect.poll(async () => (await body(issue.id)).markdown).toBe('- [ ] one\n- [x] two\n- [ ] spj c');
});

test('Round trip: opening and closing real samples changes nothing; an edit changes only its paragraph', async ({ page }) => {
  const issue = await freshIssue(page, readFileSync(join(root, 'app/test/fixtures/markdown/agent-report.md'), 'utf8'));
  const before = await body(issue.id);
  const sample = before.markdown;
  const editor = await edit(page);
  await expect(editor.locator('table')).toBeVisible();
  await expect(editor.locator('li.task')).toHaveCount(3);
  // Type and delete again: same content
  await page.keyboard.type('xy');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await expectMarkdown(editor, sample);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('desc-editor')).toHaveCount(0);
  await settled(page);
  const after = await body(issue.id);
  expect(after.markdown).toBe(sample);
  expect(after.version).toBe(before.version);

  // An edit in the first heading: everything else stays byte for byte
  await page.getByTestId('detail-description').getByText('Summary', { exact: true }).click();
  await expect(page.getByTestId('desc-editor')).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.type(' new');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await body(issue.id)).markdown).toBe(sample.replace('## Summary', '## Summary new'));
});

test('Pasted Markdown is formatted; a URL pasted over a selection becomes a link', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await freshIssue(page);
  const editor = await edit(page);
  await page.evaluate(() => navigator.clipboard.writeText('## From the agent\n\n- [ ] Item'));
  await page.keyboard.press('Control+v');
  await expect(editor.locator('h2')).toHaveText('From the agent');
  await expect(editor.locator('li.task')).toHaveText('Item');
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Docs');
  await page.keyboard.press('Shift+Home');
  await page.evaluate(() => navigator.clipboard.writeText('https://docs.convex.dev'));
  await page.keyboard.press('Control+v');
  await expectMarkdown(editor, '## From the agent\n\n- [ ] Item\n\n[Docs](https://docs.convex.dev)');
});

test('Typing stays smooth with a 50 KB description', async ({ page }) => {
  const paragraph = 'A long paragraph with **bold**, `code` and a [link](https://example.com), so it looks like real text. ';
  const blocks: string[] = [];
  let size = 0;
  for (let i = 0; size < 50_000; i++) {
    const block = i % 7 === 3 ? `- Item ${i}\n- [ ] Task ${i}` : i % 11 === 5 ? '```ts\nconst x = ' + i + ';\n```' : `## Section ${i}\n\n${paragraph.repeat(3)}`;
    blocks.push(block);
    size += block.length + 2;
  }
  const markdown = blocks.join('\n\n');
  const issue = await freshIssue(page, markdown);
  await page.getByTestId('detail-description').getByText('Section 0', { exact: true }).click();
  const editor = page.getByTestId('desc-editor');
  await expect(editor).toBeFocused();
  await page.keyboard.press('End');
  // Count long tasks (> 50 ms) while typing
  await page.evaluate(() => {
    const w = window as unknown as { __long: number[] };
    w.__long = [];
    new PerformanceObserver((list) => list.getEntries().forEach((e) => w.__long.push(e.duration))).observe({ type: 'longtask' });
  });
  const text = ' typed quickly';
  const start = Date.now();
  await page.keyboard.type(text.repeat(5));
  const perKey = (Date.now() - start) / (text.length * 5);
  await page.waitForTimeout(300);
  const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
  test.info().annotations.push({ type: 'tempo', description: `${markdown.length} characters, ${perKey.toFixed(1)} ms per key (Playwright), longest task ${Math.max(0, ...long).toFixed(0)} ms` });
  expect(Math.max(0, ...long)).toBeLessThan(100);
  await expectMarkdown(editor, markdown.replace('## Section 0', `## Section 0${text.repeat(5)}`));
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await body(issue.id)).markdown.length).toBe(markdown.length + text.length * 5);
});

test('Comment editor: Ctrl Enter sends, a task in my own comment is clickable', async ({ page }) => {
  const issue = await freshIssue(page);
  const input = page.getByTestId('comment-input');
  await input.click();
  // A textarea first, the editor after it loads (takes over the focus)
  await expect(input).toHaveAttribute('contenteditable', 'true');
  await expect(input).toBeFocused();
  await page.keyboard.type('[ ] Please check');
  await expect(page.locator('[data-testid="comment-input"] li.task')).toHaveCount(1);
  await page.keyboard.press('Control+Enter');
  const comment = page.getByTestId('comment').filter({ hasText: 'Please check' });
  await expect(comment).toBeVisible();
  await expectMarkdown(input, '');
  await settled(page);
  await comment.getByTestId('task-box').click();
  await expect.poll(async () => (await backend().query(api.issues.detail, { id: issue.id as never }))!.comments.find((c) => c.body.includes('Please check'))?.body).toBe('- [x] Please check');
  // Edit in the editor
  await comment.hover();
  await comment.getByTestId('comment-edit').click();
  const editInput = page.getByTestId('comment-edit-input');
  await expect(editInput).toBeFocused();
  await expect(editInput.locator('li.task.done')).toHaveCount(1);
  await page.keyboard.type(' now');
  await page.keyboard.press('Control+Enter');
  await expect(comment).toContainText('Please check now');
  expect(await markdownOf(input)).toBe('');
});
