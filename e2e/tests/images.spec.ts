// Images in descriptions and comments: real paste from the clipboard, drag and drop, button,
// downscaling, errors with "Retry", display in detail and peek.
// Drive videos: a link alone on a line → player once visible; other links stay links.
import { expect, test, type Page } from '@playwright/test';
import { api, backend, expectMarkdown, markdownOf, open, settled } from '../support/helpers.ts';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

const IMG_URL = /!\[[^\]]*\]\(http:\/\/127\.0\.0\.1:\d+\/img\/[A-Za-z0-9_-]{43}\)/;

/** A fresh issue via the server, detail page open. */
async function freshIssue(page: Page, description = '') {
  const meta = await backend().query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  const title = `Images ${Date.now()}`;
  const { issues } = await backend().mutation(api.issues.create, { issues: [{ teamId: team._id, title, description }] });
  await open(page, `/issue/${issues[0].identifier}`);
  return { ...issues[0], title };
}

const bodyOf = async (id: string) => (await backend().query(api.issues.detail, { id: id as never }))!.body.markdown;

/** Paints a PNG in the browser (like a screenshot) and returns its bytes. */
async function pngBytes(page: Page, width = 320, height = 200) {
  const data = await page.evaluate(
    async ([w, h]) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d')!;
      g.fillStyle = '#5e6ad2';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#fff';
      g.font = `${Math.round(h / 5)}px sans-serif`;
      g.fillText('Selfbound', w / 6, h / 2);
      // Noise so large images stay large (downscaling becomes necessary).
      if (w * h > 1e6) for (let i = 0; i < 4000; i++) g.fillRect(Math.random() * w, Math.random() * h, 3, 3);
      const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
      return [...new Uint8Array(await blob.arrayBuffer())];
    },
    [width, height],
  );
  return Buffer.from(data);
}

/** Slows the upload down (placeholder visible) or makes the first `fail` attempts fail. */
async function throttleUpload(page: Page, opts: { delay?: number; fail?: number } = {}) {
  let failures = opts.fail ?? 0;
  await page.route('**/api/storage/upload**', async (route) => {
    if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
    if (failures > 0) {
      failures--;
      await route.fulfill({ status: 500, body: 'broken' });
      return;
    }
    await route.continue();
  });
}

async function imageLoaded(page: Page, scope: string) {
  const img = page.locator(`${scope} img[src*="/img/"]`).first();
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(0);
  return img;
}

test('Screenshot with Ctrl V into the description: placeholder, then image; saved and visible in detail and peek', async ({ page }) => {
  const issue = await freshIssue(page, 'Before');
  await throttleUpload(page, { delay: 700 });
  // Real clipboard: write a PNG into it, then Ctrl V in the field.
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 400;
    c.height = 240;
    const g = c.getContext('2d')!;
    g.fillStyle = '#26b5ce';
    g.fillRect(0, 0, 400, 240);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  });
  await page.getByTestId('detail-description').click();
  const editor = page.getByTestId('desc-editor');
  await editor.press('Control+End');
  await editor.press('Control+V');
  await expectMarkdown(editor, /!\[Uploading Image …\]\(#upload-[a-z0-9]+\)/);
  await expect(editor.locator('.upload-note')).toBeVisible();
  await expectMarkdown(editor, IMG_URL, 15_000);
  await expectMarkdown(editor, /^Before\n!\[Image\]/);
  await expect(editor.locator('img[src*="/img/"]')).toBeVisible();
  await expect.poll(() => bodyOf(issue.id), { timeout: 10_000 }).toMatch(IMG_URL);
  await page.getByTestId('desc-done').click();
  await imageLoaded(page, '[data-testid="detail-description"]');
  // Light and dark
  await page.emulateMedia({ colorScheme: 'light' });
  await imageLoaded(page, '[data-testid="detail-description"]');
  await page.emulateMedia({ colorScheme: 'dark' });
  // Peek in the list
  await page.keyboard.press('Escape');
  await open(page, `/team/ORB/all?q=${encodeURIComponent(issue.title)}`);
  // Focus out of the filter field, then focus the row and press Space (peek).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator(`[data-testid="issue-row"][data-id="${issue.id}"]`).hover();
  await page.keyboard.press('Space');
  await imageLoaded(page, '[data-testid="peek"]');
});

test('Dropping a file on the comment field: sending waits until the image is uploaded', async ({ page }) => {
  await freshIssue(page);
  await throttleUpload(page, { delay: 900 });
  const png = await pngBytes(page);
  await page.getByTestId('comment-input').fill('See image:');
  // After focus the editor loads and replaces the textarea.
  await expect(page.getByTestId('comment-input')).toHaveAttribute('contenteditable', 'true');
  await page.getByTestId('comment-input').press('End');
  // The drop lands where the pointer is: the field must be on screen.
  await page.getByTestId('comment-input').scrollIntoViewIfNeeded();
  // Drag and drop with a real file in the DataTransfer.
  await page.getByTestId('comment-input').evaluate((el, bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'Flow.png', { type: 'image/png' }));
    // Dropped after the text (the editor puts the image where the pointer is).
    const r = el.getBoundingClientRect();
    const at = { clientX: r.right - 4, clientY: r.top + 10 };
    el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, ...at }));
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, ...at }));
  }, [...png]);
  await expectMarkdown(page.getByTestId('comment-input'), /Uploading Flow/);
  await expect(page.getByTestId('comment-send')).toBeDisabled();
  await expectMarkdown(page.getByTestId('comment-input'), /!\[Flow\]\(http/, 15_000);
  await page.getByTestId('comment-send').click();
  const comment = page.getByTestId('comment').filter({ hasText: 'See image' });
  await expect(comment).toBeVisible();
  await imageLoaded(page, '[data-testid="comment"]');
});

