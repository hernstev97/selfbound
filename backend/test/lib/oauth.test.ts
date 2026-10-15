import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  ACCESS_FORMAT,
  appForRedirects,
  authorizationServerMetadata,
  checkAuthorize,
  checkRegistration,
  clientCredentials,
  oauthConfig,
  parseForm,
  pkceChallenge,
  protectedResourceMetadata,
  redirectWith,
  wwwAuthenticate,
} from '../../convex/lib/oauth/core';
import { KEY_FORMAT } from '../../convex/lib/mcp/endpoint';

// OAuth for connectors, pure logic (lib/oauth/core.ts).

const cfg = oauthConfig({ CONVEX_SITE_URL: 'https://happy-otter-123.convex.site/', SELFBOUND_APP_URL: 'https://selfbound.example.com' })!;
const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const CHATGPT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const CHALLENGE = 'A'.repeat(43);

describe('configuration and metadata', () => {
  test('off without SELFBOUND_APP_URL; a custom address wins over the Convex site URL', () => {
    expect(oauthConfig({ CONVEX_SITE_URL: 'https://a.convex.site' })).toBeNull();
    expect(oauthConfig({ CONVEX_SITE_URL: 'https://a.convex.site', SELFBOUND_APP_URL: 'broken' })).toBeNull();
    expect(cfg).toEqual({
      issuer: 'https://happy-otter-123.convex.site',
      resource: 'https://happy-otter-123.convex.site/mcp',
      appUrl: 'https://selfbound.example.com',
    });
    expect(
      oauthConfig({ CONVEX_SITE_URL: 'https://a.convex.site', SELFBOUND_PUBLIC_SITE_URL: 'https://mcp.selfbound.example.com', SELFBOUND_APP_URL: 'https://selfbound.example.com' })
        ?.resource,
    ).toBe('https://mcp.selfbound.example.com/mcp');
  });

  test('SELFBOUND_PUBLIC_SITE_URL is one address; without a valid one the Convex site URL applies', () => {
    const env = { CONVEX_SITE_URL: 'https://a.convex.site', SELFBOUND_PUBLIC_SITE_URL: ' https://mcp.selfbound.example.com/ ', SELFBOUND_APP_URL: 'https://selfbound.example.com' };
    expect(oauthConfig(env)).toMatchObject({ issuer: 'https://mcp.selfbound.example.com', resource: 'https://mcp.selfbound.example.com/mcp' });
    expect(oauthConfig({ ...env, SELFBOUND_PUBLIC_SITE_URL: 'broken' })?.issuer).toBe('https://a.convex.site');
    expect(oauthConfig({ SELFBOUND_APP_URL: 'https://selfbound.example.com' })).toBeNull();
  });

  test('issuer = authorization_servers[0], iss parameter, S256 only, resource = MCP URL', () => {
    const prm = protectedResourceMetadata(cfg);
    const as = authorizationServerMetadata(cfg);
    expect(prm.resource).toBe(cfg.resource);
    expect(prm.authorization_servers).toEqual([as.issuer]);
    expect(as).toMatchObject({
      authorization_response_iss_parameter_supported: true,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: expect.arrayContaining(['none']),
      registration_endpoint: `${cfg.issuer}/oauth/register`,
    });
    expect(as).not.toHaveProperty('client_id_metadata_document_supported');
    expect(wwwAuthenticate(cfg)).toBe(
      'Bearer resource_metadata="https://happy-otter-123.convex.site/.well-known/oauth-protected-resource/mcp", scope="selfbound"',
    );
    expect(wwwAuthenticate(cfg, 'invalid_token')).toMatch(/, error="invalid_token"$/);
  });

  test('access tokens and agent keys cannot be confused', () => {
    // legacy-xlr8: tokens issued before the rename
    for (const prefix of ['selfbound', 'xlr8']) {
      const access = `${prefix}_at_${'x'.repeat(43)}`;
      const key = `${prefix}_${'x'.repeat(43)}`;
      expect(ACCESS_FORMAT.test(access)).toBe(true);
      expect(KEY_FORMAT.test(access)).toBe(false);
      expect(ACCESS_FORMAT.test(key)).toBe(false);
    }
  });
});

