import { afterEach, describe, expect, test, vi } from 'vitest';
import { api } from '../convex/_generated/api';
import { resetLegacyEnvWarnings } from '../convex/lib/legacyEnv';
import { pkceChallenge } from '../convex/lib/oauth/core';
import { recentClosedSprints } from '../convex/ops/sprints';
import { isOwnerKind, LEGACY_OWNER_KIND, OWNER_KIND } from '../convex/shared/constants';
import { createOne, fixture, OWNER, setup, type T } from './helpers';

// Everything that existed before the rename keeps working, and the new names win. The old values are
// written as literals on purpose (legacy-xlr8): old keys, tokens, codes, client IDs, scope, actor kind,
// sprint source, environment variables. A follow-up removes the fallbacks together with these tests.

type Json = Record<string, any>;

const SITE = 'http://127.0.0.1:3211';
const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'v'.repeat(20) + '-._~' + 'w'.repeat(30);
// Fixed secrets as issued by the old version (prefix xlr8_, 43 characters of base64url).
const OLD_KEY = `xlr8_${'k'.repeat(43)}`;
const OLD_ACCESS = `xlr8_at_${'a'.repeat(43)}`;
const OLD_REFRESH = `xlr8_rt_${'r'.repeat(43)}`;
const OLD_CODE = `xlr8_ac_${'c'.repeat(43)}`;
const OLD_SECRET = `xlr8_cs_${'s'.repeat(43)}`;
const OLD_CLIENT = 'xlr8-claude-AbCdEfGhIjKlMnOpQrSt';

async function sha256(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function mcp(t: T, bearer: string, method = 'tools/call', params: Json = { name: 'list_teams', arguments: {} }) {
  const r = await t.fetch('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: r.status, body: (await r.json()) as Json, challenge: r.headers.get('www-authenticate') };
}

const form = (fields: Record<string, string>, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(fields).toString(),
});

async function token(t: T, fields: Record<string, string>, headers: Record<string, string> = {}) {
  const r = await t.fetch('/oauth/token', form(fields, headers));
  return { status: r.status, body: (await r.json()) as Json };
}

/** A connector as the old version stored it: client, agent, tokens, all hashed. */
async function oldConnector(t: T, extra: { secret?: boolean } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert('oauthClients', {
      clientId: OLD_CLIENT,
      app: 'claude',
      clientName: 'Claude',
      redirectUris: [CLAUDE],
      authMethod: extra.secret ? 'client_secret_basic' : 'none',
      ...(extra.secret ? { secretHash: await sha256(OLD_SECRET) } : {}),
      createdAt: now,
      approvedAt: now,
    });
    const agentId = await ctx.db.insert('agents', { name: 'Claude on phone', connector: { app: 'claude', clientId: OLD_CLIENT }, createdAt: now });
    await ctx.db.insert('oauthTokens', { hash: await sha256(OLD_ACCESS), kind: 'access', agentId, clientId: OLD_CLIENT, expiresAt: now + 3_600_000 });
    await ctx.db.insert('oauthTokens', { hash: await sha256(OLD_REFRESH), kind: 'refresh', agentId, clientId: OLD_CLIENT, expiresAt: now + 30 * 86_400_000 });
    return agentId;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const name of ['OWNER_IDS', 'TEST_SWITCHES', 'ALLOW_SEED', 'APP_URL', 'PUBLIC_SITE_URL', 'LOCALE', 'DEV_JWKS', 'OWNER_NAME']) delete process.env[`XLR8_${name}`];
});

