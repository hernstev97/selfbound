// Info panels (`> [!WARNING] Title`): shown in the description in light and dark, readable in
// several themes, written in the editor ("/" menu, typing, kind menu, back to text).
import { expect, test, type Page } from '@playwright/test';
import { api, backend, contrast, expectMarkdown, open, settled } from '../support/helpers.ts';

const created: string[] = [];

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
  if (created.length) await backend().mutation(api.issues.remove, { ids: created.splice(0) as never[] });
});

async function freshIssue(page: Page, description = '') {
  const meta = await backend().query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  const { issues } = await backend().mutation(api.issues.create, { issues: [{ teamId: team._id, title: `Panels ${Date.now()}`, description }] });
  created.push(issues[0].id);
  await open(page, `/issue/${issues[0].identifier}`);
  await expect(page.getByTestId('detail-loading')).toHaveCount(0);
  return issues[0];
}

const DESCRIPTION = [
  'Intro text.',
  '',
  '> [!NOTE] Pre-conditions',
  '> - Record any pre-conditions',
  '> - Second item',
  '',
  '> [!WARNING] Post-conditions',
  '> Careful with `code` and **bold**.',
  '',
  '> [!SUCCESS] Requirements',
  '> - [ ] A task inside a panel',
  '',
  '> [!ERROR]',
  '> 1. Normal flow',
  '',
  '> [!IMPORTANT] Alternative flow',
  '> Written as a GitHub alert.',
  '',
  '> [!FOO] Not a panel',
  '',
  '> A plain quote',
  '',
  '> [!INFO] <img src=x onerror="window.__xss = 1"> title',
  '> body',
].join('\n');

test('Panels render in the description: kinds, titles, content, plain quotes stay quotes, no injection', async ({ page }, testInfo) => {
  await freshIssue(page, DESCRIPTION);
  const description = page.getByTestId('detail-description');
  const panels = description.locator('.callout');
  await expect(panels).toHaveCount(6);
  await expect(panels.nth(0)).toHaveClass(/callout-note/);
  await expect(panels.nth(0).locator('.callout-name')).toHaveText('Pre-conditions');
  await expect(panels.nth(0).locator('li')).toHaveCount(2);
  await expect(panels.nth(1)).toHaveClass(/callout-warning/);
  await expect(panels.nth(1).locator('code')).toHaveText('code');
  await expect(panels.nth(2)).toHaveClass(/callout-success/);
  await expect(panels.nth(2).locator('input[type="checkbox"]')).toHaveCount(1);
  // No title: the name of the kind; the ordered list is intact
  await expect(panels.nth(3)).toHaveClass(/callout-error/);
  await expect(panels.nth(3).locator('.callout-name')).toHaveText('Error');
  await expect(panels.nth(3).locator('ol > li')).toHaveText('Normal flow');
  // GitHub alert names map to the nearest kind
  await expect(panels.nth(4)).toHaveClass(/callout-info/);
  await expect(panels.nth(4).locator('.callout-name')).toHaveText('Alternative flow');
  // An unknown keyword and a plain quote stay quotes
  await expect(description.locator('blockquote')).toHaveCount(2);
  await expect(description.locator('blockquote').first()).toContainText('[!FOO] Not a panel');
  // The title is text, never markup
  await expect(panels.nth(5).locator('img')).toHaveCount(0);
  await expect(panels.nth(5).locator('.callout-name')).toContainText('<img src=x');
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  // The kind is part of the accessible name
  await expect(panels.nth(1)).toHaveAttribute('role', 'note');
  await expect(panels.nth(1)).toHaveAttribute('aria-label', 'Warning: Post-conditions');

  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    for (let i = 0; i < 5; i++) {
      expect(await contrast(panels.nth(i).locator('.callout-name')), `${scheme} title ${i}`).toBeGreaterThan(4.5);
      expect(await contrast(panels.nth(i).locator('.callout-body').first()), `${scheme} body ${i}`).toBeGreaterThan(4.5);
    }
    const image = await description.screenshot({ path: testInfo.outputPath(`panels-${scheme}.png`) });
    await testInfo.attach(`panels-${scheme}`, { body: image, contentType: 'image/png' });
  }
  await page.emulateMedia({ colorScheme: 'dark' });
});

