// Editor regressions: language picker and the way back to text on code blocks, table controls,
// no list checkbox in the detail view, task checkboxes vertically centered.
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { api, backend, expectMarkdown, focusedRow, open, settled } from '../support/helpers.ts';

const created: string[] = [];

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
  if (created.length) await backend().mutation(api.issues.remove, { ids: created.splice(0) as never[] });
});

async function freshIssue(page: Page, description = '') {
  const meta = await backend().query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  const title = `Bug ${Date.now()}`;
  const { issues } = await backend().mutation(api.issues.create, { issues: [{ teamId: team._id, title, description }] });
  created.push(issues[0].id);
  await open(page, `/issue/${issues[0].identifier}`);
  await expect(page.getByTestId('detail-loading')).toHaveCount(0);
  return issues[0];
}

const body = async (id: string) => (await backend().query(api.issues.detail, { id: id as never }))!.body.markdown;

/** Opens the editor by clicking the first paragraph. */
async function edit(page: Page) {
  await page.getByTestId('detail-description').locator('p').first().click();
  const editor = page.getByTestId('desc-editor');
  await expect(editor).toBeFocused();
  return editor;
}

async function shot(target: Locator | Page, testInfo: TestInfo, name: string) {
  const image = await target.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  await testInfo.attach(name, { body: image, contentType: 'image/png' });
}

test.describe('Codeblock', () => {
  test('Pick the language in the editor (with search); back to text via the picker, Backspace and "/"', async ({ page }, testInfo) => {
    const issue = await freshIssue(page, 'Before\n\n```ts\nconst a = 1;\nconst b = 2;\n```');
    const editor = await edit(page);
    const lang = editor.getByTestId('code-lang');
    await expect(lang).toHaveText('TypeScript');
    await editor.locator('pre').hover();
    await lang.click();
    const picker = page.getByTestId('lang-picker');
    await expect(picker).toBeVisible();
    await expect(page.getByTestId('lang-search')).toBeFocused();
    // The current language is marked
    await expect(picker.locator('.lang-item.active')).toHaveAttribute('data-id', 'typescript');
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await shot(page.getByTestId('desc-editor-wrap'), testInfo, `editor-language-picker-${scheme}`);
    }
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.keyboard.type('pyth');
    await expect(picker.locator('.lang-item.active')).toHaveAttribute('data-id', 'python');
    await page.keyboard.press('Enter');
    await expect(picker).toHaveCount(0);
    await expect(lang).toHaveText('Python');
    await expectMarkdown(editor, 'Before\n\n```python\nconst a = 1;\nconst b = 2;\n```');
    // Esc in the picker closes only the picker
    await lang.click();
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(page.getByTestId('desc-editor')).toBeVisible();

    // "Convert to text" in the picker: one paragraph per line
    await lang.click();
    await picker.locator('[data-id="to-text"]').click();
    await expect(editor.locator('pre')).toHaveCount(0);
    await expectMarkdown(editor, 'Before\n\nconst a = 1;\n\nconst b = 2;');
    // Undo brings the code block back
    await page.keyboard.press('Control+z');
    await expect(editor.locator('pre')).toHaveCount(1);

    // Backspace at the start of the code block: back to text
    await editor.locator('pre code').click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Home');
    await page.keyboard.press('Backspace');
    await expect(editor.locator('pre')).toHaveCount(0);
    await expectMarkdown(editor, 'Before\n\nconst a = 1;\n\nconst b = 2;');

    // Empty code block: "/" opens the menu, "Text" turns it back into a paragraph
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('```');
    await page.keyboard.press('Enter');
    await expect(editor.locator('pre')).toHaveCount(1);
    await page.keyboard.type('/text');
    await expect(page.getByTestId('slash-menu')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(editor.locator('pre')).toHaveCount(0);
    // In code with content, "/" stays a character
    await page.keyboard.type('```js');
    await page.keyboard.press('Enter');
    await page.keyboard.type('x // y');
    await expect(page.getByTestId('slash-menu')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect.poll(() => body(issue.id)).toBe('Before\n\nconst a = 1;\n\nconst b = 2;\n\n```js\nx // y\n```');
  });

  test('Pick the language in the rendered view without opening the editor', async ({ page }, testInfo) => {
    const issue = await freshIssue(page, '```\nselect 1;\n```\n\nText\n\n```ts\nlet a = 1;\n```');
    const description = page.getByTestId('detail-description');
    const blocks = description.locator('.codeblock');
    await expect(blocks).toHaveCount(2);
    await expect(blocks.nth(1).getByTestId('code-lang')).toHaveText('TypeScript');
    // Without a language: "Plain text" shows on hover
    await blocks.nth(0).hover();
    const plain = blocks.nth(0).getByTestId('code-lang');
    await expect(plain).toHaveText('Plain text');
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await blocks.nth(0).hover();
      await shot(description, testInfo, `view-code-block-${scheme}`);
    }
    await page.emulateMedia({ colorScheme: 'dark' });
    await plain.click();
    await expect(page.getByTestId('lang-picker')).toBeVisible();
    await expect(page.getByTestId('desc-editor')).toHaveCount(0);
    await page.keyboard.type('sql');
    await page.keyboard.press('Enter');
    await expect.poll(() => body(issue.id)).toBe('```sql\nselect 1;\n```\n\nText\n\n```ts\nlet a = 1;\n```');
    await expect(blocks.nth(0).getByTestId('code-lang')).toHaveText('SQL');
    await expect(blocks.nth(0).locator('.tk', { hasText: 'select' }).first()).toBeVisible();
    // Second block: choosing plain text removes the language
    await blocks.nth(1).getByTestId('code-lang').click();
    await page.getByTestId('lang-picker').locator('[data-id=""]').click();
    await expect.poll(() => body(issue.id)).toBe('```sql\nselect 1;\n```\n\nText\n\n```\nlet a = 1;\n```');
    await expect(page.getByTestId('desc-editor')).toHaveCount(0);
  });
});