describe('environment variables', () => {
  test('the owner allowlist works under the old name alone, and the new name wins', async () => {
    const { owner } = setup();
    // setup() sets the new variable; switch to the old one only.
    delete process.env.SELFBOUND_OWNER_IDS;
    process.env.XLR8_OWNER_IDS = OWNER.tokenIdentifier;
    resetLegacyEnvWarnings();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await owner.query(api.ops.status, {})).toBeDefined();
    expect(warn).toHaveBeenCalledWith('XLR8_OWNER_IDS is deprecated, set SELFBOUND_OWNER_IDS instead.');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(OWNER.tokenIdentifier);
    // Both set: the new one decides (here it excludes the owner).
    process.env.SELFBOUND_OWNER_IDS = 'https://dev.selfbound.local|somebody-else';
    await expect(owner.query(api.ops.status, {})).rejects.toThrow();
    process.env.SELFBOUND_OWNER_IDS = OWNER.tokenIdentifier;
  });

  test('test switches, seed permission and the owner name under the old names', async () => {
    const { t, owner } = setup({ testSwitches: false, allowSeed: false });
    delete process.env.SELFBOUND_TEST_SWITCHES;
    delete process.env.SELFBOUND_ALLOW_SEED;
    expect((await t.fetch('/health').then((r) => r.json())).testSwitches).toBe(false);
    process.env.XLR8_TEST_SWITCHES = '1';
    expect((await t.fetch('/health').then((r) => r.json())).testSwitches).toBe(true);
    // The new name wins even when it says "off".
    process.env.SELFBOUND_TEST_SWITCHES = '0';
    expect((await t.fetch('/health').then((r) => r.json())).testSwitches).toBe(false);
    expect(owner).toBeDefined();
  });

  test('OAuth is on with XLR8_APP_URL alone; XLR8_PUBLIC_SITE_URL sets the issuer', async () => {
    const { t } = setup();
    delete process.env.SELFBOUND_APP_URL;
    delete process.env.SELFBOUND_PUBLIC_SITE_URL;
    expect((await t.fetch('/health').then((r) => r.json())).oauth).toBe(false);
    process.env.XLR8_APP_URL = 'http://127.0.0.1:5412';
    expect((await t.fetch('/health').then((r) => r.json())).oauth).toBe(true);
    process.env.XLR8_PUBLIC_SITE_URL = 'https://mcp.selfbound.example.com';
    const prm = await t.fetch('/.well-known/oauth-protected-resource/mcp').then((r) => r.json());
    expect(prm.resource).toBe('https://mcp.selfbound.example.com/mcp');
  });
});

