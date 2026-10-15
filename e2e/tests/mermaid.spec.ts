// Mermaid diagrams: drawn lazily once visible, in light and dark and with the chosen theme, source
// and a note when drawing is not possible, nothing executable, live preview in the editor.
import { expect, test, type Page } from '@playwright/test';
import { api, backend, expectMarkdown, open, settled } from '../support/helpers.ts';

const created: string[] = [];

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
  if (created.length) await backend().mutation(api.issues.remove, { ids: created.splice(0) as never[] });
});

async function freshIssue(page: Page, description = '') {
  const meta = await backend().query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  const { issues } = await backend().mutation(api.issues.create, { issues: [{ teamId: team._id, title: `Diagram ${Date.now()}`, description }] });
  created.push(issues[0].id);
  await open(page, `/issue/${issues[0].identifier}`);
  await expect(page.getByTestId('detail-loading')).toHaveCount(0);
  return issues[0];
}

const FLOW = '```mermaid\nflowchart TD\n  A[Create issue] --> B{Triage}\n  B -->|accept| C[Backlog]\n  B -->|decline| D[Canceled]\n```';
const SEQUENCE = '```mermaid\nsequenceDiagram\n  participant U as User\n  participant A as Agent\n  U->>A: Write\n  A-->>U: Diagram\n```';

test('A diagram is drawn in the description, light and dark; the chunk loads only for texts with a diagram', async ({ page }, testInfo) => {
  const chunks: string[] = [];
  page.on('request', (r) => /mermaid|beautiful|elk/i.test(r.url()) && r.url().endsWith('.js') && chunks.push(r.url()));
  await freshIssue(page, 'Plain text without a diagram.');
  await expect(page.getByTestId('detail-description')).toContainText('Plain text');
  await page.waitForTimeout(500);
  expect(chunks).toEqual([]);

  await freshIssue(page, `Flow:\n\n${FLOW}\n\nAfter.`);
  const block = page.getByTestId('detail-description').locator('.vblock');
  await expect(block).toHaveAttribute('data-state', 'ready');
  await expect(block.locator('.vblock-view')).toHaveAttribute('role', 'img');
  await expect(block.locator('.vblock-view')).toHaveAttribute('aria-label', /^Diagram: .*Create issue.*Triage/);
  // The drawing sits in a shadow root; Playwright pierces it
  await expect(block.locator('svg text', { hasText: 'Triage' })).toHaveCount(1);
  // The source stays in the page (copy button) but is hidden
  await expect(block.locator('pre')).toBeHidden();
  expect(chunks.length).toBeGreaterThan(0);
  expect(await block.locator('svg').evaluate((el) => !!(el.getRootNode() as ShadowRoot).host)).toBe(true);

  const fills: Record<string, string> = {};
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    // Live: the same drawing, new colors, without drawing again
    fills[scheme] = await block.locator('svg text', { hasText: 'Triage' }).evaluate((el) => getComputedStyle(el).fill);
    const image = await block.screenshot({ path: testInfo.outputPath(`diagram-${scheme}.png`) });
    await testInfo.attach(`diagram-${scheme}`, { body: image, contentType: 'image/png' });
  }
  expect(fills.dark).not.toBe(fills.light);
  await expect(block).toHaveAttribute('data-state', 'ready');
  await page.emulateMedia({ colorScheme: 'dark' });
});

const DEFAULT_LOOK = { dark: 'xlr8', light: 'xlr8', sans: 'inter', mono: 'system', overrides: [] };
test.afterAll(async () => {
  await backend().mutation(api.appearance.save, DEFAULT_LOOK); // other specs run on the same data
});

test('The chosen themes: text stays readable on the nodes, edges and arrows are visible (dark and light)', async ({ page }, testInfo) => {
  await freshIssue(page, `${FLOW}\n\n${SEQUENCE}`);
  const pairs = [
    ['dracula', 'solarized-light'],
    ['catppuccin-mocha', 'github-light'],
    ['nord', 'catppuccin-latte'],
    ['gruvbox-dark', 'tokyo-night-light'],
  ] as const;
  for (const [dark, light] of pairs) {
    await backend().mutation(api.appearance.save, { ...DEFAULT_LOOK, dark, light });
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.reload();
      const block = page.getByTestId('detail-description').locator('.vblock').first();
      await expect(block).toHaveAttribute('data-state', 'ready');
      await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
      const name = scheme === 'dark' ? dark : light;
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-raised').trim())).not.toBe('');
      const ratios = await block.locator('svg').first().evaluate((svg) => {
        const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
        const rgb = (c: string) => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = '#000';
          ctx.fillStyle = c;
          ctx.fillRect(0, 0, 1, 1);
          return [...ctx.getImageData(0, 0, 1, 1).data] as number[];
        };
        const lum = (c: number[]) => {
          const f = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
          return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
        };
        const ratio = (a: string, b: string) => {
          const [x, y] = [lum(rgb(a)), lum(rgb(b))];
          return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
        };
        const surface = getComputedStyle((svg.getRootNode() as ShadowRoot).host).backgroundColor;
        const node = svg.querySelector('g.node rect')!;
        const text = svg.querySelector('g.node text')!;
        const edge = svg.querySelector('polyline.edge')!;
        return {
          text: ratio(getComputedStyle(text).fill, getComputedStyle(node).fill),
          edge: ratio(getComputedStyle(edge).stroke, surface),
          node: ratio(getComputedStyle(node).stroke, surface),
        };
      });
      expect(ratios.text, `${name} text on node`).toBeGreaterThan(4.5);
      expect(ratios.edge, `${name} edge on surface`).toBeGreaterThan(3);
      const image = await block.screenshot({ path: testInfo.outputPath(`theme-${scheme}-${name}.png`) });
      await testInfo.attach(`theme-${scheme}-${name}`, { body: image, contentType: 'image/png' });
    }
  }
  await page.emulateMedia({ colorScheme: 'dark' });
});

