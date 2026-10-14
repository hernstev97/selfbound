// Connectors (claude.ai, ChatGPT) via OAuth: "Connect connector" in the settings, registration and
// authorization like Claude does it (over HTTP), consent page in the browser, redirect back to
// claude.ai (intercepted), token, MCP call as a connector, revoking the connector in the list.
import { createHash, randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { api, backend, settled } from '../support/helpers.ts';
import { BACKEND_PORT } from '../support/env.ts';

const SITE = `http://127.0.0.1:${BACKEND_PORT + 1}`;
const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';

/** Registers a client like Claude and starts the authorization; returns the consent page URL. */
async function startFlow(request: APIRequestContext) {
  const reg = await request.post(`${SITE}/oauth/register`, {
    data: { redirect_uris: [CLAUDE], token_endpoint_auth_method: 'none', client_name: 'Claude' },
  });
  expect(reg.status()).toBe(201);
  const clientId = (await reg.json()).client_id as string;
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLAUDE,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'e2e-state',
    resource: `${SITE}/mcp`,
  });
  const authorize = await request.get(`${SITE}/oauth/authorize?${params}`, { maxRedirects: 0 });
  expect(authorize.status()).toBe(302);
  return { clientId, verifier, consentUrl: authorize.headers()['location']! };
}

/** Intercepts the redirect to claude.ai (the real page is never loaded). */
async function captureClaude(page: Page) {
  const seen: string[] = [];
  await page.route('https://claude.ai/**', async (route) => {
    seen.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'back at Claude' });
  });
  return seen;
}

const mcpCall = (token: string) =>
  fetch(`${SITE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_teams', arguments: {} } }),
  });

test('Connect a connector, approve, work as a connector, revoke', async ({ page, request }) => {
  await page.goto('/settings/agents');
  await expect(page.getByTestId('connector-url')).toHaveText(`${SITE}/mcp`);
  await page.getByTestId('connector-arm').click();
  await expect(page.getByTestId('connector-armed')).toContainText(/Accepting new connectors, 1\d:\d\d min left/);
  await settled(page);

  const flow = await startFlow(request);
  expect(new URL(flow.consentUrl).pathname).toBe('/oauth/consent');
  const seen = await captureClaude(page);
  await page.goto(flow.consentUrl);
  await expect(page.getByTestId('oauth-consent')).toContainText('Connect Claude to Selfbound?');
  await expect(page.getByTestId('oauth-host')).toHaveText('claude.ai');
  await expect(page.getByTestId('sidebar')).toHaveCount(0);
  await expect(page).toHaveURL(flow.consentUrl);
  await page.getByTestId('oauth-name').fill('E2E Claude');
  await page.getByTestId('oauth-approve').click();
  await expect.poll(() => seen.length).toBe(1);
  const back = new URL(seen[0]!);
  expect(back.origin + back.pathname).toBe(CLAUDE);
  expect(back.searchParams.get('state')).toBe('e2e-state');
  expect(back.searchParams.get('iss')).toBe(SITE);

  const token = await request.post(`${SITE}/oauth/token`, {
    form: { grant_type: 'authorization_code', code: back.searchParams.get('code')!, code_verifier: flow.verifier, redirect_uri: CLAUDE, client_id: flow.clientId },
  });
  expect(token.status()).toBe(200);
  const access = (await token.json()).access_token as string;
  expect((await mcpCall(access)).status).toBe(200);

  await page.goto('/settings/agents');
  // After the approval Selfbound no longer accepts new connectors.
  await expect(page.getByTestId('connector-arm')).toBeVisible();
  const row = page.locator('[data-testid="agent-row"][data-name="E2E Claude"]');
  await expect(row.getByTestId('agent-connector')).toHaveText('Connector · claude.ai');
  await expect(row).toContainText('1 today');
  await row.getByTestId('agent-revoke').click();
  await expect(page.getByTestId('agent-revoke-dialog')).toContainText('claude.ai loses access immediately');
  await page.getByTestId('agent-revoke-confirm').click();
  await expect(row.getByTestId('agent-revoked')).toBeVisible();
  await settled(page);
  const after = await mcpCall(access);
  expect(after.status).toBe(401);
  expect(after.headers.get('www-authenticate')).toContain('error="invalid_token"');
});

test('Consent page: no Allow without "Connect connector"; Deny returns to the app', async ({ page, request }) => {
  await backend().mutation(api.oauth.arm, { on: true });
  const flow = await startFlow(request);
  await backend().mutation(api.oauth.arm, { on: false });
  const seen = await captureClaude(page);
  await page.goto(flow.consentUrl);
  await expect(page.getByTestId('oauth-not-armed')).toBeVisible();
  await expect(page.getByTestId('oauth-approve')).toBeDisabled();
  // Arming (e.g. in another tab): the page notices at once.
  await backend().mutation(api.oauth.arm, { on: true });
  await expect(page.getByTestId('oauth-not-armed')).toHaveCount(0);
  await expect(page.getByTestId('oauth-approve')).toBeEnabled();
  await page.getByTestId('oauth-deny').click();
  await expect.poll(() => seen.length).toBe(1);
  expect(Object.fromEntries(new URL(seen[0]!).searchParams)).toMatchObject({ error: 'access_denied', state: 'e2e-state', iss: SITE });

  // The same request again: done. Unknown request: notice (also under the old German path and parameter).
  await page.goto(flow.consentUrl);
  await expect(page.getByTestId('oauth-done')).toBeVisible();
  await page.goto('/oauth/consent?request=doesnotexist');
  await expect(page.getByTestId('oauth-unknown')).toBeVisible();
  await page.goto('/oauth/freigabe?anfrage=doesnotexist');
  await expect(page.getByTestId('oauth-unknown')).toBeVisible();
  await backend().mutation(api.oauth.arm, { on: false });
});
