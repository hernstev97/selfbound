// Code blocks: syntax highlighting by language (light and dark, with the chosen VS Code theme),
// neutral without a language, no layout shift while loading, loaded only when needed, copy button,
// output stays sanitized.
import { expect, test } from '@playwright/test';
import { api, backend, focusedRow, open, resolve, settled } from '../support/helpers.ts';

const DEFAULT = { dark: 'xlr8', light: 'xlr8', sans: 'inter', mono: 'system', overrides: [] };

/** Other specs run on the same data: back to the default appearance. */
const reset = () => backend().mutation(api.appearance.save, DEFAULT);
test.beforeAll(reset);
test.afterAll(reset);

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

const DESCRIPTION = [
  'Clean up before the release.',
  '',
  '```ts',
  '// Load the description',
  'export async function load(id: string): Promise<Issue | null> {',
  '  const rows = await db.query("issues").filter((q) => q.eq(q.field("id"), id)).collect();',
  '  return rows.length > 0 ? rows[0] : null;',
  '}',
  '```',
  '',
  '```bash',
  'pnpm test && node tooling/deploy-web.mjs --dry-run # check only',
  '```',
  '',
  '```',
  'const noLanguage = "stays neutral";',
  '```',
  '',
  '```text',
  '<img src=x onerror="window.__xss = 1"><script>window.__xss = 2</script>',
  '```',
].join('\n');

test('Code blocks: colored with a language, neutral without, copy, sanitized', async ({ page, context }, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page, '/team/MOSAIK');
  const key = (await focusedRow(page).getAttribute('data-key'))!;
  const hit = (await resolve(key))!;
  const client = backend();
  const doc = (await client.query(api.issues.detail, { id: hit.id }))!;
  await client.mutation(api.issues.setDescription, { id: hit.id, markdown: DESCRIPTION, baseVersion: doc.body.version });

  await page.goto(`/issue/${key}`);
  const description = page.getByTestId('detail-description');
  const blocks = description.locator('.codeblock');
  await expect(blocks).toHaveCount(4);

  // With a language: color arrives after the text.
  await expect(blocks.nth(0).locator('code.hl .tk', { hasText: 'export' }).first()).toBeVisible();
  await expect(blocks.nth(0).locator('.tk', { hasText: '// Load the description' })).toHaveText('// Load the description');
  await expect(blocks.nth(1).locator('code.hl .tk').first()).toBeVisible();

  // Without a language and with an unknown language: neutral, nothing guessed.
  await expect(blocks.nth(2).locator('.tk')).toHaveCount(0);
  await expect(blocks.nth(2).locator('code')).toHaveText('const noLanguage = "stays neutral";');
  await expect(blocks.nth(3).locator('.tk')).toHaveCount(0);

  // Security: markup in a code block stays text, nothing runs.
  await expect(blocks.nth(3).locator('code')).toContainText('<img src=x onerror=');
  await expect(blocks.nth(3).locator('img, script')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();

  // Colors differ from the body text, in the dark and the light theme.
  const keyword = blocks.nth(0).locator('.tk', { hasText: 'export' }).first();
  const code = blocks.nth(0).locator('code');
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    const [keywordColor, textColor] = await Promise.all([keyword.evaluate((e) => getComputedStyle(e).color), code.evaluate((e) => getComputedStyle(e).color)]);
    expect(keywordColor).not.toBe(textColor);
    const shot = await description.screenshot({ path: testInfo.outputPath(`codeblock-${scheme}.png`) });
    await testInfo.attach(`codeblock-${scheme}`, { body: shot, contentType: 'image/png' });
  }

  // Copy: on the block, copies the source without markup.
  await blocks.nth(1).hover();
  await blocks.nth(1).getByTestId('code-copy').click();
  await expect(blocks.nth(1).getByTestId('code-copy')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('pnpm test && node tooling/deploy-web.mjs --dry-run # check only');
});

const TS = ['```ts', 'export const answer: number = 42; // the answer', '```', '', '```bash', 'echo "hi"', '```'].join('\n');

