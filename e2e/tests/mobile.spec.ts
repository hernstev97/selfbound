// Phone profiles (iPhone 13, Pixel 7): one column, drawer, detail full screen, create via "+".
import { expect, test } from '@playwright/test';
import { api, backend, expectMarkdown, open, settled, uploadImage } from '../support/helpers.ts';
import { deflateSync } from 'node:zlib';

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
});

test('List with large rows, detail full screen, back', async ({ page }) => {
  await page.goto('/team/ORB');
  const first = page.getByTestId('issue-row').first();
  await expect(first).toBeVisible();
  expect((await first.boundingBox())!.height).toBeGreaterThanOrEqual(50);
  await expect(page.getByTestId('sidebar')).not.toBeInViewport();
  await expect(page.getByTestId('mobile-bar')).toBeVisible();
  await first.tap();
  await expect(page.getByTestId('detail')).toBeVisible();
  const panel = (await page.getByTestId('panel').boundingBox())!;
  expect(panel.width).toBeGreaterThan((page.viewportSize()!.width ?? 0) - 2);
  await page.getByTestId('detail-back-mobile').tap();
  await expect(page.getByTestId('issue-row').first()).toBeVisible();
});

test('Inbox on a phone: no split, tapping opens the issue as its own page', async ({ page }) => {
  await page.goto('/inbox');
  const first = page.getByTestId('issue-row').first();
  await expect(first).toBeVisible();
  await expect(page.getByTestId('inbox-split')).toHaveCount(0);
  await first.tap();
  await expect(page).toHaveURL(/\/issue\//);
  await expect(page.getByTestId('detail')).toBeVisible();
  await page.getByTestId('detail-back-mobile').tap();
  await expect(page).toHaveURL(/\/inbox$/);
});

test('Sidebar as a drawer', async ({ page }) => {
  await page.goto('/team/ORB');
  await expect(page.getByTestId('issue-row').first()).toBeVisible();
  await page.getByTestId('mobile-menu').tap();
  await expect(page.getByTestId('sidebar')).toBeInViewport();
  await page.getByTestId('nav-triage').tap();
  await expect(page).toHaveURL(/\/triage/);
  await expect(page.getByTestId('sidebar')).not.toBeInViewport();
});

test('A long press opens the context menu, not the issue', async ({ page }) => {
  await page.goto('/team/ORB');
  const first = page.getByTestId('issue-row').first();
  await expect(first).toBeVisible();
  const box = (await first.boundingBox())!;
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  // Real touch via CDP: finger down, hold 700 ms, release.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.getByTestId('context-menu')).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.getByTestId('detail')).toHaveCount(0);
  await expect(page.getByTestId('context-menu')).toBeVisible();
});

test('Create via the round button', async ({ page }) => {
  await page.goto('/team/ORB');
  await expect(page.getByTestId('issue-row').first()).toBeVisible();
  await page.getByTestId('mobile-create').tap();
  await expect(page.getByTestId('create-dialog')).toBeVisible();
  await page.getByTestId('create-title').fill(`From the phone ${test.info().project.name}`);
  await page.getByTestId('create-submit').tap();
  await expect(page.getByTestId('issue-row').filter({ hasText: `From the phone ${test.info().project.name}` })).toBeVisible();
});

test('Picker on a phone: search field not focused right away, no shortcuts', async ({ page }) => {
  await page.goto('/team/ORB');
  await page.getByTestId('issue-row').first().tap();
  await expect(page.getByTestId('detail')).toBeVisible();
  await page.locator('.mobile-props .chip').first().tap();
  await expect(page.getByTestId('palette')).toBeVisible();
  await expect(page.getByTestId('palette-input')).not.toBeFocused();
  await expect(page.getByTestId('palette').locator('.shortcut, .kbd')).toHaveCount(0);
  await page.getByTestId('palette-overlay').tap({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId('palette')).toHaveCount(0);
});

/** A small single-color PNG (without a browser). */
function png(width: number, height: number) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8 bit
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x9a)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const file = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return new Uint8Array(file);
}

test('Image and Drive video in the detail on a phone: fit the width', async ({ page }) => {
  await page.route('https://drive.google.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<body>Drive player (test)</body>' }));
  const url = await uploadImage(png(1600, 900));
  const meta = await backend().query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  const { issues } = await backend().mutation(api.issues.create, {
    issues: [{ teamId: team._id, title: `Phone image ${Date.now()}`, description: `![Wide](${url})\n\nhttps://drive.google.com/file/d/1KcvfrHQXoFu0QfuEdTfUwP-Pj2NxSHnl/view` }],
  });
  await page.goto(`/issue/${issues[0].identifier}`);
  const img = page.getByTestId('detail-description').locator('img');
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(1600);
  const width = page.viewportSize()!.width;
  expect((await img.boundingBox())!.width).toBeLessThanOrEqual(width);
  const frame = page.getByTestId('detail-description').locator('.drive-embed iframe');
  await frame.scrollIntoViewIfNeeded();
  await expect(frame).toBeVisible();
  expect((await frame.boundingBox())!.width).toBeLessThanOrEqual(width);
});

test('Description editor on a phone: tap, type, check a task, the "/" menu fits on screen', async ({ page }) => {
  const meta = await backend().query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  const { issues } = await backend().mutation(api.issues.create, { issues: [{ teamId: team._id, title: `Phone editor ${Date.now()}`, description: '- [ ] Shopping\n- [ ] Packing' }] });
  await page.goto(`/issue/${issues[0].identifier}`);
  await page.getByTestId('detail-description').getByText('Packing').tap();
  const editor = page.getByTestId('desc-editor');
  await expect(editor).toBeFocused();
  // Tap the checkbox
  await editor.locator('li.task input').first().tap();
  await expectMarkdown(editor, '- [x] Shopping\n- [ ] Packing');
  await expect(editor.locator('li.task input').first()).toBeChecked();
  // Font at least 16 px (otherwise iOS zooms on focus)
  expect(await editor.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
  await page.keyboard.press('End');
  await page.keyboard.type(' and suitcase');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  const menu = page.getByTestId('slash-menu');
  await expect(menu).toBeInViewport();
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await menu.getByTestId('slash-item').filter({ hasText: 'Quote' }).tap();
  await page.keyboard.type('Do not forget');
  await expectMarkdown(editor, '- [x] Shopping\n- [ ] Packing and suitcase\n\n> Do not forget');
  await page.getByTestId('desc-done').tap();
  await expect(page.getByTestId('detail-description').locator('blockquote')).toHaveText('Do not forget');
  await settled(page);
  await backend().mutation(api.issues.remove, { ids: [issues[0].id] });
});

test('Board on a phone: columns almost as wide as the screen, swipe horizontally', async ({ page }) => {
  await open(page, '/team/ORB/all?layout=board');
  const first = page.getByTestId('board-column').first();
  await expect(first).toBeVisible();
  const width = await first.evaluate((el) => el.getBoundingClientRect().width / window.innerWidth);
  expect(width).toBeGreaterThan(0.8);
  const scrollable = await page.getByTestId('board').evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(scrollable).toBe(true);
  await expect(first.getByTestId('issue-card').first()).toBeVisible();
});
