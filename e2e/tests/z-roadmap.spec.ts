// Roadmap and progress per team (SELF-113): release view, progress tracker, the issue's public card,
// the team settings and the image export with public issues only.
// The file name starts with "z-" so it runs last: it creates the sample team EMB (seed.roadmapDemo),
// which must not show up in the other tests (team cards, sprint planning).
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { api, backend, open, resolve, settled, uploadImage } from '../support/helpers.ts';

/** A real (decodable) PNG of one color. */
function png(width: number, height: number, rgb: [number, number, number]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set(rgb, y * (width * 3 + 1) + 1 + x * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

/** Chunk types of a PNG file. */
function chunks(bytes: Buffer) {
  const out: string[] = [];
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    out.push(bytes.toString('ascii', at + 4, at + 8));
    at += 12 + length;
  }
  return out;
}

test.beforeAll(async () => {
  const images = [];
  for (const rgb of [[200, 110, 40], [90, 60, 40], [160, 40, 30], [120, 120, 120], [210, 140, 60], [60, 80, 100]] as [number, number, number][]) images.push(await uploadImage(png(64, 36, rgb)));
  await backend().mutation(api.seed.roadmapDemo, { images });
});

async function roadmap(page: Page, path = '/team/EMB/roadmap') {
  await open(page, '/team/EMB');
  await page.goto(path);
  await expect(page.getByTestId('roadmap-page')).toBeVisible();
  await expect(page.getByTestId('roadmap-card').first()).toBeVisible();
}

test('Sidebar entry and G R; columns follow the project order, categories in label order', async ({ page }) => {
  await open(page, '/team/EMB');
  await expect(page.getByTestId('nav-team-EMB-roadmap')).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('r');
  await expect(page).toHaveURL(/\/team\/EMB\/roadmap$/);
  const columns = page.getByTestId('roadmap-column');
  await expect(columns).toHaveCount(4);
  await expect(columns.locator('h2')).toHaveText(['Etappe 1 · Erster Funke', 'Etappe 2 · Die Gießerei', 'Etappe 3 · Unter Asche', 'Etappe 4 · Glutkern']);
  await expect(columns.first().getByTestId('roadmap-column-count')).toHaveText('7 of 7 done');
  const categories = columns.first().getByTestId('roadmap-category').locator('.rm-group-name');
  await expect(categories).toHaveText(['Figuren', 'Orte', 'Gegner', 'Fähigkeiten', 'Klang und Grafik', 'Technik']);
  // The public title replaces the title on the card; the internal one is the hint below.
  const hero = page.getByTestId('roadmap-card').filter({ hasText: 'Die Glutritterin' });
  await expect(hero.locator('.rm-card-internal')).toHaveText('Held: Grundbewegung und Ausweichrolle');
  await expect(hero.locator('.rm-card-summary')).toContainText('Die erste Heldin');
});

test('Fold a category and all of them; filters: only public, category, stage', async ({ page }) => {
  await roadmap(page);
  const first = page.getByTestId('roadmap-column').first();
  const figures = first.getByTestId('roadmap-category').first();
  await figures.getByTestId('roadmap-category-toggle').click();
  await expect(figures.getByTestId('roadmap-card')).toHaveCount(0);
  await expect(figures.getByTestId('roadmap-category-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('roadmap-toggle-all').click();
  await expect(page.getByTestId('roadmap-card')).toHaveCount(0);
  await page.keyboard.press('z');
  await expect(page.getByTestId('roadmap-card')).not.toHaveCount(0);

  const all = await page.getByTestId('roadmap-card').count();
  await page.getByTestId('roadmap-public-only').click();
  await expect(page.getByTestId('roadmap-card')).toHaveCount(16);
  expect(all).toBeGreaterThan(16);
  await expect(page.getByTestId('roadmap-card').filter({ hasText: 'Spoiler' })).toHaveCount(0);
  await page.getByTestId('roadmap-public-only').click();

  await page.getByTestId('roadmap-filter-category').filter({ hasText: 'Gegner' }).click();
  await expect(page.getByTestId('roadmap-category')).toHaveCount(4);
  await page.getByTestId('roadmap-filter-stage').and(page.locator('[data-stage="done"]')).click();
  await expect(page.getByTestId('roadmap-card')).toHaveCount(3);
  await page.getByTestId('roadmap-filter-clear').click();
  await expect(page.getByTestId('roadmap-card')).toHaveCount(all);
  // The filters are remembered per team.
  await page.reload();
  await expect(page.getByTestId('roadmap-card')).toHaveCount(all);
});

test('A card opens beside the roadmap (editable), Esc closes it, Enter opens its page', async ({ page }) => {
  await roadmap(page);
  await page.getByTestId('roadmap-card').filter({ hasText: 'Der erste Kreis' }).click();
  const beside = page.getByTestId('roadmap-beside');
  await expect(beside).toBeVisible();
  await expect(beside.getByTestId('detail-key')).toHaveText('EMB-2');
  await expect(beside.locator('[data-testid="detail-public-toggle"]:visible')).toHaveAttribute('aria-checked', 'true');
  // J moves the focus and the issue beside follows.
  await page.keyboard.press('j');
  await expect(beside.getByTestId('detail-key')).not.toHaveText('EMB-2');
  await page.keyboard.press('Escape');
  await expect(beside).toHaveCount(0);
  // Keyboard alone: arrows across columns, Enter opens beside, Enter again the page.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('roadmap-beside')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/issue\/EMB-\d+$/);
  await page.goBack();
  await expect(page.getByTestId('roadmap-page')).toBeVisible();
});

test('Progress: rows with counts, zoom, today, unfold to the issues, rows by category', async ({ page }) => {
  await roadmap(page);
  await page.keyboard.press('2');
  await expect(page).toHaveURL(/\/team\/EMB\/roadmap\/progress$/);
  const rows = page.getByTestId('progress-row');
  await expect(rows).toHaveCount(4);
  await expect(rows.getByTestId('progress-count')).toHaveText(['7/7', '2/10', '0/5', '0/3']);
  await expect(rows.first().locator('.pg-bar.done')).toBeVisible();
  await expect(rows.first().locator('.pg-dot')).toHaveCount(7);
  // Planned stages: a dashed span up to the end of their quarter.
  await expect(rows.nth(2).locator('.pg-plan')).toBeVisible();
  await page.getByTestId('progress-zoom-year').click();
  await expect(page.getByTestId('progress-zoom-year')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('progress-today').click();
  await rows.first().locator('.pg-name').click();
  await expect(page.getByTestId('progress-issue')).toHaveCount(7);
  await page.keyboard.press('z');
  await expect(page.getByTestId('progress-issue')).toHaveCount(0);
  await page.getByTestId('progress-rows-categories').click();
  await expect(page.getByTestId('progress-row').locator('.pg-title')).toHaveText(['Figuren', 'Orte', 'Gegner', 'Fähigkeiten', 'Klang und Grafik', 'Technik']);
  await page.getByTestId('progress-rows-projects').click();
});

test('Issue page: make public, public title and summary, cover image from the issue; history', async ({ page }) => {
  const target = (await resolve('EMB-5'))!;
  // An image in the description becomes a choice for the cover.
  const image = await uploadImage(png(48, 27, [30, 140, 200]));
  const detail = await backend().query(api.issues.detail, { id: target.id as never });
  await backend().mutation(api.issues.setDescription, { id: target.id as never, markdown: `Speicherstand.\n\n![shot](${image})`, baseVersion: detail!.body.version });
  await open(page, '/issue/EMB-5');
  const card = page.locator('[data-testid="detail-public"]:visible');
  await expect(card.getByTestId('detail-public-toggle')).toHaveAttribute('aria-checked', 'false');
  await card.getByTestId('detail-public-toggle').click();
  await expect(card.getByTestId('detail-public-toggle')).toHaveAttribute('aria-checked', 'true');
  await card.getByTestId('detail-public-title').fill('Fortschritt bleibt');
  await card.getByTestId('detail-public-summary').click();
  await card.getByTestId('detail-public-summary').fill('Zwischen den Läufen bleibt der Fortschritt erhalten.');
  await card.getByTestId('detail-public-title').click();
  await card.locator('.pub-thumb').first().click();
  await expect(card.getByTestId('detail-public-image')).toBeVisible();
  await settled(page);
  await expect.poll(async () => (await backend().query(api.issues.detail, { id: target.id as never }))?.publicCard).toEqual({ title: 'Fortschritt bleibt', summary: 'Zwischen den Läufen bleibt der Fortschritt erhalten.', image });
  // Ctrl Z takes back the public switch (not the texts).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+z');
  await expect(card.getByTestId('detail-public-toggle')).toHaveAttribute('aria-checked', 'false');
  // Redo is offered once the server confirmed the undo.
  await settled(page);
  await page.keyboard.press('Control+Shift+z');
  await expect(card.getByTestId('detail-public-toggle')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('activity')).toContainText(/public|öffentlich/i);
});

test('Image export: only public issues, PNG without text chunks, under 8 MB, download and size', async ({ page }) => {
  await roadmap(page);
  await page.getByTestId('roadmap-export').click();
  const dialog = page.getByTestId('roadmap-export-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('export-image')).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByTestId('export-info')).toContainText('1920 ×');
  const data = await page.evaluate(() => (window as unknown as { __selfboundRoadmapExport: { data: unknown; size: number; width: number } }).__selfboundRoadmapExport);
  const text = JSON.stringify(data.data);
  // Not public, internal titles, identifiers, descriptions: none of it reaches the picture's data.
  for (const secret of ['Spoiler', 'Wächter 2', 'Tiegelwächter', 'Ladezeiten', 'Held: Grundbewegung', 'EMB-', 'Ein spielbarer Lauf']) expect(text, secret).not.toContain(secret);
  expect(text).toContain('Die Glutritterin');
  expect(data.size).toBeLessThan(8 * 1024 * 1024);
  expect(data.width).toBe(1920);

  await dialog.getByTestId('export-portrait').click();
  await dialog.getByTestId('export-light').click();
  await dialog.getByTestId('export-view-progress').click();
  await expect(dialog.getByTestId('export-info')).toContainText('1080 ×', { timeout: 15_000 });
  const download = page.waitForEvent('download');
  await dialog.getByTestId('export-download').click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^emberfall-progress-\d{4}-\d{2}-\d{2}\.png$/);
  const bytes = readFileSync((await file.path())!);
  expect(bytes.subarray(1, 4).toString()).toBe('PNG');
  expect(chunks(bytes).filter((c) => !['IHDR', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'iCCP', 'pHYs', 'PLTE', 'tRNS'].includes(c))).toEqual([]);
  expect(bytes.readUInt32BE(16)).toBe(1080);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('Team settings: stage per status changes the cards; turning the roadmap off removes the entry', async ({ page }) => {
  await open(page, '/team/EMB');
  await page.goto('/settings/teams/EMB');
  const section = page.getByTestId('team-roadmap');
  await expect(section).toBeVisible();
  await section.locator('[data-testid="team-roadmap-stage"][data-state="In Review"]').selectOption('progress');
  await expect.poll(async () => (await backend().query(api.meta.get, {})).teams.find((t) => t.key === 'EMB')?.roadmap?.stages?.length).toBe(1);
  await page.goto('/team/EMB/roadmap');
  await expect(page.getByTestId('roadmap-card').filter({ hasText: 'Die Gießerei' }).locator('.rm-stage')).toHaveText(/In progress/);
  await page.goto('/settings/teams/EMB');
  await page.getByTestId('team-roadmap-on').click();
  await expect(page.getByTestId('nav-team-EMB-roadmap')).toHaveCount(0);
  await settled(page);
  await page.goto('/team/EMB/roadmap');
  await expect(page.getByTestId('roadmap-off')).toBeVisible();
  await page.getByTestId('roadmap-turn-on').click();
  await expect(page.getByTestId('roadmap-card').first()).toBeVisible();
});
