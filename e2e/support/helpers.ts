import { expect, type Locator, type Page } from '@playwright/test';
import { ConvexHttpClient } from 'convex/browser';
import { readFileSync } from 'node:fs';
import { api } from '@xlr8/backend/api';
import { BACKEND_PORT, BACKEND_URL, state } from './env.ts';

/** A second client (like an agent or a second device), with the local test token. */
export function backend() {
  const client = new ConvexHttpClient(BACKEND_URL);
  client.setAuth(readFileSync(state('token'), 'utf8'));
  return client;
}

export { api };

/** Waits until the server has confirmed all changes (otherwise they are lost when the page closes). */
export async function settled(page: Page) {
  await page.waitForFunction(() => ((window as unknown as { __xlr8?: { saves: { confirmed?: number; failed?: boolean }[] } }).__xlr8?.saves ?? []).every((s) => s.confirmed !== undefined || s.failed));
}

/** Opens a page and waits for the list (or the detail view). */
export async function open(page: Page, path = '/all?group=none&order=created') {
  await page.goto(path);
  await expect(page.locator('[data-testid="issue-row"], [data-testid="issue-card"], [data-testid="empty-state"], [data-testid="detail"]').first()).toBeVisible();
  // The order is final only once all buckets came from the server (not just the IndexedDB mirror).
  await page.waitForFunction(() => (window as unknown as { __xlr8?: { app?: { store: { sync: { get(): { phase: string } } } } } }).__xlr8?.app?.store.sync.get().phase === 'live');
  // Move the mouse out of the list, otherwise hover moves the focus.
  await page.mouse.move(2, 890);
}

export const focusedRow = (page: Page) => page.locator('[data-testid="issue-row"].focused');
export const row = (page: Page, id: string) => page.locator(`[data-testid="issue-row"][data-id="${id}"]`);

export async function setRejectWrites(value: boolean) {
  await backend().mutation(api.admin.setRejectWrites, { value });
}

/** The issue for an identifier, via the server. */
export async function resolve(identifier: string) {
  return await backend().query(api.issues.resolve, { identifier });
}

let agentKey: Promise<string> | null = null;

/** A real agent over MCP (key created once per run). Returns the tool result. */
export async function agentCall(tool: string, args: Record<string, unknown>) {
  agentKey ??= backend()
    .action(api.agents.create, { name: 'E2E-Agent' })
    .then((r) => r.key);
  const response = await fetch(`http://127.0.0.1:${BACKEND_PORT + 1}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${await agentKey}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const body = (await response.json()) as { result?: { isError?: boolean; content?: { text: string }[] }; error?: unknown };
  if (!response.ok || body.error || body.result?.isError) throw new Error(`MCP ${tool}: ${response.status} ${JSON.stringify(body)}`);
  return body.result;
}

/** Uploads an image via the server (like the app) and returns the /img URL for Markdown. */
export async function uploadImage(bytes: Uint8Array<ArrayBuffer>, type = 'image/png') {
  const client = backend();
  const uploadUrl = await client.mutation(api.files.generateUploadUrl, {});
  const response = await fetch(uploadUrl, { method: 'POST', headers: { 'Content-Type': type }, body: bytes });
  const { storageId } = (await response.json()) as { storageId: never };
  return (await client.action(api.files.register, { storageId })).url;
}

/**
 * WCAG contrast of the computed text or outline color against the surface behind it (ancestor
 * backgrounds composited). An outline with an outward offset sits on the parent's surface.
 */
export async function contrast(target: Locator, part: 'text' | 'outline' = 'text') {
  return await target.evaluate((el, part) => {
    // Canvas converts any CSS color (oklch, color-mix …) to sRGB.
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    const rgba = (color: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0]!, d[1]!, d[2]!, d[3]! / 255] as const;
    };
    const over = (top: readonly number[], below: readonly number[]) => [0, 1, 2].map((i) => top[i]! * top[3]! + below[i]! * (1 - top[3]!)).concat(1);
    const lum = (c: readonly number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
    };
    const style = getComputedStyle(el);
    const layers: (readonly number[])[] = [];
    for (let n: Element | null = part === 'outline' && parseFloat(style.outlineOffset) >= 0 ? el.parentElement : el; n; n = n.parentElement) layers.unshift(rgba(getComputedStyle(n).backgroundColor));
    const bg = layers.reduce((below, top) => over(top, below), [255, 255, 255, 1]);
    const fg = over(rgba(part === 'text' ? style.color : style.outlineColor), bg);
    const [a, b] = [lum(fg), lum(bg)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }, part);
}

/** Markdown of an input: the editor (getter `markdown`) or the textarea (`value`) while it loads. */
export async function markdownOf(field: Locator) {
  return await field.evaluate((el) => (el as HTMLElement & { markdown?: string }).markdown ?? (el as HTMLTextAreaElement).value ?? '');
}

/** Waits until the field has the text (the editor reports in batches). */
export async function expectMarkdown(field: Locator, expected: string | RegExp, timeout = 7000) {
  const poll = expect.poll(() => markdownOf(field), { timeout });
  if (typeof expected === 'string') await poll.toBe(expected);
  else await poll.toMatch(expected);
}
