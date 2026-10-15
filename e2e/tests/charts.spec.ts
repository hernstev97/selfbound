// Data charts (```chart, JSON): stat tiles, stacked and 100 % areas, lines with a reference and
// markers, bars (grouped, stacked, 100 %, horizontal), heatmap. Drawn lazily in the shown text,
// light and dark, with a tooltip, a table view and a readable note when the spec is wrong.
import { expect, test, type Page } from '@playwright/test';
import { api, backend, open, settled } from '../support/helpers.ts';

const created: string[] = [];

test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await settled(page);
  if (created.length) await backend().mutation(api.issues.remove, { ids: created.splice(0) as never[] });
});

async function freshIssue(page: Page, description = '') {
  const meta = await backend().query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  const { issues } = await backend().mutation(api.issues.create, { issues: [{ teamId: team._id, title: `Charts ${Date.now()}`, description }] });
  created.push(issues[0].id);
  await open(page, `/issue/${issues[0].identifier}`);
  await expect(page.getByTestId('detail-loading')).toHaveCount(0);
  return issues[0];
}

const fence = (spec: unknown) => `\`\`\`chart\n${JSON.stringify(spec, null, 2)}\n\`\`\``;

// Demo data (made up): no real numbers anywhere.
const weeks = Array.from({ length: 28 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 6, 6 + i * 7));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
});
const wave = (i: number, phase: number, amp: number) => Math.sin(i / 3 + phase) * amp;
const SHARE = {
  type: 'area',
  stack: 'percent',
  title: 'Model B went from 0 to half of all runs in 3 days',
  subtitle: 'Share of runs per week, by model family (demo data).',
  x: weeks,
  series: [
    { name: 'Model A', values: weeks.map((_, i) => (i < 20 ? 45 + wave(i, 0, 4) : Math.max(1, 45 - (i - 19) * 22))) },
    { name: 'Model B', values: weeks.map((_, i) => (i < 23 ? 0 : (i - 22) * 12)) },
    { name: 'Model C', values: weeks.map((_, i) => 18 + wave(i, 2, 3)) },
    { name: 'Model D', values: weeks.map((_, i) => 14 + wave(i, 4, 2)) },
    { name: 'Other', values: weeks.map(() => 12) },
  ],
  rules: [{ x: weeks[23], label: 'Model B ships' }],
};
const HEAT = {
  type: 'heatmap',
  title: 'Peak is Thursday 3 PM',
  subtitle: 'Runs started by weekday and hour (demo data).',
  rows: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  columns: Array.from({ length: 24 }, (_, h) => (h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`)),
  values: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((_, d) => Array.from({ length: 24 }, (_, h) => Math.round((d > 4 ? 40 : 100) * Math.exp(-(((h - 15) / 5) ** 2)) + 8 + ((d * 7 + h * 3) % 5)))),
  legend: { low: 'fewer', high: 'more' },
};
const LORENZ = {
  type: 'line',
  title: 'The top 10% of users send 65% of runs',
  subtitle: 'Cumulative share of runs, users sorted from heaviest to lightest. The diagonal is equal use.',
  x: Array.from({ length: 21 }, (_, i) => i * 5),
  xUnit: '%',
  unit: '%',
  yMin: 0,
  yMax: 100,
  reference: 'diagonal',
  series: [{ name: 'Share of runs', values: Array.from({ length: 21 }, (_, i) => Math.round(100 * (1 - (1 - (i * 5) / 100) ** 4.3))) }],
  markers: [
    { x: 5, label: 'top 5% → 61%' },
    { x: 25, label: 'top 25% → 94%' },
  ],
};
const DENSITY = {
  type: 'line',
  title: 'A run in tool B takes about twice as long as in tool A',
  subtitle: 'Completed runs by wall time (demo data).',
  unit: '%',
  x: ['1s', '3s', '10s', '30s', '1m', '3m', '10m', '30m', '1h'],
  series: [
    { name: 'Tool A', values: [0.6, 1.4, 4.2, 7.1, 6.4, 3.6, 1.2, 0.4, 0.1] },
    { name: 'Tool B', values: [0, 0.2, 2.9, 5.6, 6.1, 4.8, 2.4, 0.8, 0.3] },
  ],
};
const EFFORT = {
  type: 'bar',
  orientation: 'horizontal',
  stack: 'percent',
  title: 'Tool B users pick low effort 3x as often',
  subtitle: 'Effort level on completed runs that report one (demo data).',
  categories: ['Tool A', 'Tool B'],
  series: [
    { name: 'low', values: [3, 11] },
    { name: 'medium', values: [23, 30] },
    { name: 'high', values: [55, 39] },
    { name: 'xhigh', values: [13, 13] },
    { name: 'max', values: [6, 7] },
  ],
};
const STATS = {
  type: 'stat',
  items: [
    { label: 'users sent a run', value: '85.0k' },
    { label: 'runs sent', value: '24.0M', delta: '+12% vs last month', trend: [4, 5, 5, 7, 6, 8, 9, 9, 11, 12, 12, 14] },
    { label: 'runs, median user', value: '27' },
    { label: 'of runs from top 1%', value: '18%' },
  ],
};
const COLUMNS = {
  type: 'bar',
  title: 'Issues done per week',
  categories: ['W1', 'W2', 'W3', 'W4', 'W5', 'W6'],
  unit: '',
  series: [
    { name: 'Bugs', values: [4, 6, 3, 8, 5, 7] },
    { name: 'Features', values: [2, 3, 5, 4, 6, 9] },
  ],
};

test('Charts draw in the shown text, light and dark; the chunk loads only for texts with a chart', async ({ page }, testInfo) => {
  const chunks: string[] = [];
  // The lazy chunk is named after the renderer (match the name part only, a hash may contain any letters)
  page.on('request', (r) => /\/assets\/chart-[\w-]+\.js$/.test(new URL(r.url()).pathname) && chunks.push(r.url()));
  await freshIssue(page, 'No chart here.');
  await expect(page.getByTestId('detail-description')).toContainText('No chart here');
  await page.waitForTimeout(400);
  expect(chunks).toEqual([]);

  await freshIssue(page, [STATS, SHARE, HEAT, LORENZ, DENSITY, EFFORT, COLUMNS].map(fence).join('\n\n'));
  const blocks = page.getByTestId('detail-description').locator('.vblock');
  await expect(blocks).toHaveCount(7);
  for (let i = 0; i < 7; i++) {
    await blocks.nth(i).scrollIntoViewIfNeeded();
    await expect(blocks.nth(i)).toHaveAttribute('data-state', 'ready');
  }
  expect(chunks.length).toBeGreaterThan(0);
  await expect(blocks.nth(0).locator('.vchart-stat')).toHaveCount(4);
  await expect(blocks.nth(1).locator('svg path[fill^="var(--chart-"]')).toHaveCount(5);
  await expect(blocks.nth(1).locator('.vc-rule-label')).toHaveText('Model B ships');
  await expect(blocks.nth(2).locator('.vc-cell')).toHaveCount(7 * 24);
  await expect(blocks.nth(3).locator('circle')).toHaveCount(2 + 1); // two markers + the hover dot
  await expect(blocks.nth(4).locator('.vchart-legend li')).toHaveCount(2);
  await expect(blocks.nth(5).locator('.vc-in-label').first()).toBeVisible();
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    const names = ['stats', 'share', 'heatmap', 'cumulative', 'lines', 'effort', 'columns'];
    for (let i = 0; i < 7; i++) {
      await blocks.nth(i).scrollIntoViewIfNeeded();
      const image = await blocks.nth(i).screenshot({ path: testInfo.outputPath(`chart-${names[i]}-${scheme}.png`) });
      await testInfo.attach(`chart-${names[i]}-${scheme}`, { body: image, contentType: 'image/png' });
    }
  }
  await page.emulateMedia({ colorScheme: 'dark' });
});

test('Hover and keyboard: crosshair with one tooltip for all series, per-cell and per-bar tooltips, table view', async ({ page }, testInfo) => {
  await freshIssue(page, [SHARE, HEAT, COLUMNS].map(fence).join('\n\n'));
  const blocks = page.getByTestId('detail-description').locator('.vblock');
  const area = blocks.nth(0);
  await expect(area).toHaveAttribute('data-state', 'ready');
  const svg = area.locator('svg.vchart-svg');
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + 100);
  const tip = area.locator('.vchart-tip');
  await expect(tip).toBeVisible();
  await expect(tip.locator('.vchart-tip-row')).toHaveCount(5);
  await expect(tip.locator('.vchart-tip-title')).not.toBeEmpty();
  const image = await area.screenshot({ path: testInfo.outputPath('chart-tooltip.png') });
  await testInfo.attach('chart-tooltip', { body: image, contentType: 'image/png' });
  await page.mouse.move(box.x - 40, box.y - 40);
  await expect(tip).toBeHidden();
  // Keyboard: focus the plot, arrows move the crosshair
  await svg.focus();
  await page.keyboard.press('ArrowRight');
  await expect(tip).toBeVisible();
  const first = await tip.locator('.vchart-tip-title').textContent();
  await page.keyboard.press('ArrowRight');
  expect(await tip.locator('.vchart-tip-title').textContent()).not.toBe(first);
  await page.keyboard.press('Escape');
  await expect(tip).toBeHidden();

  // Heatmap cell
  const heat = blocks.nth(1);
  await heat.scrollIntoViewIfNeeded();
  await heat.locator('.vc-cell').nth(3 * 24 + 15).hover();
  await expect(heat.locator('.vchart-tip')).toContainText('Thu · 3p');
  // Bar
  const bars = blocks.nth(2);
  await bars.scrollIntoViewIfNeeded();
  await bars.locator('svg.vchart-svg rect[fill="transparent"]').first().hover();
  await expect(bars.locator('.vchart-tip')).toBeVisible();

  // Table view with every value
  await area.locator('.vchart-toggle').click();
  await expect(area.locator('table.vchart-table tbody tr')).toHaveCount(28);
  await expect(area.locator('svg.vchart-svg')).toHaveCount(0);
  await area.locator('.vchart-toggle').click();
  await expect(area.locator('svg.vchart-svg')).toHaveCount(1);
});

test('Wrong specs keep the source and say what is wrong; labels are text, never markup', async ({ page }) => {
  await freshIssue(
    page,
    [
      '```chart\n{ "type": "bar", "categories": ["a", "b"], "series": [{ "name": "x", "values": [1] }] }\n```',
      '```chart\nnot json\n```',
      '```chart\n{ "type": "pie" }\n```',
      fence({ type: 'bar', title: '<img src=x onerror="window.__xss=1">', categories: ['<b>a</b>', 'b'], series: [{ name: '<script>window.__xss=2</script>', values: [1, 2] }] }),
    ].join('\n\n'),
  );
  const blocks = page.getByTestId('detail-description').locator('.vblock');
  await expect(blocks).toHaveCount(4);
  for (let i = 0; i < 3; i++) await expect(blocks.nth(i)).toHaveAttribute('data-state', 'error');
  await expect(blocks.nth(0).locator('.vblock-error')).toContainText('"series[0].values" has 1 values, "categories" has 2');
  await expect(blocks.nth(0).locator('pre')).toBeVisible();
  await expect(blocks.nth(1).locator('.vblock-error')).toContainText('Invalid JSON');
  await expect(blocks.nth(2).locator('.vblock-error')).toContainText('Unknown chart type "pie"');
  await expect(blocks.nth(3)).toHaveAttribute('data-state', 'ready');
  await expect(blocks.nth(3).locator('.vchart-title')).toContainText('<img src=x');
  await expect(blocks.nth(3).locator('img, script, b')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test('Editor: "/" inserts a chart with a live preview that follows the JSON', async ({ page }) => {
  const issue = await freshIssue(page, 'Start');
  await page.getByTestId('detail-description').locator('p').first().click();
  const editor = page.getByTestId('desc-editor');
  await expect(editor).toBeFocused();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/chart (');
  await expect(page.getByTestId('slash-menu').getByTestId('slash-item').first()).toHaveAttribute('data-id', 'chart');
  await page.keyboard.press('Enter');
  const preview = editor.locator('.vblock-preview');
  await expect(preview.locator('.vchart-title')).toHaveText('Issues done per week');
  await expect(preview.locator('svg.vchart-svg')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await backend().query(api.issues.detail, { id: issue.id as never }))!.body.markdown).toContain('"type": "bar"');
});