describe('Redirect-URIs', () => {
  test('only the known addresses of Claude and ChatGPT', () => {
    expect(appForRedirects([CLAUDE])).toBe('claude');
    expect(appForRedirects(['https://claude.com/api/mcp/auth_callback', CLAUDE])).toBe('claude');
    expect(appForRedirects([CHATGPT])).toBe('chatgpt');
    expect(appForRedirects(['https://chatgpt.com/connector/oauth/abc_DEF-123'])).toBe('chatgpt');
    for (const bad of [
      'http://claude.ai/api/mcp/auth_callback',
      'https://claude.ai.evil.com/api/mcp/auth_callback',
      'https://evil.com/?https://claude.ai/api/mcp/auth_callback',
      `${CLAUDE}/`,
      `${CLAUDE}?x=1`,
      'https://chatgpt.com/connector/oauth/a/b',
      'https://chatgpt.com/connector/oauth/',
      'http://localhost/callback',
    ]) {
      expect(appForRedirects([bad]), bad).toBeNull();
    }
    expect(appForRedirects([CLAUDE, CHATGPT])).toBeNull();
    expect(appForRedirects([])).toBeNull();
  });

  test('registration: required fields, defaults, limits', () => {
    expect(checkRegistration({ redirect_uris: [CLAUDE], token_endpoint_auth_method: 'none', client_name: ' Claude ' })).toEqual({
      ok: true,
      value: { app: 'claude', clientName: 'Claude', redirectUris: [CLAUDE], authMethod: 'none' },
    });
    // RFC 7591: client_secret_basic by default
    expect(checkRegistration({ redirect_uris: [CHATGPT] })).toMatchObject({ ok: true, value: { authMethod: 'client_secret_basic' } });
    expect(checkRegistration({ redirect_uris: ['https://evil.com/cb'] })).toMatchObject({ ok: false, error: 'invalid_redirect_uri' });
    expect(checkRegistration({ redirect_uris: [CLAUDE], grant_types: ['client_credentials'] })).toMatchObject({ ok: false });
    expect(checkRegistration({ redirect_uris: [CLAUDE], token_endpoint_auth_method: 'private_key_jwt' })).toMatchObject({ ok: false });
    expect(checkRegistration({ redirect_uris: Array(6).fill(CLAUDE) })).toMatchObject({ ok: false });
    expect(checkRegistration([])).toMatchObject({ ok: false });
  });
});

describe('authorization', () => {
  const client = { redirectUris: [CLAUDE] };
  const params = (extra: Record<string, string> = {}) =>
    new URLSearchParams({
      response_type: 'code',
      client_id: 'c',
      redirect_uri: CLAUDE,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      state: 's1',
      resource: cfg.resource,
      ...extra,
    });

  test('valid request; missing redirect_uri with exactly one registered', () => {
    expect(checkAuthorize(params(), client, cfg)).toEqual({
      kind: 'ok',
      redirectUri: CLAUDE,
      redirectGiven: true,
      state: 's1',
      codeChallenge: CHALLENGE,
    });
    const p = params();
    p.delete('redirect_uri');
    p.delete('resource');
    expect(checkAuthorize(p, client, cfg)).toMatchObject({ kind: 'ok', redirectGiven: false });
    expect(checkAuthorize(params({ resource: `${cfg.resource}/` }), client, cfg)).toMatchObject({ kind: 'ok' });
  });

  test('wrong redirect: a page only, never a redirect', () => {
    expect(checkAuthorize(params({ redirect_uri: 'https://evil.com/cb' }), client, cfg).kind).toBe('page');
    expect(checkAuthorize(params({ redirect_uri: CHATGPT }), client, cfg).kind).toBe('page');
  });

  test('errors after the redirect is verified go to the client', () => {
    expect(checkAuthorize(params({ code_challenge_method: 'plain' }), client, cfg)).toMatchObject({ kind: 'error', error: 'invalid_request' });
    expect(checkAuthorize(params({ code_challenge: 'short' }), client, cfg)).toMatchObject({ kind: 'error', error: 'invalid_request' });
    expect(checkAuthorize(params({ response_type: 'token' }), client, cfg)).toMatchObject({ kind: 'error', error: 'unsupported_response_type' });
    expect(checkAuthorize(params({ resource: 'https://other.example/mcp' }), client, cfg)).toMatchObject({
      kind: 'error',
      error: 'invalid_target',
      state: 's1',
    });
  });

  test('redirect back to the client always carries iss', () => {
    const url = new URL(redirectWith(CLAUDE, { code: 'c1', state: 'a b&c' }, cfg.issuer));
    expect(url.origin + url.pathname).toBe(CLAUDE);
    expect(Object.fromEntries(url.searchParams)).toEqual({ code: 'c1', state: 'a b&c', iss: cfg.issuer });
  });
});

describe('token endpoint', () => {
  test('PKCE S256 matches node:crypto', async () => {
    const verifier = 'dBjftJeZ4CVP-mJ92K9TQhxJdTtVYcE5Px4pxD4sYkI';
    expect(await pkceChallenge(verifier)).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  test('form and JSON; client authentication via Basic (URL-encoded) or form', () => {
    expect(parseForm('grant_type=refresh_token&a=1&a=2', 'application/x-www-form-urlencoded')).toEqual({ grant_type: 'refresh_token', a: '1' });
    expect(parseForm('{"grant_type":"x","n":1}', 'application/json')).toEqual({ grant_type: 'x' });
    expect(parseForm('{broken', 'application/json')).toBeNull();
    const basic = `Basic ${btoa('selfbound-claude-1:sec%3Aret')}`;
    expect(clientCredentials(basic, {})).toEqual({ clientId: 'selfbound-claude-1', secret: 'sec:ret', basic: true });
    expect(clientCredentials(null, { client_id: 'c', client_secret: 's' })).toEqual({ clientId: 'c', secret: 's', basic: false });
    expect(clientCredentials('Basic !!!', {})).toBeNull();
  });
});