test.describe('Tables', () => {
  const TABLE = '| Case | Expected |\n| --- | --- |\n| A | 1 |';

  test('Cell menu: insert, align and delete rows and columns', async ({ page }, testInfo) => {
    const issue = await freshIssue(page, TABLE);
    await page.getByTestId('detail-description').locator('td').first().click();
    const editor = page.getByTestId('desc-editor');
    await expect(editor).toBeFocused();
    await editor.locator('td').first().click();
    const handle = page.getByTestId('table-handle');
    await expect(handle).toBeVisible();
    await handle.click();
    const menu = page.getByTestId('table-menu');
    await expect(menu).toBeVisible();
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await shot(page, testInfo, `table-menu-${scheme}`);
    }
    await page.emulateMedia({ colorScheme: 'dark' });
    await menu.locator('[data-id="row-after"]').click();
    await expect(menu).toHaveCount(0);
    await expect(editor.locator('tr')).toHaveCount(3);
    await page.keyboard.type('B');
    await expectMarkdown(editor, '| Case | Expected |\n| --- | --- |\n| A | 1 |\n| B | |');

    // Row above the header row: new header row, the old one becomes a normal row (Markdown has only one)
    await editor.locator('th').first().click();
    await handle.click();
    await menu.locator('[data-id="row-before"]').click();
    await page.keyboard.type('New');
    await expect(editor.locator('tr').first().locator('th')).toHaveCount(2);
    await expect(editor.locator('tr').nth(1).locator('th')).toHaveCount(0);
    await expectMarkdown(editor, '| New | |\n| --- | --- |\n| Case | Expected |\n| A | 1 |\n| B | |');

    // Column to the right, center it, then delete a row and a column
    await editor.locator('td').first().click();
    await handle.click();
    await menu.locator('[data-id="col-after"]').click();
    await expect(editor.locator('tr').first().locator('th')).toHaveCount(3);
    await handle.click();
    await menu.locator('[data-id="align-center"]').click();
    // New column right of "Case", cursor in it: it gets centered
    await expectMarkdown(editor, '| New | | |\n| --- | :-: | --- |\n| Case | | Expected |\n| A | | 1 |\n| B | | |');
    await editor.locator('td').nth(1).click();
    await handle.click();
    await menu.locator('[data-id="col-delete"]').click();
    await handle.click();
    await menu.locator('[data-id="row-delete"]').click();
    await expectMarkdown(editor, '| New | |\n| --- | --- |\n| A | 1 |\n| B | |');

    // Right-clicking a cell opens the same menu; Esc closes only the menu
    await editor.locator('td').first().click({ button: 'right' });
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(editor).toBeFocused();
    await page.keyboard.press('Escape');
    await expect.poll(() => body(issue.id)).toBe('| New | |\n| --- | --- |\n| A | 1 |\n| B | |');
  });

  test('Keys: Ctrl Alt arrows insert, Ctrl Alt Backspace deletes, Tab in the last cell appends a row', async ({ page }) => {
    await freshIssue(page, TABLE);
    await page.getByTestId('detail-description').locator('td').first().click();
    const editor = page.getByTestId('desc-editor');
    await editor.locator('td').nth(1).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Tab');
    await page.keyboard.type('B');
    await expectMarkdown(editor, '| Case | Expected |\n| --- | --- |\n| A | 1 |\n| B | |');
    await page.keyboard.press('Control+Alt+ArrowUp');
    await page.keyboard.type('Z');
    await expectMarkdown(editor, '| Case | Expected |\n| --- | --- |\n| A | 1 |\n| Z | |\n| B | |');
    await page.keyboard.press('Control+Alt+ArrowRight');
    await expect(editor.locator('tr').first().locator('th')).toHaveCount(3);
    await page.keyboard.press('Control+Alt+Shift+Backspace');
    await expect(editor.locator('tr').first().locator('th')).toHaveCount(2);
    await page.keyboard.press('Control+Alt+Backspace');
    await expectMarkdown(editor, '| Case | Expected |\n| --- | --- |\n| A | 1 |\n| B | |');
  });
});

