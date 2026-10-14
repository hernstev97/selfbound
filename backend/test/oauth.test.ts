import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from '../convex/_generated/api';
import { pkceChallenge } from '../convex/lib/oauth/core';
import { APP_URL, expectCode, fixture, setup, type Client, type T } from './helpers';

// OAuth for connectors (claude.ai, ChatGPT) over HTTP: metadata, registration only while armed,
// approval by the owner, tokens, MCP call as a connector, rotation, revocation.

type Json = Record<string, any>;

const SITE = 'http://127.0.0.1:3211';
const RESOURCE = `${SITE}/mcp`;
const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const CHATGPT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const VERIFIER = 'v'.repeat(20) + '-._~' + 'w'.repeat(30);

afterEach(() => {
  vi.useRealTimers();
});

/** Only freezes the clock (scheduler and promises run normally). */
function clock() {
  vi.useFakeTimers({ toFake: ['Date'] });
  let now = Date.UTC(2026, 9, 10, 12);
  vi.setSystemTime(now);
  return (ms: number) => vi.setSystemTime((now += ms));
}

const form = (fields: Record<string, string>, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(fields).toString(),
});

async function register(t: T, meta: Json = {}) {
  const r = await t.fetch('/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [CLAUDE], token_endpoint_auth_method: 'none', client_name: 'Claude', ...meta }),
  });
  return { status: r.status, body: (await r.json()) as Json };
}

async function authorize(t: T, clientId: string, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLAUDE,
    code_challenge: await pkceChallenge(VERIFIER),
    code_challenge_method: 'S256',
    state: 'state-1',
    resource: RESOURCE,
    scope: 'xlr8 offline_access',
    ...extra,
  });
  return await t.fetch(`/oauth/authorize?${params}`);
}

const requestOf = (r: Response) => new URL(r.headers.get('location')!).searchParams.get('request')!;

async function token(t: T, fields: Record<string, string>, headers: Record<string, string> = {}) {
  const r = await t.fetch('/oauth/token', form(fields, headers));
  return { status: r.status, body: (await r.json()) as Json, headers: r.headers };
}

/** Arm, register, authorize, approve: returns client and code. */
async function approved(t: T, owner: Client, name = 'claude.ai') {
  await owner.mutation(api.oauth.arm, { on: true });
  const { body: reg } = await register(t);
  const request = requestOf(await authorize(t, reg.client_id));
  const { redirect } = await owner.action(api.oauth.decide, { request, approve: true, name });
  const back = new URL(redirect);
  return { clientId: reg.client_id as string, code: back.searchParams.get('code')!, back, request };
}

async function connect(t: T, owner: Client, name?: string) {
  const a = await approved(t, owner, name);
  const tokens = await token(t, {
    grant_type: 'authorization_code',
    code: a.code,
    code_verifier: VERIFIER,
    redirect_uri: CLAUDE,
    client_id: a.clientId,
    resource: RESOURCE,
  });
  expect(tokens.status, JSON.stringify(tokens.body)).toBe(200);
  return { ...a, access: tokens.body.access_token as string, refresh: tokens.body.refresh_token as string };
}

async function mcp(t: T, bearer: string | null, method = 'tools/call', params: Json = { name: 'list_teams', arguments: {} }) {
  const r = await t.fetch('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-11-25',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: r.status, body: (await r.json()) as Json, challenge: r.headers.get('www-authenticate') };
}

async function connectorAgents(owner: Client) {
  return (await owner.query(api.ops.status, {})).agents.filter((a) => a.connector !== null);
}