async function describeWith(page: import('@playwright/test').Page, markdown: string) {
  await open(page, '/team/MOSAIK');
  const key = (await focusedRow(page).getAttribute('data-key'))!;
  const hit = (await resolve(key))!;
  const client = backend();
  const doc = (await client.query(api.issues.detail, { id: hit.id }))!;
  await client.mutation(api.issues.setDescription, { id: hit.id, markdown, baseVersion: doc.body.version });
  return key;
}

test('Code blocks: the neutral block and the colored one have the same size (no layout shift)', async ({ page }) => {
  const key = await describeWith(page, TS);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  // The TypeScript grammar arrives late: the block stays neutral meanwhile.
  await page.route('**/assets/typescript-*.js', async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto(`/issue/${key}`);
  const block = page.getByTestId('detail-description').locator('.codeblock').first();
  await expect(block.locator('code')).toContainText('export const answer');
  await page.waitForTimeout(300);
  await expect(block.locator('.tk')).toHaveCount(0);
  const before = (await block.boundingBox())!;
  const lineBefore = await block.locator('code').evaluate((e) => e.getBoundingClientRect().height);
  release();
  await expect(block.locator('.tk').first()).toBeVisible();
  const after = (await block.boundingBox())!;
  expect(after.height).toBe(before.height);
  expect(after.width).toBe(before.width);
  expect(await block.locator('code').evaluate((e) => e.getBoundingClientRect().height)).toBe(lineBefore);
});

test('Code blocks: Shiki and each grammar load only when a text uses them', async ({ page }) => {
  const key = await describeWith(page, TS);
  const urls: string[] = [];
  page.on('request', (r) => urls.push(new URL(r.url()).pathname));
  const loaded = (name: RegExp) => urls.some((u) => name.test(u));
  await page.goto('/all');
  await expect(page.getByTestId('issue-row').first()).toBeVisible();
  await page.waitForTimeout(1500);
  expect(loaded(/\/assets\/(highlight-|typescript-|shellscript-)/)).toBe(false);

  await page.goto(`/issue/${key}`);
  await expect(page.getByTestId('detail-description').locator('.codeblock .tk').first()).toBeVisible();
  expect(loaded(/\/assets\/highlight-/)).toBe(true);
  expect(loaded(/\/assets\/typescript-/)).toBe(true);
  expect(loaded(/\/assets\/shellscript-/)).toBe(true);
  // The regex engine is JavaScript: no WebAssembly file.
  expect(loaded(/\.wasm$/)).toBe(false);
  // Languages the text does not use stay unloaded.
  expect(loaded(/\/assets\/(python|kotlin|sql|yaml|vue)-/)).toBe(false);
});

test('Code blocks: exactly the colors of the chosen VS Code theme, and a new theme recolors open blocks', async ({ page }, testInfo) => {
  const key = await describeWith(page, TS);
  const client = backend();
  await client.mutation(api.appearance.save, { ...DEFAULT, dark: 'dracula', light: 'github-light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`/issue/${key}`);
  const block = page.getByTestId('detail-description').locator('.codeblock').first();
  const color = (text: string) => block.locator('.tk', { hasText: text }).first().evaluate((e) => getComputedStyle(e).color);
  // Dracula: keyword pink (#ff79c6); the comment (#6272a4) is lifted to 3 : 1 on the code block, same hue
  await expect.poll(() => color('export')).toBe('rgb(255, 121, 198)');
  await expect.poll(() => color('// the answer')).toBe('rgb(106, 122, 173)');
  await block.screenshot({ path: testInfo.outputPath('theme-dracula.png') });
  // Light mode: GitHub Light keyword (#cf222e), same HTML
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => color('export')).toBe('rgb(207, 34, 46)');
  await block.screenshot({ path: testInfo.outputPath('theme-github-light.png') });
  // Another theme chosen on the server (as from another device): the open block is colored again.
  await page.emulateMedia({ colorScheme: 'dark' });
  await client.mutation(api.appearance.save, { ...DEFAULT, dark: 'nord', light: 'github-light' });
  await expect.poll(() => color('export'), { timeout: 15_000 }).not.toBe('rgb(255, 121, 198)');
  await expect(block.locator('.tk').first()).toBeVisible();
});