test('Sequence diagram, a diagram inside an info panel, and a diagram far below the fold waits until it is visible', async ({ page }, testInfo) => {
  await freshIssue(page, `> [!NOTE] Flow\n> ${FLOW.split('\n').join('\n> ')}\n\n${SEQUENCE}\n\n${'Filler paragraph.\n\n'.repeat(60)}\n${FLOW}`);
  const blocks = page.getByTestId('detail-description').locator('.vblock');
  await expect(blocks).toHaveCount(3);
  await expect(blocks.nth(0)).toHaveAttribute('data-state', 'ready');
  await expect(blocks.nth(0).locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " callout ")]')).toHaveCount(1);
  await expect(blocks.nth(1)).toHaveAttribute('data-state', 'ready');
  await expect(blocks.nth(1).locator('svg text', { hasText: 'Agent' }).first()).toBeVisible();
  const panel = await page.getByTestId('detail-description').locator('.callout').first().screenshot({ path: testInfo.outputPath('diagram-in-panel.png') });
  await testInfo.attach('diagram-in-panel', { body: panel, contentType: 'image/png' });
  const seq = await blocks.nth(1).screenshot({ path: testInfo.outputPath('diagram-sequence.png') });
  await testInfo.attach('diagram-sequence', { body: seq, contentType: 'image/png' });
  // The last one is far below: not drawn yet
  expect(await blocks.nth(2).getAttribute('data-state')).toBeNull();
  await blocks.nth(2).scrollIntoViewIfNeeded();
  await expect(blocks.nth(2)).toHaveAttribute('data-state', 'ready');
});

test('Errors keep the source and say why: invalid text, a type that is not drawn yet; nothing executes', async ({ page }) => {
  await freshIssue(
    page,
    [
      '```mermaid\nthis is not a diagram\n```',
      '```mermaid\npie title Pets\n  "Dogs": 3\n```',
      '```mermaid\nflowchart TD\n  A["<img src=x onerror=window.__xss=1>"] --> B["<script>window.__xss=2</script>"]\n  click A "javascript:window.__xss=3"\n```',
    ].join('\n\n'),
  );
  const blocks = page.getByTestId('detail-description').locator('.vblock');
  await expect(blocks).toHaveCount(3);
  await expect(blocks.nth(0)).toHaveAttribute('data-state', 'error');
  await expect(blocks.nth(0).locator('pre')).toBeVisible();
  await expect(blocks.nth(0).locator('pre')).toContainText('this is not a diagram');
  await expect(blocks.nth(0).locator('.vblock-error')).toContainText('Diagram could not be drawn');
  await expect(blocks.nth(1)).toHaveAttribute('data-state', 'error');
  await expect(blocks.nth(1).locator('.vblock-error')).toContainText('pie diagrams are not drawn yet');
  await expect(blocks.nth(2)).toHaveAttribute('data-state', 'ready');
  await expect(blocks.nth(2).locator('svg text', { hasText: '<img src=x' })).toHaveCount(1);
  await expect(blocks.nth(2).locator('img, script, foreignObject, a')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test('Editor: "/" inserts a diagram with a live preview; an incomplete text keeps the last drawing and shows the error; Esc saves the Markdown', async ({ page }, testInfo) => {
  const issue = await freshIssue(page, 'Start');
  await page.getByTestId('detail-description').locator('p').first().click();
  const editor = page.getByTestId('desc-editor');
  await expect(editor).toBeFocused();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/diag');
  await expect(page.getByTestId('slash-menu').getByTestId('slash-item').first()).toHaveAttribute('data-id', 'mermaid');
  await page.keyboard.press('Enter');
  await expect(editor.locator('.codeblock[data-block="mermaid"]')).toHaveCount(1);
  await expect(editor.getByTestId('code-lang')).toHaveText(/mermaid/i);
  const preview = editor.locator('.vblock-preview');
  await expect(preview.locator('svg text', { hasText: 'Decision' })).toHaveCount(1);
  await expectMarkdown(editor, 'Start\n\n```mermaid\nflowchart TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Done]\n  B -->|No| D[Try again]\n```');
  // Typing: the drawing follows after a pause
  await page.keyboard.type('\n  D --> E[Ship]');
  await expect(preview.locator('svg text', { hasText: 'Ship' })).toHaveCount(1);
  const image = await page.getByTestId('desc-editor-wrap').screenshot({ path: testInfo.outputPath('diagram-editor.png') });
  await testInfo.attach('diagram-editor', { body: image, contentType: 'image/png' });
  // Broken text: the last drawing stays, a note says why
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown'); // first line of the diagram: "flowchart TD"
  await page.keyboard.press('Home');
  await page.keyboard.type('xx');
  await expect(preview.locator('.vblock-error')).toBeVisible();
  await expect(preview.locator('svg text', { hasText: 'Ship' })).toHaveCount(1);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await expect(preview.locator('.vblock-error')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await backend().query(api.issues.detail, { id: issue.id as never }))!.body.markdown).toContain('E[Ship]');
  await expect(page.getByTestId('detail-description').locator('.vblock')).toHaveAttribute('data-state', 'ready');
});