describe('OAuth off (no XLR8_APP_URL)', () => {
  test('everything 404, 401 without challenge, approval impossible', async () => {
    const { t, owner } = setup();
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/oauth/authorize']) {
      expect((await t.fetch(path)).status, path).toBe(404);
    }
    expect((await t.fetch('/oauth/register', { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await mcp(t, null)).challenge).toBeNull();
    expect((await owner.query(api.ops.status, {})).connectors).toEqual({ enabled: false, url: null });
    await expectCode(owner.action(api.oauth.decide, { request: 'x', approve: false }), 'invalid');
    expect(await (await t.fetch('/health')).json()).toMatchObject({ oauth: false });
  });
});

describe('OAuth on', () => {
  test('metadata, 401 with challenge (not for agent keys), CORS', async () => {
    const { t, owner } = setup({ oauth: true });
    const prm = await (await t.fetch('/.well-known/oauth-protected-resource/mcp')).json();
    expect(prm).toEqual({
      resource: RESOURCE,
      authorization_servers: [SITE],
      bearer_methods_supported: ['header'],
      scopes_supported: ['xlr8'],
      resource_name: 'Selfbound',
    });
    expect(await (await t.fetch('/.well-known/oauth-protected-resource')).json()).toEqual(prm);
    const as = (await (await t.fetch('/.well-known/oauth-authorization-server')).json()) as Json;
    expect(as).toMatchObject({ issuer: SITE, token_endpoint: `${SITE}/oauth/token`, authorization_response_iss_parameter_supported: true });
    expect((await t.fetch('/.well-known/openid-configuration')).status).toBe(404);
    const pre = await t.fetch('/oauth/token', { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');

    const none = await mcp(t, null);
    expect(none.status).toBe(401);
    expect(none.challenge).toBe(`Bearer resource_metadata="${SITE}/.well-known/oauth-protected-resource/mcp", scope="xlr8"`);
    expect((await mcp(t, `xlr8_at_${'A'.repeat(43)}`)).challenge).toMatch(/error="invalid_token"/);
    // Agent keys: still 401 without challenge, valid keys work.
    const wrong = await mcp(t, 'xlr8_wrong');
    expect(wrong.status).toBe(401);
    expect(wrong.challenge).toBeNull();
    const { key } = await owner.action(api.agents.create, { name: 'Claude Code' });
    expect((await mcp(t, key)).status).toBe(200);
    expect(await (await t.fetch('/health')).json()).toMatchObject({ oauth: true });
    expect((await owner.query(api.ops.status, {})).connectors).toEqual({ enabled: true, url: RESOURCE });
  });

  test('registration only while armed and only for Claude and ChatGPT', async () => {
    const { t, owner, stranger } = setup({ oauth: true });
    expect(await register(t)).toMatchObject({ status: 400, body: { error: 'invalid_client_metadata' } });
    await expectCode(stranger.mutation(api.oauth.arm, { on: true }), 'access_denied');
    await owner.mutation(api.oauth.arm, { on: true });
    expect((await owner.query(api.ops.status, {})).connectorsArmedUntil).toBeGreaterThan(Date.now());
    const ok = await register(t);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ client_id: expect.stringMatching(/^xlr8-claude-/), token_endpoint_auth_method: 'none', redirect_uris: [CLAUDE] });
    expect(ok.body.client_secret).toBeUndefined();
    expect(await register(t, { redirect_uris: ['https://evil.example/cb'] })).toMatchObject({ status: 400, body: { error: 'invalid_redirect_uri' } });
    const gpt = await register(t, { redirect_uris: [CHATGPT], token_endpoint_auth_method: 'client_secret_post' });
    expect(gpt.body).toMatchObject({ client_id: expect.stringMatching(/^xlr8-chatgpt-/), client_secret: expect.stringMatching(/^xlr8_cs_/) });
    // Stored only as a hash.
    const stored = await t.run(async (ctx) => await ctx.db.query('oauthClients').collect());
    expect(JSON.stringify(stored)).not.toContain(gpt.body.client_secret);
  });

  test('full flow: approval by the owner, tokens, change with the connector as source', async () => {
    const { t, owner, stranger } = setup({ oauth: true });
    const f = await fixture(owner);
    await owner.mutation(api.oauth.arm, { on: true });
    const { body: reg } = await register(t);

    // Unknown client or wrong redirect: a page, no redirect.
    const unknown = await authorize(t, 'xlr8-claude-nonexistent');
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get('location')).toBeNull();
    expect((await authorize(t, reg.client_id, { redirect_uri: CHATGPT })).status).toBe(400);
    // Errors after the redirect is verified: back to the client, with state and iss.
    const plain = await authorize(t, reg.client_id, { code_challenge_method: 'plain' });
    expect(plain.status).toBe(302);
    expect(Object.fromEntries(new URL(plain.headers.get('location')!).searchParams)).toMatchObject({
      error: 'invalid_request',
      state: 'state-1',
      iss: SITE,
    });

    const start = await authorize(t, reg.client_id);
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(`${APP_URL}/oauth/consent`);
    const request = requestOf(start);

    await expectCode(stranger.query(api.oauth.request, { request }), 'access_denied');
    await expectCode(stranger.action(api.oauth.decide, { request, approve: true, name: 'x' }), 'access_denied');
    expect(await owner.query(api.oauth.request, { request })).toMatchObject({
      state: 'pending',
      app: 'claude',
      clientName: 'Claude',
      redirectHost: 'claude.ai',
      suggestedName: 'claude.ai',
    });
    expect(await owner.query(api.oauth.request, { request: 'nonexistent' })).toEqual({ state: 'unknown' });
    // App builds from before the rename send the legacy argument name `anfrage`.
    expect(await owner.query(api.oauth.request, { anfrage: request })).toMatchObject({ state: 'pending' });
    await expectCode(owner.query(api.oauth.request, {}), 'invalid');

    const { redirect } = await owner.action(api.oauth.decide, { request, approve: true, name: '  Claude  on phone ' });
    const back = new URL(redirect);
    expect(back.origin + back.pathname).toBe(CLAUDE);
    expect(back.searchParams.get('state')).toBe('state-1');
    expect(back.searchParams.get('iss')).toBe(SITE);
    const code = back.searchParams.get('code')!;
    expect(code).toMatch(/^xlr8_ac_/);
    // Disarmed; the request is handled.
    expect((await owner.query(api.ops.status, {})).connectorsArmedUntil).toBeNull();
    await expectCode(owner.action(api.oauth.decide, { request, approve: true, name: 'x' }), 'conflict');

    const tokens = await token(t, {
      grant_type: 'authorization_code',
      code,
      code_verifier: VERIFIER,
      redirect_uri: CLAUDE,
      client_id: reg.client_id,
      resource: RESOURCE,
    });
    expect(tokens.status).toBe(200);
    expect(tokens.headers.get('cache-control')).toBe('no-store');
    expect(tokens.body).toMatchObject({
      access_token: expect.stringMatching(/^xlr8_at_/),
      refresh_token: expect.stringMatching(/^xlr8_rt_/),
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'xlr8',
    });
    const stored = await t.run(async (ctx) => await ctx.db.query('oauthTokens').collect());
    expect(stored).toHaveLength(2);
    expect(JSON.stringify(stored)).not.toContain(tokens.body.access_token);

    const created = await mcp(t, tokens.body.access_token, 'tools/call', {
      name: 'create_issues',
      arguments: { requestId: 'req-oauth-0001', issues: [{ team: 'ORB', title: 'From the phone' }] },
    });
    expect(created.status).toBe(200);
    expect(created.body.result.isError).toBeUndefined();
    const detail = await mcp(t, tokens.body.access_token, 'tools/call', { name: 'get_issue', arguments: { identifier: 'ORB-1' } });
    expect(detail.body.result.structuredContent.createdBy).toBe('Claude on phone (agent)');

    const [agent] = await connectorAgents(owner);
    expect(agent).toMatchObject({ name: 'Claude on phone', keyPrefix: null, connector: { app: 'claude' }, revokedAt: null, callsToday: 2 });
    const issue = await t.run(async (ctx) => await ctx.db.query('issues').withIndex('by_team_number', (q) => q.eq('teamId', f.orb)).first());
    expect(issue?.createdBy).toEqual({ kind: 'agent', agentId: agent!._id });
  });

  test('code only once: redeeming it again revokes the connector', async () => {
    const { t, owner } = setup({ oauth: true });
    const c = await connect(t, owner);
    const again = await token(t, { grant_type: 'authorization_code', code: c.code, code_verifier: VERIFIER, redirect_uri: CLAUDE, client_id: c.clientId });
    expect(again).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    expect((await connectorAgents(owner))[0]).toMatchObject({ revokedReason: 'code_reuse', revokedAt: expect.any(Number) });
    const r = await mcp(t, c.access);
    expect(r.status).toBe(401);
    expect(r.challenge).toMatch(/invalid_token/);
  });

  test('wrong verifier, wrong redirect, other client: invalid_grant, the code is dead afterwards', async () => {
    const { t, owner } = setup({ oauth: true });
    const a = await approved(t, owner);
    const wrong = await token(t, { grant_type: 'authorization_code', code: a.code, code_verifier: 'x'.repeat(43), redirect_uri: CLAUDE, client_id: a.clientId });
    expect(wrong).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    const late = await token(t, { grant_type: 'authorization_code', code: a.code, code_verifier: VERIFIER, redirect_uri: CLAUDE, client_id: a.clientId });
    expect(late.body.error).toBe('invalid_grant');
    expect(await connectorAgents(owner)).toEqual([]);

    const b = await approved(t, owner);
    expect((await token(t, { grant_type: 'authorization_code', code: b.code, code_verifier: VERIFIER, redirect_uri: CHATGPT, client_id: b.clientId })).body.error).toBe('invalid_grant');
    const c = await approved(t, owner);
    expect((await token(t, { grant_type: 'authorization_code', code: c.code, code_verifier: VERIFIER, redirect_uri: CLAUDE, client_id: b.clientId })).body.error).toBe('invalid_grant');
    expect((await token(t, { grant_type: 'authorization_code', code: c.code, code_verifier: VERIFIER, client_id: 'unknown' })).status).toBe(401);
    expect((await token(t, { grant_type: 'password', client_id: c.clientId })).body.error).toBe('unsupported_grant_type');
    expect((await token(t, { grant_type: 'authorization_code', code: c.code, code_verifier: VERIFIER, client_id: c.clientId, resource: 'https://x/mcp' })).body.error).toBe('invalid_target');
  });

  test('refresh: rotation, short grace period, reuse afterwards → revoked', async () => {
    const tick = clock();
    const { t, owner } = setup({ oauth: true });
    const c = await connect(t, owner);
    tick(50 * 60_000);
    const first = await token(t, { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId });
    expect(first.status).toBe(200);
    expect(first.body.refresh_token).not.toBe(c.refresh);
    expect((await mcp(t, first.body.access_token)).status).toBe(200);
    // Retry within the grace period (e.g. a second device): works.
    tick(30_000);
    expect((await token(t, { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId })).status).toBe(200);
    // Another client with the token: nothing.
    expect((await token(t, { grant_type: 'refresh_token', refresh_token: first.body.refresh_token, client_id: 'xlr8-claude-other' })).status).toBe(401);
    // After the grace period: stolen → connector revoked, the new tokens are dead too.
    tick(2 * 60_000);
    const reuse = await token(t, { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId });
    expect(reuse).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    expect((await connectorAgents(owner))[0]).toMatchObject({ revokedReason: 'refresh_reuse' });
    expect((await mcp(t, first.body.access_token)).status).toBe(401);
    expect((await token(t, { grant_type: 'refresh_token', refresh_token: first.body.refresh_token, client_id: c.clientId })).body.error).toBe('invalid_grant');
  });

  test('access token expires after an hour, then refresh helps', async () => {
    const tick = clock();
    const { t, owner } = setup({ oauth: true });
    const c = await connect(t, owner);
    expect((await mcp(t, c.access)).status).toBe(200);
    tick(61 * 60_000);
    const expired = await mcp(t, c.access);
    expect(expired.status).toBe(401);
    expect(expired.challenge).toMatch(/invalid_token/);
    const renewed = await token(t, { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId });
    expect((await mcp(t, renewed.body.access_token)).status).toBe(200);
  });

  test('revoking in the settings takes effect immediately; revocation by the app', async () => {
    const { t, owner } = setup({ oauth: true });
    const a = await connect(t, owner, 'claude.ai');
    const [agent] = await connectorAgents(owner);
    await owner.mutation(api.agents.revoke, { agentId: agent!._id });
    expect((await mcp(t, a.access)).status).toBe(401);
    expect((await token(t, { grant_type: 'refresh_token', refresh_token: a.refresh, client_id: a.clientId })).body.error).toBe('invalid_grant');
    expect((await connectorAgents(owner))[0]).toMatchObject({ revokedReason: 'owner' });
    expect(await t.run(async (ctx) => await ctx.db.query('oauthTokens').collect())).toEqual([]);

    const b = await connect(t, owner, 'second connection');
    const revoked = await t.fetch('/oauth/revoke', form({ token: b.refresh, client_id: b.clientId }));
    expect(revoked.status).toBe(200);
    expect((await mcp(t, b.access)).status).toBe(401);
    const agents = await connectorAgents(owner);
    expect(agents.map((x) => [x.name, x.revokedReason])).toEqual([
      ['second connection', 'client'],
      ['claude.ai', 'owner'],
    ]);
    // Unknown token: 200 anyway (RFC 7009).
    expect((await t.fetch('/oauth/revoke', form({ token: 'whatever', client_id: b.clientId }))).status).toBe(200);
  });

  test('deny, not armed, expired', async () => {
    const tick = clock();
    const { t, owner } = setup({ oauth: true });
    await owner.mutation(api.oauth.arm, { on: true });
    const { body: reg } = await register(t);
    const first = requestOf(await authorize(t, reg.client_id));
    const { redirect } = await owner.action(api.oauth.decide, { request: first, approve: false });
    expect(Object.fromEntries(new URL(redirect).searchParams)).toMatchObject({ error: 'access_denied', state: 'state-1', iss: SITE });
    expect(await owner.query(api.oauth.request, { request: first })).toMatchObject({ state: 'denied' });

    // Disarmed (e.g. a planted link): approval fails.
    await owner.mutation(api.oauth.arm, { on: false });
    const second = requestOf(await authorize(t, reg.client_id));
    await expectCode(owner.action(api.oauth.decide, { request: second, approve: true, name: 'x' }), 'access_denied');

    // A new request of the same client replaces the old one; an expired one cannot be approved.
    await owner.mutation(api.oauth.arm, { on: true });
    const third = requestOf(await authorize(t, reg.client_id));
    expect(await owner.query(api.oauth.request, { request: second })).toEqual({ state: 'unknown' });
    tick(16 * 60_000);
    await owner.mutation(api.oauth.arm, { on: true });
    await expectCode(owner.action(api.oauth.decide, { request: third, approve: true, name: 'x' }), 'invalid');
  });

  test('client with secret: Basic or form, rejected without the secret', async () => {
    const { t, owner } = setup({ oauth: true });
    await owner.mutation(api.oauth.arm, { on: true });
    const { body: reg } = await register(t, { redirect_uris: [CHATGPT], token_endpoint_auth_method: 'client_secret_basic' });
    const request = requestOf(await authorize(t, reg.client_id, { redirect_uri: CHATGPT }));
    const { redirect } = await owner.action(api.oauth.decide, { request, approve: true, name: 'ChatGPT' });
    const code = new URL(redirect).searchParams.get('code')!;
    const fields = { grant_type: 'authorization_code', code, code_verifier: VERIFIER, redirect_uri: CHATGPT };
    expect((await token(t, { ...fields, client_id: reg.client_id })).status).toBe(401);
    expect((await token(t, { ...fields, client_id: reg.client_id, client_secret: 'xlr8_cs_wrong' })).status).toBe(401);
    const basic = `Basic ${btoa(`${encodeURIComponent(reg.client_id)}:${encodeURIComponent(reg.client_secret)}`)}`;
    const ok = await token(t, fields, { Authorization: basic });
    expect(ok.status).toBe(200);
    expect((await connectorAgents(owner))[0]).toMatchObject({ name: 'ChatGPT', connector: { app: 'chatgpt' } });
    const refreshed = await token(t, { grant_type: 'refresh_token', refresh_token: ok.body.refresh_token, client_id: reg.client_id, client_secret: reg.client_secret });
    expect(refreshed.status).toBe(200);
  });

  test('cleanup: expired tokens, old requests, never approved clients', async () => {
    const tick = clock();
    const { t, owner } = setup({ oauth: true });
    const c = await connect(t, owner);
    await owner.mutation(api.oauth.arm, { on: true });
    await register(t); // never approved
    tick(2 * 24 * 60 * 60_000);
    const result = await t.mutation(internal.oauth.cleanup, {});
    expect(result).toMatchObject({ tokens: 1, requests: 1, clients: 1, more: false });
    // The refresh token (30 days) is still alive, and so is the approved client.
    expect((await token(t, { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId })).status).toBe(200);
  });
});
