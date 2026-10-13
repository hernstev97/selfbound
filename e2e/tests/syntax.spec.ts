// Code blocks: syntax highlighting by language (light and dark), neutral without a language,
// copy button, output stays sanitized.
import { expect, test } from '@playwright/test';
import { api, backend, focusedRow, open, resolve, settled } from '../support/helpers.ts';

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
  await expect(blocks.nth(0).locator('.hljs-keyword').first()).toBeVisible();
  await expect(blocks.nth(0).locator('.hljs-comment')).toHaveText('// Load the description');
  await expect(blocks.nth(1).locator('.hljs-built_in, .hljs-keyword, .hljs-comment').first()).toBeVisible();

  // Without a language and with an unknown language: neutral, nothing guessed.
  await expect(blocks.nth(2).locator('[class^="hljs-"]')).toHaveCount(0);
  await expect(blocks.nth(2).locator('code')).toHaveText('const noLanguage = "stays neutral";');
  await expect(blocks.nth(3).locator('[class^="hljs-"]')).toHaveCount(0);

  // Security: markup in a code block stays text, nothing runs.
  await expect(blocks.nth(3).locator('code')).toContainText('<img src=x onerror=');
  await expect(blocks.nth(3).locator('img, script')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();

  // Colors differ from the body text, in the dark and the light theme.
  const keyword = blocks.nth(0).locator('.hljs-keyword').first();
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