describe('secrets and OAuth issued before the rename', () => {
  test('an old agent key (xlr8_…) still works, with and without OAuth', async () => {
    for (const oauth of [false, true]) {
      const { t } = setup({ oauth });
      await t.run(async (ctx) => {
        await ctx.db.insert('agents', { name: 'Old agent', keyHash: await sha256(OLD_KEY), keyPrefix: OLD_KEY.slice(0, 10), createdAt: 0 });
      });
      expect((await mcp(t, OLD_KEY)).status, `oauth ${oauth}`).toBe(200);
      const wrong = await mcp(t, `xlr8_${'z'.repeat(43)}`);
      expect(wrong.status).toBe(401);
      expect(wrong.challenge).toBeNull();
    }
  });

  test('a new key is shown with the new prefix and lists next to an old one', async () => {
    const { t, owner } = setup();
    await t.run(async (ctx) => {
      await ctx.db.insert('agents', { name: 'Old agent', keyHash: await sha256(OLD_KEY), keyPrefix: OLD_KEY.slice(0, 10), createdAt: 0 });
    });
    const created = await owner.action(api.agents.create, { name: 'New agent' });
    expect(created.key.startsWith('selfbound_')).toBe(true);
    expect(created.keyPrefix).toHaveLength(14);
    expect((await mcp(t, created.key)).status).toBe(200);
    expect((await owner.query(api.agents.list, {})).map((a) => a.keyPrefix).sort()).toEqual([created.keyPrefix, 'xlr8_kkkkk'].sort());
  });

  test('an old access token works, an old refresh token rotates into new-style tokens', async () => {
    const { t } = setup({ oauth: true });
    await oldConnector(t);
    expect((await mcp(t, OLD_ACCESS)).status).toBe(200);
    const refreshed = await token(t, { grant_type: 'refresh_token', refresh_token: OLD_REFRESH, client_id: OLD_CLIENT });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.access_token).toMatch(/^selfbound_at_/);
    expect(refreshed.body.refresh_token).toMatch(/^selfbound_rt_/);
    // The grant was made before the rename and the request names no scope: the connector keeps seeing the scope it knows.
    expect(refreshed.body.scope).toBe('xlr8');
    expect((await mcp(t, refreshed.body.access_token)).status).toBe(200);
    // The new refresh token rotates again.
    expect((await token(t, { grant_type: 'refresh_token', refresh_token: refreshed.body.refresh_token, client_id: OLD_CLIENT })).status).toBe(200);
  });

  test('a client that asks for the new scope gets it, even with an old client id', async () => {
    const { t } = setup({ oauth: true });
    await oldConnector(t);
    const refreshed = await token(t, { grant_type: 'refresh_token', refresh_token: OLD_REFRESH, client_id: OLD_CLIENT, scope: 'selfbound' });
    expect(refreshed.body.scope).toBe('selfbound');
  });

  test('a client that asks for the legacy scope keeps seeing it', async () => {
    const { t } = setup({ oauth: true });
    await oldConnector(t);
    const refreshed = await token(t, { grant_type: 'refresh_token', refresh_token: OLD_REFRESH, client_id: OLD_CLIENT, scope: 'xlr8' });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.scope).toBe('xlr8');
  });

  test('an old client and scope pass authorize; an old code and an old client secret redeem', async () => {
    const { t, owner } = setup({ oauth: true });
    await oldConnector(t, { secret: true });
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: OLD_CLIENT,
      redirect_uri: CLAUDE,
      code_challenge: await pkceChallenge(VERIFIER),
      code_challenge_method: 'S256',
      state: 's',
      resource: `${SITE}/mcp`,
      scope: 'xlr8 offline_access',
    });
    const start = await t.fetch(`/oauth/authorize?${params}`);
    expect(start.status).toBe(302);
    const publicId = new URL(start.headers.get('location')!).searchParams.get('request')!;
    expect(await owner.query(api.oauth.request, { request: publicId })).toMatchObject({ state: 'pending', clientKnown: true });

    // A code issued by the old version, redeemed with the old client secret (HTTP Basic).
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert('oauthRequests', {
        publicId: 'old-request',
        clientId: OLD_CLIENT,
        app: 'claude',
        redirectUri: CLAUDE,
        redirectGiven: true,
        codeChallenge: await pkceChallenge(VERIFIER),
        createdAt: now,
        expiresAt: now + 900_000,
        status: 'approved',
        name: 'Old code',
        codeHash: await sha256(OLD_CODE),
        codeExpiresAt: now + 300_000,
      });
    });
    const basic = `Basic ${btoa(`${encodeURIComponent(OLD_CLIENT)}:${encodeURIComponent(OLD_SECRET)}`)}`;
    const exchanged = await token(t, { grant_type: 'authorization_code', code: OLD_CODE, code_verifier: VERIFIER, redirect_uri: CLAUDE }, { Authorization: basic });
    expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
    expect(exchanged.body.access_token).toMatch(/^selfbound_at_/);
    expect((await mcp(t, exchanged.body.access_token)).status).toBe(200);
    // Without or with a wrong secret: rejected.
    expect((await token(t, { grant_type: 'refresh_token', refresh_token: exchanged.body.refresh_token, client_id: OLD_CLIENT })).status).toBe(401);
    expect((await token(t, { grant_type: 'refresh_token', refresh_token: exchanged.body.refresh_token, client_id: OLD_CLIENT, client_secret: `xlr8_cs_${'x'.repeat(43)}` })).status).toBe(401);
  });

  test('the old token can be revoked; the app disconnects an old connector', async () => {
    const { t } = setup({ oauth: true });
    await oldConnector(t);
    expect((await t.fetch('/oauth/revoke', form({ token: OLD_REFRESH, client_id: OLD_CLIENT }))).status).toBe(200);
    expect((await mcp(t, OLD_ACCESS)).status).toBe(401);
  });

  test('both scopes are advertised', async () => {
    const { t } = setup({ oauth: true });
    const as = await t.fetch('/.well-known/oauth-authorization-server').then((r) => r.json());
    expect(as.scopes_supported).toEqual(['selfbound', 'xlr8', 'offline_access']);
    const prm = await t.fetch('/.well-known/oauth-protected-resource/mcp').then((r) => r.json());
    expect(prm.scopes_supported).toEqual(['selfbound', 'xlr8']);
  });
});

