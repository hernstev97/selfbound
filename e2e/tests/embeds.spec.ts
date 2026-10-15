// Embeds (XLR8-73): a YouTube or X link alone on a line becomes a card. The backend cache is seeded
// (no provider is contacted). Checks: nothing is requested from YouTube or X before the click,
// the player loads from youtube-nocookie.com only after it, links in a sentence and gone posts stay
// links, phone width and light/dark.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { api, backend, open, settled } from '../support/helpers.ts';

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

const VIDEO = 'dQw4w9WgXcQ';
const POST = '1585341984679469056';
const GONE = '1585341984679469057';
const PROVIDER_HOSTS = /(^|\.)(youtube\.com|youtube-nocookie\.com|ytimg\.com|youtu\.be|twimg\.com|x\.com|twitter\.com)$/;

/** Solid-color PNG (bytes as base64). */
function png(width: number, height: number, [r, g, b]: [number, number, number]) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

test.beforeAll(async () => {
  const client = backend();
  await client.action(api.embeds.seedForTest, {
    provider: 'youtube',
    id: VIDEO,
    status: 'ok',
    title: 'Demo video: keyboard-first planning',
    author: 'Demo channel',
    media: [{ slot: 'thumb', kind: 'thumb', base64: png(480, 360, [70, 90, 160]), width: 480, height: 360 }],
  });
  await client.action(api.embeds.seedForTest, {
    provider: 'x',
    id: POST,
    status: 'ok',
    author: 'Demo Author',
    handle: 'demo_user',
    text: 'Shipping a small thing today.\nSecond line of the post, with example.com/post in it.',
    createdAt: Date.parse('2026-10-14T09:30:00Z'),
    media: [
      { slot: 'avatar', kind: 'avatar', base64: png(73, 73, [200, 120, 60]) },
      { slot: 'm0', kind: 'photo', base64: png(800, 450, [60, 150, 110]), width: 800, height: 450, alt: 'A green demo picture' },
    ],
  });
  await client.action(api.embeds.seedForTest, { provider: 'x', id: GONE, status: 'unavailable', media: [] });
});

async function freshIssue(page: Page, description: string) {
  const meta = await backend().query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  const { issues } = await backend().mutation(api.issues.create, { issues: [{ teamId: team._id, title: `Embeds ${Date.now()}`, description }] });
  await open(page, `/issue/${issues[0].identifier}`);
  return issues[0];
}

const description = [
  `In a sentence it stays a link: https://youtu.be/${VIDEO} (see above)`,
  '',
  `https://www.youtube.com/watch?v=${VIDEO}&t=1m30s`,
  '',
  `[A post worth reading](https://x.com/demo_user/status/${POST})`,
  '',
  `https://x.com/demo_user/status/${GONE}`,
].join('\n');

