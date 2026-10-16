// Desired model per issue (XLR8-93): the step-by-step picker on the issue page, inheritance shown
// dimmed with its source, Settings › Models and the team default. The seed enables three models of a
// small sample catalog (backend/data/models.ts), so nothing here contacts models.dev.
import { expect, test } from '@playwright/test';
import { api, backend, open, settled } from '../support/helpers.ts';

const created: string[] = [];
test.afterAll(async () => {
  if (created.length) await backend().mutation(api.issues.remove, { ids: created as never });
  const meta = await backend().query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  await backend().mutation(api.teams.update, { teamId: team._id, defaultModel: null });
});

async function fresh(title: string, parentId?: string) {
  const meta = await backend().query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  const { issues } = await backend().mutation(api.issues.create, { issues: [{ teamId: team._id, title, status: 'todo', ...(parentId ? { parentId: parentId as never } : {}) }] });
  created.push(issues[0].id);
  return issues[0];
}

async function modelOf(id: string) {
  const { maxSeq } = await backend().query(api.meta.counter, {});
  for (let bucket = Math.floor(maxSeq / 64); bucket >= 0; bucket--) {
    const hit = (await backend().query(api.issues.bucket, { bucket })).find((d) => d._id === id);
    if (hit) return hit.model ?? null;
  }
  return null;
}

test('Shift+M: provider, model, effort, speed; the sub-issue inherits it, dimmed with the source', async ({ page }) => {
  const parent = await fresh(`Model parent ${Date.now()}`);
  const child = await fresh(`Model child ${Date.now()}`, parent.id);
  await open(page, `/issue/${parent.identifier}`);
  const chip = page.getByTestId('detail-model');
  await expect(chip).toContainText('Choose model');

  await page.keyboard.press('Shift+M');
  const picker = page.locator('[data-testid="palette"][data-kind="model"]');
  await expect(picker).toBeVisible();
  await picker.getByText('Anthropic', { exact: true }).click();
  await expect(picker.getByText('1M context').first()).toBeVisible();
  await picker.getByText('Claude Opus 5.5', { exact: true }).click();
  // Effort: typing filters the step, Enter goes on to the speed.
  await page.keyboard.type('xh');
  await page.keyboard.press('Enter');
  await expect(picker.getByText('Standard speed')).toBeVisible();
  // Esc goes back one step, not out of the picker.
  await page.keyboard.press('Escape');
  await expect(picker.getByText('Default effort')).toBeVisible();
  await page.keyboard.type('xh');
  await page.keyboard.press('Enter');
  await picker.getByText('fast', { exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(chip).toHaveText('Claude Opus 5.5 · xhigh · fast');
  await expect(page.getByTestId('detail-model-note')).toHaveText('1M context');
  await settled(page);
  expect(await modelOf(parent.id)).toEqual({ provider: 'anthropic', modelId: 'claude-opus-5-5', effort: 'xhigh', speed: 'fast' });

  await open(page, `/issue/${child.identifier}`);
  await expect(page.getByTestId('detail-model')).toHaveText('Claude Opus 5.5 · xhigh · fast');
  await expect(page.getByTestId('detail-model').locator('.val')).toHaveClass(/inherited/);
  await expect(page.getByTestId('detail-model-note')).toContainText(`From parent ${parent.identifier}`);

  // Undo puts the parent back to no model.
  await open(page, `/issue/${parent.identifier}`);
  await page.keyboard.press('Shift+M');
  await picker.getByText('No model', { exact: true }).click();
  await expect(page.getByTestId('detail-model')).toContainText('Choose model');
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('detail-model')).toHaveText('Claude Opus 5.5 · xhigh · fast');
  await settled(page);
});

test('Settings › Models: enable a model by provider, then the team default inherits into issues', async ({ page }) => {
  await page.goto('/settings/models');
  const enabled = page.getByTestId('models-enabled');
  await expect(enabled.getByTestId('model-row')).toHaveCount(3);
  await page.getByTestId('models-provider').selectOption('google');
  const gemini = page.getByTestId('models-catalog').locator('[data-model="google/gemini-3.8-flash"]');
  await gemini.getByTestId('model-toggle').click();
  await expect(enabled.locator('[data-model="google/gemini-3.8-flash"]')).toBeVisible();
  // Search across providers.
  await page.getByTestId('models-provider').selectOption('');
  await page.getByTestId('models-search').fill('sonnet');
  await expect(page.getByTestId('models-catalog').getByTestId('model-row')).toHaveCount(1);
  await enabled.locator('[data-model="google/gemini-3.8-flash"]').getByTestId('model-toggle').click();
  await expect(enabled.getByTestId('model-row')).toHaveCount(3);

  await page.goto('/settings/teams/ORB');
  await page.getByTestId('team-model-model').selectOption('anthropic/claude-sonnet-5-5');
  await page.getByTestId('team-model-effort').selectOption('high');
  await settled(page);
  const issue = await fresh(`Team default ${Date.now()}`);
  await open(page, `/issue/${issue.identifier}`);
  await expect(page.getByTestId('detail-model')).toHaveText('Claude Sonnet 5.5 · high');
  await expect(page.getByTestId('detail-model-note')).toContainText('Default of Orbit');
});