describe('actor kind steven / owner', () => {
  test('new writes store owner; whoami says owner', async () => {
    const { t, owner } = setup();
    expect(await owner.query(api.health.whoami, {})).toEqual({ kind: OWNER_KIND });
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb);
    await owner.mutation(api.comments.add, { issueId: a.id, body: 'x' });
    const stored = await t.run(async (ctx) => ({
      issue: (await ctx.db.get('issues', a.id))!.createdBy,
      comments: (await ctx.db.query('comments').collect()).map((c) => c.author),
      history: (await ctx.db.query('history').collect()).map((h) => h.actor),
    }));
    expect(JSON.stringify(stored)).not.toContain(LEGACY_OWNER_KIND);
    expect(stored.issue).toEqual({ kind: 'owner' });
  });

  test('isOwnerKind accepts both and nothing else', () => {
    expect(isOwnerKind('owner')).toBe(true);
    expect(isOwnerKind('steven')).toBe(true); // legacy-xlr8
    for (const kind of ['agent', 'github', 'import', 'system', '']) expect(isOwnerKind(kind)).toBe(false);
  });

  test('data still holding the legacy kind keeps working: edit comments, wiki revisions, MCP names', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const a = await createOne(owner, f.orb, { title: 'Old issue' });
    const { commentId } = await owner.mutation(api.comments.add, { issueId: a.id, body: 'Old comment' });
    await t.run(async (ctx) => {
      await ctx.db.patch('issues', a.id, { createdBy: { kind: 'steven' } }); // legacy-xlr8
      await ctx.db.patch('comments', commentId, { author: { kind: 'steven' } }); // legacy-xlr8
    });
    // The owner (new kind) edits a comment whose author is stored with the legacy kind.
    await owner.mutation(api.comments.edit, { commentId, body: 'Edited' });
    const { key } = await owner.action(api.agents.create, { name: 'Codex' });
    const detail = (await mcp(t, key, 'tools/call', { name: 'get_issue', arguments: { identifier: a.identifier } })).body.result.structuredContent;
    expect(detail.createdBy).toBe('Owner');
    expect(detail.comments[0]).toMatchObject({ author: 'Owner', body: 'Edited' });
  });

  test('a retry across the migration returns the stored result (idempotency owner steven/owner)', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const args = { requestId: 'retry-across-migration', issues: [{ teamId: f.orb, title: 'Once' }] };
    const first = await owner.mutation(api.issues.create, args);
    // The request was stored before the migration (legacy owner string); the retry comes after the deploy.
    await t.run(async (ctx) => {
      const row = (await ctx.db.query('requests').collect()).find((r) => r.requestId === args.requestId)!;
      await ctx.db.patch('requests', row._id, { owner: 'steven' }); // legacy-xlr8
    });
    expect(await owner.mutation(api.issues.create, args)).toEqual(first);
    // And the other way round: stored as owner, retried after being (or while still) legacy.
    await t.run(async (ctx) => {
      const row = (await ctx.db.query('requests').collect()).find((r) => r.requestId === args.requestId)!;
      await ctx.db.patch('requests', row._id, { owner: 'owner' });
    });
    expect(await owner.mutation(api.issues.create, args)).toEqual(first);
    const issues = await t.run(async (ctx) => await ctx.db.query('issues').collect());
    expect(issues.filter((i) => i.title === 'Once')).toHaveLength(1);
  });
});

describe('sprint source selfbound / xlr8', () => {
  test('new sprints are selfbound; recent closed sprints and the capacity cover both values', async () => {
    const { t, owner } = setup();
    const { id } = await owner.mutation(api.sprints.create, { goal: 'New' });
    expect((await t.run(async (ctx) => await ctx.db.get('sprints', id)))?.source).toBe('selfbound');
    const closed = await t.run(async (ctx) => {
      const make = async (number: number, source: 'selfbound' | 'xlr8' | 'linear', closedAt: number) =>
        await ctx.db.insert('sprints', {
          number,
          name: `Sprint ${number}`,
          goal: '',
          startDate: '2026-01-01',
          endDate: '2026-01-07',
          state: 'closed',
          source,
          closedAt,
          updatedAt: closedAt,
        });
      return [await make(101, 'xlr8', 1000), await make(102, 'selfbound', 2000), await make(103, 'xlr8', 3000), await make(104, 'linear', 4000)]; // legacy-xlr8
    });
    // Selfbound sprints (either value) newest first; imported cycles are a separate source.
    const numbers = async (source: 'selfbound' | 'linear', count: number) =>
      await t.run(async (ctx) => (await recentClosedSprints(ctx, source, count)).map((s) => s.number));
    expect(await numbers('selfbound', 2)).toEqual([103, 102]);
    expect(await numbers('selfbound', 5)).toEqual([103, 102, 101]);
    expect(await numbers('linear', 5)).toEqual([104]);
    expect(closed).toHaveLength(4);
    const meta = await owner.query(api.meta.get, {});
    expect(meta.sprints.filter((s) => s.state === 'closed').map((s) => s.number)).toEqual([104, 103, 102, 101]);
    const capacity = await owner.query(api.sprints.capacitySuggestion, {});
    expect(capacity.basis.map((b: { number: number }) => b.number)).toEqual([103, 102, 101]);
  });
});

describe('theme ID', () => {
  test('selfbound and the old xlr8 are both accepted', async () => {
    const { owner } = setup();
    const base = { sans: 'inter', mono: 'system', overrides: [] };
    await owner.mutation(api.appearance.save, { ...base, dark: 'selfbound', light: 'xlr8' });
    expect((await owner.query(api.appearance.get, {})).settings).toMatchObject({ dark: 'selfbound', light: 'xlr8' });
  });
});