test('Cards for YouTube and X; nothing is requested from the providers before the click', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', (request) => {
    const host = new URL(request.url()).hostname;
    if (PROVIDER_HOSTS.test(host)) requested.push(request.url());
  });
  await page.route('https://www.youtube-nocookie.com/**', async (route) => {
    await route.fulfill({ contentType: 'text/html', body: '<body style="background:#222;color:#fff;font:14px sans-serif">Player (test)</body>' });
  });
  await freshIssue(page, description);
  const desc = page.getByTestId('detail-description');

  const youtube = desc.getByTestId('embed-youtube');
  const post = desc.getByTestId('embed-x');
  await expect(youtube).toBeVisible();
  await expect(youtube).toContainText('Demo video: keyboard-first planning');
  await expect(youtube).toContainText('Demo channel');
  await expect(youtube.locator('img')).toHaveAttribute('src', /^http:\/\/127\.0\.0\.1:\d+\/embed\/youtube\/dQw4w9WgXcQ\/thumb$/);
  await expect(post).toContainText('Demo Author');
  await expect(post).toContainText('@demo_user');
  await expect(post).toContainText('Shipping a small thing today.');
  await expect(post.locator('img[alt="A green demo picture"]')).toBeVisible();
  await expect(post.locator('img.emb-avatar')).toHaveAttribute('src', /\/embed\/x\/1585341984679469056\/avatar$/);
  await expect(post.getByRole('link', { name: 'Open on X' })).toHaveAttribute('href', `https://x.com/demo_user/status/${POST}`);

  // The cards replace the plain links; sentence links and unavailable posts stay links.
  await expect(desc.locator('.embed')).toHaveCount(3);
  await expect(desc.locator('.embed:has([data-testid="embed-youtube"]) > a.embed-link')).toBeHidden();
  await expect(desc.locator(`p a[href="https://youtu.be/${VIDEO}"]`)).toBeVisible();
  const gone = desc.locator(`.embed a.embed-link[href="https://x.com/demo_user/status/${GONE}"]`);
  await expect(gone).toBeVisible();
  await expect(gone).toHaveAttribute('target', '_blank');
  await expect(desc.getByTestId('embed-x')).toHaveCount(1);

  // Not a single request to YouTube, X or their CDNs so far.
  await page.waitForTimeout(300);
  expect(requested).toEqual([]);
  await expect(desc.locator('iframe')).toHaveCount(0);

  // Click: now the player loads from youtube-nocookie.com (start time from the link).
  await youtube.getByTestId('embed-play').click();
  const frame = youtube.locator('iframe');
  await expect(frame).toHaveAttribute('src', `https://www.youtube-nocookie.com/embed/${VIDEO}?autoplay=1&rel=0&playsinline=1&start=90`);
  await expect(page.frameLocator('[data-testid="embed-youtube"] iframe').locator('body')).toContainText('Player (test)');
  // The click did not start editing the description.
  await expect(desc.locator('textarea, [contenteditable="true"]')).toHaveCount(0);
  expect(requested.every((url) => url.startsWith('https://www.youtube-nocookie.com/'))).toBe(true);
});

test('Without a start time in the link the player starts at the beginning', async ({ page }) => {
  await page.route('https://www.youtube-nocookie.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<body>Player</body>' }));
  await freshIssue(page, `https://www.youtube.com/watch?v=${VIDEO}`);
  const card = page.getByTestId('detail-description').getByTestId('embed-youtube');
  await card.getByTestId('embed-play').click();
  await expect(card.locator('iframe')).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&playsinline=1');
});

test('The CSP lets youtube-nocookie.com be framed, nothing else new', async ({ page }) => {
  await freshIssue(page, 'x');
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toMatch(/frame-src [^;]*https:\/\/www\.youtube-nocookie\.com /);
  expect(csp).not.toMatch(/youtube\.com |twimg|x\.com/);
});

test('Comments get cards too', async ({ page }) => {
  const issue = await freshIssue(page, 'with a comment');
  await backend().mutation(api.comments.add, { issueId: issue.id, body: `Look at this:\n\nhttps://x.com/demo_user/status/${POST}` });
  await expect(page.getByTestId('embed-x').first()).toContainText('Demo Author');
});

test.describe('phone', () => {
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true });

  test('cards fit the screen without sideways scrolling', async ({ page }) => {
    await freshIssue(page, description);
    const post = page.getByTestId('embed-x');
    await expect(post).toBeVisible();
    await expect(post.locator('img[alt="A green demo picture"]')).toBeVisible();
    for (const card of [page.getByTestId('embed-youtube'), post]) {
      const box = (await card.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(360);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    const dir = process.env.EMBED_SHOTS;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      await post.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => [...document.images].every((img) => img.complete || img.getBoundingClientRect().top > innerHeight));
      writeFileSync(`${dir}/embeds-phone.png`, await page.screenshot());
    }
  });
});

for (const scheme of ['dark', 'light'] as const) {
  test(`${scheme} theme: the card is readable and has an edge`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 1500 }); // lazy images below the fold load too
    await freshIssue(page, description);
    const post = page.getByTestId('embed-x');
    await expect(post).toBeVisible();
    const colors = await post.evaluate((el) => {
      const style = getComputedStyle(el);
      return { bg: style.backgroundColor, text: getComputedStyle(el.querySelector('.emb-text')!).color };
    });
    expect(colors.bg).not.toBe(colors.text);
    const dir = process.env.EMBED_SHOTS;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      await page.waitForFunction(() => [...document.images].every((img) => img.complete));
      writeFileSync(`${dir}/embeds-${scheme}.png`, await page.screenshot({ clip: { x: 244, y: 60, width: 880, height: 1100 } }));
    }
  });
}