test('Pasted Markdown with a panel becomes a panel; a divider from the "/" menu lands inside, a table cell has no panel entry', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await freshIssue(page, 'Start');
  await page.getByTestId('detail-description').locator('p').first().click();
  const editor = page.getByTestId('desc-editor');
  await expect(editor).toBeFocused();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.evaluate(() => navigator.clipboard.writeText('> [!NOTE] Pasted\n> - one\n> - two'));
  await page.keyboard.press('Control+v');
  await expect(editor.locator('.callout-note')).toHaveCount(1);
  await expect(editor.locator('.callout-note .callout-title')).toHaveText('Pasted');
  await expect(editor.locator('.callout-note li')).toHaveCount(2);
  await expectMarkdown(editor, 'Start\n\n> [!NOTE] Pasted\n>\n> - one\n> - two');
  // Divider from the "/" menu while the cursor is in the title: goes in front of the content, inside the panel
  await editor.locator('.callout-note .callout-title').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/div');
  await page.keyboard.press('Enter');
  await expect(editor.locator('.callout-note hr')).toHaveCount(1);
  // No panel entry in a table cell
  await page.keyboard.press('Control+End');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('/tab');
  await page.keyboard.press('Enter');
  await expect(editor.locator('table')).toHaveCount(1);
  await page.keyboard.type('/panel');
  await expect(page.getByTestId('slash-menu')).toHaveCount(0);
});

test('Panels in the editor: "/" menu, title, content, kind menu, back to text; untouched text stays as written', async ({ page }, testInfo) => {
  const issue = await freshIssue(page, '> [!TIP] Hint\n> Written as a tip.\n\nAfter');
  await page.getByTestId('detail-description').locator('p').last().click();
  const editor = page.getByTestId('desc-editor');
  await expect(editor).toBeFocused();
  // Open and leave untouched: byte for byte the same
  await expectMarkdown(editor, '> [!TIP] Hint\n> Written as a tip.\n\nAfter');
  await expect(editor.locator('.callout-success')).toHaveCount(1);

  // New panel from the "/" menu on an empty line
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/warn');
  const menu = page.getByTestId('slash-menu');
  await expect(menu.getByTestId('slash-item').first()).toHaveAttribute('data-id', 'callout-warning');
  await page.keyboard.press('Enter');
  await expect(editor.locator('.callout-warning')).toHaveCount(1);
  // Without a title the kind's name is shown as a hint, and the cursor is in the title
  await expect(editor.locator('.callout-warning.untitled')).toHaveCount(1);
  await page.keyboard.type('Careful');
  await page.keyboard.press('Enter'); // from the title into the content
  await page.keyboard.type('Check twice');
  await expectMarkdown(editor, '> [!TIP] Hint\n> Written as a tip.\n\nAfter\n\n> [!WARNING] Careful\n> Check twice');

  const image = await page.getByTestId('desc-editor-wrap').screenshot({ path: testInfo.outputPath('panels-editor.png') });
  await testInfo.attach('panels-editor', { body: image, contentType: 'image/png' });

  // Ctrl Alt P: next kind (warning → error)
  await page.keyboard.press('Control+Alt+p');
  await expect(editor.locator('.callout-error')).toHaveCount(1);
  await expectMarkdown(editor, '> [!TIP] Hint\n> Written as a tip.\n\nAfter\n\n> [!ERROR] Careful\n> Check twice');

  // Change the kind with the symbol
  await editor.locator('.callout-error > button.callout-icon').click();
  const kinds = page.getByTestId('callout-menu');
  await expect(kinds).toBeVisible();
  await expect(kinds.locator('[data-id="error"]')).toHaveAttribute('aria-checked', 'true');
  await kinds.locator('[data-id="success"]').click();
  await expect(kinds).toHaveCount(0);
  await expect(editor.locator('.callout-success')).toHaveCount(2);
  await expectMarkdown(editor, '> [!TIP] Hint\n> Written as a tip.\n\nAfter\n\n> [!SUCCESS] Careful\n> Check twice');
  await page.keyboard.press('Control+Alt+p'); // success → warning → error
  await page.keyboard.press('Control+Alt+p');
  await expect(editor.locator('.callout-error')).toHaveCount(1);

  // Backspace at the start of the title takes the panel apart
  await page.waitForTimeout(700); // separate step in the undo history
  await editor.locator('.callout-error .callout-title').click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  await expect(editor.locator('.callout-error')).toHaveCount(0);
  await expectMarkdown(editor, '> [!TIP] Hint\n> Written as a tip.\n\nAfter\n\nCareful\n\nCheck twice');
  await page.keyboard.press('Control+z');
  await expectMarkdown(editor, '> [!TIP] Hint\n> Written as a tip.\n\nAfter\n\n> [!ERROR] Careful\n> Check twice');

  // Typing "> " and then the marker makes a panel
  await page.keyboard.press('Control+End');
  await page.keyboard.press('ArrowDown'); // new paragraph after the last block
  await page.keyboard.type('> [!info] ');
  await expect(editor.locator('.callout-info')).toHaveCount(1);
  await page.keyboard.type('Heads up');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await backend().query(api.issues.detail, { id: issue.id as never }))!.body.markdown).toContain('\n\n> [!info] Heads up');
});

