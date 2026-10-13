// OAuth integration test (connectors): the official MCP SDK client signs in via OAuth like
// claude.ai, against the real local endpoint. Flow: 401 with challenge → metadata → registration
// (DCR) → /oauth/authorize → approval by the owner (instead of the browser: oauth.decide) →
// tokens → tools as a connector → refresh → revocation in the settings → 401.

import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { auth, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../convex/_generated/api.js';

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

/** Storage of a client like claude.ai; the redirect to the browser is only recorded. */
function provider() {
  const store = { client: undefined, tokens: undefined, verifier: undefined, authorizationUrl: undefined };
  return {
    store,
    get redirectUrl() {
      return CALLBACK;
    },
    get clientMetadata() {
      return { client_name: 'Integration test (like Claude)', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
    },
    clientInformation: () => store.client,
    saveClientInformation: (info) => void (store.client = info),
    tokens: () => store.tokens,
    saveTokens: (tokens) => void (store.tokens = tokens),
    redirectToAuthorization: (url) => void (store.authorizationUrl = url),
    saveCodeVerifier: (v) => void (store.verifier = v),
    codeVerifier: () => store.verifier,
  };
}

export async function oauthSuite(backend, log) {
  const admin = new ConvexHttpClient(backend.url);
  admin.setAuth(backend.token);
  const url = new URL(`${backend.siteUrl}/mcp`);
  const p = provider();

  // 1. Not armed: registration is rejected, the client gets no further.
  const blocked = new StreamableHTTPClientTransport(url, { authProvider: provider() });
  await assert.rejects(new Client({ name: 'x', version: '1' }).connect(blocked), /not accepting new connectors|invalid_client_metadata/);
  log('OAuth: no registration without "Connect connector"');

  // 2. Arm, connect: 401 → registration → redirect to the consent page.
  await admin.mutation(api.oauth.arm, { on: true });
  const transport = new StreamableHTTPClientTransport(url, { authProvider: p });
  await assert.rejects(new Client({ name: 'xlr8-oauth', version: '1' }).connect(transport), UnauthorizedError);
  assert.match(p.store.client.client_id, /^xlr8-claude-/);
  const authorizationUrl = p.store.authorizationUrl;
  assert.equal(authorizationUrl.searchParams.get('resource'), url.href);
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
  const toConsent = await fetch(authorizationUrl, { redirect: 'manual' });
  assert.equal(toConsent.status, 302);
  const consent = new URL(toConsent.headers.get('location'));
  assert.equal(consent.pathname, '/oauth/consent');
  const request = consent.searchParams.get('request');
  assert.ok(request);

  // 3. The owner approves (normally in the browser), the code goes back to the app.
  const { redirect } = await admin.action(api.oauth.decide, { request, approve: true, name: 'Integration test connector' });
  const back = new URL(redirect);
  assert.equal(back.searchParams.get('iss'), backend.siteUrl);
  await transport.finishAuth(back.searchParams.get('code'));
  assert.match(p.store.tokens.access_token, /^xlr8_at_/);
  log('OAuth: registration, approval, tokens (PKCE, resource, iss)');

  // 4. Tools as a connector; the change records it as the source.
  const client = new Client({ name: 'xlr8-oauth', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(url, { authProvider: p }));
  const { tools } = await client.listTools();
  assert.equal(tools.length, 19);
  const { teamId } = await admin.mutation(api.teams.create, { key: 'OAU', name: 'OAuth' });
  assert.ok(teamId);
  const created = await client.callTool({ name: 'create_issues', arguments: { requestId: 'integration-oauth-0001', issues: [{ team: 'OAU', title: 'From the connector' }] } });
  assert.notEqual(created.isError, true, JSON.stringify(created.content));
  const detail = await client.callTool({ name: 'get_issue', arguments: { identifier: 'OAU-1' } });
  assert.equal(detail.structuredContent.createdBy, 'Integration test connector (agent)');
  await client.close();
  log('OAuth: tools/list, create_issues as a connector (source in the history)');

  // 5. Refresh with rotation: auth() with an existing refresh token renews (like Claude before expiry).
  const before = p.store.tokens;
  assert.equal(await auth(p, { serverUrl: url }), 'AUTHORIZED');
  const next = p.store.tokens;
  assert.notEqual(next.access_token, before.access_token);
  assert.notEqual(next.refresh_token, before.refresh_token);
  log('OAuth: refresh with a new refresh token (SDK auth())');

  // 6. Revoking in the settings → immediately 401 with a sign-in challenge.
  const status = await admin.query(api.ops.status, {});
  const connector = status.agents.find((a) => a.name === 'Integration test connector');
  assert.deepEqual(connector.connector, { app: 'claude' });
  await admin.mutation(api.agents.revoke, { agentId: connector._id });
  const after = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${next.access_token}`, 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-11-25' },
    body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
  });
  assert.equal(after.status, 401);
  assert.match(after.headers.get('www-authenticate') ?? '', /resource_metadata=.*error="invalid_token"/);
  log('OAuth: connector revoked → 401 invalid_token');
}
