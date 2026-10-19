// Data export (SELF-46): Settings → Data export downloads one ZIP with JSON, Markdown and images.
// The ZIP is read back with the backup's reader (tooling/backup/snapshot.mjs).
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { api, backend, uploadImage } from '../support/helpers.ts';

const snapshotModule = new URL('../../tooling/backup/snapshot.mjs', import.meta.url).href;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);

test('Export all data: one ZIP with JSON, Markdown and the images of descriptions', async ({ page }) => {
  const url = await uploadImage(PNG);
  const token = url.split('/img/')[1]!;
  const meta = await backend().query(api.meta.get, {});
  const team = meta.teams.find((t) => t.key === 'ORB')!;
  const title = `Export ${Date.now()}`;
  const { issues } = await backend().mutation(api.issues.create, { issues: [{ teamId: team._id, title, description: `Screenshot\n\n![shot](${url})` }] });
  await backend().mutation(api.comments.add, { issueId: issues[0]!.id, body: 'A comment for the export' });

  await page.goto('/settings/export');
  await expect(page.getByTestId('settings-page')).toHaveAttribute('data-section', 'export');
  const download = page.waitForEvent('download');
  await page.getByTestId('data-export-run').click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^selfbound-export-\d{4}-\d{2}-\d{2}\.zip$/);
  await expect(page.getByTestId('data-export-done')).toBeVisible();

  const { readZip } = (await import(snapshotModule)) as { readZip: (buf: Buffer) => Map<string, Buffer> };
  const entries = readZip(readFileSync(await file.path()));
  const manifest = JSON.parse(entries.get('json/manifest.json')!.toString('utf8'));
  expect(manifest).toMatchObject({ format: 'selfbound-export', version: 1, source: 'app' });
  expect(manifest.tables.issues).toBeGreaterThan(0);
  const exported = JSON.parse(entries.get('json/issues.json')!.toString('utf8')) as { title: string }[];
  expect(exported.map((i) => i.title)).toContain(title);
  // Agent key hashes never leave the instance.
  expect(entries.get('json/agents.json')!.toString('utf8')).not.toContain('keyHash');
  expect(entries.has('json/oauthTokens.json')).toBe(false);

  const identifier = issues[0]!.identifier;
  const md = [...entries].find(([name]) => name.startsWith(`markdown/issues/ORB/${identifier} `))?.[1].toString('utf8');
  expect(md).toContain(`# ${identifier} ${title}`);
  expect(md).toContain(`![shot](../../../files/images/${token}.png)`);
  expect(md).toContain('A comment for the export');
  expect(entries.get(`files/images/${token}.png`)?.length).toBe(PNG.length);
  expect(entries.get('markdown/README.md')!.toString('utf8')).toContain('# Selfbound export');
});