test('Agent details: closed under the summary, open with a click or the keyboard, stay open while a task is ticked and on return; phone width', async ({ page }, testInfo) => {
  const meta = await backend().query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  const { issues: linked } = await backend().mutation(api.issues.create, { issues: [{ teamId: team._id, title: `Linked ${Date.now()}` }] });
  const other = linked[0];
  created.push(other.id);
  const issue = await freshIssue(
    page,
    [`Short summary for people, see ${other.identifier}.`, '', '> [!AGENT] Details für Agenten', '> - [ ] First criterion', '> - [ ] Second criterion', '>', '> Files: `app/src/lib/blocks/callout.ts`'].join('\n'),
  );
  const description = page.getByTestId('detail-description');
  const details = description.locator('details.callout-agent');
  const summary = details.locator('summary');
  await expect(details).toHaveCount(1);
  await expect(details).not.toHaveAttribute('open');
  await expect(summary).toHaveText('Details für Agenten');
  await expect(details.locator('.callout-body')).toBeHidden();
  await expect(description.getByText('Short summary for people')).toBeVisible();

  // One click opens it, without starting the editor
  await summary.click();
  await expect(details).toHaveAttribute('open', '');
  await expect(details.getByText('First criterion')).toBeVisible();
  await expect(page.getByTestId('desc-editor')).toHaveCount(0);

  // Ticking a task inside renders the text again; the block stays open
  await details.getByTestId('task-box').first().click();
  await expect.poll(async () => (await backend().query(api.issues.detail, { id: issue.id as never }))!.body.markdown).toContain('- [x] First criterion');
  await expect(details.getByTestId('task-box').first()).toBeChecked();
  await expect(details).toHaveAttribute('open', '');

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    expect(await contrast(summary.locator('.callout-name')), `${scheme} title`).toBeGreaterThan(4.5);
    expect(await contrast(details.locator('.callout-body')), `${scheme} body`).toBeGreaterThan(4.5);
  }
  await page.emulateMedia({ colorScheme: 'dark' });

  // Keyboard: Enter and space on the focused bar
  await summary.click();
  await expect(details).not.toHaveAttribute('open');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(details).toHaveAttribute('open', '');
  await page.keyboard.press(' ');
  await expect(details).not.toHaveAttribute('open');
  await expect(page.getByTestId('desc-editor')).toHaveCount(0);

  // Opened, it is still open when coming back to the issue
  await summary.click();
  await description.locator(`a[href="/issue/${other.identifier}"]`).click();
  await expect(page.getByTestId('detail-key')).toHaveText(other.identifier);
  await page.goBack();
  await expect(page.getByTestId('detail-key')).toHaveText(issue.identifier);
  await expect(details).toHaveAttribute('open', '');

  // Phone width: the bar is a touch target and nothing overflows
  await page.setViewportSize({ width: 360, height: 800 });
  expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    for (const state of ['open', 'closed'] as const) {
      if ((state === 'open') !== (await details.evaluate((el) => (el as HTMLDetailsElement).open))) await summary.click();
      await expect(details.locator('.callout-body')).toBeVisible({ visible: state === 'open' });
      const image = await description.screenshot({ path: testInfo.outputPath(`agent-${scheme}-${state}.png`) });
      await testInfo.attach(`agent-${scheme}-${state}`, { body: image, contentType: 'image/png' });
    }
  }
  await page.emulateMedia({ colorScheme: 'dark' });
});

test('Agent details in the editor: the "/" menu inserts an AGENT panel, shown open; the page shows it closed', async ({ page }) => {
  await freshIssue(page, 'Summary');
  await page.getByTestId('detail-description').locator('p').first().click();
  const editor = page.getByTestId('desc-editor');
  await expect(editor).toBeFocused();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/agent');
  await expect(page.getByTestId('slash-menu').getByTestId('slash-item').first()).toHaveAttribute('data-id', 'callout-agent');
  await page.keyboard.press('Enter');
  // Without a title the kind's name is the hint
  await expect(editor.locator('.callout-agent.untitled')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Acceptance criteria');
  await expect(editor.getByText('Acceptance criteria')).toBeVisible();
  await expectMarkdown(editor, 'Summary\n\n> [!AGENT]\n> Acceptance criteria');
  await page.keyboard.press('Escape');
  const details = page.getByTestId('detail-description').locator('details.callout-agent');
  await expect(details).not.toHaveAttribute('open');
  await expect(details.locator('summary')).toHaveText('Details for agents');
});