test('Detail: the list selection checkbox does not linger next to the title', async ({ page }, testInfo) => {
  await open(page, '/team/ORB');
  await page.keyboard.press('j');
  await expect(focusedRow(page).getByTestId('row-check')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('detail-description')).toBeVisible();
  // The list is kept in the background, but its checkboxes are invisible.
  await expect(page.locator('.list-page.kept')).toHaveCount(1);
  const visible = await page.locator('.list-page.kept .row-check').evaluateAll((boxes) => boxes.filter((b) => getComputedStyle(b).visibility !== 'hidden').length);
  expect(visible).toBe(0);
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await shot(page, testInfo, `detail-without-checkbox-${scheme}`);
  }
  // Back to the list: the focused row's checkbox is back
  await page.keyboard.press('Escape');
  await expect(focusedRow(page).getByTestId('row-check')).toBeVisible();
});

test('Tasks: checkbox centered on the first text line, in view and editor, light and dark', async ({ page }, testInfo) => {
  await freshIssue(page, 'List\n\n- [ ] First task\n- [x] Second task\n- [ ] Third with **bold** and a longer text that wraps onto the next line because it is so long that it does not fit, certainly not');
  /** Distance between the centers of checkbox and first text line per task (px). */
  const offsets = (root: Locator) =>
    root.locator('li.task').evaluateAll((items) =>
      items.map((li) => {
        const box = li.querySelector('input')!.getBoundingClientRect();
        const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (t.textContent!.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
        const text = walker.nextNode()!;
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 1);
        const line = range.getClientRects()[0]!;
        // Line center: the paragraph's line height laid around the glyphs
        const lh = parseFloat(getComputedStyle(text.parentElement!).lineHeight);
        const lineTop = line.top - (lh - line.height) / 2;
        return Math.abs(box.top + box.height / 2 - (lineTop + lh / 2));
      }),
    );
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const view = page.getByTestId('detail-description');
    await expect(view.locator('li.task')).toHaveCount(3);
    for (const d of await offsets(view)) expect(d).toBeLessThanOrEqual(1);
    await shot(view, testInfo, `tasks-view-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  const editor = await edit(page);
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(editor.locator('li.task')).toHaveCount(3);
    for (const d of await offsets(editor)) expect(d).toBeLessThanOrEqual(1);
    await shot(editor, testInfo, `tasks-editor-${scheme}`);
  }
});