test('Button in the create dialog; a large image is downscaled in the browser and stored as WebP', async ({ page }) => {
  await open(page, '/team/ORB');
  await page.keyboard.press('c');
  await page.getByTestId('create-title').fill(`Large image ${Date.now()}`);
  const big = await pngBytes(page, 3600, 2400);
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.create-foot').getByTestId('image-button').click();
  await (await chooser).setFiles({ name: 'Huge.png', mimeType: 'image/png', buffer: big });
  const desc = page.getByTestId('create-description');
  await expectMarkdown(desc, /!\[Huge\]\(http/, 20_000);
  const url = (await markdownOf(desc)).match(/\((http[^)]+)\)/)![1];
  const response = await page.request.get(url);
  const size = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight };
  }, url);
  const info = { type: response.headers()['content-type'], csp: response.headers()['content-security-policy'], ...size };
  expect(info).toEqual({ type: 'image/webp', csp: "default-src 'none'; sandbox", width: 2560, height: 1707 });
  await page.getByTestId('create-submit').click();
  await expect(page.getByTestId('create-title')).toHaveCount(0);
});

test('Upload fails: visible error, "Retry" works; non-images are rejected', async ({ page }) => {
  await freshIssue(page);
  await throttleUpload(page, { fail: 1 });
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.comment-box').getByTestId('image-button').click();
  await (await chooser).setFiles({ name: 'Broken.png', mimeType: 'image/png', buffer: await pngBytes(page) });
  const input = page.getByTestId('comment-input');
  await expectMarkdown(input, /!\[Upload failed: Broken\]/);
  const toast = page.getByTestId('toast').filter({ hasText: 'not uploaded' });
  await expect(toast).toBeVisible();
  // No upload in flight any more: sending is possible again.
  await expect(page.getByTestId('comment-send')).toBeEnabled();
  await toast.getByTestId('toast-action').click();
  await expectMarkdown(input, /!\[Broken\]\(http/, 15_000);

  // SVG (may contain scripts) and text are never uploaded.
  await input.fill('');
  const second = page.waitForEvent('filechooser');
  await page.locator('.comment-box').getByTestId('image-button').click();
  await (await second).setFiles({ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') });
  await expect(page.getByTestId('toast').filter({ hasText: 'not uploaded' }).getByTestId('toast-detail')).toContainText('Images only');
});

test('A Drive link alone on a line becomes a player (only once visible), other links stay links', async ({ page }) => {
  const id = '1KcvfrHQXoFu0QfuEdTfUwP-Pj2NxSHnl';
  const frames: string[] = [];
  await page.route('https://drive.google.com/**', async (route) => {
    frames.push(route.request().url());
    await route.fulfill({ contentType: 'text/html', body: '<body style="background:#222;color:#fff;font:14px sans-serif">Drive player (test)</body>' });
  });
  const filler = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1}`).join('\n\n');
  await freshIssue(
    page,
    [
      'A normal link at the top: https://example.com/page',
      `Inside a sentence it stays a link: https://drive.google.com/file/d/${id}/view?usp=sharing see above`,
      filler,
      `https://drive.google.com/file/d/${id}/view?usp=sharing`,
      '',
      `[Flow as a video](https://drive.google.com/file/d/${id}/view)`,
    ].join('\n'),
  );
  // The app's CSP: only Drive (and Clerk's bot protection) may be embedded.
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', /frame-src https:\/\/drive\.google\.com /);
  const desc = page.getByTestId('detail-description');
  const embeds = desc.locator('.drive-embed');
  await expect(embeds).toHaveCount(2);
  // Further down, not visible yet: no player loaded.
  await expect(desc.locator('iframe')).toHaveCount(0);
  expect(frames).toEqual([]);
  await expect(desc.locator('a[href="https://example.com/page"]')).toBeVisible();
  await expect(desc.locator(`p a[href^="https://drive.google.com/file/d/${id}/view"]`)).toHaveCount(1);
  await embeds.first().scrollIntoViewIfNeeded();
  const frame = desc.locator('iframe').first();
  await expect(frame).toHaveAttribute('src', `https://drive.google.com/file/d/${id}/preview`);
  await expect(page.frameLocator('.drive-embed iframe').first().locator('body')).toContainText('Drive player');
  await expect(embeds.nth(1).locator('.drive-open')).toHaveText('Flow as a video · Open in Drive');
  await expect(embeds.nth(1).locator('.drive-open')).toHaveAttribute('target', '_blank');
});
